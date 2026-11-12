"""Change alerts to PMs and owners.

Reads the change logs the app already keeps and turns the changes people care
about into notifications (notify.py), once each:

  project_schedule_item_history   dates, crews, PM, status (Assignments page, the
                                  nightly Job Schedule import, Project Setup)
  audit_log                       invoice schedule edits, crew-pay edits, change
                                  orders, closeout and crew-pay decisions

Who hears (2026-11-12): the project's PMs (users linked to a PM) and every
office user (page.assignment) by default; anyone can switch a kind off in their
notification settings, or "Change alerts for every project" off to hear only
about their own projects. Never the person who made the change.

Each run also (setup/reviews.py) turns the same changes into re-review items on
Project Setup, alerts everyone when a project goes back to setup (setup.review),
and keeps schedule-line statuses in step with the dates (projects/lifecycle.py). One run's changes are grouped into one alert
per project and kind. Routine automatic
moves (the nightly invoice re-dating and alignment) are not announced.

run() is cheap and guarded by a MySQL named lock, so it's called from the bell's
poll (at most once a minute per worker) instead of needing a scheduler.
"""
import json
import time
import zlib
from collections import defaultdict

from sqlalchemy import bindparam, text

from app.db import engine
from .notify import notify

WATCH_ALL = "watch.all_projects"   # notification_prefs kind: on by default for office users; in_app=0 = only my projects
_last = {"at": 0.0}
MIN_GAP = 60

FIELD_LABEL = {
    "start_date": "Start", "end_date": "End", "crews": "Crew", "project_managers": "PM", "status": "Status",
    "travel_days": "Travel days", "overage_days": "Overage days", "equipment_type": "Equipment", "non_working": "Days off",
}
# history field -> notification kind
FIELD_KIND = {"start_date": "change.dates", "end_date": "change.dates", "non_working": "change.dates",
              "crews": "change.crew", "project_managers": "change.crew", "status": "change.dates"}
AUDIT_KIND = {
    "billing.milestone_update": "change.billing", "billing.milestone_auto_dates": "change.billing",
    "crew_payment.update": "change.billing", "crew_payment.add": "change.billing", "crew_payment.delete": "change.billing",
    "change_order.create_from_pdf": "change.order", "change_order.update_from_pdf": "change.order",
    "change_order.create_full_quote": "change.order", "change_order.update": "change.order",
}


def _fmt(v):
    if v is None or v == "" or v == []:
        return "none"
    if isinstance(v, list):
        return ", ".join(str(x) for x in v) or "none"
    return str(v).replace("_", " ")


def _project_people(conn, cids=None, qbo_ids=None):
    """{qbo_id: (name, [pm user ids])} for projects by internal id or QBO id."""
    if cids:
        rows = conn.execute(text("SELECT id, qbo_id, display_name FROM qbo_customers WHERE id IN :i")
                            .bindparams(bindparam("i", expanding=True)), {"i": list(cids)}).all()
    elif qbo_ids:
        rows = conn.execute(text("SELECT id, qbo_id, display_name FROM qbo_customers WHERE qbo_id IN :i")
                            .bindparams(bindparam("i", expanding=True)), {"i": list(qbo_ids)}).all()
    else:
        return {}, {}
    by_cid = {r[0]: (str(r[1]), r[2]) for r in rows}
    pms = defaultdict(set)
    if by_cid:
        for cid, uid in conn.execute(text("""
            SELECT DISTINCT p.qbo_customer_id, u.id
            FROM projects p JOIN project_schedule_items s ON s.project_id = p.id
            JOIN project_schedule_item_project_managers spm ON spm.schedule_item_id = s.id AND spm.unassigned_at IS NULL
            JOIN users u ON u.project_manager_id = spm.project_manager_id AND u.is_active = 1
            WHERE p.qbo_customer_id IN :c""").bindparams(bindparam("c", expanding=True)), {"c": list(by_cid)}).all():
            pms[cid].add(uid)
    out = {q: (name, sorted(pms[cid])) for cid, (q, name) in by_cid.items()}
    return out, by_cid


def _schedule_history(conn, owners, start):
    rows = conn.execute(text("""
        SELECT h.id, h.changed_by_user_id AS by_uid, h.changed_at, h.changes, p.qbo_customer_id AS cid
        FROM project_schedule_item_history h
        JOIN project_schedule_items s ON s.id = h.schedule_item_id JOIN projects p ON p.id = s.project_id
        WHERE h.id > :w AND h.action = 'updated' ORDER BY h.id LIMIT 2000"""), {"w": start}).mappings().all()
    if not rows:
        return start, 0
    people, by_cid = _project_people(conn, cids={r["cid"] for r in rows})
    groups = {}   # (project, kind) -> {lines, ids, by}
    for r in rows:
        try:
            ch = json.loads(r["changes"]) if isinstance(r["changes"], str) else (r["changes"] or {})
        except ValueError:
            ch = {}
        q = by_cid.get(r["cid"])
        if not q:
            continue
        e, name = q
        for f, pair in ch.items():
            kind = FIELD_KIND.get(f)
            if not kind or not isinstance(pair, list) or len(pair) != 2:
                continue
            old, new = pair
            if f == "status" and new not in ("completed", "on_hold", "canceled"):
                continue   # not_started -> in_progress happens every day; not news
            g = groups.setdefault((e, kind), {"name": name, "lines": [], "ids": [], "by": set()})
            line = f"{FIELD_LABEL.get(f, f)}: {_fmt(old)} → {_fmt(new)}"
            if line not in g["lines"]:
                g["lines"].append(line)
            g["ids"].append(r["id"])
            g["by"].add(r["by_uid"])
    sent = 0
    for (e, kind), g in groups.items():
        pm_ids = people.get(e, (g["name"], []))[1]
        label = {"change.dates": "Dates changed", "change.crew": "Crew or PM changed"}[kind]
        if any(l.startswith("Status: ") and l.endswith("completed") for l in g["lines"]):
            label = "Job marked complete"
        who = "the Job Schedule (nightly import)" if g["by"] == {None} else "the app"
        rcpt = [u for u in set(pm_ids) | set(owners) if u not in g["by"]]
        sent += notify(rcpt, kind, f"{label}: {g['name']}", body="\n".join(g["lines"][:12]) + f"\nChanged in {who}.",
                       link=f"#/entity/project/{e}", subject=e, dedupe_key=f"{kind}:h{g['ids'][0]}-{g['ids'][-1]}")
    return rows[-1]["id"], sent


def _audit(conn, owners, start):
    rows = conn.execute(text("""
        SELECT id, actor_user_id, actor_email, action, target_label, detail FROM audit_log
        WHERE id > :w AND action IN :a ORDER BY id LIMIT 2000""").bindparams(bindparam("a", expanding=True)),
        {"w": start, "a": list(AUDIT_KIND)}).mappings().all()
    last = conn.execute(text("SELECT COALESCE(MAX(id), :w) FROM audit_log"), {"w": start}).scalar()
    if not rows:
        return last, 0
    dets = {}
    for r in rows:
        try:
            dets[r["id"]] = json.loads(r["detail"]) if isinstance(r["detail"], str) else (r["detail"] or {})
        except ValueError:
            dets[r["id"]] = {}
    ents = {str(d.get("entity_id") or d.get("project_qbo_id")) for d in dets.values() if d.get("entity_id") or d.get("project_qbo_id")}
    people, _ = _project_people(conn, qbo_ids=ents)
    sent = 0
    for r in rows:
        d = dets[r["id"]]
        e = str(d.get("entity_id") or d.get("project_qbo_id") or "")
        if not e or e not in people:
            continue
        name, pm_ids = people[e]
        kind = AUDIT_KIND[r["action"]]
        ch = d.get("changes") or {}
        lines = [f"{k.replace('_', ' ').capitalize()}: {_fmt(v[0])} → {_fmt(v[1])}" for k, v in ch.items() if isinstance(v, list) and len(v) == 2]
        if kind == "change.billing":
            what = "Invoice schedule changed" if r["action"].startswith("billing.") else "Crew pay schedule changed"
            if r["action"] == "crew_payment.add":
                what = "Crew payment added"
            elif r["action"] == "crew_payment.delete":
                what = "Crew payment removed"
        else:
            what = "Change order " + ("added" if "create" in r["action"] else "updated")
            if d.get("amount") is not None:
                lines.append(f"Amount: ${float(d['amount']):,.0f}")
        if r["target_label"]:
            lines.insert(0, str(r["target_label"]))
        rcpt = [u for u in set(pm_ids) | set(owners) if u != r["actor_user_id"]]
        tab = "changeorders" if kind == "change.order" else "billing"
        sent += notify(rcpt, kind, f"{what}: {name}", body="\n".join(lines) + f"\nBy {r['actor_email'] or 'the app'}.",
                       link=f"#/entity/project/{e}?tab={tab}", subject=e, dedupe_key=f"{kind}:a{r['id']}")
    return max(last, rows[-1]["id"]), sent


def office_users():
    """Every active office user (page.assignment), minus those who switched
    "Change alerts for every project" off."""
    from .notify import users_with_capability
    with engine.connect() as conn:
        off = {r[0] for r in conn.execute(text(
            "SELECT user_id FROM notification_prefs WHERE kind = :k AND in_app = 0"), {"k": WATCH_ALL}).all()}
    return [u for u in users_with_capability("page.assignment") if u not in off]


def _setup_reviews(office):
    """Changes -> re-review items on Project Setup, one alert per project."""
    from app.setup import reviews as RV
    from app.projects import lifecycle as LC
    try:
        with engine.begin() as conn:
            back = RV.process(conn)
            LC.sync_line_status(conn)
            names, emails = {}, {}
            if back:
                names = {str(q): n for q, n in conn.execute(text("SELECT qbo_id, display_name FROM qbo_customers WHERE qbo_id IN :e")
                                                             .bindparams(bindparam("e", expanding=True)), {"e": list(back)}).all()}
                emails = {str(em).lower(): uid for uid, em in conn.execute(text("SELECT id, email FROM users WHERE is_active = 1")).all() if em}
    except Exception:
        return 0
    sent = 0
    for e, why in back.items():
        lines = list(dict.fromkeys(why))
        text_all = " ".join(lines).lower()
        made_by = {uid for em, uid in emails.items() if em in text_all}     # never alert the person who made the change
        sent += notify([u for u in office if u not in made_by], "setup.review", f"Back to Project Setup: {names.get(e, e)}",
                       body="\n".join(lines[:10]) + "\nRe-check the steps it reopened on Project Setup.",
                       link=f"#/setup?job={e}", subject=e,
                       dedupe_key=f"setup.review:{e}:{zlib.crc32(chr(10).join(lines).encode())}")
    return sent


def run(force=False):
    """Announce new changes. Returns how many notifications were stored."""
    now = time.time()
    if not force and now - _last["at"] < MIN_GAP:
        return 0
    _last["at"] = now
    sent = 0
    with engine.connect() as lockc:
        got = lockc.execute(text("SELECT GET_LOCK('opi_change_watch', 0)")).scalar()
        if not got:
            return 0
        try:
            owners = office_users()
            with engine.begin() as conn:
                marks = dict(conn.execute(text("SELECT name, last_id FROM notification_watermark")).all())
            if not marks:
                return 0
            with engine.connect() as conn:
                h_last, n1 = _schedule_history(conn, owners, int(marks.get("schedule_history", 0)))
                a_last, n2 = _audit(conn, owners, int(marks.get("audit_log", 0)))
            with engine.begin() as conn:
                conn.execute(text("UPDATE notification_watermark SET last_id = :v WHERE name = 'schedule_history'"), {"v": h_last})
                conn.execute(text("UPDATE notification_watermark SET last_id = :v WHERE name = 'audit_log'"), {"v": a_last})
            sent = n1 + n2 + _setup_reviews(owners)
        finally:
            lockc.execute(text("SELECT RELEASE_LOCK('opi_change_watch')"))
    return sent
