"""
App edits to data imported from Google Drive files (migration 0088).

The crew Payment Schedules and the Job Schedule are copied into the app every
night. When someone changes one of those values in the app instead of in the
file, the change is recorded here; the import keeps the app's value and Data
Review ("App changes not in Drive") shows the file, the row, what the app says
and what the file says, with a link to the file. The item resolves itself once
the file is updated to match, or when someone clicks "Use Drive's value".

  record()     called by the edit endpoints (payments, assignment save)
  keep_app()   called by the imports for each overridden field
  items()      Data Review items
  release()    "Use Drive's value"
"""
from datetime import date, datetime

from sqlalchemy import text

from app.db import engine
from .review import _item, _money, _md

CAT = "app_edits"
PAYMENT, JOB = "payment_schedule", "job_schedule"
JOB_SCHEDULE_LINK = "https://drive.google.com/open?id={}"
LABELS = {"pay_date": "pay date", "amount": "amount", "send_invoice_date": "send-invoice date",
          "start_date": "start date", "end_date": "end date", "status": "status", "overage_days": "overage days",
          "travel_days": "travel days", "wire_guidance": "wire guidance", "equipment_type": "equipment",
          "crews": "crews", "pms": "project managers", "added": "row added", "non_working": "days off"}


def norm(v):
    """Comparable text for a value (dates ISO, money to the cent, lists sorted)."""
    if v is None or v == "":
        return None
    if isinstance(v, (datetime, date)):
        return v.isoformat()[:10]
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)) or hasattr(v, "quantize"):
        f = float(v)
        return str(int(f)) if f == int(f) else f"{f:.2f}"
    if isinstance(v, (list, tuple, set)):
        return ", ".join(sorted(str(x) for x in v)) or None
    return str(v)[:1000]


def record(conn, source, table, target_id, field, app_value, sheet_value, *, entity_id=None, file_id=None,
           file_name=None, sheet_ref=None, user_email=None):
    """Remember that a person set `field` in the app. Setting it back to what
    the file says clears the record."""
    a, s = norm(app_value), norm(sheet_value)
    cur = conn.execute(text("""SELECT id, sheet_value, resolved_at FROM app_overrides
                               WHERE target_table = :t AND target_id = :i AND field = :f"""),
                       {"t": table, "i": target_id, "f": field}).mappings().first()
    if cur and cur["resolved_at"] is None:
        s = cur["sheet_value"]          # keep what the file said before the first edit
    if a == s and field != "added":
        if cur:
            conn.execute(text("""UPDATE app_overrides SET app_value = :a, resolved_at = NOW(),
                                 resolved_how = 'matches_file', resolved_by = :u WHERE id = :id"""),
                         {"a": a, "u": user_email, "id": cur["id"]})
        return
    if cur:
        conn.execute(text("""UPDATE app_overrides SET app_value = :a, sheet_value = :s, entity_id = :e, file_id = :fid,
                             file_name = :fn, sheet_ref = :ref, created_by = :u, resolved_at = NULL, resolved_how = NULL,
                             resolved_by = NULL WHERE id = :id"""),
                     {"a": a, "s": s, "e": entity_id, "fid": file_id, "fn": file_name, "ref": sheet_ref,
                      "u": user_email, "id": cur["id"]})
    else:
        conn.execute(text("""INSERT INTO app_overrides (source, target_table, target_id, field, entity_id, app_value,
                             sheet_value, file_id, file_name, sheet_ref, created_by)
                             VALUES (:src, :t, :i, :f, :e, :a, :s, :fid, :fn, :ref, :u)"""),
                     {"src": source, "t": table, "i": target_id, "f": field, "e": entity_id, "a": a, "s": s,
                      "fid": file_id, "fn": file_name, "ref": sheet_ref, "u": user_email})


def open_for(conn, table, ids):
    """{target_id: {field: override row}} for the open overrides on these rows."""
    ids = [int(i) for i in ids if i is not None]
    if not ids:
        return {}
    out = {}
    for r in conn.execute(text(f"""SELECT * FROM app_overrides WHERE target_table = :t AND resolved_at IS NULL
                                   AND target_id IN ({', '.join(str(i) for i in ids)})"""), {"t": table}).mappings():
        out.setdefault(r["target_id"], {})[r["field"]] = dict(r)
    return out


def keep_app(conn, ov, sheet_value, do_apply=True, sheet_ref=None):
    """The import found an override. True = keep the app's value (and note what
    the file says now); False = the file now says the same, so it's resolved."""
    s = norm(sheet_value)
    if s == ov["app_value"]:
        if do_apply:
            conn.execute(text("""UPDATE app_overrides SET sheet_value = :s, checked_at = NOW(), resolved_at = NOW(),
                                 resolved_how = 'file_updated' WHERE id = :id"""), {"s": s, "id": ov["id"]})
        return False
    if do_apply:
        conn.execute(text("""UPDATE app_overrides SET sheet_value = :s, checked_at = NOW(),
                             sheet_ref = COALESCE(:ref, sheet_ref) WHERE id = :id"""),
                     {"s": s, "ref": sheet_ref, "id": ov["id"]})
    return True


def release(override_id, user_email):
    """'Use Drive's value': drop the app's change. Payment rows take the file's
    value now; Job Schedule lines on the next import (nightly / Refresh)."""
    with engine.begin() as conn:
        ov = conn.execute(text("SELECT * FROM app_overrides WHERE id = :id"), {"id": override_id}).mappings().first()
        if not ov or ov["resolved_at"] is not None:
            return {"ok": True, "already": True}
        applied = False
        if ov["target_table"] == "project_payment_installments":
            if ov["field"] == "added":
                conn.execute(text("DELETE FROM project_payment_installments WHERE id = :i AND source <> 'sheet'"),
                             {"i": ov["target_id"]})
                applied = True
            elif ov["field"] in ("pay_date", "amount", "send_invoice_date"):
                conn.execute(text(f"UPDATE project_payment_installments SET {ov['field']} = :v WHERE id = :i"),
                             {"v": ov["sheet_value"], "i": ov["target_id"]})
                applied = True
        conn.execute(text("""UPDATE app_overrides SET resolved_at = NOW(), resolved_how = 'use_file', resolved_by = :u
                             WHERE id = :id"""), {"u": user_email, "id": override_id})
    try:
        from app.cashflow.schedule_forecast import touch_dirty
        touch_dirty()
    except Exception:
        pass
    return {"ok": True, "applied_now": applied}


def _fmt(field, v):
    if v is None:
        return "blank"
    if field.endswith("_date") and len(v) == 10:
        return _md(v)
    if field == "amount":
        try:
            return _money(float(v))
        except ValueError:
            return v
    return v


def items(conn):
    rows = conn.execute(text("""
        SELECT o.*, qc.display_name AS project FROM app_overrides o
        LEFT JOIN qbo_customers qc ON qc.qbo_id = o.entity_id COLLATE utf8mb4_unicode_ci
        WHERE o.resolved_at IS NULL ORDER BY o.created_at
    """)).mappings().all()
    from .sheets import JOB_SCHEDULE_ID
    from .payment_import import drive_link
    out = []
    for r in rows:
        f = r["field"]
        label = "row deleted" if f.startswith("deleted:") else LABELS.get(f, f)
        proj = r["project"] or "Project"
        if r["source"] == PAYMENT:
            fname = r["file_name"] or "Payment Schedule"
            where = f"{fname}{', ' + r['sheet_ref'] if r['sheet_ref'] else ''}"
            if f == "added":
                title = f"{proj}: crew payment added in the app ({r['app_value']}), not in {fname}"
                fix = f"Add this row to {fname} in the project's Drive folder, or use Drive's value to remove it from the app."
            elif f.startswith("deleted:"):
                title = f"{proj}: crew payment removed in the app, still in {fname} ({r['sheet_value']})"
                fix = f"Remove row {f.split(':', 1)[1]} from {fname}, or use Drive's value to bring it back."
            else:
                title = (f"{proj}: crew {label} changed in the app to {_fmt(f, r['app_value'])}; "
                         f"{fname} says {_fmt(f, r['sheet_value'])}")
                fix = f"Change the {label} in {where} to {_fmt(f, r['app_value'])}, or use Drive's value."
            ref = {"override_id": r["id"], "file_id": r["file_id"], "qbo_id": r["entity_id"],
                   "sheet_url": drive_link(r["file_id"], None) if r["file_id"] else None}
        else:
            where = f"the Job Schedule{', ' + r['sheet_ref'] if r['sheet_ref'] else ''}"
            title = (f"{proj}: {label} changed in the app to {_fmt(f, r['app_value'])}; "
                     f"the Job Schedule says {_fmt(f, r['sheet_value'])}")
            fix = f"Update {where} to match, or use Drive's value (applied on the next Job Schedule import)."
            ref = {"override_id": r["id"], "qbo_id": r["entity_id"],
                   "sheet_url": JOB_SCHEDULE_LINK.format(JOB_SCHEDULE_ID)}
        detail = (f"Changed in the app by {r['created_by'] or 'someone'} on {_md(r['created_at'])}. "
                  f"Where: {where}. The nightly import keeps the app's value and checks the file again each night; "
                  "this clears itself once the file matches.")
        out.append(_item(CAT, f"{r['source']}_edit", str(r["id"]), "medium", title, detail, fix=fix,
                         link=f"#/entity/project/{r['entity_id']}?tab={'billing' if r['source'] == PAYMENT else 'assignment'}"
                         if r["entity_id"] else None,
                         sheet=r["sheet_value"], app=r["app_value"], ref=ref))
    return out
