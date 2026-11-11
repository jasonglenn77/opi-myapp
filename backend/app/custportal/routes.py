"""
Customer portal: a customer (or dealer) sees their own projects with no app
account: status and schedule, invoices and balances, documents, and change
orders to approve or decline.

Access is a private link staff create for a customer contact (like the crew
passcodes): the link's token is shown once, only its hash is kept, and it can be
revoked. Opening it gives a 30-day customer session that can only call the
customer endpoints below and only for that customer's projects.

  Staff (page.customers)
    GET  /api/customer-portal/customers?q=          customers to give access to
    GET  /api/customer-portal/access                every link, who it's for, last used
    POST /api/customer-portal/access                {customer_qbo_id, name, email, contact_id, days} -> {link}
    POST /api/customer-portal/access/{id}/revoke
  Public
    POST /api/customer-portal/login                 {token} -> customer session
  Customer session
    GET  /api/customer-portal/me
    GET  /api/customer-portal/projects
    GET  /api/customer-portal/project/{qbo_id}      schedule, invoices, documents, change orders
    GET  /api/customer-portal/file/{doc_id}         signed link to one of their documents
    POST /api/customer-portal/change-order/{co_id}/respond   {decision, name, note}
"""
import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from jose import JWTError, jwt
from pydantic import BaseModel
from sqlalchemy import bindparam, text

from app import mailer
from app.audit import record_audit
from app.auth import JWT_ALG, JWT_SECRET, require_capability
from app.db import engine
from app.s3 import signed_file_url

router = APIRouter(prefix="/api/customer-portal", tags=["customer-portal"])
STAFF = "page.customers"
SESSION_DAYS = 30
DOC_FOLDERS = {"5_purchase_orders": "Purchase orders", "4_quotes": "Quotes & estimates",
               "6_project_management/2_construction/6_project_completion": "Completion"}
STATUS = {"not_started": "Scheduled", "in_progress": "In progress", "completed": "Complete", "on_hold": "On hold",
          "pending": "Being scheduled", "needs_attention": "Being scheduled", "canceled": "Canceled"}


def _h(tok):
    return hashlib.sha256(tok.encode()).hexdigest()


# ---------------------------------------------------------------- staff
@router.get("/customers")
def customers(q: str = "", user=Depends(require_capability(STAFF))):
    like = f"%{q.strip()}%"
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT c.qbo_id, c.display_name, c.email,
                   (SELECT COUNT(*) FROM qbo_customers p WHERE p.is_project = 1 AND (p.parent_qbo_id = c.qbo_id
                      OR p.parent_qbo_id IN (SELECT m.qbo_id FROM qbo_customers m WHERE m.parent_qbo_id = c.qbo_id))) AS projects
            FROM qbo_customers c WHERE c.is_project = 0 AND c.display_name LIKE :q
            ORDER BY projects DESC, c.display_name LIMIT 25"""), {"q": like}).mappings().all()
    return {"items": [dict(r) for r in rows if r["projects"]]}


@router.get("/access")
def list_access(user=Depends(require_capability(STAFF))):
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT a.id, a.customer_qbo_id, c.display_name AS customer, a.name, a.email, a.active, a.expires_at,
                   a.created_by, a.created_at, a.last_used_at
            FROM customer_portal_access a LEFT JOIN qbo_customers c ON c.qbo_id = a.customer_qbo_id
            ORDER BY a.active DESC, a.created_at DESC""")).mappings().all()
    return {"items": [{k: (str(v) if isinstance(v, datetime) else v) for k, v in dict(r).items()} for r in rows],
            "email_configured": mailer.is_configured()}


class AccessIn(BaseModel):
    customer_qbo_id: str
    name: Optional[str] = None
    email: Optional[str] = None
    contact_id: Optional[int] = None
    days: Optional[int] = 365


@router.post("/access")
def create_access(body: AccessIn, user=Depends(require_capability(STAFF))):
    tok = secrets.token_urlsafe(32)
    exp = datetime.utcnow() + timedelta(days=max(1, min(body.days or 365, 730)))
    with engine.begin() as conn:
        cust = conn.execute(text("SELECT display_name FROM qbo_customers WHERE qbo_id = :q"), {"q": body.customer_qbo_id}).scalar()
        if not cust:
            raise HTTPException(404, "Customer not found")
        res = conn.execute(text("""
            INSERT INTO customer_portal_access (customer_qbo_id, contact_id, name, email, token_hash, expires_at, created_by)
            VALUES (:c, :ct, :n, :e, :h, :x, :by)"""), {"c": body.customer_qbo_id, "ct": body.contact_id, "n": (body.name or "").strip() or None,
                                                      "e": (body.email or "").strip() or None, "h": _h(tok), "x": exp, "by": user["email"]})
    link = f"{mailer.app_base_url()}/#/client?k={tok}"
    record_audit(user, "customer_portal.create", "customer_portal_access", res.lastrowid, cust, {"name": body.name, "email": body.email})
    sent = False
    if body.email and mailer.is_configured():
        html = mailer._shell(f"Your projects with OnPoint Installers",
                             f"Hi{(' ' + body.name.split()[0]) if body.name else ''},<br><br>Here's your private link to follow your projects with "
                             "OnPoint Installers: status and dates, invoices, documents, and change orders to approve.", "Open my projects", link)
        sent = mailer.send_email(body.email, "Your OnPoint Installers project portal", html, f"Your projects: {link}")
    return {"ok": True, "id": res.lastrowid, "link": link, "emailed": sent}


@router.post("/access/{aid}/revoke")
def revoke(aid: int, user=Depends(require_capability(STAFF))):
    with engine.begin() as conn:
        conn.execute(text("UPDATE customer_portal_access SET active = 0 WHERE id = :i"), {"i": aid})
    record_audit(user, "customer_portal.revoke", "customer_portal_access", aid)
    return {"ok": True}


# ---------------------------------------------------------------- customer session
class LoginIn(BaseModel):
    token: str


@router.post("/login")
def login(body: LoginIn):
    with engine.begin() as conn:
        a = conn.execute(text("""SELECT a.id, a.customer_qbo_id, a.name, a.active, a.expires_at, c.display_name
                                 FROM customer_portal_access a LEFT JOIN qbo_customers c ON c.qbo_id = a.customer_qbo_id
                                 WHERE a.token_hash = :h"""), {"h": _h(body.token or "")}).mappings().first()
        if not a or not a["active"] or (a["expires_at"] and a["expires_at"] < datetime.utcnow()):
            raise HTTPException(401, "This link isn't valid any more. Ask OnPoint Installers for a new one.")
        conn.execute(text("UPDATE customer_portal_access SET last_used_at = NOW() WHERE id = :i"), {"i": a["id"]})
    tok = jwt.encode({"cust_session": True, "aid": a["id"], "exp": datetime.utcnow() + timedelta(days=SESSION_DAYS)},
                     JWT_SECRET, algorithm=JWT_ALG)
    return {"session": tok, "customer": a["display_name"], "name": a["name"]}


def customer(authorization: str = Header(default="")):
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "Sign in with your link")
    try:
        p = jwt.decode(authorization.removeprefix("Bearer ").strip(), JWT_SECRET, algorithms=[JWT_ALG])
    except JWTError:
        raise HTTPException(401, "Your session ended. Open your link again.")
    if not p.get("cust_session"):
        raise HTTPException(401, "Customer session required")
    with engine.connect() as conn:
        a = conn.execute(text("""SELECT a.id, a.customer_qbo_id, a.name, a.email, a.active, a.expires_at, c.display_name
                                 FROM customer_portal_access a LEFT JOIN qbo_customers c ON c.qbo_id = a.customer_qbo_id
                                 WHERE a.id = :i"""), {"i": p.get("aid")}).mappings().first()
    if not a or not a["active"] or (a["expires_at"] and a["expires_at"] < datetime.utcnow()):
        raise HTTPException(401, "This link isn't valid any more. Ask OnPoint Installers for a new one.")
    return dict(a)


def _project_ids(conn, cq):
    """Every project under the customer (up to three levels down)."""
    ids, frontier = set(), {str(cq)}
    for _ in range(3):
        if not frontier:
            break
        rows = conn.execute(text("SELECT qbo_id, is_project FROM qbo_customers WHERE parent_qbo_id IN :f")
                            .bindparams(bindparam("f", expanding=True)), {"f": list(frontier)}).all()
        frontier = set()
        for q, is_p in rows:
            (ids if is_p else frontier).add(str(q))
            frontier.add(str(q))
    return ids


def _own(conn, c, qbo_id):
    if str(qbo_id) not in _project_ids(conn, c["customer_qbo_id"]):
        raise HTTPException(404, "Project not found")


@router.get("/me")
def me(c=Depends(customer)):
    return {"customer": c["display_name"], "name": c["name"], "email": c["email"]}


def _sched(conn, ids):
    if not ids:
        return {}
    rows = conn.execute(text("""
        SELECT qc.qbo_id, qc.display_name, MIN(psi.start_date) s, MAX(psi.end_date) e,
               (SELECT psi2.status FROM project_schedule_items psi2 WHERE psi2.project_id = p.id
                ORDER BY psi2.start_date IS NULL, psi2.start_date DESC, psi2.sort_order DESC, psi2.id DESC LIMIT 1) st,
               (SELECT GROUP_CONCAT(DISTINCT TRIM(CONCAT(COALESCE(pm.first_name,''),' ',COALESCE(pm.last_name,''))) SEPARATOR ', ')
                FROM project_schedule_items s3 JOIN project_schedule_item_project_managers spm ON spm.schedule_item_id = s3.id AND spm.unassigned_at IS NULL
                JOIN project_managers pm ON pm.id = spm.project_manager_id WHERE s3.project_id = p.id) pms
        FROM qbo_customers qc JOIN projects p ON p.qbo_customer_id = qc.id
        LEFT JOIN project_schedule_items psi ON psi.project_id = p.id
        WHERE qc.qbo_id IN :ids GROUP BY qc.qbo_id, qc.display_name, p.id""").bindparams(bindparam("ids", expanding=True)),
        {"ids": list(ids)}).mappings().all()
    return {str(r["qbo_id"]): r for r in rows}


def _invoices(conn, ids):
    if not ids:
        return []
    return conn.execute(text("""
        SELECT customer_qbo_id, qbo_id, doc_number, txn_date, due_date, total_amt, balance_amt FROM (
          SELECT t.*, ROW_NUMBER() OVER (PARTITION BY t.qbo_id ORDER BY t.id DESC) rn
          FROM qbo_transactions t WHERE t.entity_type = 'Invoice' AND t.customer_qbo_id IN :ids) x
        WHERE rn = 1 ORDER BY txn_date DESC""").bindparams(bindparam("ids", expanding=True)), {"ids": list(ids)}).mappings().all()


def _cos(conn, qbo_id):
    """Change orders on a project the customer should see: QuickBooks estimates on
    the project after the original (Pending = waiting on them), plus change orders
    made in the app and sent. Keys: 'q<estimate qbo id>' or 'a<app id>'."""
    from app.change_orders.routes import _project_estimates, _derive_status, _overlays
    ests = _project_estimates(conn, qbo_id)
    ov = _overlays(conn, qbo_id)
    by_q = {str(o["qbo_estimate_id"]): o for o in ov if o["qbo_estimate_id"]}
    ids = [o["id"] for o in ov]
    resp = {}
    if ids:
        for r in conn.execute(text("SELECT co_id, decision, signer_name, note, at FROM change_order_responses WHERE co_id IN :i ORDER BY at")
                              .bindparams(bindparam("i", expanding=True)), {"i": ids}).mappings():
            resp[r["co_id"]] = {"decision": r["decision"], "by": r["signer_name"], "note": r["note"], "at": str(r["at"])[:16]}
    out = []
    for e in ests[1:]:   # the oldest estimate is the original contract
        o = by_q.get(str(e["qbo_id"]))
        st = (o["status"] if o and o["status"] in ("approved", "rejected") else None) or _derive_status(e["qbo_status"])
        if st == "draft":
            continue
        out.append({"id": f"q{e['qbo_id']}", "number": e["doc_number"], "title": (o and o["title"]) or f"Estimate {e['doc_number']}",
                    "reason": o and o["reason"], "scope": o and o["scope"], "amount": float(e["amount"] or 0),
                    "status": st, "date": str(e["txn_date"]) if e["txn_date"] else None, "response": resp.get(o["id"]) if o else None})
    for o in ov:
        if o["qbo_estimate_id"] or o["kind"] != "change_order" or o["status"] not in ("sent", "approved", "rejected"):
            continue
        out.append({"id": f"a{o['id']}", "number": o["co_number"], "title": o["title"] or "Change order", "reason": o["reason"],
                    "scope": o["scope"], "amount": float(o["amount"] or 0), "status": o["status"], "date": None,
                    "response": resp.get(o["id"])})
    out.sort(key=lambda x: (x["status"] != "sent", x["date"] or ""))
    return out


@router.get("/projects")
def projects(c=Depends(customer)):
    with engine.connect() as conn:
        ids = _project_ids(conn, c["customer_qbo_id"])
        sc = _sched(conn, ids)
        inv = _invoices(conn, ids)
        cos = {e: sum(1 for x in _cos(conn, e) if x["status"] == "sent") for e in ids if e in sc}
    by = {}
    for i in inv:
        b = by.setdefault(str(i["customer_qbo_id"]), [0.0, 0.0])
        b[0] += float(i["total_amt"] or 0)
        b[1] += float(i["balance_amt"] or 0)
    out = []
    for e, r in sc.items():
        if r["st"] == "canceled":
            continue
        out.append({"qbo_id": e, "name": r["display_name"], "status": STATUS.get(r["st"] or "pending", "Being scheduled"),
                    "start": str(r["s"]) if r["s"] else None, "end": str(r["e"]) if r["e"] else None, "pm": r["pms"],
                    "invoiced": round(by.get(e, [0, 0])[0], 2), "balance": round(by.get(e, [0, 0])[1], 2),
                    "change_orders_waiting": int(cos.get(e, 0))})
    rank = {"In progress": 0, "Scheduled": 1, "Being scheduled": 2, "On hold": 3, "Complete": 4}
    out.sort(key=lambda p: (rank.get(p["status"], 5), p["start"] or "9999"))
    return {"customer": c["display_name"], "projects": out,
            "balance": round(sum(p["balance"] for p in out), 2)}


@router.get("/project/{qbo_id}")
def project(qbo_id: str, c=Depends(customer)):
    with engine.connect() as conn:
        _own(conn, c, qbo_id)
        sc = _sched(conn, {qbo_id}).get(qbo_id)
        inv = _invoices(conn, {qbo_id})
        docs = conn.execute(text("""SELECT id, folder, original_filename, created_at FROM documents
                                    WHERE entity_type = 'project' AND entity_id = :e AND drive_removed_at IS NULL AND folder IN :f
                                    ORDER BY folder, original_filename""").bindparams(bindparam("f", expanding=True)),
                            {"e": qbo_id, "f": list(DOC_FOLDERS)}).mappings().all()
        cos = _cos(conn, qbo_id)
    if not sc:
        raise HTTPException(404, "Project not found")
    return {
        "qbo_id": qbo_id, "name": sc["display_name"], "status": STATUS.get(sc["st"] or "pending", "Being scheduled"),
        "start": str(sc["s"]) if sc["s"] else None, "end": str(sc["e"]) if sc["e"] else None, "pm": sc["pms"],
        "invoices": [{"doc": i["doc_number"], "date": str(i["txn_date"]) if i["txn_date"] else None,
                      "due": str(i["due_date"]) if i["due_date"] else None, "amount": float(i["total_amt"] or 0),
                      "balance": float(i["balance_amt"] or 0)} for i in inv],
        "documents": [{"id": d["id"], "group": DOC_FOLDERS.get(d["folder"], "Documents"), "name": d["original_filename"],
                       "date": str(d["created_at"])[:10] if d["created_at"] else None} for d in docs],
        "change_orders": cos,
    }


@router.get("/file/{doc_id}")
def file(doc_id: int, c=Depends(customer)):
    with engine.connect() as conn:
        d = conn.execute(text("SELECT entity_type, entity_id, folder, s3_key, original_filename FROM documents WHERE id = :i"),
                         {"i": doc_id}).mappings().first()
        if not d or d["entity_type"] != "project" or d["folder"] not in DOC_FOLDERS or not d["s3_key"]:
            raise HTTPException(404, "Document not found")
        _own(conn, c, d["entity_id"])
    return {"url": signed_file_url(d["s3_key"]), "name": d["original_filename"]}


class RespondIn(BaseModel):
    decision: str
    name: str
    note: Optional[str] = None


@router.post("/change-order/{key}/respond")
def respond(key: str, body: RespondIn, request: Request, c=Depends(customer)):
    """key: 'q<QuickBooks estimate id>' (a Pending estimate on the project) or 'a<app change order id>'."""
    if body.decision not in ("approved", "declined"):
        raise HTTPException(400, "Approve or decline")
    if len((body.name or "").strip()) < 2:
        raise HTTPException(400, "Type your full name to sign")
    status = "approved" if body.decision == "approved" else "rejected"
    with engine.begin() as conn:
        if key.startswith("q"):
            est = conn.execute(text("""SELECT t.qbo_id, t.doc_number, MAX(t.total_amt) amt, MAX(sl.project_customer_qbo_id) pid,
                                              MAX(JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus'))) st
                                       FROM qbo_transactions t JOIN qbo_sales_transaction_lines sl ON sl.transaction_id = t.id
                                       WHERE t.entity_type = 'Estimate' AND t.qbo_id = :q GROUP BY t.qbo_id, t.doc_number"""),
                               {"q": key[1:]}).mappings().first()
            if not est or not est["pid"]:
                raise HTTPException(404, "Change order not found")
            pid = str(est["pid"])
            _own(conn, c, pid)
            co = conn.execute(text("SELECT id, title, status FROM project_change_orders WHERE project_qbo_id = :p AND qbo_estimate_id = :q"),
                              {"p": pid, "q": key[1:]}).mappings().first()
            if (co and co["status"] in ("approved", "rejected")) or est["st"] != "Pending":
                raise HTTPException(409, "This change order has already been answered")
            title, amount = (co and co["title"]) or f"Estimate {est['doc_number']}", float(est["amt"] or 0)
            if not co:
                res = conn.execute(text("""INSERT INTO project_change_orders (project_qbo_id, qbo_estimate_id, kind, title, amount, status)
                                           VALUES (:p, :q, 'change_order', :t, :a, :s)"""),
                                   {"p": pid, "q": key[1:], "t": title, "a": amount, "s": status})
                co_id = res.lastrowid
            else:
                conn.execute(text("UPDATE project_change_orders SET status = :s WHERE id = :i"), {"s": status, "i": co["id"]})
                co_id = co["id"]
        else:
            co = conn.execute(text("SELECT id, project_qbo_id, title, amount, status FROM project_change_orders WHERE id = :i AND kind = 'change_order'"),
                              {"i": int(key.lstrip("a") or 0)}).mappings().first()
            if not co:
                raise HTTPException(404, "Change order not found")
            pid = str(co["project_qbo_id"])
            _own(conn, c, pid)
            if co["status"] != "sent":
                raise HTTPException(409, "This change order has already been answered")
            conn.execute(text("UPDATE project_change_orders SET status = :s WHERE id = :i"), {"s": status, "i": co["id"]})
            co_id, title, amount = co["id"], co["title"] or "Change order", float(co["amount"] or 0)
        conn.execute(text("""INSERT INTO change_order_responses (co_id, decision, signer_name, note, access_id, ip)
                             VALUES (:c, :d, :n, :t, :a, :ip)"""),
                     {"c": co_id, "d": body.decision, "n": body.name.strip()[:160], "t": (body.note or "").strip() or None,
                      "a": c["id"], "ip": (request.client.host if request.client else None)})
        name = conn.execute(text("SELECT display_name FROM qbo_customers WHERE qbo_id = :q"), {"q": pid}).scalar()
    actor = {"id": None, "email": f"customer:{body.name.strip()[:60]}"}
    record_audit(actor, "change_order.customer_" + body.decision, "change_order", co_id, title,
                 {"project_qbo_id": pid, "amount": amount, "note": body.note, "via": "customer portal"})
    try:   # tell the PM and the owners watching every project
        from app.help.notify import notify
        from app.help.watch import _project_people, WATCH_ALL
        with engine.connect() as conn:
            people, _ = _project_people(conn, qbo_ids={pid})
            watchers = [r[0] for r in conn.execute(text("SELECT user_id FROM notification_prefs WHERE kind = :k AND in_app = 1"),
                                                   {"k": WATCH_ALL}).all()]
        pms = (people.get(pid) or (None, []))[1]
        lines = [f"{title} · ${amount:,.0f}", f"Signed by {body.name.strip()}"]
        if body.note:
            lines.append(f'"{body.note.strip()}"')
        if key.startswith("q") and body.decision == "approved":
            lines.append("Mark the estimate Accepted in QuickBooks.")
        notify(set(pms) | set(watchers), "change.order",
               f"Customer {'approved' if body.decision == 'approved' else 'declined'} a change order: {name}",
               body="\n".join(lines), link=f"#/entity/project/{pid}?tab=changeorders", subject=pid,
               dedupe_key=f"co.response:{co_id}")
    except Exception:
        pass
    return {"ok": True}
