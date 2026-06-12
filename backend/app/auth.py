import os
from datetime import datetime, timedelta

from fastapi import Depends, HTTPException, status, Header
from jose import jwt, JWTError
from sqlalchemy import text

from .db import engine
from .permissions import load_capabilities

JWT_SECRET = os.getenv("JWT_SECRET", "dev-only-change-me")
JWT_ALG = "HS256"
JWT_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", "480"))

def create_access_token(sub: str) -> str:
    expire = datetime.utcnow() + timedelta(minutes=JWT_EXPIRE_MINUTES)
    payload = {"sub": sub, "exp": expire}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)

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
