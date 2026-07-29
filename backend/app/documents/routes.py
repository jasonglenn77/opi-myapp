"""
Document system (Phase 2). The 9-folder structure (mirrors OPI's Google Drive)
attached to any entity: estimate / job / project. S3-backed via the `documents`
table. Folders are gated by stage — estimates show 1-5, jobs/projects show all 9.
Read/write gated by page.customers.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from sqlalchemy import text

from app.db import engine
from app.auth import get_current_user
from app.permissions import has_capability, PAGE_CUSTOMERS
from app.s3 import s3_client, AWS_BUCKET, build_document_key, signed_file_url

router = APIRouter(prefix="/api/documents", tags=["documents"])

# Canonical folder tree (mirrors the Google Drive structure). `stage` =
# 'estimate' folders show on every entity; 'project' folders only on jobs/projects.
FOLDER_TREE = [
    {"key": "1_request_for_quote", "label": "1 Request for Quote", "stage": "estimate"},
    {"key": "2_drawings_calcs",    "label": "2 Drawings and Calcs", "stage": "estimate"},
    {"key": "3_bill_of_materials", "label": "3 Bill of Materials", "stage": "estimate"},
    {"key": "4_quotes",            "label": "4 Quotes", "stage": "estimate"},
    {"key": "5_purchase_orders",   "label": "5 Purchase Orders", "stage": "estimate"},
    {"key": "6_project_management", "label": "6 Project Management", "stage": "project", "children": [
        {"key": "6_project_management/1_kickoff", "label": "1 Kickoff"},
        {"key": "6_project_management/2_construction", "label": "2 Construction Progression Updates", "children": [
            {"key": "6_project_management/2_construction/1_before_pictures", "label": "1 Before Pictures"},
            {"key": "6_project_management/2_construction/2_active_pictures", "label": "2 Active Pictures"},
            {"key": "6_project_management/2_construction/3_bols", "label": "3 BOL's"},
            {"key": "6_project_management/2_construction/4_drawing_updates", "label": "4 Drawing Updates"},
            {"key": "6_project_management/2_construction/5_anchor_installation", "label": "5 Anchor Installation"},
            {"key": "6_project_management/2_construction/6_project_completion", "label": "6 Project Completion"},
        ]},
    ]},
    {"key": "7_notes",     "label": "7 Notes", "stage": "project"},
    {"key": "8_receipts",  "label": "8 Receipts", "stage": "project", "children": [
        {"key": "8_receipts/materials", "label": "Materials"},
        {"key": "8_receipts/travel",    "label": "Travel"},
    ]},
    {"key": "9_marketing", "label": "9 Marketing", "stage": "project"},
]

VALID_TYPES = ("estimate", "job", "project", "opportunity")

# The 5 estimate-stage folders (owned by the opportunity in the ownership+join
# model). Everything else (6–9 + children) is project-stage, owned by the project.
ESTIMATE_FOLDER_KEYS = {
    "1_request_for_quote", "2_drawings_calcs", "3_bill_of_materials",
    "4_quotes", "5_purchase_orders",
}


def _linked_project_qbo_id(conn, opp_id):
    """The QBO project an opportunity is linked to (or None)."""
    return conn.execute(
        text("SELECT project_qbo_id FROM opportunities WHERE id = :i"),
        {"i": opp_id}).scalar()


def _linked_opportunity_id(conn, project_qbo_id):
    """The opportunity linked to a QBO project (most recent, or None)."""
    return conn.execute(
        text("SELECT id FROM opportunities WHERE project_qbo_id = :p ORDER BY id DESC LIMIT 1"),
        {"p": project_qbo_id}).scalar()


def store_document_bytes(entity_type, entity_id, folder, filename, body,
                         content_type="application/octet-stream", user_id=None):
    """Store raw bytes as a document (S3 put + `documents` row). Reused by the
    estimate-PDF endpoint to file a generated quote into the '4 Quotes' folder.
    Returns the new document id."""
    key = build_document_key(entity_type, str(entity_id), folder, filename)
    s3_client.put_object(Bucket=AWS_BUCKET, Key=key, Body=body, ContentType=content_type)
    with engine.begin() as conn:
        return conn.execute(text("""
            INSERT INTO documents (entity_type, entity_id, folder, s3_bucket, s3_key,
                original_filename, content_type, size_bytes, uploaded_by_user_id)
            VALUES (:t,:i,:f,:b,:k,:fn,:ct,:sz,:u)
        """), {"t": entity_type, "i": str(entity_id), "f": folder, "b": AWS_BUCKET, "k": key,
               "fn": filename, "ct": content_type, "sz": len(body), "u": user_id}).lastrowid


def _gated_tree(entity_type: str, linked: bool = False):
    """Which folders an entity shows. Estimates: the 5 estimate-stage folders.
    Opportunities: 5 folders normally, but ALL 9 once linked to a project (it's a
    project now). Jobs/projects: all 9."""
    if entity_type == "estimate":
        return [n for n in FOLDER_TREE if n.get("stage") == "estimate"]
    if entity_type == "opportunity" and not linked:
        return [n for n in FOLDER_TREE if n.get("stage") == "estimate"]
    return FOLDER_TREE


def _all_keys(nodes):
    keys = []
    for n in nodes:
        keys.append(n["key"])
        if n.get("children"):
            keys.extend(_all_keys(n["children"]))
    return keys


def _require(user):
    if not has_capability(user, PAGE_CUSTOMERS):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _entity_meta(conn, etype, eid):
    if etype in ("project", "job"):
        # resolve to root customer for the header
        cur = conn.execute(text("SELECT display_name, parent_qbo_id FROM qbo_customers WHERE qbo_id=:id"),
                           {"id": eid}).mappings().first()
        if not cur:
            return None
        name = cur["display_name"]
        root_name, pq, guard = name, cur["parent_qbo_id"], 0
        while pq and guard < 10:
            p = conn.execute(text("SELECT display_name, parent_qbo_id FROM qbo_customers WHERE qbo_id=:id"),
                             {"id": pq}).mappings().first()
            if not p:
                break
            root_name, pq, guard = p["display_name"], p["parent_qbo_id"], guard + 1
        return {"name": name, "customer_name": root_name}
    if etype == "estimate":
        r = conn.execute(text("""
            SELECT t.doc_number, c.display_name AS cust,
                   JSON_UNQUOTE(JSON_EXTRACT(t.raw_json,'$.CustomerMemo.value')) AS memo
            FROM qbo_transactions t LEFT JOIN qbo_customers c ON c.qbo_id = t.customer_qbo_id
            WHERE t.qbo_id=:id AND t.entity_type='Estimate'
        """), {"id": eid}).mappings().first()
        if not r:
            return None
        nm = (f"#{r['doc_number']} {r['memo'] or ''}").strip() if r["doc_number"] else (r["memo"] or "Estimate")
        return {"name": nm, "customer_name": r["cust"]}
    if etype == "opportunity":
        r = conn.execute(text("""
            SELECT o.title, o.quote_number,
                   COALESCE(qc.display_name, o.customer_name_raw) AS cust
            FROM opportunities o LEFT JOIN qbo_customers qc ON qc.id = o.qbo_customer_id
            WHERE o.id = :id
        """), {"id": eid}).mappings().first()
        if not r:
            return None
        nm = r["title"] or (f"Quote #{r['quote_number']}" if r["quote_number"] else "Opportunity")
        return {"name": nm, "customer_name": r["cust"]}
    return None


@router.get("/{entity_type}/{entity_id}")
def get_entity_documents(entity_type: str, entity_id: str, user=Depends(get_current_user)):
    """Folder tree (gated by stage) + the files filed in each folder + entity header."""
    _require(user)
    if entity_type not in VALID_TYPES:
        raise HTTPException(status_code=400, detail="Bad entity_type")
    with engine.connect() as conn:
        meta = _entity_meta(conn, entity_type, entity_id)
        if not meta:
            raise HTTPException(status_code=404, detail="Entity not found")

        # Ownership + join: an opportunity owns its estimate folders (1–5); a
        # project owns the project folders (6–9). When linked, each view MERGES
        # the counterpart's docs so the linked project shows the estimate docs
        # and the linked opportunity shows the project docs — without ever moving
        # them, so unlinking is non-destructive and the opp keeps its count.
        sources = [(entity_type, entity_id)]
        linked = False
        if entity_type == "opportunity":
            proj = _linked_project_qbo_id(conn, entity_id)
            if proj:
                linked = True
                sources.append(("project", str(proj)))
        elif entity_type in ("project", "job"):
            opp = _linked_opportunity_id(conn, entity_id)
            if opp is not None:
                sources.append(("opportunity", str(opp)))

        clauses = " OR ".join(f"(d.entity_type=:t{k} AND d.entity_id=:i{k})" for k in range(len(sources)))
        params = {}
        for k, (t, i) in enumerate(sources):
            params[f"t{k}"] = t
            params[f"i{k}"] = i
        rows = conn.execute(text(f"""
            SELECT d.id, d.folder, d.original_filename, d.content_type, d.size_bytes, d.created_at,
                   TRIM(CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,''))) AS uploaded_by
            FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by_user_id
            WHERE {clauses}
            ORDER BY d.created_at DESC
        """), params).mappings().all()
    files_by_folder = {}
    for r in rows:
        files_by_folder.setdefault(r["folder"], []).append({
            "id": r["id"], "filename": r["original_filename"], "content_type": r["content_type"],
            "size_bytes": int(r["size_bytes"] or 0), "created_at": str(r["created_at"]) if r["created_at"] else None,
            "uploaded_by": (r["uploaded_by"] or "").strip() or None,
        })
    return {"entity": {"type": entity_type, "id": entity_id, **meta},
            "tree": _gated_tree(entity_type, linked=linked), "files": files_by_folder}


@router.post("/{entity_type}/{entity_id}")
async def upload_document(entity_type: str, entity_id: str, folder: str = Query(...),
                          file: UploadFile = File(...), user=Depends(get_current_user)):
    _require(user)
    if entity_type not in VALID_TYPES:
        raise HTTPException(status_code=400, detail="Bad entity_type")

    body = await file.read()
    if len(body) > 100 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File exceeds 100 MB limit")

    with engine.begin() as conn:
        # Resolve the link so linked opportunities accept project folders, and
        # route each upload to its owner: estimate folders (1–5) → the
        # opportunity, project folders (6–9) → the project. Backfilling a project
        # with no linked opportunity keeps estimate docs on the project.
        is_estimate_folder = folder in ESTIMATE_FOLDER_KEYS
        own_type, own_id, linked = entity_type, entity_id, False
        if entity_type == "opportunity":
            proj = _linked_project_qbo_id(conn, entity_id)
            if proj:
                linked = True
                if not is_estimate_folder:
                    own_type, own_id = "project", str(proj)
        elif entity_type in ("project", "job"):
            if is_estimate_folder:
                opp = _linked_opportunity_id(conn, entity_id)
                if opp is not None:
                    own_type, own_id = "opportunity", str(opp)

        if folder not in _all_keys(_gated_tree(entity_type, linked=linked)):
            raise HTTPException(status_code=400, detail="Unknown folder for this entity")

        key = build_document_key(own_type, own_id, folder, file.filename or "file")
        s3_client.put_object(Bucket=AWS_BUCKET, Key=key, Body=body,
                             ContentType=file.content_type or "application/octet-stream")
        conn.execute(text("""
            INSERT INTO documents (entity_type, entity_id, folder, s3_bucket, s3_key,
                original_filename, content_type, size_bytes, uploaded_by_user_id)
            VALUES (:t,:i,:f,:b,:k,:fn,:ct,:sz,:u)
        """), {"t": own_type, "i": own_id, "f": folder, "b": AWS_BUCKET, "k": key,
               "fn": file.filename, "ct": file.content_type, "sz": len(body), "u": user.get("id")})
    return {"ok": True}


@router.get("/file/{doc_id}/url")
def document_url(doc_id: int, user=Depends(get_current_user)):
    _require(user)
    with engine.connect() as conn:
        r = conn.execute(text("SELECT s3_key, original_filename FROM documents WHERE id=:id"),
                         {"id": doc_id}).mappings().first()
    if not r:
        raise HTTPException(status_code=404, detail="Document not found")
    return {"url": signed_file_url(r["s3_key"]), "filename": r["original_filename"]}


@router.delete("/file/{doc_id}")
def delete_document(doc_id: int, user=Depends(get_current_user)):
    _require(user)
    with engine.begin() as conn:
        r = conn.execute(text("SELECT s3_bucket, s3_key FROM documents WHERE id=:id"),
                         {"id": doc_id}).mappings().first()
        if not r:
            raise HTTPException(status_code=404, detail="Document not found")
        try:
            s3_client.delete_object(Bucket=r["s3_bucket"], Key=r["s3_key"])
        except Exception:
            pass  # row removal proceeds even if S3 delete fails
        conn.execute(text("DELETE FROM documents WHERE id=:id"), {"id": doc_id})
    return {"ok": True}
