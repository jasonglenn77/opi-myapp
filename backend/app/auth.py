import os
from datetime import datetime, timedelta

from fastapi import Depends, HTTPException, status, Header
from jose import jwt, JWTError
from sqlalchemy import text

from .db import engine

JWT_SECRET = os.getenv("JWT_SECRET", "dev-only-change-me")
JWT_ALG = "HS256"
JWT_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", "60"))

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

    return {"id": user["id"], "email": user["email"], "role": user["role"]}

def require_admin(user=Depends(get_current_user)):
    if (user.get("role") or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user
