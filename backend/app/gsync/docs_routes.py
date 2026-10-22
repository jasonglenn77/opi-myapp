"""
Drive documents holding area API (app/gsync/docs_sync.py).

  GET  /api/drive-docs/status                 last sync run + backfill state + holding totals
  GET  /api/drive-docs/unmatched?status=open  holding-area folders (open | ignored | linked | all)
  GET  /api/drive-docs/unmatched/{id}         one folder + its held files
  GET  /api/drive-docs/targets?q=             projects + Pipeline quotes to link to
  POST /api/drive-docs/unmatched/{id}/link    {"project_qbo_id": "..."} or {"quote_number": "..."}
                                              or {"opportunity_id": n}: moves the held rows (no re-upload)
  POST /api/drive-docs/unmatched/{id}/ignore  leave the files in the holding area, hide from review
  POST /api/drive-docs/unmatched/{id}/reopen  ignored -> open
"""
import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from app.auth import get_current_user
from app.audit import record_audit
from app.db import engine
from app.permissions import has_capability, PAGE_CUSTOMERS, PAGE_ESTIMATE, PAGE_ASSIGNMENT
from .docs_sync import EST, folder_url

router = APIRouter(prefix="/api/drive-docs", tags=["drive-docs"])


def _require(user):
    if not any(has_capability(user, c) for c in (PAGE_CUSTOMERS, PAGE_ESTIMATE, PAGE_ASSIGNMENT)):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _row(r):
    d = dict(r)
    if isinstance(d.get("suggestion"), str):
        d["suggestion"] = json.loads(d["suggestion"]) if d["suggestion"] else None
    for k in ("created_at", "updated_at", "linked_at"):
        if d.get(k) is not None:
            d[k] = str(d[k])
    d["drive_url"] = folder_url(d["drive_folder_id"]) if d["drive_folder_id"] != "" else None
    d["total_bytes"] = int(d.get("total_bytes") or 0)
    return d


COLS = """id, drive_folder_id, path, company, folder_name, kind, guessed_job, suggestion, file_count, total_bytes,
          status, linked_entity_type, linked_entity_id, linked_by_email, linked_at, created_at, updated_at"""


@router.get("/status")
def status(user=Depends(get_current_user)):
    _require(user)
    with engine.connect() as conn:
        st = {r[0]: r[1] for r in conn.execute(text(
            "SELECT k, v FROM drive_sync_state WHERE k IN ('backfill_completed_at', 'last_full_walk_at')"))}
        last = conn.execute(text("""SELECT id, started_at, finished_at, ok, summary, error, triggered_by FROM gsync_runs
                                    WHERE source = 'drive_docs' ORDER BY id DESC LIMIT 1""")).mappings().first()
        hold = conn.execute(text("""SELECT status, COUNT(*) n, SUM(file_count) files, SUM(total_bytes) b
                                    FROM drive_unmatched_folders GROUP BY status""")).mappings().all()
        docs = conn.execute(text("""SELECT COUNT(*) n, SUM(size_bytes) b FROM documents
                                    WHERE source_drive_id IS NOT NULL""")).mappings().first()
        errors = conn.execute(text("SELECT COUNT(*) FROM drive_file_state WHERE status = 'error'")).scalar()
    lr = None
    if last:
        lr = {k: (str(v) if k in ("started_at", "finished_at") and v else v) for k, v in dict(last).items()}
        if isinstance(lr["summary"], str):
            lr["summary"] = json.loads(lr["summary"])
    return {"backfill_completed_at": st.get("backfill_completed_at"), "last_run": lr,
            "drive_documents": int(docs["n"] or 0), "drive_bytes": int(docs["b"] or 0), "copy_errors": errors,
            "holding": {h["status"]: {"folders": h["n"], "files": int(h["files"] or 0), "bytes": int(h["b"] or 0)}
                        for h in hold}}


@router.get("/unmatched")
def list_unmatched(status: str = "open", q: Optional[str] = None, user=Depends(get_current_user)):
    _require(user)
    where, p = ["1=1"], {}
    if status != "all":
        where.append("status = :s")
        p["s"] = status
    if q:
        where.append("(path LIKE :q OR guessed_job LIKE :q)")
        p["q"] = f"%{q}%"
    with engine.connect() as conn:
        rows = conn.execute(text(f"SELECT {COLS} FROM drive_unmatched_folders WHERE {' AND '.join(where)} "
                                 "ORDER BY total_bytes DESC LIMIT 1000"), p).mappings().all()
    return {"folders": [_row(r) for r in rows]}


@router.get("/unmatched/{uid}")
def get_unmatched(uid: int, user=Depends(get_current_user)):
    _require(user)
    with engine.connect() as conn:
        r = conn.execute(text(f"SELECT {COLS} FROM drive_unmatched_folders WHERE id = :i"), {"i": uid}).mappings().first()
        if not r:
            raise HTTPException(status_code=404, detail="Not found")
        files = conn.execute(text("""
            SELECT id, original_filename AS filename, folder, drive_path, size_bytes, content_type, drive_link,
                   (s3_key = '') AS link_only, created_at
            FROM documents WHERE entity_type = 'drive_hold' AND entity_id = :i
            ORDER BY drive_path LIMIT 2000"""), {"i": str(uid)}).mappings().all()
    return {"folder": _row(r), "files": [{**dict(f), "size_bytes": int(f["size_bytes"] or 0),
                                          "link_only": bool(f["link_only"]),
                                          "created_at": str(f["created_at"]) if f["created_at"] else None}
                                         for f in files]}


@router.get("/targets")
def targets(q: str = "", user=Depends(get_current_user)):
    """Projects + Pipeline quotes matching q (job #, quote #, name)."""
    _require(user)
    q = q.strip()
    if len(q) < 2:
        return {"projects": [], "opportunities": []}
    like = f"%{q}%"
    with engine.connect() as conn:
        projects = conn.execute(text("""SELECT qbo_id, display_name FROM qbo_customers
                                        WHERE is_project = 1 AND display_name LIKE :q
                                        ORDER BY display_name DESC LIMIT 15"""), {"q": like}).mappings().all()
        opps = conn.execute(text("""
            SELECT o.id, o.quote_number, o.title, o.status, o.project_qbo_id,
                   COALESCE(qc.display_name, o.customer_name_raw) AS customer
            FROM opportunities o LEFT JOIN qbo_customers qc ON qc.id = o.qbo_customer_id
            WHERE o.quote_number LIKE :q OR o.title LIKE :q OR o.customer_name_raw LIKE :q
            ORDER BY o.id DESC LIMIT 15"""), {"q": like}).mappings().all()
    return {"projects": [dict(p) for p in projects], "opportunities": [dict(o) for o in opps]}


class LinkIn(BaseModel):
    project_qbo_id: Optional[str] = None
    quote_number: Optional[str] = None
    opportunity_id: Optional[int] = None


@router.post("/unmatched/{uid}/link")
def link(uid: int, body: LinkIn, user=Depends(get_current_user)):
    """Link a held Drive folder to a project or quote: its held documents rows
    move there (same ownership rule as uploads: estimate folders 1-5 of a
    project go to its linked quote, project folders of a linked quote go to
    the project). The link is remembered, so future syncs file new files from
    that Drive folder on the same record."""
    _require(user)
    with engine.begin() as conn:
        h = conn.execute(text("SELECT id, drive_folder_id, path, status FROM drive_unmatched_folders WHERE id = :i"),
                         {"i": uid}).mappings().first()
        if not h:
            raise HTTPException(status_code=404, detail="Not found")
        if body.project_qbo_id:
            p = conn.execute(text("SELECT qbo_id, display_name FROM qbo_customers WHERE qbo_id = :q AND is_project = 1"),
                             {"q": body.project_qbo_id}).mappings().first()
            if not p:
                raise HTTPException(status_code=400, detail="Unknown QuickBooks project")
            et, eid, label = "project", str(p["qbo_id"]), p["display_name"]
        elif body.opportunity_id or body.quote_number:
            if body.opportunity_id:
                o = conn.execute(text("SELECT id, quote_number, title FROM opportunities WHERE id = :i"),
                                 {"i": body.opportunity_id}).mappings().first()
            else:
                os_ = conn.execute(text("""SELECT id, quote_number, title FROM opportunities
                                           WHERE quote_number = :q OR SUBSTRING_INDEX(quote_number, '.', 1) = :q
                                           ORDER BY (quote_number = :q) DESC, id DESC"""),
                                   {"q": body.quote_number.strip().lstrip("#")}).mappings().all()
                if len({x["id"] for x in os_ if x["quote_number"] == body.quote_number.strip().lstrip("#")}) > 1:
                    raise HTTPException(status_code=400, detail="Several quotes have that number - pick one")
                o = os_[0] if os_ else None
            if not o:
                raise HTTPException(status_code=400, detail="Unknown quote")
            et, eid, label = "opportunity", str(o["id"]), f"#{o['quote_number']} {o['title'] or ''}".strip()
        else:
            raise HTTPException(status_code=400, detail="Give project_qbo_id, quote_number or opportunity_id")

        linked_opp = linked_proj = None
        if et == "project":
            linked_opp = conn.execute(text("SELECT id FROM opportunities WHERE project_qbo_id = :p ORDER BY id DESC LIMIT 1"),
                                      {"p": eid}).scalar()
        else:
            linked_proj = conn.execute(text("SELECT project_qbo_id FROM opportunities WHERE id = :i"), {"i": eid}).scalar()
        docs = conn.execute(text("SELECT id, folder FROM documents WHERE entity_type = 'drive_hold' AND entity_id = :i"),
                            {"i": str(uid)}).mappings().all()
        moved = 0
        for d in docs:
            top = d["folder"].split("/")[0]
            t, i = et, eid
            if et == "project" and top in EST and linked_opp:
                t, i = "opportunity", str(linked_opp)
            elif et == "opportunity" and top not in EST and linked_proj:
                t, i = "project", str(linked_proj)
            conn.execute(text("UPDATE documents SET entity_type = :t, entity_id = :i WHERE id = :id"),
                         {"t": t, "i": i, "id": d["id"]})
            moved += 1
        conn.execute(text("""UPDATE drive_unmatched_folders SET status = 'linked', linked_entity_type = :t,
                               linked_entity_id = :i, linked_by_email = :e, linked_at = NOW() WHERE id = :id"""),
                     {"t": et, "i": eid, "e": user.get("email") or "user", "id": uid})
        conn.execute(text("""UPDATE drive_folders SET match_kind = 'manual', entity_type = :t, entity_id = :i
                             WHERE drive_id = :f AND is_root = 1"""), {"t": et, "i": eid, "f": h["drive_folder_id"]})
    record_audit(user, "drive_docs.link_folder", et, eid, label,
                 {"drive_folder_id": h["drive_folder_id"], "path": h["path"], "moved_documents": moved})
    return {"ok": True, "entity_type": et, "entity_id": eid, "label": label, "moved": moved,
            "link": f"#/entity/{et}/{eid}"}


def _set_status(uid, status, user, frm):
    with engine.begin() as conn:
        n = conn.execute(text(f"""UPDATE drive_unmatched_folders SET status = :s
                                   WHERE id = :i AND status IN ({', '.join(f"'{x}'" for x in frm)})"""),
                         {"s": status, "i": uid}).rowcount
    if not n:
        raise HTTPException(status_code=400, detail=f"Only {' or '.join(frm)} folders can be set to {status}")
    record_audit(user, f"drive_docs.{status}_folder", "drive_unmatched_folder", str(uid), None, None)
    return {"ok": True}


@router.post("/unmatched/{uid}/ignore")
def ignore(uid: int, user=Depends(get_current_user)):
    _require(user)
    return _set_status(uid, "ignored", user, ("open",))


@router.post("/unmatched/{uid}/reopen")
def reopen(uid: int, user=Depends(get_current_user)):
    _require(user)
    return _set_status(uid, "open", user, ("ignored",))
