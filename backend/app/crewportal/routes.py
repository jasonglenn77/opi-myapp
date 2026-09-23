"""
Crew Portal (Crew Portal design 2026-09-22, build steps 1+2).

Crews are contractors: NO user accounts — only the passcode-gated #/field page
(app/crewauth). These endpoints take a CREW session token ONLY and are scoped
server-side to the crew's assigned projects (require_crew_project /
crew_project_ids — the same project_schedule_item_work_crews chain the office
and PM pages join). The boss master code (crew_id NULL, role 'boss') sees all
crews' projects, same zero-financial content.

HARD RULE: no financial fields of any kind in any response here.

  * GET /api/crew-portal/my-projects — the crew's Active / Upcoming / Past
    buckets (same status buckets as pm/routes.py: active=in_progress;
    upcoming=needs_attention/pending/not_started/…; past=completed/canceled,
    capped at the 25 most recent). Rows: qbo_id, name, customer, dates,
    pm_names, status.
  * GET /api/crew-portal/documents?project_qbo_id= — ONLY the files in the
    "10 Crew Documents" folder (PM-curated), with the same signed S3 URLs the
    documents API issues. No other folder is reachable; no crew upload.
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text

from app.db import engine
from app.crewauth.routes import get_crew_session, get_user_or_crew, require_crew_project
from app.permissions import has_capability, PAGE_PM_PORTAL
from app.s3 import signed_file_url

router = APIRouter(prefix="/api/crew-portal", tags=["crew-portal"])

# Same buckets as pm/routes.py (projects-hub / crew-hub convention).
ACTIVE_STATUSES = {"in_progress"}
PAST_STATUSES = {"completed", "canceled"}
PAST_CAP = 25

# The one folder crews can see (documents.routes.FOLDER_TREE key).
CREW_FOLDER = "10_crew_documents"


@router.get("/my-projects")
def my_projects(sess=Depends(get_crew_session)):
    """The crew's assigned projects, bucketed Active / Upcoming / Past. Crew
    token only. No financial fields of any kind (hard rule)."""
    crew_clause, params = "", {}
    if sess.get("role") != "boss":
        crew_clause = " AND swc.work_crew_id = :crew"
        params["crew"] = sess.get("crew_id") or -1

    with engine.connect() as conn:
        rows = conn.execute(text(f"""
            WITH scope AS (
              SELECT DISTINCT p.qbo_customer_id
              FROM projects p
              JOIN project_schedule_items psi ON psi.project_id = p.id
              JOIN project_schedule_item_work_crews swc ON swc.schedule_item_id = psi.id
              WHERE swc.unassigned_at IS NULL{crew_clause}
            ),
            latest_status AS (
              SELECT qbo_customer_id, status FROM (
                SELECT p.qbo_customer_id, psi.status,
                       ROW_NUMBER() OVER (PARTITION BY p.qbo_customer_id
                         ORDER BY psi.start_date IS NULL, psi.start_date DESC,
                                  psi.sort_order DESC, psi.id DESC) AS rn
                FROM projects p
                JOIN project_schedule_items psi ON psi.project_id = p.id
              ) x WHERE rn = 1
            ),
            win AS (
              SELECT p.qbo_customer_id,
                     MIN(psi.start_date) AS start_date,
                     MAX(psi.end_date)   AS end_date
              FROM projects p
              JOIN project_schedule_items psi ON psi.project_id = p.id
              GROUP BY p.qbo_customer_id
            ),
            pms AS (
              SELECT p.qbo_customer_id,
                     GROUP_CONCAT(DISTINCT TRIM(CONCAT(COALESCE(m.first_name,''),' ',
                         COALESCE(m.last_name,'')))
                       ORDER BY spm.is_primary DESC, m.last_name, m.first_name
                       SEPARATOR ', ') AS pm_names
              FROM projects p
              JOIN project_schedule_items psi ON psi.project_id = p.id
              JOIN project_schedule_item_project_managers spm ON spm.schedule_item_id = psi.id
              LEFT JOIN project_managers m ON m.id = spm.project_manager_id
              WHERE spm.unassigned_at IS NULL
              GROUP BY p.qbo_customer_id
            )
            SELECT qc.qbo_id, qc.display_name, qc.parent_qbo_id,
                   COALESCE(ls.status, 'needs_attention') AS status,
                   w.start_date, w.end_date,
                   COALESCE(px.pm_names, '') AS pm_names
            FROM qbo_customers qc
            JOIN projects p ON p.qbo_customer_id = qc.id
            JOIN scope sc ON sc.qbo_customer_id = qc.id
            LEFT JOIN latest_status ls ON ls.qbo_customer_id = qc.id
            LEFT JOIN win w  ON w.qbo_customer_id  = qc.id
            LEFT JOIN pms px ON px.qbo_customer_id = qc.id
            WHERE qc.is_project = 1
            ORDER BY w.start_date IS NULL, w.start_date, qc.display_name
        """), params).mappings().all()

        # Root-customer names via one pass over the customer tree (same
        # resolution pm/routes.py uses for its project cards).
        parents = {r["qbo_id"]: (r["display_name"], r["parent_qbo_id"]) for r in
                   conn.execute(text(
                       "SELECT qbo_id, display_name, parent_qbo_id FROM qbo_customers"
                   )).mappings().all()}

    def root_customer(parent_qbo_id):
        name, pq, guard = None, parent_qbo_id, 0
        while pq and pq in parents and guard < 10:
            name, pq, guard = parents[pq][0], parents[pq][1], guard + 1
        return name

    active, upcoming, past = [], [], []
    for r in rows:
        st = (r["status"] or "").lower()
        item = {
            "qbo_id": str(r["qbo_id"]),
            "name": r["display_name"],
            "customer": root_customer(r["parent_qbo_id"]) or r["display_name"],
            "status": st,
            "start_date": str(r["start_date"]) if r["start_date"] else None,
            "end_date": str(r["end_date"]) if r["end_date"] else None,
            "pm_names": r["pm_names"] or None,
        }
        if st in PAST_STATUSES:
            past.append(item)
        elif st in ACTIVE_STATUSES:
            active.append(item)
        else:
            upcoming.append(item)

    # Past: the most recent first (undated last), capped — old completed work
    # is noise on a phone.
    past.sort(key=lambda x: (x["end_date"] is not None, x["end_date"] or ""),
              reverse=True)
    past = past[:PAST_CAP]

    return {
        "crew": ({"id": sess["crew_id"], "name": sess["crew_name"]}
                 if sess.get("crew_id") is not None else None),
        "role": sess.get("role"),
        "active": active,
        "upcoming": upcoming,
        "past": past,
    }


@router.get("/documents")
def crew_documents(project_qbo_id: str = Query(...), sess=Depends(get_user_or_crew)):
    """ONLY the files in the project's '10 Crew Documents' folder (PM-curated),
    each with the same signed S3 URL the documents API issues. Crew tokens are
    scoped to the crew's assigned projects; readable on past projects
    (read-only there means no submit/upload — docs stay viewable). Crews can
    never list or download any other folder. USER tokens with page.pm_portal
    are also accepted (Crew Portal step 3: the PM's "Open crew view" renders
    this same section); other user tokens 403."""
    if sess.get("kind") == "user" and not has_capability(sess["user"], PAGE_PM_PORTAL):
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    with engine.connect() as conn:
        exists = conn.execute(text(
            "SELECT qbo_id FROM qbo_customers WHERE qbo_id = :id"
        ), {"id": project_qbo_id}).scalar()
        if exists is None:
            raise HTTPException(status_code=404, detail="Project not found")
        require_crew_project(conn, sess, project_qbo_id)

        rows = conn.execute(text("""
            SELECT id, original_filename, content_type, size_bytes, created_at, s3_key
            FROM documents
            WHERE entity_type = 'project' AND entity_id = :e AND folder = :f
            ORDER BY created_at DESC, id DESC
        """), {"e": str(project_qbo_id), "f": CREW_FOLDER}).mappings().all()

    return {"files": [{
        "id": r["id"],
        "filename": r["original_filename"],
        "content_type": r["content_type"],
        "size": int(r["size_bytes"] or 0),
        "uploaded_at": str(r["created_at"]) if r["created_at"] else None,
        "url": signed_file_url(r["s3_key"]),
    } for r in rows]}
