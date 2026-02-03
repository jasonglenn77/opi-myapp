from fastapi import FastAPI, Depends, HTTPException, status, Header
from pydantic import BaseModel
from datetime import datetime, timedelta
import os

from jose import jwt, JWTError
from passlib.context import CryptContext

from .db import db_check
from sqlalchemy import text

import uuid
from typing import Optional

app = FastAPI()

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

JWT_SECRET = os.getenv("JWT_SECRET", "dev-only-change-me")
JWT_ALG = "HS256"
JWT_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", "60"))


class LoginRequest(BaseModel):
    email: str
    password: str

class UserCreateRequest(BaseModel):
    email: str
    password: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    role: str = "user"
    is_active: bool = True

class UserUpdateRequest(BaseModel):
    email: Optional[str] = None
    password: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    role: Optional[str] = None
    is_active: Optional[bool] = None

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

    # Validate user still exists + active in DB
    from .db import engine
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

@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/db-check")
def database_check():
    return db_check()

def get_user_by_email(email: str):
    # Uses SQLAlchemy engine from db.py (most likely you already have it)
    from .db import engine
    with engine.connect() as conn:
        row = conn.execute(
            text("""
                SELECT id, email, password_hash, role, is_active
                FROM users
                WHERE email = :email
                LIMIT 1
            """),
            {"email": email.lower()},
        ).mappings().first()
        return row


@app.post("/api/login")
def login(req: LoginRequest):
    user = get_user_by_email(req.email)

    # Keep error generic so we don't leak whether email exists
    if not user or int(user["is_active"]) != 1:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if not pwd_context.verify(req.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    # (optional) update last_login_at
    from .db import engine
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE users SET last_login_at = NOW() WHERE id = :id"),
            {"id": user["id"]},
        )

    token = create_access_token(sub=user["email"])
    return {"access_token": token, "token_type": "bearer", "role": user["role"]}

@app.get("/api/me")
def me(user=Depends(get_current_user)):
    return {"user": user}


@app.get("/api/dashboard")
def dashboard(user=Depends(get_current_user)):
    return {
        "welcome": "Welcome to OnPoint Installers",
        "user": user,
        "stats": {
            "open_jobs": 3,
            "quotes_pending": 2,
            "invoices_due": 1,
        },
    }

@app.get("/api/users")
def list_users(_admin=Depends(require_admin)):
    from .db import engine
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT id, uuid, email, first_name, last_name, role, is_active,
                   created_at, updated_at, last_login_at
            FROM users
            ORDER BY id DESC
        """)).mappings().all()
    return [dict(r) for r in rows]


@app.post("/api/users")
def create_user(req: UserCreateRequest, _admin=Depends(require_admin)):
    from .db import engine

    email = req.email.strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="Email required")

    role = (req.role or "user").strip().lower()
    if role not in ("admin", "user"):
        raise HTTPException(status_code=400, detail="Invalid role")

    user_uuid = str(uuid.uuid4())
    password_hash = pwd_context.hash(req.password)

    first_name = (req.first_name or "").strip() or None
    last_name = (req.last_name or "").strip() or None

    try:
        with engine.begin() as conn:
            conn.execute(text("""
                INSERT INTO users (uuid, email, first_name, last_name, password_hash, role, is_active)
                VALUES (:uuid, :email, :first_name, :last_name, :password_hash, :role, :is_active)
            """), {
                "uuid": user_uuid,
                "email": email,
                "first_name": first_name,
                "last_name": last_name,
                "password_hash": password_hash,
                "role": role,
                "is_active": 1 if req.is_active else 0,
            })
    except Exception:
        raise HTTPException(status_code=400, detail="Could not create user (email may already exist)")

    return {"ok": True}


@app.put("/api/users/{user_id}")
def update_user(user_id: int, req: UserUpdateRequest, _admin=Depends(require_admin)):
    from .db import engine

    updates = []
    params = {"id": user_id}

    if req.email is not None:
        email = req.email.strip().lower()
        if not email:
            raise HTTPException(status_code=400, detail="Email cannot be empty")
        updates.append("email = :email")
        params["email"] = email

    if req.first_name is not None:
        updates.append("first_name = :first_name")
        params["first_name"] = req.first_name.strip() or None

    if req.last_name is not None:
        updates.append("last_name = :last_name")
        params["last_name"] = req.last_name.strip() or None

    if req.role is not None:
        role = req.role.strip().lower()
        if role not in ("admin", "user"):
            raise HTTPException(status_code=400, detail="Invalid role")
        updates.append("role = :role")
        params["role"] = role

    if req.is_active is not None:
        updates.append("is_active = :is_active")
        params["is_active"] = 1 if req.is_active else 0

    if req.password is not None and req.password != "":
        updates.append("password_hash = :password_hash")
        params["password_hash"] = pwd_context.hash(req.password)

    if not updates:
        return {"ok": True, "updated": False}

    try:
        with engine.begin() as conn:
            result = conn.execute(text(f"""
                UPDATE users
                SET {", ".join(updates)}
                WHERE id = :id
            """), params)
            if result.rowcount == 0:
                raise HTTPException(status_code=404, detail="User not found")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Could not update user (email may already exist)")

    return {"ok": True, "updated": True}


@app.delete("/api/users/{user_id}")
def disable_user(user_id: int, _admin=Depends(require_admin)):
    """
    Safer than hard delete: disable the user
    """
    from .db import engine
    with engine.begin() as conn:
        result = conn.execute(text("""
            UPDATE users
            SET is_active = 0
            WHERE id = :id
        """), {"id": user_id})

    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="User not found")

    return {"ok": True}

