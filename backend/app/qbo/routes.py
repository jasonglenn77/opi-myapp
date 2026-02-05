from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import text

from app.db import engine
from app.qbo import service

# TEMP for now: use your existing admin dependency from main.py
# (Once routes work, we can refactor auth to avoid circular imports if needed.)
from app.auth import require_admin

router = APIRouter(prefix="/api/qbo", tags=["qbo"])


@router.get("/start")
def qbo_start(_admin=Depends(require_admin)):
    try:
        return {"auth_url": service.build_auth_url()}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/callback")
def qbo_callback(code: str, realmId: str, state: str = ""):
    try:
        tokens = service.exchange_code_for_tokens(code)
        service.upsert_connection(realmId, tokens)
        return {"ok": True, "realm_id": realmId}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"OAuth callback failed: {e}")


@router.post("/sync/customers")
def sync_customers(_admin=Depends(require_admin)):
    try:
        return service.run_customers_sync()
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/customers/sample")
def customers_sample(limit: int = 20, _admin=Depends(require_admin)):
    service.qbo_init_tables()
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT qbo_id, display_name, email, JSON_EXTRACT(raw_json, '$') AS raw_json
            FROM qbo_customers
            ORDER BY id DESC
            LIMIT :limit
        """), {"limit": int(limit)}).mappings().all()
    return [dict(r) for r in rows]
