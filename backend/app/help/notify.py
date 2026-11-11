"""In-app notifications (the bell), with email alongside when the mail server is set up.

Every feature that needs to tell a person something goes through notify():
feedback replies, change alerts to PMs and owners, crew offers, closeout nudges.

    notify([user_id, ...], "change.dates", "Start date moved on Sysco Walnut",
           body="11/9 → 11/16", link="#/entity/project/123", subject="123",
           dedupe_key="change.dates:123:2026-11-16")

Rules
-----
* A (user, dedupe_key) pair is stored once, so a nightly job can call notify()
  every run without repeating itself.
* notification_prefs can switch a kind off in-app or by email per person
  ('*' = every kind). No row = on.
* Email goes out only when mailer.is_configured() (prod has no SMTP yet), and
  never raises: a notification is never lost because email is down.
"""
from typing import Iterable, Optional

from sqlalchemy import bindparam, text

from app import mailer
from app.db import engine


def _prefs(conn, user_ids, kind):
    rows = conn.execute(text(
        "SELECT user_id, kind, in_app, email FROM notification_prefs "
        "WHERE user_id IN :ids AND kind IN (:k, '*')"
    ).bindparams(bindparam("ids", expanding=True)), {"ids": list(user_ids), "k": kind}).mappings().all()
    out = {}
    for r in rows:
        cur = out.get(r["user_id"])
        # A specific kind beats the '*' row.
        if cur is None or r["kind"] != "*":
            out[r["user_id"]] = (bool(r["in_app"]), bool(r["email"]))
    return out


def notify(user_ids: Iterable[int], kind: str, title: str, body: Optional[str] = None,
           link: Optional[str] = None, subject: Optional[str] = None,
           dedupe_key: Optional[str] = None, email: bool = True) -> int:
    """Store a notification for each user. Returns how many new rows were stored."""
    ids = sorted({int(u) for u in user_ids if u})
    if not ids:
        return 0
    made = []
    with engine.begin() as conn:
        prefs = _prefs(conn, ids, kind)
        active = {r[0]: r[1] for r in conn.execute(text(
            "SELECT id, email FROM users WHERE id IN :ids AND is_active = 1"
        ).bindparams(bindparam("ids", expanding=True)), {"ids": ids}).all()}
        for uid in ids:
            if uid not in active:
                continue
            in_app, by_email = prefs.get(uid, (True, True))
            if not in_app and not by_email:
                continue
            res = conn.execute(text(
                "INSERT IGNORE INTO notifications (user_id, kind, title, body, link, subject, dedupe_key, read_at) "
                "VALUES (:u, :k, :t, :b, :l, :s, :d, :r)"
            ), {"u": uid, "k": kind, "t": title[:255], "b": body, "l": link, "s": subject,
                "d": dedupe_key, "r": None if in_app else "1970-01-02"})
            if res.rowcount:
                made.append((uid, active[uid], by_email, res.lastrowid))
    if email and mailer.is_configured():
        for uid, addr, by_email, nid in made:
            if not by_email or not addr:
                continue
            url = mailer.app_base_url() + "/" + (link or "#/projects")
            html = mailer._shell(title, (body or "").replace("\n", "<br>"), "Open in the app", url)
            if mailer.send_email(addr, title, html, f"{title}\n\n{body or ''}\n\n{url}\n"):
                with engine.begin() as conn:
                    conn.execute(text("UPDATE notifications SET emailed_at = NOW() WHERE id = :i"), {"i": nid})
    return len(made)


def users_with_capability(cap: str) -> list:
    """Active user ids holding a capability (role default or per-user grant)."""
    from app.permissions import load_capabilities
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT id, role FROM users WHERE is_active = 1")).all()
    return [r[0] for r in rows if cap in load_capabilities(r[0], r[1])]


def users_with_role(*roles: str) -> list:
    with engine.connect() as conn:
        rows = conn.execute(text(
            "SELECT id FROM users WHERE is_active = 1 AND role IN :r"
        ).bindparams(bindparam("r", expanding=True)), {"r": list(roles)}).all()
    return [r[0] for r in rows]
