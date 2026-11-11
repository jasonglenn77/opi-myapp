"""
Help, tours, feedback, what's new, and the notification bell.

  Tours
  GET  /api/help/tours                     which tours I've finished / skipped
  POST /api/help/tours/{key}               {status: done|skipped|null}

  Feedback (anyone signed in sends; staff with users.manage triage)
  POST  /api/help/feedback                 {kind, message, page, page_title, browser, viewport}
  GET   /api/help/feedback/mine            what I've sent, with replies
  GET   /api/help/feedback?status=         staff: everything
  PATCH /api/help/feedback/{id}            staff: {status, staff_note, reply}

  What's new
  GET    /api/help/whats-new               published notes I haven't seen
  POST   /api/help/whats-new/{id}          {action: seen|skipped|later}
  GET    /api/help/notes                   staff: every note, with how many have seen it
  POST   /api/help/notes                   staff: create
  PATCH  /api/help/notes/{id}              staff: edit / publish / unpublish
  DELETE /api/help/notes/{id}              staff: delete a draft

  Notifications
  GET  /api/notifications?unread=1&limit=  my notifications + unread count
  POST /api/notifications/{id}/read
  POST /api/notifications/read-all
  GET  /api/notifications/prefs            my per-kind settings
  PUT  /api/notifications/prefs            [{kind, in_app, email}]
"""
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from app import mailer
from app.audit import record_audit
from app.auth import get_current_user, require_capability
from app.db import engine
from .notify import notify, users_with_capability

router = APIRouter(prefix="/api/help", tags=["help"])
notif_router = APIRouter(prefix="/api/notifications", tags=["notifications"])
STAFF = "users.manage"

KINDS = ("bug", "idea", "question")
FB_STATUSES = ("new", "in_progress", "answered", "closed")

# Notification kinds a person can switch on/off (label shown on the settings card).
NOTIFICATION_KINDS = [
    ("watch.all_projects", "Change alerts for every project, not only mine (owners)"),
    ("feedback.reply", "Replies to my feedback"),
    ("feedback.new", "New feedback sent (staff)"),
    ("change.dates", "Project dates changed"),
    ("change.crew", "Crew or PM changed on a project"),
    ("change.order", "Change orders added or approved"),
    ("change.billing", "Invoice or crew-pay schedule changed"),
    ("schedule.overdue", "Invoices or crew pay overdue"),
    ("closeout.ready", "Jobs ready to close out"),
]


def _iso(v):
    return v.isoformat() if isinstance(v, datetime) else v


def _row(r):
    return {k: _iso(v) for k, v in dict(r).items()}


# ---------------------------------------------------------------- tours
@router.get("/tours")
def my_tours(user=Depends(get_current_user)):
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT tour_key, status FROM help_tour_progress WHERE user_id = :u"),
                            {"u": user["id"]}).all()
    return {"tours": {r[0]: r[1] for r in rows}}


class TourIn(BaseModel):
    status: Optional[str] = None


@router.post("/tours/{key:path}")
def mark_tour(key: str, body: TourIn, user=Depends(get_current_user)):
    with engine.begin() as conn:
        if body.status in ("done", "skipped"):
            conn.execute(text(
                "INSERT INTO help_tour_progress (user_id, tour_key, status) VALUES (:u, :k, :s) "
                "ON DUPLICATE KEY UPDATE status = VALUES(status), at = NOW()"
            ), {"u": user["id"], "k": key[:60], "s": body.status})
        else:
            conn.execute(text("DELETE FROM help_tour_progress WHERE user_id = :u AND tour_key = :k"),
                         {"u": user["id"], "k": key[:60]})
    return {"ok": True}


# ---------------------------------------------------------------- feedback
class FeedbackIn(BaseModel):
    kind: str
    message: str
    page: Optional[str] = None
    page_title: Optional[str] = None
    browser: Optional[str] = None
    viewport: Optional[str] = None


@router.post("/feedback")
def send_feedback(body: FeedbackIn, user=Depends(get_current_user)):
    kind = body.kind if body.kind in KINDS else "question"
    msg = (body.message or "").strip()
    if not msg:
        raise HTTPException(400, "Write a message first.")
    with engine.begin() as conn:
        res = conn.execute(text(
            "INSERT INTO feedback (user_id, user_email, kind, message, page, page_title, browser, viewport) "
            "VALUES (:u, :e, :k, :m, :p, :pt, :b, :v)"
        ), {"u": user["id"], "e": user["email"], "k": kind, "m": msg[:8000], "p": (body.page or "")[:255],
            "pt": (body.page_title or "")[:255], "b": (body.browser or "")[:500], "v": (body.viewport or "")[:40]})
        fid = res.lastrowid
    label = {"bug": "Bug report", "idea": "Idea", "question": "Question"}[kind]
    staff = [u for u in users_with_capability(STAFF) if u != user["id"]]
    notify(staff, "feedback.new", f"{label} from {user['email']}", body=msg[:300],
           link="#/help-admin", subject=f"feedback:{fid}", dedupe_key=f"feedback.new:{fid}")
    return {"ok": True, "id": fid}


@router.get("/feedback/mine")
def my_feedback(user=Depends(get_current_user)):
    with engine.connect() as conn:
        rows = conn.execute(text(
            "SELECT id, kind, message, page, page_title, status, reply, replied_at, replied_by, created_at "
            "FROM feedback WHERE user_id = :u ORDER BY created_at DESC LIMIT 200"
        ), {"u": user["id"]}).mappings().all()
    return {"items": [_row(r) for r in rows]}


@router.get("/feedback")
def all_feedback(status: Optional[str] = None, user=Depends(require_capability(STAFF))):
    where, params = "", {}
    if status in FB_STATUSES:
        where, params = "WHERE status = :s", {"s": status}
    with engine.connect() as conn:
        rows = conn.execute(text(
            f"SELECT * FROM feedback {where} ORDER BY FIELD(status,'new','in_progress','answered','closed'), "
            "created_at DESC LIMIT 500"
        ), params).mappings().all()
        counts = dict(conn.execute(text("SELECT status, COUNT(*) FROM feedback GROUP BY status")).all())
    return {"items": [_row(r) for r in rows], "counts": {s: int(counts.get(s, 0)) for s in FB_STATUSES}}


class FeedbackPatch(BaseModel):
    status: Optional[str] = None
    staff_note: Optional[str] = None
    reply: Optional[str] = None


@router.patch("/feedback/{fid}")
def triage_feedback(fid: int, body: FeedbackPatch, user=Depends(require_capability(STAFF))):
    with engine.begin() as conn:
        cur = conn.execute(text("SELECT * FROM feedback WHERE id = :i"), {"i": fid}).mappings().first()
        if not cur:
            raise HTTPException(404, "Not found")
        sets, params = [], {"i": fid}
        if body.staff_note is not None:
            sets.append("staff_note = :n"); params["n"] = body.staff_note
        new_reply = (body.reply or "").strip()
        if new_reply:
            sets += ["reply = :r", "replied_at = NOW()", "replied_by = :rb"]
            params.update(r=new_reply, rb=user["email"])
            if not body.status:
                body.status = "answered"
        if body.status in FB_STATUSES:
            sets.append("status = :s"); params["s"] = body.status
        if sets:
            conn.execute(text(f"UPDATE feedback SET {', '.join(sets)} WHERE id = :i"), params)
    record_audit(user, "feedback.update", "feedback", fid, (cur["message"] or "")[:60],
                 {"status": body.status, "replied": bool(new_reply)})
    if new_reply and cur["user_id"]:
        notify([cur["user_id"]], "feedback.reply", "Reply to your feedback",
               body=f"You wrote: {cur['message'][:200]}\n\nReply from {user['email']}:\n{new_reply}",
               link="#/help-mine", subject=f"feedback:{fid}",
               dedupe_key=f"feedback.reply:{fid}:{datetime.utcnow():%Y%m%d%H%M%S}")
    return {"ok": True, "email_sent": bool(new_reply) and mailer.is_configured()}


# ---------------------------------------------------------------- what's new
@router.get("/whats-new")
def whats_new(user=Depends(get_current_user)):
    caps = user.get("capabilities") or set()
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT n.id, n.title, n.body, n.page, n.tour_key, n.capability, n.published_at
            FROM release_notes n
            LEFT JOIN release_note_seen s ON s.note_id = n.id AND s.user_id = :u
            WHERE n.published_at IS NOT NULL AND n.published_at <= NOW()
              AND (s.action IS NULL OR (s.action = 'later' AND s.at < NOW() - INTERVAL 12 HOUR))
            ORDER BY n.published_at DESC LIMIT 20
        """), {"u": user["id"]}).mappings().all()
        recent = conn.execute(text("""
            SELECT id, title, body, page, tour_key, capability, published_at FROM release_notes
            WHERE published_at IS NOT NULL AND published_at <= NOW()
            ORDER BY published_at DESC LIMIT 30
        """)).mappings().all()
    ok = lambda r: not r["capability"] or r["capability"] in caps
    return {"unseen": [_row(r) for r in rows if ok(r)], "recent": [_row(r) for r in recent if ok(r)]}


class SeenIn(BaseModel):
    action: str


@router.post("/whats-new/{nid}")
def mark_note(nid: int, body: SeenIn, user=Depends(get_current_user)):
    action = body.action if body.action in ("seen", "skipped", "later") else "seen"
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO release_note_seen (user_id, note_id, action) VALUES (:u, :n, :a) "
            "ON DUPLICATE KEY UPDATE action = VALUES(action), at = NOW()"
        ), {"u": user["id"], "n": nid, "a": action})
    return {"ok": True}


@router.get("/notes")
def list_notes(user=Depends(require_capability(STAFF))):
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT n.*, (SELECT COUNT(*) FROM release_note_seen s WHERE s.note_id = n.id AND s.action <> 'later') AS seen_by
            FROM release_notes n ORDER BY COALESCE(n.published_at, n.created_at) DESC
        """)).mappings().all()
    return {"items": [_row(r) for r in rows]}


class NoteIn(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    page: Optional[str] = None
    tour_key: Optional[str] = None
    capability: Optional[str] = None
    publish: Optional[bool] = None


@router.post("/notes")
def create_note(body: NoteIn, user=Depends(require_capability(STAFF))):
    if not (body.title or "").strip() or not (body.body or "").strip():
        raise HTTPException(400, "A note needs a title and some text.")
    with engine.begin() as conn:
        res = conn.execute(text(
            "INSERT INTO release_notes (title, body, page, tour_key, capability, published_at, created_by) "
            "VALUES (:t, :b, :p, :k, :c, :pub, :by)"
        ), {"t": body.title.strip()[:200], "b": body.body.strip(), "p": body.page or None,
            "k": body.tour_key or None, "c": body.capability or None,
            "pub": datetime.utcnow() if body.publish else None, "by": user["email"]})
    record_audit(user, "release_note.create", "release_note", res.lastrowid, body.title[:60])
    return {"ok": True, "id": res.lastrowid}


@router.patch("/notes/{nid}")
def edit_note(nid: int, body: NoteIn, user=Depends(require_capability(STAFF))):
    sets, params = [], {"i": nid}
    for col in ("title", "body", "page", "tour_key", "capability"):
        v = getattr(body, col)
        if v is not None:
            sets.append(f"{col} = :{col}"); params[col] = v.strip() or None if col != "title" else v.strip()
    if body.publish is True:
        sets.append("published_at = COALESCE(published_at, NOW())")
    elif body.publish is False:
        sets.append("published_at = NULL")
    if sets:
        with engine.begin() as conn:
            conn.execute(text(f"UPDATE release_notes SET {', '.join(sets)} WHERE id = :i"), params)
    record_audit(user, "release_note.update", "release_note", nid, None, {"publish": body.publish})
    return {"ok": True}


@router.delete("/notes/{nid}")
def delete_note(nid: int, user=Depends(require_capability(STAFF))):
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM release_note_seen WHERE note_id = :i"), {"i": nid})
        conn.execute(text("DELETE FROM release_notes WHERE id = :i"), {"i": nid})
    record_audit(user, "release_note.delete", "release_note", nid)
    return {"ok": True}


# ---------------------------------------------------------------- notifications
@notif_router.get("")
def my_notifications(unread: int = 0, limit: int = 40, user=Depends(get_current_user)):
    limit = max(1, min(limit, 200))
    try:   # announce new project changes (cheap; at most once a minute per worker)
        from . import watch
        watch.run()
    except Exception:
        pass
    where = "AND read_at IS NULL" if unread else ""
    with engine.connect() as conn:
        rows = conn.execute(text(
            f"SELECT id, kind, title, body, link, subject, created_at, read_at FROM notifications "
            f"WHERE user_id = :u {where} AND (read_at IS NULL OR read_at > '1970-01-03') "
            f"ORDER BY created_at DESC LIMIT {limit}"
        ), {"u": user["id"]}).mappings().all()
        n = conn.execute(text("SELECT COUNT(*) FROM notifications WHERE user_id = :u AND read_at IS NULL"),
                         {"u": user["id"]}).scalar()
    return {"items": [_row(r) for r in rows], "unread": int(n or 0)}


@notif_router.post("/read-all")
def read_all(user=Depends(get_current_user)):
    with engine.begin() as conn:
        conn.execute(text("UPDATE notifications SET read_at = NOW() WHERE user_id = :u AND read_at IS NULL"),
                     {"u": user["id"]})
    return {"ok": True}


@notif_router.post("/{nid}/read")
def read_one(nid: int, user=Depends(get_current_user)):
    with engine.begin() as conn:
        conn.execute(text("UPDATE notifications SET read_at = NOW() WHERE id = :i AND user_id = :u AND read_at IS NULL"),
                     {"i": nid, "u": user["id"]})
    return {"ok": True}


@notif_router.get("/prefs")
def get_prefs(user=Depends(get_current_user)):
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT kind, in_app, email FROM notification_prefs WHERE user_id = :u"),
                            {"u": user["id"]}).all()
    saved = {r[0]: (bool(r[1]), bool(r[2])) for r in rows}
    dflt = lambda k: (False, False) if k == "watch.all_projects" else (True, True)   # opt-in
    return {"email_configured": mailer.is_configured(),
            "kinds": [{"kind": k, "label": lbl, "in_app": saved.get(k, dflt(k))[0],
                       "email": saved.get(k, dflt(k))[1]} for k, lbl in NOTIFICATION_KINDS]}


class PrefIn(BaseModel):
    kind: str
    in_app: bool = True
    email: bool = True


@notif_router.put("/prefs")
def put_prefs(body: List[PrefIn], user=Depends(get_current_user)):
    known = {k for k, _ in NOTIFICATION_KINDS} | {"*"}
    with engine.begin() as conn:
        for p in body:
            if p.kind not in known:
                continue
            conn.execute(text(
                "INSERT INTO notification_prefs (user_id, kind, in_app, email) VALUES (:u, :k, :a, :e) "
                "ON DUPLICATE KEY UPDATE in_app = VALUES(in_app), email = VALUES(email)"
            ), {"u": user["id"], "k": p.kind, "a": int(p.in_app), "e": int(p.email)})
    return {"ok": True}
