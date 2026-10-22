"""
Refresh from Google Drive: download the B151 + Job Schedule, store the parsed
copies, mirror the B151 into the Pipeline, link quotes to QBO projects, and
update the Assignments (schedule lines, crews, PMs) from the Job Schedule.

  python -m app.gsync.run              # refresh + mirror (what the nightly cron runs)
  python -m app.gsync.run --dry-run    # download + parse + show what the mirror would change
"""
import json
import sys
import threading
from datetime import date, timedelta

from sqlalchemy import text

from app.db import engine
from app.audit import record_audit
from . import sheets, b151, schedule_import

_lock = threading.Lock()


def _start(source, who):
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO gsync_runs (source, triggered_by) VALUES (:s, :w)"), {"s": source, "w": who})
        return conn.execute(text("SELECT LAST_INSERT_ID()")).scalar()


def _finish(run_id, ok, summary=None, error=None, modified=None):
    with engine.begin() as conn:
        conn.execute(text("""
            UPDATE gsync_runs SET finished_at = NOW(), ok = :ok, summary = :s, error = :e, drive_modified = :m
            WHERE id = :id"""), {"id": run_id, "ok": 1 if ok else 0, "s": json.dumps(summary, default=str) if summary else None,
                                 "e": (error or "")[:4000] or None, "m": modified})


def refresh_b151(who="manual", dry_run=False, actor=None):
    run_id = None if dry_run else _start("b151", who)
    try:
        with engine.connect() as conn:
            prev = conn.execute(text("SELECT COUNT(*) FROM gsync_b151_rows")).scalar() or 0
        meta, rows, via = sheets.fetch_b151_rows(min_expected=int(prev * 0.98))
        # Guard: never mirror from a download that lost rows (the sheet only grows).
        if prev and len(rows) < prev * 0.98:
            raise RuntimeError(f"B151 download looks incomplete ({len(rows)} rows vs {prev} last time, via {via}) — "
                               "nothing changed; try again or enable the Google Sheets API")
        with engine.begin() as conn:
            p = b151.plan(conn, rows)
            if dry_run:
                return {"rows": len(rows), **b151.summarize(p), "sample": p["updates"][:15], "new": p["creates"][:15]}
            sheets.store_b151(conn, rows)
            b151.apply(conn, p)
        summary = {"rows": len(rows), "via": via, **b151.summarize(p)}
        if rows and rows[0].get("_fill_stats"):
            summary["workbook_fill"] = rows[0]["_fill_stats"]
        try:
            from app.opportunities.qbo_sync import run as qbo_link
            summary["qbo_links"] = qbo_link(do_apply=True, link_only=True)[0]["linked_project"]
        except Exception as e:  # linking is best-effort
            summary["qbo_links_error"] = str(e)
        if p["updates"] or p["creates"]:
            record_audit(actor or {"email": f"gsync:{who}"}, "opportunity.b151_mirror", "opportunity", None,
                         "Pipeline updated from the B151", {
                             "summary": summary,
                             "status_changes": [{"id": u["id"], "quote": u["quote"],
                                                 "from": u["old"].get("pipeline_status"), "to": u["new"]["pipeline_status"]}
                                                for u in p["updates"] if "pipeline_status" in u["new"]][:500],
                             "created_quotes": [c["quote_number"] for c in p["creates"]][:500]})
        _finish(run_id, True, summary, modified=meta.get("modifiedTime"))
        return summary
    except Exception as e:
        if run_id:
            _finish(run_id, False, error=str(e))
        raise


def refresh_schedule(who="manual"):
    run_id = _start("job_schedule", who)
    try:
        meta, data = sheets.fetch_job_schedule()
        recs = sheets.parse_job_schedule(data, since=date.today() - timedelta(days=120))
        with engine.begin() as conn:
            sheets.store_job_schedule(conn, recs)
        summary = {"cells": len(recs), "from": str(min(r["day"] for r in recs)) if recs else None,
                   "to": str(max(r["day"] for r in recs)) if recs else None}
        _finish(run_id, True, summary, modified=meta.get("modifiedTime"))
        return summary
    except Exception as e:
        _finish(run_id, False, error=str(e))
        raise


def refresh_assignments(who="manual"):
    """Job Schedule → Assignments (schedule_import, apply mode), right after
    the sheet copy is refreshed. Logged as gsync_runs source 'schedule_import'."""
    run_id = _start("schedule_import", who)
    try:
        summary, p = schedule_import.run(do_apply=True)
        if summary.get("error"):
            raise RuntimeError(summary["error"])
        summary["sample"] = [{"job": c["job"], "line": c["schedule_item_id"], "visit": c["visit"],
                              "fields": sorted(c["changes"])} for c in p["changes"][:40]]
        _finish(run_id, not summary.get("errors"), summary,
                error="; ".join(f"{e['job']}: {e['error']}" for e in summary.get("errors", []))[:4000] or None)
        if p["changes"]:
            record_audit({"email": f"gsync:{who}"}, "schedule.job_schedule_import", "project_schedule_item", None,
                         "Assignments updated from the Job Schedule",
                         {k: v for k, v in summary.items() if k != "sample"})
        return summary
    except Exception as e:
        _finish(run_id, False, error=str(e))
        raise


def refresh_all(who="manual", actor=None):
    """Both sheets (then the Assignments from the Job Schedule, then the Drive
    documents sync); one at a time across the process."""
    if not _lock.acquire(blocking=False):
        return {"busy": True}
    try:
        out = {}
        for name, fn in (("b151", lambda: refresh_b151(who, actor=actor)), ("job_schedule", lambda: refresh_schedule(who)),
                         ("schedule_import", lambda: refresh_assignments(who))):
            if name == "schedule_import" and "error" in out.get("job_schedule", {}):
                continue   # never import from a stale / failed download
            try:
                out[name] = fn()
            except Exception as e:
                out[name] = {"error": str(e)}
        # Drive Customers folder -> app documents, AFTER the sheets (so new
        # quotes/project links from the B151 are matched). Skipped until the
        # one-time backfill has completed; cron = weekly full walk + nightly
        # incremental with a time budget, the button = a short incremental.
        try:
            from . import docs_sync
            out["drive_docs"] = docs_sync.nightly(who="cron" if who == "cron" else who)
        except Exception as e:
            out["drive_docs"] = {"error": str(e)}
        return out
    finally:
        _lock.release()


def last_runs():
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT r.source, r.started_at, r.finished_at, r.ok, r.drive_modified, r.summary, r.error, r.triggered_by
            FROM gsync_runs r
            JOIN (SELECT source, MAX(id) id FROM gsync_runs GROUP BY source) m ON m.id = r.id
        """)).mappings().all()
    out = {}
    for r in rows:
        d = dict(r)
        if isinstance(d["summary"], str):
            d["summary"] = json.loads(d["summary"])
        if isinstance(d["summary"], dict):
            d["summary"].pop("folders", None)      # drive_reconcile per-folder list (large; Data Review items carry it)
        out[d["source"]] = {k: (str(v) if k in ("started_at", "finished_at") and v else v) for k, v in d.items()}
    return out


if __name__ == "__main__":
    if "--dry-run" in sys.argv:
        print(json.dumps(refresh_b151("cli", dry_run=True), indent=1, default=str)[:6000])
    else:
        print(json.dumps(refresh_all("cron" if "--cron" in sys.argv else "cli"), indent=1, default=str))
