"""
Sign in with Microsoft (OPI's Microsoft 365 accounts). Built switched OFF: it
turns on once these are set on the backend (from an app registration in OPI's
Microsoft Entra / Azure portal):

    MS_TENANT_ID       the directory (tenant) id
    MS_CLIENT_ID       the application (client) id
    MS_CLIENT_SECRET   a client secret for it
    MS_REDIRECT_URI    optional; default {APP_BASE_URL}/api/auth/microsoft/callback
                       (add exactly this as a "Web" redirect URI on the registration)
    MS_ALLOWED_DOMAINS optional; default onpointinstallers.com (comma-separated)

Flow (OpenID Connect authorization code):
  GET /api/auth/microsoft/config     {enabled} for the login page
  GET /api/auth/microsoft/start      -> Microsoft's sign-in page
  GET /api/auth/microsoft/callback   code -> tokens (server to server) -> the
                                     signed-in email must belong to an ACTIVE user
                                     in the app (no account is created by signing
                                     in) -> back to /#/sso?token=<app token>

Passwords keep working alongside it. Users are still created and given roles on
the Users page; Microsoft only proves who they are.
"""
import base64
import json
import os
import secrets
from datetime import datetime, timedelta
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse
from jose import JWTError, jwt
from sqlalchemy import text

from app import mailer
from app.audit import record_audit
from app.auth import JWT_ALG, JWT_SECRET, create_access_token
from app.db import engine

router = APIRouter(prefix="/api/auth/microsoft", tags=["auth"])


def _cfg():
    base = mailer.app_base_url()
    return {
        "tenant": os.getenv("MS_TENANT_ID", "").strip(),
        "client_id": os.getenv("MS_CLIENT_ID", "").strip(),
        "secret": os.getenv("MS_CLIENT_SECRET", "").strip(),
        "redirect": os.getenv("MS_REDIRECT_URI", "").strip() or f"{base}/api/auth/microsoft/callback",
        "domains": [d.strip().lower() for d in os.getenv("MS_ALLOWED_DOMAINS", "onpointinstallers.com").split(",") if d.strip()],
        "base": base,
    }


def enabled() -> bool:
    c = _cfg()
    return bool(c["tenant"] and c["client_id"] and c["secret"])


def _back(msg=None, token=None):
    base = _cfg()["base"]
    if token:
        return RedirectResponse(f"{base}/#/sso?token={token}", status_code=302)
    return RedirectResponse(f"{base}/#/login?sso_error={msg or 'failed'}", status_code=302)


@router.get("/config")
def config():
    return {"enabled": enabled()}


@router.get("/start")
def start():
    if not enabled():
        raise HTTPException(404, "Microsoft sign-in isn't set up")
    c = _cfg()
    nonce = secrets.token_urlsafe(16)
    state = jwt.encode({"n": nonce, "p": "ms_state", "exp": datetime.utcnow() + timedelta(minutes=10)}, JWT_SECRET, algorithm=JWT_ALG)
    q = {"client_id": c["client_id"], "response_type": "code", "redirect_uri": c["redirect"], "response_mode": "query",
         "scope": "openid email profile", "state": state, "nonce": nonce, "prompt": "select_account"}
    return RedirectResponse(f"https://login.microsoftonline.com/{c['tenant']}/oauth2/v2.0/authorize?{urlencode(q)}", status_code=302)


def _claims(id_token: str) -> dict:
    # The id_token comes straight from Microsoft's token endpoint over TLS, in
    # exchange for our code and client secret, so its payload can be read
    # without re-checking the signature (OpenID Connect Core 3.1.3.7).
    part = id_token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))


@router.get("/callback")
def callback(code: str = "", state: str = "", error: str = "", error_description: str = ""):
    if error:
        return _back("cancelled" if error == "access_denied" else "microsoft")
    if not enabled():
        return _back("off")
    try:
        st = jwt.decode(state, JWT_SECRET, algorithms=[JWT_ALG])
        if st.get("p") != "ms_state":
            raise JWTError("wrong state")
    except JWTError:
        return _back("expired")
    c = _cfg()
    try:
        r = httpx.post(f"https://login.microsoftonline.com/{c['tenant']}/oauth2/v2.0/token", timeout=20, data={
            "client_id": c["client_id"], "client_secret": c["secret"], "grant_type": "authorization_code",
            "code": code, "redirect_uri": c["redirect"], "scope": "openid email profile"})
        r.raise_for_status()
        claims = _claims(r.json()["id_token"])
    except Exception:
        return _back("microsoft")
    if claims.get("nonce") != st.get("n") or claims.get("tid") != c["tenant"] or claims.get("aud") != c["client_id"]:
        return _back("mismatch")
    email = (claims.get("email") or claims.get("preferred_username") or "").strip().lower()
    if not email or (c["domains"] and email.split("@")[-1] not in c["domains"]):
        record_audit(None, "auth.login_failed", "user", None, email, {"why": "microsoft: email domain not allowed"})
        return _back("domain")
    with engine.begin() as conn:
        u = conn.execute(text("SELECT id, email, is_active FROM users WHERE email = :e"), {"e": email}).mappings().first()
        if not u or int(u["is_active"]) != 1:
            record_audit(None, "auth.login_failed", "user", u["id"] if u else None, email, {"why": "microsoft: no active account"})
            return _back("no_account")
        conn.execute(text("UPDATE users SET last_login_at = NOW() WHERE id = :i"), {"i": u["id"]})
    record_audit({"id": u["id"], "email": u["email"]}, "auth.login", "user", u["id"], u["email"], {"method": "microsoft"})
    return _back(token=create_access_token(sub=u["email"]))
