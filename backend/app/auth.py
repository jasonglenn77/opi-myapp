import os
from datetime import datetime, timedelta

from fastapi import Depends, HTTPException, status, Header
from jose import jwt, JWTError
from sqlalchemy import text

from .db import engine
from .permissions import load_capabilities

JWT_SECRET = os.getenv("JWT_SECRET", "dev-only-change-me")
JWT_ALG = "HS256"
# Sliding sessions (2026-11-12). The old fixed 8-hour token (JWT_EXPIRE_MINUTES)
# signed everyone out once a working day, even mid-task. Now a sign-in stays
# good while it's used: any successful API call made with a token older than
# RENEW_AFTER gets a fresh one back in the X-Session-Token header (api.js
# stores it). Idle for SESSION_IDLE_HOURS -> signed out; and every SESSION_MAX_DAYS
# after the password / Microsoft sign-in, sign in again regardless. A deactivated
# user is still refused on their next call (get_current_user checks is_active).
SESSION_IDLE_HOURS = int(os.getenv("JWT_SESSION_IDLE_HOURS", str(14 * 24)))
SESSION_MAX_DAYS = int(os.getenv("JWT_SESSION_MAX_DAYS", "90"))
RENEW_AFTER = timedelta(minutes=30)
RENEW_HEADER = "X-Session-Token"


def create_access_token(sub: str, auth_time: int | None = None) -> str:
    now = int(datetime.utcnow().timestamp())
    auth_time = int(auth_time or now)
    exp = min(now + SESSION_IDLE_HOURS * 3600, auth_time + SESSION_MAX_DAYS * 86400)
    payload = {"sub": sub, "iat": now, "auth": auth_time, "exp": exp}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def renewed_token(authorization: str) -> str | None:
    """A fresh staff token for a request's bearer token, or None when it doesn't
    need one yet (or isn't a staff sign-in: crew / customer-portal sessions keep
    their own lifetimes)."""
    if not (authorization or "").startswith("Bearer "):
        return None
    try:
        p = jwt.decode(authorization.removeprefix("Bearer ").strip(), JWT_SECRET, algorithms=[JWT_ALG])
    except JWTError:
        return None
    if not p.get("sub") or p.get("crew_session") or p.get("cust_session"):
        return None
    now = int(datetime.utcnow().timestamp())
    if p.get("iat") and now - int(p["iat"]) < RENEW_AFTER.total_seconds():
        return None
    auth_time = int(p.get("auth") or now)      # pre-2026-11-12 tokens: the clock starts now
    if now >= auth_time + SESSION_MAX_DAYS * 86400:
        return None
    return create_access_token(p["sub"], auth_time)

def get_current_user(authorization: str = Header(default="")):
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")

    token = authorization.removeprefix("Bearer ").strip()

    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
        email = payload.get("sub")
        if not email:
            raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid/expired token")

    # Prefer the full row (includes the resource links added in migration
    # 0001). Fall back to the legacy columns so a code deploy that lands before
    # the migration runs doesn't lock everyone out. Separate connections are
    # used so a failed SELECT can't taint the connection for the fallback.
    try:
        with engine.connect() as conn:
            user = conn.execute(
                text("""
                    SELECT id, email, role, is_active, project_manager_id, work_crew_id
                    FROM users
                    WHERE email = :email
                    LIMIT 1
                """),
                {"email": email.lower()},
            ).mappings().first()
    except Exception:
        with engine.connect() as conn:
            user = conn.execute(
                text("""
                    SELECT id, email, role, is_active
                    FROM users
                    WHERE email = :email
                    LIMIT 1
                """),
                {"email": email.lower()},
            ).mappings().first()

    if not user or int(user["is_active"]) != 1:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid/expired token")

    capabilities = load_capabilities(user["id"], user["role"])

    return {
        "id": user["id"],
        "email": user["email"],
        "role": user["role"],
        "project_manager_id": user.get("project_manager_id"),
        "work_crew_id": user.get("work_crew_id"),
        "capabilities": capabilities,
    }

def require_admin(user=Depends(get_current_user)):
    if (user.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user

def require_capability(capability: str):
    """Dependency factory: 403 unless the current user has `capability`."""
    def _dep(user=Depends(get_current_user)):
        if capability not in (user.get("capabilities") or set()):
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return user
    return _dep
