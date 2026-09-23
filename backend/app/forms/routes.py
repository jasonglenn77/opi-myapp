"""
Crew field-forms engine (PM Portal Phase 2; C2 rework 2026-09-21).

Form DEFINITIONS live in form_templates (migrations 0052 + 0054) as JSON —
seven standardized forms seeded verbatim from the OPI Project Management doc:
kickoff_update, daily_update, completion, truck_unloading, truck_loading,
wire_guidance_trailer, gear_request. Per-project the PM controls:
  * toggles  — which optional daily sections apply ("jha", "anchoring",
               "wire_guidance"); base sections are toggle "always";
  * custom_questions — Jason's per-project additions, appended to that form's
               last section at serve time and marked {"custom": true};
  * forms map (0053/0054) — per form_code: required, cadence (one_time /
               daily / every_other_day / weekly / as_needed),
               exclude_weekdays (ints 0=Mon..6=Sun, Python weekday()),
               skipped_dates (ISO dates the PM excused), removed_questions
               (standard question keys hidden for this project — questions
               carrying a red_flag_on rule are refused).
All live in project_form_settings. Submissions carry report_date (0054) —
the day the answers are FOR (recurring forms can backfill a missed day);
the status engine (app/forms/status.py) keys on it.

Crews (passcode sessions, app/crewauth) or logged-in users fetch merged
templates, upload media straight into the project's existing S3 document tree
(so files appear in the Documents tab automatically) and submit answers.
Submissions land in form_submissions with a computed red_flag: any yes_no
question answered with its definition's red_flag_on value (existing damage YES,
work area clear NO, equipment down YES, layout changes YES, material shortages
YES) — or an explicit red_flag_reason from the crew. PMs review the queue
(page.pm_portal). Every write is audited (app/audit.py).
"""
import json
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy import text

from app.db import engine
from app.audit import record_audit
from app.auth import require_capability
from app.permissions import PAGE_PM_PORTAL
from app.crewauth.routes import get_user_or_crew, actor_for_audit, require_crew_project
from app.documents.routes import store_document_bytes
from app.forms.status import (
    CADENCES, CADENCE_INTERVAL, default_cadence, default_required, form_status,
)

router = APIRouter(prefix="/api/forms", tags=["forms"])

# Where each form's uploads are filed in the project's S3 document tree
# (keys from documents.routes.FOLDER_TREE — they show in the Documents tab).
FORM_UPLOAD_FOLDER = {
    "kickoff_update": "6_project_management/1_kickoff",
    "daily_update": "6_project_management/2_construction/2_active_pictures",
    "completion": "6_project_management/2_construction/6_project_completion",
    "truck_unloading": "6_project_management/2_construction/3_bols",
    "truck_loading": "6_project_management/2_construction/3_bols",
    "wire_guidance_trailer": "6_project_management/2_construction/2_active_pictures",
    "gear_request": "7_notes",   # no media questions today; custom Qs are text
}

TOGGLE_KEYS = ("jha", "anchoring", "wire_guidance")
DEFAULT_TOGGLES = {k: False for k in TOGGLE_KEYS}

MAX_UPLOAD_BYTES = 100 * 1024 * 1024   # same cap as /api/documents uploads
ALLOWED_CT_PREFIXES = ("image/", "video/")
ALLOWED_CT_EXACT = ("application/pdf",)


# ── helpers ─────────────────────────────────────────────────────────────────
def _project_meta(conn, project_qbo_id):
    return conn.execute(text(
        "SELECT qbo_id, display_name FROM qbo_customers WHERE qbo_id = :id"
    ), {"id": project_qbo_id}).mappings().first()


def _load_templates(conn):
    rows = conn.execute(text("""
        SELECT id, code, title, definition, sort_order
        FROM form_templates WHERE active = 1 ORDER BY sort_order, id
    """)).mappings().all()
    out = []
    for r in rows:
        d = r["definition"]
        out.append({"id": r["id"], "code": r["code"], "title": r["title"],
                    "definition": json.loads(d) if isinstance(d, (str, bytes)) else d})
    return out


def _load_settings(conn, project_qbo_id):
    row = conn.execute(text("""
        SELECT toggles, custom_questions, forms, updated_by_user_id, updated_at
        FROM project_form_settings WHERE project_qbo_id = :p
    """), {"p": project_qbo_id}).mappings().first()
    toggles = dict(DEFAULT_TOGGLES)
    custom = []
    forms = {}
    if row:
        try:
            t = row["toggles"]
            t = json.loads(t) if isinstance(t, (str, bytes)) else (t or {})
            for k in TOGGLE_KEYS:
                if k in t:
                    toggles[k] = bool(t[k])
        except Exception:
            pass
        try:
            c = row["custom_questions"]
            c = json.loads(c) if isinstance(c, (str, bytes)) else (c or [])
            custom = c if isinstance(c, list) else []
        except Exception:
            pass
        try:
            f = row["forms"]
            f = json.loads(f) if isinstance(f, (str, bytes)) else (f or {})
            forms = f if isinstance(f, dict) else {}
        except Exception:
            pass
    return toggles, custom, forms, row


def _forms_with_defaults(forms, codes):
    """Complete {form_code: {required, cadence, exclude_weekdays,
    skipped_dates, removed_questions}} map for every active form — stored
    overrides merged with the 0053/0054 defaults, so clients always see a
    full map. exclude_weekdays are ints 0=Mon..6=Sun (Python weekday())."""
    out = {}
    for code in codes:
        cfg = forms.get(code) if isinstance(forms.get(code), dict) else {}
        cadence = cfg.get("cadence")
        if cadence not in CADENCES:
            cadence = default_cadence(code)
        excl = cfg.get("exclude_weekdays")
        excl = sorted({int(w) for w in excl if isinstance(w, (int, float)) and 0 <= int(w) <= 6}) \
            if isinstance(excl, list) else []
        skips = cfg.get("skipped_dates")
        skips = sorted({s for s in skips if isinstance(s, str) and _iso_date(s)}) \
            if isinstance(skips, list) else []
        removed = cfg.get("removed_questions")
        removed = [k for k in removed if isinstance(k, str)] if isinstance(removed, list) else []
        out[code] = {"required": bool(cfg.get("required", default_required(code))),
                     "cadence": cadence, "exclude_weekdays": excl,
                     "skipped_dates": skips, "removed_questions": removed}
    return out


def _iso_date(s):
    try:
        return date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def _walk_questions(definition):
    """Yield every question in a definition, branch children included."""
    def walk(qs):
        for q in qs or []:
            yield q
            if isinstance(q.get("branches"), dict):
                yield from walk(q["branches"].get("yes"))
                yield from walk(q["branches"].get("no"))
    for sec in (definition or {}).get("sections", []):
        yield from walk(sec.get("questions"))


def _red_flag_keys(definition):
    return {q.get("key") for q in _walk_questions(definition)
            if q.get("red_flag_on") in ("yes", "no")}


def _strip_removed(definition, removed):
    """Drop removed question keys from a definition IN PLACE (sections and
    branch children). Red-flag carriers never land in removed_questions —
    the PUT refuses them — so this is a plain filter."""
    if not removed:
        return definition
    gone = set(removed)

    def prune(qs):
        kept = []
        for q in qs or []:
            if q.get("key") in gone:
                continue
            if isinstance(q.get("branches"), dict):
                q["branches"] = {"yes": prune(q["branches"].get("yes")),
                                 "no": prune(q["branches"].get("no"))}
            kept.append(q)
        return kept

    for sec in (definition or {}).get("sections", []):
        sec["questions"] = prune(sec.get("questions"))
    return definition


def _normalize_custom(entry, idx):
    """A custom_questions entry is {form_code, question} where question is a
    plain label string or a question object. Normalize to a question object
    marked custom (default type: text)."""
    q = entry.get("question")
    if isinstance(q, str):
        q = {"label": q, "type": "text"}
    elif isinstance(q, dict):
        q = dict(q)
    else:
        return None
    q.setdefault("type", "text")
    q.setdefault("key", f"custom_{idx}")
    q["custom"] = True
    return q


def _merged_templates(conn, project_qbo_id):
    """Templates with the project's toggles applied (each section gains
    "enabled"), removed_questions stripped (crew + preview never see them),
    custom questions appended to their form's last section, and the per-form
    settings stamped on each template (required, cadence, exclude_weekdays,
    skipped_dates, off_today — a required=false form is STILL returned,
    marked so the crew UI can de-emphasize it)."""
    templates = _load_templates(conn)
    toggles, custom, forms, _ = _load_settings(conn, project_qbo_id)
    forms_full = _forms_with_defaults(forms, [t["code"] for t in templates])
    for t in templates:
        _strip_removed(t["definition"], forms_full[t["code"]]["removed_questions"])
    for i, entry in enumerate(custom, start=1):
        if not isinstance(entry, dict):
            continue
        code = entry.get("form_code")
        q = _normalize_custom(entry, i)
        if not q:
            continue
        for t in templates:
            if t["code"] == code and t["definition"].get("sections"):
                secs = t["definition"]["sections"]
                # Optional section_key places the question at that section's
                # end (the C2 editor's "+ Add question"); default: last section.
                target = next((s for s in secs if s.get("key") == entry.get("section_key")),
                              secs[-1])
                target.setdefault("questions", []).append(q)
                break
    today = date.today()
    for t in templates:
        for sec in t["definition"].get("sections", []):
            tg = sec.get("toggle", "always")
            sec["enabled"] = True if tg == "always" else bool(toggles.get(tg))
        cfg = forms_full[t["code"]]
        t["required"] = cfg["required"]
        t["cadence"] = cfg["cadence"]
        t["exclude_weekdays"] = cfg["exclude_weekdays"]
        t["skipped_dates"] = cfg["skipped_dates"]
        t["removed_questions"] = cfg["removed_questions"]
        # Crew card hint "off day today" (server-local date, same convention
        # as the status engine). Only meaningful for recurring cadences.
        t["off_today"] = (t["cadence"] in CADENCE_INTERVAL
                          and (today.weekday() in cfg["exclude_weekdays"]
                               or today.isoformat() in cfg["skipped_dates"]))
    return templates, toggles


def form_status_rows(conn, project_qbo_id, project_status=None):
    """Per-form tracking rows for one project — the SAME rows the PM Overview
    tracking list and GET /api/forms/status serve: merged template + settings
    (required, cadence, day exclusions), submission stats, and the
    status-engine verdict incl. {expected_so_far, filled} progress counts
    (app/forms/status.py). project_status may be passed in when the caller
    already computed the canonical status (pm overview does).
    Returns (rows, project_status, window) — window = {start_date, end_date}."""
    from app.billing.routes import _canonical_status  # local: avoids import cycle

    if project_status is None:
        project_status = _canonical_status(conn, project_qbo_id)

    win = conn.execute(text("""
        SELECT MIN(psi.start_date) AS start_date, MAX(psi.end_date) AS end_date
        FROM projects p
        JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
        JOIN project_schedule_items psi ON psi.project_id = p.id
        WHERE qc.qbo_id = :e
    """), {"e": project_qbo_id}).mappings().first() or {}

    # One pass over this project's submissions: REPORT dates for the status
    # engine (report_date = the day the answers are for, 0054; falls back to
    # server-local DATE(submitted_at)) + the review stats the tracking list
    # already showed.
    subs = conn.execute(text("""
        SELECT form_code,
               COALESCE(report_date, DATE(submitted_at)) AS sub_date,
               submitted_at, status, red_flag
        FROM form_submissions WHERE project_qbo_id = :e
    """), {"e": project_qbo_id}).mappings().all()
    by_form = {}
    for s in subs:
        b = by_form.setdefault(s["form_code"], {
            "dates": [], "n": 0, "last_at": None, "needs_review": 0, "red_flags": 0})
        b["dates"].append(s["sub_date"])
        b["n"] += 1
        if b["last_at"] is None or s["submitted_at"] > b["last_at"]:
            b["last_at"] = s["submitted_at"]
        if s["status"] == "submitted":
            b["needs_review"] += 1
            if s["red_flag"]:
                b["red_flags"] += 1

    templates, _toggles = _merged_templates(conn, project_qbo_id)
    rows = []
    for t in templates:
        # applicable = at least one enabled section (today: all three templates)
        if not any(sec.get("enabled") for sec in t["definition"].get("sections", [])):
            continue
        b = by_form.get(t["code"]) or {}
        verdict = form_status(
            form_code=t["code"], required=t["required"], cadence=t["cadence"],
            project_status=project_status,
            window_start=win.get("start_date"), window_end=win.get("end_date"),
            submission_dates=b.get("dates") or [],
            exclude_weekdays=t["exclude_weekdays"],
            skipped_dates=t["skipped_dates"])
        rows.append({
            "form_code": t["code"], "title": t["title"],
            "required": t["required"], "cadence": t["cadence"],
            "exclude_weekdays": t["exclude_weekdays"],
            "skipped_dates": t["skipped_dates"],
            "status": verdict["status"], "overdue_days": verdict["overdue_days"],
            "expected_so_far": verdict["expected_so_far"],
            "filled": verdict["filled"],
            "submissions_count": int(b.get("n") or 0),
            "last_submitted_at": str(b["last_at"]) if b.get("last_at") else None,
            "needs_review_count": int(b.get("needs_review") or 0),
            "red_flags": int(b.get("red_flags") or 0),
        })
    window = {"start_date": str(win["start_date"]) if win.get("start_date") else None,
              "end_date": str(win["end_date"]) if win.get("end_date") else None}
    return rows, project_status, window


def _is_yes(value):
    return str(value).strip().lower() in ("yes", "true", "1", "y")


def _compute_red_flags(definition, answers):
    """Labels of yes_no questions whose answer matches their red_flag_on value."""
    flags = []
    for sec in (definition or {}).get("sections", []):
        for q in sec.get("questions", []):
            trigger = q.get("red_flag_on")
            if q.get("type") != "yes_no" or trigger not in ("yes", "no"):
                continue
            if q.get("key") not in (answers or {}):
                continue
            answered_yes = _is_yes(answers[q["key"]])
            if (trigger == "yes") == answered_yes:
                flags.append(q.get("label") or q.get("key"))
    return flags


def _submission_row(r):
    ctx, ans = r.get("crew_context"), r.get("answers")
    try:
        ctx = json.loads(ctx) if isinstance(ctx, (str, bytes)) else ctx
    except Exception:
        pass
    try:
        ans = json.loads(ans) if isinstance(ans, (str, bytes)) else ans
    except Exception:
        pass
    return ctx, ans


# ── templates + per-project settings ────────────────────────────────────────
@router.get("/templates")
def get_templates(project_qbo_id: Optional[str] = Query(default=None),
                  actor=Depends(get_user_or_crew)):
    """Active form templates. With ?project_qbo_id=X they are MERGED with that
    project's PM toggles (sections gain "enabled") and custom questions
    (appended to the form's last section, marked {"custom": true}).
    Each template also carries the per-form settings (required, cadence,
    exclude_weekdays [0=Mon..6=Sun], skipped_dates, removed_questions already
    stripped from the definition, off_today) and, in project mode, the status
    engine's verdict (status, overdue_days, expected_so_far, filled,
    submissions_count) so the crew UI can hint "done today" / "due today" /
    "N submitted". The project block carries the schedule window for the
    crew's "for date" backfill picker. A required=false form is still
    returned, marked so the crew UI can de-emphasize it. Accepts a logged-in
    user OR a crew session token."""
    with engine.connect() as conn:
        if project_qbo_id:
            meta = _project_meta(conn, project_qbo_id)
            if not meta:
                raise HTTPException(status_code=404, detail="Project not found")
            # Crew tokens only see projects assigned to their crew (read is OK
            # on a past project — its forms render view-only client-side).
            require_crew_project(conn, actor, project_qbo_id)
            templates, toggles = _merged_templates(conn, project_qbo_id)
            status_rows, _st, window = form_status_rows(conn, project_qbo_id)
            by_code = {r["form_code"]: r for r in status_rows}
            for t in templates:
                r = by_code.get(t["code"])
                t["status"] = r["status"] if r else None
                t["overdue_days"] = r["overdue_days"] if r else 0
                t["expected_so_far"] = r["expected_so_far"] if r else None
                t["filled"] = r["filled"] if r else None
                t["submissions_count"] = r["submissions_count"] if r else 0
            return {"project": {"qbo_id": str(meta["qbo_id"]), "name": meta["display_name"],
                                "start_date": window["start_date"],
                                "end_date": window["end_date"]},
                    "toggles": toggles, "templates": templates}
        templates = _load_templates(conn)
        for t in templates:
            for sec in t["definition"].get("sections", []):
                sec["enabled"] = sec.get("toggle", "always") == "always"
            t["required"] = default_required(t["code"])
            t["cadence"] = default_cadence(t["code"])
            t["exclude_weekdays"] = []
            t["skipped_dates"] = []
            t["removed_questions"] = []
            t["off_today"] = False
        return {"project": None, "toggles": dict(DEFAULT_TOGGLES), "templates": templates}


class ProjectFormSettings(BaseModel):
    toggles: Optional[dict] = None            # {"jha": bool, "anchoring": bool, "wire_guidance": bool}
    custom_questions: Optional[list] = None   # [{form_code, question(str|obj)}]
    # forms: {form_code: {"required": bool, "cadence": str,
    #         "exclude_weekdays": [0=Mon..6=Sun], "skipped_dates": ["YYYY-MM-DD"],
    #         "removed_questions": [question keys]}} — all keys optional/partial
    forms: Optional[dict] = None


@router.get("/project-settings/{project_qbo_id}")
def get_project_settings(project_qbo_id: str,
                         user=Depends(require_capability(PAGE_PM_PORTAL))):
    with engine.connect() as conn:
        if not _project_meta(conn, project_qbo_id):
            raise HTTPException(status_code=404, detail="Project not found")
        toggles, custom, forms, row = _load_settings(conn, project_qbo_id)
        codes = [t["code"] for t in _load_templates(conn)]
    return {"project_qbo_id": project_qbo_id, "toggles": toggles,
            "custom_questions": custom,
            "forms": _forms_with_defaults(forms, codes),
            "updated_at": str(row["updated_at"]) if row and row["updated_at"] else None}


@router.put("/project-settings/{project_qbo_id}")
def put_project_settings(project_qbo_id: str, body: ProjectFormSettings,
                         user=Depends(require_capability(PAGE_PM_PORTAL))):
    """PM per-project form controls: section toggles, custom questions, and
    per-form requirement + cadence + day exclusions + removed questions
    (migrations 0053/0054)."""
    with engine.connect() as conn:
        if not _project_meta(conn, project_qbo_id):
            raise HTTPException(status_code=404, detail="Project not found")
        old_toggles, old_custom, old_forms, _ = _load_settings(conn, project_qbo_id)
        templates = _load_templates(conn)
        valid_codes = {t["code"] for t in templates}
        tpl_by_code = {t["code"]: t for t in templates}

    new_toggles = dict(old_toggles)
    if body.toggles is not None:
        for k, v in body.toggles.items():
            if k not in TOGGLE_KEYS:
                raise HTTPException(status_code=400, detail=f"Unknown toggle: {k}")
            new_toggles[k] = bool(v)

    new_custom = old_custom
    if body.custom_questions is not None:
        cleaned = []
        for entry in body.custom_questions:
            if not isinstance(entry, dict) or entry.get("form_code") not in valid_codes:
                raise HTTPException(status_code=400,
                                    detail="Each custom question needs a valid form_code")
            if not entry.get("question"):
                raise HTTPException(status_code=400, detail="Each custom question needs a question")
            item = {"form_code": entry["form_code"], "question": entry["question"]}
            sk = entry.get("section_key")
            if isinstance(sk, str) and sk:
                item["section_key"] = sk
            cleaned.append(item)
        new_custom = cleaned

    new_forms = dict(old_forms)
    if body.forms is not None:
        for code, cfg in body.forms.items():
            if code not in valid_codes:
                raise HTTPException(status_code=400, detail=f"Unknown form_code: {code}")
            if not isinstance(cfg, dict):
                raise HTTPException(status_code=400,
                                    detail=f"forms[{code}] must be an object")
            cur = dict(new_forms.get(code) or {})
            if "required" in cfg:
                cur["required"] = bool(cfg["required"])
            if "cadence" in cfg:
                if cfg["cadence"] not in CADENCES:
                    raise HTTPException(status_code=400,
                                        detail=f"cadence must be one of {', '.join(CADENCES)}")
                cur["cadence"] = cfg["cadence"]
            if "exclude_weekdays" in cfg:
                wd = cfg["exclude_weekdays"]
                if (not isinstance(wd, list)
                        or any(not isinstance(w, int) or isinstance(w, bool)
                               or w < 0 or w > 6 for w in wd)):
                    raise HTTPException(status_code=400, detail=(
                        f"forms[{code}].exclude_weekdays must be a list of ints "
                        "0-6 (0=Monday .. 6=Sunday)"))
                cur["exclude_weekdays"] = sorted(set(wd))
            if "skipped_dates" in cfg:
                sd = cfg["skipped_dates"]
                if not isinstance(sd, list) or any(
                        not isinstance(s, str) or not _iso_date(s) for s in sd):
                    raise HTTPException(status_code=400, detail=(
                        f"forms[{code}].skipped_dates must be a list of "
                        "YYYY-MM-DD dates"))
                cur["skipped_dates"] = sorted({_iso_date(s).isoformat() for s in sd})
            if "removed_questions" in cfg:
                rq = cfg["removed_questions"]
                if not isinstance(rq, list) or any(not isinstance(k, str) for k in rq):
                    raise HTTPException(status_code=400, detail=(
                        f"forms[{code}].removed_questions must be a list of "
                        "question keys"))
                defn = tpl_by_code[code]["definition"]
                all_keys = {q.get("key") for q in _walk_questions(defn)}
                flag_keys = _red_flag_keys(defn)
                unknown = sorted(set(rq) - all_keys)
                if unknown:
                    raise HTTPException(status_code=400, detail=(
                        f"forms[{code}].removed_questions: not questions of this "
                        f"form: {', '.join(unknown)}"))
                flagged = sorted(set(rq) & flag_keys)
                if flagged:
                    raise HTTPException(status_code=400, detail=(
                        f"forms[{code}].removed_questions: these questions raise "
                        f"red flags and cannot be removed: {', '.join(flagged)}"))
                cur["removed_questions"] = sorted(set(rq))
            new_forms[code] = cur

    with engine.begin() as conn:
        conn.execute(text("""
            INSERT INTO project_form_settings (project_qbo_id, toggles, custom_questions, forms, updated_by_user_id)
            VALUES (:p, :t, :c, :f, :u)
            ON DUPLICATE KEY UPDATE toggles = VALUES(toggles),
                custom_questions = VALUES(custom_questions),
                forms = VALUES(forms),
                updated_by_user_id = VALUES(updated_by_user_id)
        """), {"p": project_qbo_id, "t": json.dumps(new_toggles),
               "c": json.dumps(new_custom), "f": json.dumps(new_forms),
               "u": user.get("id")})

    changes = {}
    if new_toggles != old_toggles:
        changes["toggles"] = [old_toggles, new_toggles]
    if new_custom != old_custom:
        changes["custom_questions"] = [len(old_custom), len(new_custom)]
    if new_forms != old_forms:
        changes["forms"] = [old_forms, new_forms]
    record_audit(user, "form.settings_update", "project", project_qbo_id, None,
                 {"changes": changes})
    return {"ok": True, "toggles": new_toggles, "custom_questions": new_custom,
            "forms": _forms_with_defaults(new_forms, sorted(valid_codes))}


@router.get("/status")
def project_form_status(project_qbo_id: str = Query(...),
                        user=Depends(require_capability(PAGE_PM_PORTAL))):
    """Per-form tracking status for one project — the same rows the PM
    Overview's tracking list carries: required, cadence, day exclusions, the
    status engine's verdict (done / due / due_today / done_today / overdue /
    not_required / upcoming / pending / as_needed + overdue_days), the
    {expected_so_far, filled} progress counts and submission/review stats."""
    with engine.connect() as conn:
        if not _project_meta(conn, project_qbo_id):
            raise HTTPException(status_code=404, detail="Project not found")
        rows, project_status, window = form_status_rows(conn, project_qbo_id)
    return {"project_qbo_id": str(project_qbo_id),
            "project_status": project_status, "window": window, "forms": rows}


# ── media upload (into the project's Documents tree) ────────────────────────
@router.post("/upload")
async def upload_form_media(project_qbo_id: str = Query(...), form_code: str = Query(...),
                            file: UploadFile = File(...), actor=Depends(get_user_or_crew)):
    """Store a form photo/video/PDF through the SAME S3 + documents-table path
    the Documents tab uses, filed in the form's project folder. Returns the
    document id to reference from the submission's answers JSON."""
    folder = FORM_UPLOAD_FOLDER.get(form_code)
    if not folder:
        raise HTTPException(status_code=400, detail="Unknown form_code")
    ct = (file.content_type or "").lower()
    if not (ct.startswith(ALLOWED_CT_PREFIXES) or ct in ALLOWED_CT_EXACT):
        raise HTTPException(status_code=400, detail="Only images, videos and PDFs are allowed")
    body = await file.read()
    if len(body) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="File exceeds 100 MB limit")
    with engine.connect() as conn:
        if not _project_meta(conn, project_qbo_id):
            raise HTTPException(status_code=404, detail="Project not found")
        # Crew scoping: assigned projects only; completed projects read-only.
        require_crew_project(conn, actor, project_qbo_id, write=True)

    uploader_id = actor["user"].get("id") if actor.get("kind") == "user" else None
    doc_id = store_document_bytes("project", project_qbo_id, folder,
                                  file.filename or "upload", body,
                                  content_type=ct or "application/octet-stream",
                                  user_id=uploader_id)
    record_audit(actor_for_audit(actor), "form.upload", "document", doc_id, file.filename,
                 {"project_qbo_id": project_qbo_id, "form_code": form_code,
                  "folder": folder, "size_bytes": len(body)})
    return {"ok": True, "document_id": doc_id, "folder": folder, "filename": file.filename}


# ── submissions ─────────────────────────────────────────────────────────────
class FormSubmit(BaseModel):
    project_qbo_id: str
    form_code: str
    answers: dict
    red_flag_reason: Optional[str] = None
    report_date: Optional[str] = None   # YYYY-MM-DD — the day the answers are
                                        # FOR (recurring forms backfill missed
                                        # days); defaults to today


@router.post("/submit")
def submit_form(body: FormSubmit, actor=Depends(get_user_or_crew)):
    """Record a form submission (crew session OR logged-in user). red_flag is
    computed from the template's red_flag_on markers, or forced by an explicit
    red_flag_reason from the submitter. report_date (optional, recurring
    forms) must fall inside the project window and not in the future."""
    with engine.connect() as conn:
        meta = _project_meta(conn, body.project_qbo_id)
        if not meta:
            raise HTTPException(status_code=404, detail="Project not found")
        # Crew scoping: assigned projects only; completed projects read-only.
        require_crew_project(conn, actor, body.project_qbo_id, write=True)
        tpl = next((t for t in _load_templates(conn) if t["code"] == body.form_code), None)
        if not tpl:
            raise HTTPException(status_code=400, detail="Unknown form_code")

        report_date = date.today()
        if body.report_date:
            rd = _iso_date(body.report_date)
            if not rd:
                raise HTTPException(status_code=400,
                                    detail="report_date must be YYYY-MM-DD")
            if rd > date.today():
                raise HTTPException(status_code=400,
                                    detail="report_date cannot be in the future")
            win = conn.execute(text("""
                SELECT MIN(psi.start_date) AS start_date
                FROM projects p
                JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
                JOIN project_schedule_items psi ON psi.project_id = p.id
                WHERE qc.qbo_id = :e
            """), {"e": body.project_qbo_id}).mappings().first() or {}
            ws = win.get("start_date")
            if ws and rd < ws:
                raise HTTPException(status_code=400, detail=(
                    f"report_date is before the project start ({ws})"))
            report_date = rd

        # crew_context: crews record as themselves; a USER token (PM view /
        # office) records ON BEHALF of the project's assigned crew —
        # {"kind":"user", on_behalf:true, user:<name/email>, crew:<crew names>}
        # (same shape receipts.submitted_by uses; crew-token behavior unchanged).
        from app.receipts.routes import submitted_by_context
        crew_context = submitted_by_context(conn, actor, body.project_qbo_id)

    flags = _compute_red_flags(tpl["definition"], body.answers or {})
    explicit = (body.red_flag_reason or "").strip() or None
    red_flag = bool(flags or explicit)
    reason_parts = list(flags)
    if explicit:
        reason_parts.append(explicit)
    reason = ("; ".join(reason_parts))[:500] if reason_parts else None

    with engine.begin() as conn:
        sub_id = conn.execute(text("""
            INSERT INTO form_submissions
                (project_qbo_id, form_code, crew_context, answers, report_date,
                 red_flag, red_flag_reason)
            VALUES (:p, :f, :ctx, :ans, :rd, :rf, :rr)
        """), {"p": body.project_qbo_id, "f": body.form_code,
               "ctx": json.dumps(crew_context), "ans": json.dumps(body.answers or {}),
               "rd": report_date.isoformat(),
               "rf": 1 if red_flag else 0, "rr": reason}).lastrowid

    record_audit(actor_for_audit(actor), "form.submit", "form_submission", sub_id,
                 f"{body.form_code} @ {meta['display_name']}",
                 {"project_qbo_id": body.project_qbo_id, "form_code": body.form_code,
                  "report_date": report_date.isoformat(),
                  "red_flag": red_flag, "red_flag_reason": reason,
                  "answer_count": len(body.answers or {})})
    return {"ok": True, "id": sub_id, "red_flag": red_flag,
            "red_flag_reason": reason, "report_date": report_date.isoformat()}


def _pm_scope_sql():
    """QBO ids of projects actively assigned to :pm (same chain pm/routes.py uses)."""
    return """
        SELECT DISTINCT qc.qbo_id
        FROM projects p
        JOIN project_schedule_items psi ON psi.project_id = p.id
        JOIN project_schedule_item_project_managers spm ON spm.schedule_item_id = psi.id
        JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
        WHERE spm.project_manager_id = :pm AND spm.unassigned_at IS NULL
    """


@router.get("/submissions")
def list_submissions(project_qbo_id: Optional[str] = None, form_code: Optional[str] = None,
                     status: Optional[str] = None, limit: int = 100,
                     user=Depends(require_capability(PAGE_PM_PORTAL))):
    limit = max(1, min(int(limit or 100), 500))
    where, params = ["1=1"], {"lim": limit}
    if project_qbo_id:
        where.append("s.project_qbo_id = :p"); params["p"] = project_qbo_id
    if form_code:
        where.append("s.form_code = :f"); params["f"] = form_code
    if status:
        if status not in ("submitted", "reviewed"):
            raise HTTPException(status_code=400, detail="status must be submitted or reviewed")
        where.append("s.status = :st"); params["st"] = status
    with engine.connect() as conn:
        rows = conn.execute(text(f"""
            SELECT s.id, s.project_qbo_id, qc.display_name AS project_name, s.form_code,
                   s.crew_context, s.red_flag, s.red_flag_reason, s.status, s.submitted_at,
                   s.report_date, s.reviewed_at,
                   TRIM(CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,''))) AS reviewed_by
            FROM form_submissions s
            LEFT JOIN qbo_customers qc ON qc.qbo_id = s.project_qbo_id
            LEFT JOIN users u ON u.id = s.reviewed_by_user_id
            WHERE {' AND '.join(where)}
            ORDER BY s.submitted_at DESC, s.id DESC
            LIMIT :lim
        """), params).mappings().all()
    items = []
    for r in rows:
        ctx, _ = _submission_row(dict(r))
        items.append({
            "id": r["id"], "project_qbo_id": r["project_qbo_id"],
            "project_name": r["project_name"], "form_code": r["form_code"],
            "crew_context": ctx, "red_flag": bool(r["red_flag"]),
            "red_flag_reason": r["red_flag_reason"], "status": r["status"],
            "submitted_at": str(r["submitted_at"]) if r["submitted_at"] else None,
            "report_date": str(r["report_date"]) if r["report_date"] else None,
            "reviewed_by": (r["reviewed_by"] or "").strip() or None,
            "reviewed_at": str(r["reviewed_at"]) if r["reviewed_at"] else None,
        })
    return {"submissions": items}


@router.get("/queue")
def review_queue(all: int = 0, user=Depends(require_capability(PAGE_PM_PORTAL))):
    """The PM review queue: unreviewed submissions across the logged-in PM's
    projects (?all=1 for every project) + red-flag count."""
    pm_id = user.get("project_manager_id") or -1
    show_all = bool(all)
    scope_clause = "" if show_all else f" AND s.project_qbo_id IN ({_pm_scope_sql()})"
    with engine.connect() as conn:
        rows = conn.execute(text(f"""
            SELECT s.id, s.project_qbo_id, qc.display_name AS project_name, s.form_code,
                   s.crew_context, s.red_flag, s.red_flag_reason, s.submitted_at
            FROM form_submissions s
            LEFT JOIN qbo_customers qc ON qc.qbo_id = s.project_qbo_id
            WHERE s.status = 'submitted'{scope_clause}
            ORDER BY s.red_flag DESC, s.submitted_at DESC, s.id DESC
            LIMIT 500
        """), {"pm": pm_id}).mappings().all()
    items = []
    for r in rows:
        ctx, _ = _submission_row(dict(r))
        items.append({
            "id": r["id"], "project_qbo_id": r["project_qbo_id"],
            "project_name": r["project_name"], "form_code": r["form_code"],
            "crew_context": ctx, "red_flag": bool(r["red_flag"]),
            "red_flag_reason": r["red_flag_reason"],
            "submitted_at": str(r["submitted_at"]) if r["submitted_at"] else None,
        })
    return {"scope": "all" if show_all else "mine", "items": items,
            "counts": {"unreviewed": len(items),
                       "red_flags": sum(1 for i in items if i["red_flag"])}}


@router.get("/submissions/{submission_id}")
def submission_detail(submission_id: int, user=Depends(require_capability(PAGE_PM_PORTAL))):
    with engine.connect() as conn:
        r = conn.execute(text("""
            SELECT s.*, qc.display_name AS project_name,
                   TRIM(CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,''))) AS reviewed_by
            FROM form_submissions s
            LEFT JOIN qbo_customers qc ON qc.qbo_id = s.project_qbo_id
            LEFT JOIN users u ON u.id = s.reviewed_by_user_id
            WHERE s.id = :id
        """), {"id": submission_id}).mappings().first()
    if not r:
        raise HTTPException(status_code=404, detail="Submission not found")
    ctx, ans = _submission_row(dict(r))
    return {
        "id": r["id"], "project_qbo_id": r["project_qbo_id"],
        "project_name": r["project_name"], "form_code": r["form_code"],
        "crew_context": ctx, "answers": ans, "red_flag": bool(r["red_flag"]),
        "red_flag_reason": r["red_flag_reason"], "status": r["status"],
        "submitted_at": str(r["submitted_at"]) if r["submitted_at"] else None,
        "report_date": str(r["report_date"]) if r["report_date"] else None,
        "reviewed_by": (r["reviewed_by"] or "").strip() or None,
        "reviewed_at": str(r["reviewed_at"]) if r["reviewed_at"] else None,
    }


@router.patch("/submissions/{submission_id}/review")
def review_submission(submission_id: int, user=Depends(require_capability(PAGE_PM_PORTAL))):
    with engine.begin() as conn:
        r = conn.execute(text("""
            SELECT id, project_qbo_id, form_code, status FROM form_submissions WHERE id = :id
        """), {"id": submission_id}).mappings().first()
        if not r:
            raise HTTPException(status_code=404, detail="Submission not found")
        conn.execute(text("""
            UPDATE form_submissions
            SET status = 'reviewed', reviewed_by_user_id = :u, reviewed_at = NOW()
            WHERE id = :id
        """), {"id": submission_id, "u": user.get("id")})
    record_audit(user, "form.review", "form_submission", submission_id,
                 f"{r['form_code']} @ {r['project_qbo_id']}",
                 {"previous_status": r["status"]})
    return {"ok": True, "id": submission_id, "status": "reviewed"}
