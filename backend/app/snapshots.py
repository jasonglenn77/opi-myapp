"""
Saved page builds (migration 0089), shared by all workers and kept across
restarts. Pattern ("stale while revalidate"):

    data, meta = snapshots.serve("review", build_fn, sig_fn, max_age=900)

  * no snapshot yet         -> build now (blocking), save, return it
  * snapshot, same data sig -> return it (refreshed in the background once it
                               is older than max_age, as a safety net)
  * snapshot, data changed  -> return it at once, rebuild in the background;
                               meta["refreshing"] tells the page to re-ask

A MySQL named lock keeps two workers from rebuilding the same page at once.

CLI:  python -m app.snapshots warm     # rebuild every page snapshot (nightly)
"""
import json
import sys
import threading
import time
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import text

from app.db import engine

_inflight = set()
_lock = threading.Lock()


def _default(o):
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    if isinstance(o, Decimal):
        return float(o)
    if isinstance(o, (set, tuple)):
        return list(o)
    return str(o)


def dumps(v):
    return json.dumps(v, default=_default, separators=(",", ":"))


def get(key):
    """(payload, sig, age_seconds) or None."""
    with engine.connect() as conn:
        r = conn.execute(text("""SELECT payload, sig, TIMESTAMPDIFF(SECOND, computed_at, NOW()) AS age
                                 FROM page_snapshots WHERE skey = :k"""), {"k": key}).first()
    return (json.loads(r[0]), r[1], int(r[2] or 0)) if r else None


def get_many(prefix):
    """{key: (payload, sig)} for every snapshot whose key starts with prefix."""
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT skey, payload, sig FROM page_snapshots WHERE skey LIKE :p"),
                            {"p": prefix + "%"}).all()
    return {r[0]: (json.loads(r[1]), r[2]) for r in rows}


def put(key, payload, sig=None, seconds=None, conn=None):
    sql = text("""INSERT INTO page_snapshots (skey, sig, payload, build_seconds) VALUES (:k, :s, :p, :b)
                  ON DUPLICATE KEY UPDATE sig = VALUES(sig), payload = VALUES(payload),
                    build_seconds = VALUES(build_seconds), computed_at = NOW()""")
    params = {"k": key, "s": sig, "p": dumps(payload), "b": round(seconds, 2) if seconds is not None else None}
    if conn is not None:
        conn.execute(sql, params)
    else:
        with engine.begin() as c:
            c.execute(sql, params)


def rebuild(key, build_fn, sig_fn=None):
    """Build + save under a named lock. Returns the payload (None if another
    worker holds the lock)."""
    with engine.connect() as lk:
        got = lk.execute(text("SELECT GET_LOCK(:n, 0)"), {"n": f"snap:{key}"}).scalar()
        if not got:
            return None
        try:
            sig = sig_fn() if sig_fn else None
            t = time.time()
            data = build_fn()
            put(key, data, sig, time.time() - t)
            return data
        finally:
            lk.execute(text("SELECT RELEASE_LOCK(:n)"), {"n": f"snap:{key}"})


def refresh_async(key, build_fn, sig_fn=None):
    with _lock:
        if key in _inflight:
            return
        _inflight.add(key)

    def run():
        try:
            rebuild(key, build_fn, sig_fn)
        except Exception:
            pass
        finally:
            with _lock:
                _inflight.discard(key)
    threading.Thread(target=run, daemon=True).start()


def refreshing(key):
    with _lock:
        return key in _inflight


def serve(key, build_fn, sig_fn=None, max_age=900, force=False):
    """(payload, meta) - see the module docstring."""
    if force:
        data = rebuild(key, build_fn, sig_fn)
        if data is not None:
            return data, {"age": 0, "refreshing": False}
    snap = get(key)
    if snap is None:
        data = rebuild(key, build_fn, sig_fn)
        if data is None:                       # another worker is building it right now
            for _ in range(120):
                time.sleep(0.5)
                snap = get(key)
                if snap:
                    break
            if not snap:
                return build_fn(), {"age": 0, "refreshing": False}
        else:
            return data, {"age": 0, "refreshing": False}
    data, sig, age = snap
    stale = age > max_age or (sig_fn is not None and sig_fn() != sig)
    if stale:
        refresh_async(key, build_fn, sig_fn)
    return data, {"age": age, "refreshing": stale or refreshing(key)}


def warm():
    """Rebuild every page snapshot (nightly after the sync, and on demand)."""
    out = {}
    from app.gsync import review
    from app.jobcost import service as JC
    from app.tracker import routes as TR
    for name, fn in (("review", review.refresh_snapshot), ("jobcost", JC.refresh_snapshot),
                     ("tracker", TR.refresh_snapshot)):
        t = time.time()
        try:
            fn()
            out[name] = round(time.time() - t, 1)
        except Exception as e:
            out[name] = f"error: {e}"
    return out


if __name__ == "__main__":
    if sys.argv[1:] == ["warm"]:
        print(warm())
