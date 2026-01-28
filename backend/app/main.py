from fastapi import FastAPI, Depends, HTTPException, status, Header
from pydantic import BaseModel
from datetime import datetime, timedelta
import os

from jose import jwt, JWTError
from passlib.context import CryptContext

from .db import db_check
from sqlalchemy import text

app = FastAPI()

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

JWT_SECRET = os.getenv("JWT_SECRET", "dev-only-change-me")
JWT_ALG = "HS256"
JWT_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", "60"))


class LoginRequest(BaseModel):
    email: str
    password: str


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
