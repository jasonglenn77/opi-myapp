"""
When a job actually finished. OPI has no official completion date, so every
signal is kept and one best date is chosen:

  last_scheduled   last day on the Job Schedule (the default: the last invoice
                   lands within two weeks of it on most jobs)
  marked_complete  first time the status was set to completed. The history only
                   starts in April 2026, and imports flip the status by date, so
                   it is a record date rather than proof of the last day of work.
  completion_form  the crew's Project Completion Form, when one was filed. This
                   is the only signal that comes from the job site, so it wins.
  final_invoice    last invoice in QuickBooks
  last_cost        last bill or card charge tagged to the job. Bills trail the
                   job (rentals, lodging statements), so it is never the best date.

gap_days compares the job-side signals; GAP_FLAG_DAYS or more flags the job.
"""
import json
from datetime import date

from sqlalchemy import text

GAP_FLAG_DAYS = 30
BEST_LABEL = {"completion_form": "Completion form", "last_scheduled": "Last scheduled day"}


def load(conn):
    """{entity_id: dates} for every project with a schedule."""
    out, id_map = {}, {}
    for r in conn.execute(text("""
        SELECT qc.qbo_id, qc.id AS cid, MAX(psi.end_date) AS e
        FROM qbo_customers qc JOIN projects p ON p.qbo_customer_id = qc.id
        JOIN project_schedule_items psi ON psi.project_id = p.id
        WHERE qc.is_project = 1 GROUP BY qc.qbo_id, qc.id
    """)).mappings():
        out[str(r["qbo_id"])] = {"last_scheduled": r["e"], "marked_complete": None, "completion_form": None,
                                 "final_invoice": None, "last_cost": None}
        id_map[r["cid"]] = str(r["qbo_id"])

    for r in conn.execute(text("""
        SELECT p.qbo_customer_id AS cid, h.changed_at, h.changes
        FROM project_schedule_item_history h
        JOIN project_schedule_items s ON s.id = h.schedule_item_id JOIN projects p ON p.id = s.project_id
        WHERE h.changes LIKE '%completed%' ORDER BY h.changed_at
    """)).mappings():
        try:
            ch = json.loads(r["changes"]) if isinstance(r["changes"], str) else r["changes"]
        except ValueError:
            continue
        st = (ch or {}).get("status")
        eid = id_map.get(r["cid"])
        if eid and st and len(st) > 1 and st[1] == "completed" and not out[eid]["marked_complete"]:
            out[eid]["marked_complete"] = r["changed_at"].date()

    for r in conn.execute(text("""
        SELECT project_qbo_id, MAX(COALESCE(report_date, DATE(submitted_at)))
        FROM form_submissions WHERE form_code = 'completion' GROUP BY project_qbo_id
    """)).all():
        if str(r[0]) in out:
            out[str(r[0])]["completion_form"] = r[1]
    for r in conn.execute(text("""
        SELECT customer_qbo_id, MAX(txn_date) FROM qbo_transactions
        WHERE entity_type = 'Invoice' AND total_amt > 0 GROUP BY customer_qbo_id
    """)).all():
        if str(r[0]) in out:
            out[str(r[0])]["final_invoice"] = r[1]
    for r in conn.execute(text("""
        SELECT l.line_customer_qbo_id, MAX(t.txn_date)
        FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
        WHERE t.entity_type IN ('Bill', 'Purchase') AND l.line_customer_qbo_id IS NOT NULL
        GROUP BY l.line_customer_qbo_id
    """)).all():
        if str(r[0]) in out:
            out[str(r[0])]["last_cost"] = r[1]

    for d in out.values():
        src = "completion_form" if d["completion_form"] else "last_scheduled"
        d["best"], d["best_source"] = d[src], BEST_LABEL[src]
        pts = [v for v in (d["completion_form"], d["last_scheduled"], d["final_invoice"]) if isinstance(v, date)]
        d["gap_days"] = (max(pts) - min(pts)).days if len(pts) > 1 else 0
        d["flag"] = d["gap_days"] >= GAP_FLAG_DAYS
    return out
