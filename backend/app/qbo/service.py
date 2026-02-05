import os
import base64
import urllib.parse
import secrets
import json
from datetime import datetime, timedelta

import httpx
from sqlalchemy import text

from app.db import engine

QBO_CLIENT_ID = os.getenv("QBO_CLIENT_ID")
QBO_CLIENT_SECRET = os.getenv("QBO_CLIENT_SECRET")
QBO_REDIRECT_URI = os.getenv("QBO_REDIRECT_URI")

QBO_AUTH_URL = os.getenv("QBO_AUTH_URL", "https://appcenter.intuit.com/connect/oauth2")
QBO_TOKEN_URL = os.getenv("QBO_TOKEN_URL", "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer")

QBO_API_BASE = os.getenv("QBO_API_BASE", "https://quickbooks.api.intuit.com")
QBO_GRAPHQL_BASE = os.getenv("QBO_GRAPHQL_BASE", "https://qb.api.intuit.com/graphql")

SCOPES = ["com.intuit.quickbooks.accounting"]


def _basic_auth_header() -> str:
    raw = f"{QBO_CLIENT_ID}:{QBO_CLIENT_SECRET}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("utf-8")


def qbo_init_tables() -> None:
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS qbo_connection (
              id INT AUTO_INCREMENT PRIMARY KEY,
              realm_id VARCHAR(32) NOT NULL UNIQUE,
              access_token TEXT NOT NULL,
              refresh_token TEXT NOT NULL,
              expires_at DATETIME NOT NULL,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        """))

        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS qbo_customers (
              id INT AUTO_INCREMENT PRIMARY KEY,
              qbo_id VARCHAR(32) NOT NULL UNIQUE,
              display_name VARCHAR(255) NULL,
              email VARCHAR(255) NULL,
              raw_json JSON NOT NULL,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        """))


def build_auth_url() -> str:
    if not all([QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI]):
        raise RuntimeError("Missing QBO env vars: QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI")

    state = secrets.token_urlsafe(24)
    params = {
        "client_id": QBO_CLIENT_ID,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "redirect_uri": QBO_REDIRECT_URI,
        "state": state,
    }
    return QBO_AUTH_URL + "?" + urllib.parse.urlencode(params)


def exchange_code_for_tokens(code: str) -> dict:
    headers = {
        "Authorization": _basic_auth_header(),
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": QBO_REDIRECT_URI,
    }
    with httpx.Client(timeout=30) as client:
        r = client.post(QBO_TOKEN_URL, headers=headers, data=data)
        r.raise_for_status()
        return r.json()


def refresh_access_token(refresh_token: str) -> dict:
    headers = {
        "Authorization": _basic_auth_header(),
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    data = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }
    with httpx.Client(timeout=30) as client:
        r = client.post(QBO_TOKEN_URL, headers=headers, data=data)
        r.raise_for_status()
        return r.json()


def upsert_connection(realm_id: str, tokens: dict) -> None:
    qbo_init_tables()

    access_token = tokens["access_token"]
    refresh_token = tokens["refresh_token"]
    expires_in = int(tokens.get("expires_in", 3600))
    expires_at = datetime.utcnow() + timedelta(seconds=expires_in - 60)

    with engine.begin() as conn:
        conn.execute(text("""
            INSERT INTO qbo_connection (realm_id, access_token, refresh_token, expires_at)
            VALUES (:realm_id, :access_token, :refresh_token, :expires_at)
            ON DUPLICATE KEY UPDATE
              access_token = VALUES(access_token),
              refresh_token = VALUES(refresh_token),
              expires_at = VALUES(expires_at)
        """), {
            "realm_id": realm_id,
            "access_token": access_token,
            "refresh_token": refresh_token,
            "expires_at": expires_at,
        })


def get_connection() -> dict | None:
    qbo_init_tables()
    with engine.connect() as conn:
        row = conn.execute(text("""
            SELECT realm_id, access_token, refresh_token, expires_at
            FROM qbo_connection
            ORDER BY id DESC
            LIMIT 1
        """)).mappings().first()
    return dict(row) if row else None


def get_valid_access_token() -> tuple[str, str]:
    c = get_connection()
    if not c:
        raise RuntimeError("No QBO connection saved yet. Go through /api/qbo/start first.")

    realm_id = c["realm_id"]
    access_token = c["access_token"]
    refresh_token = c["refresh_token"]
    expires_at = c["expires_at"]

    # If not expired, use it
    if datetime.utcnow() < expires_at:
        return realm_id, access_token

    # Refresh and store newest tokens
    new_tokens = refresh_access_token(refresh_token)
    upsert_connection(realm_id, new_tokens)
    return realm_id, new_tokens["access_token"]


# FOR CUSTOMERS INTO qbo_customers TABLE
def fetch_customers(realm_id: str, access_token: str, limit: int = 200) -> list[dict]:
    query = f"SELECT * FROM Customer MAXRESULTS {int(limit)}"
    url = f"{QBO_API_BASE}/v3/company/{realm_id}/query"
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    with httpx.Client(timeout=30) as client:
        r = client.get(url, headers=headers, params={"query": query})
        r.raise_for_status()
        data = r.json()
    return data.get("QueryResponse", {}).get("Customer", []) or []

def upsert_customers(customers: list[dict]) -> int:
    qbo_init_tables()
    count = 0
    with engine.begin() as conn:
        for c in customers:
            qbo_id = str(c.get("Id") or "")
            if not qbo_id:
                continue

            display_name = c.get("DisplayName")
            email = None
            pe = c.get("PrimaryEmailAddr") or {}
            if isinstance(pe, dict):
                email = pe.get("Address")

            conn.execute(text("""
                INSERT INTO qbo_customers (qbo_id, display_name, email, raw_json)
                VALUES (:qbo_id, :display_name, :email, CAST(:raw AS JSON))
                ON DUPLICATE KEY UPDATE
                  display_name = VALUES(display_name),
                  email = VALUES(email),
                  raw_json = VALUES(raw_json)
            """), {
                "qbo_id": qbo_id,
                "display_name": display_name,
                "email": email,
                "raw": json.dumps(c),
            })
            count += 1
    return count

def run_customers_sync() -> dict:
    realm_id, access_token = get_valid_access_token()
    customers = fetch_customers(realm_id, access_token)
    upserted = upsert_customers(customers)
    return {"realm_id": realm_id, "customers_fetched": len(customers), "customers_upserted": upserted}
