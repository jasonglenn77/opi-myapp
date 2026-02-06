import os
import base64
import urllib.parse
import secrets
import json
from datetime import datetime, timedelta

import httpx
from sqlalchemy import text

from app.db import engine

from decimal import Decimal
from typing import Any, Optional

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

def _parse_bool(v: Any) -> Optional[int]:
    if v is None:
        return None
    return 1 if bool(v) else 0

def _parse_decimal(v: Any) -> Optional[Decimal]:
    if v is None:
        return None
    try:
        return Decimal(str(v))
    except Exception:
        return None

def _parse_qbo_dt(s: Any) -> Optional[datetime]:
    # QBO returns ISO with timezone, e.g. "2026-02-05T22:39:07-08:00"
    if not s or not isinstance(s, str):
        return None
    try:
        # Python 3.11+ handles offset with fromisoformat
        return datetime.fromisoformat(s)
    except Exception:
        return None


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
              job TINYINT(1) NULL,
              active TINYINT(1) NULL,
              is_project TINYINT(1) NULL,
              parent_qbo_id VARCHAR(32) NULL,
              balance_with_jobs DECIMAL(18,2) NULL,
              meta_create_time DATETIME NULL,
              meta_last_updated_time DATETIME NULL,
              raw_json JSON NOT NULL,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        """))

        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS qbo_sync_runs (
              id INT AUTO_INCREMENT PRIMARY KEY,
              sync_type VARCHAR(50) NOT NULL,
              triggered_by VARCHAR(50) NOT NULL,
              started_at DATETIME NOT NULL,
              finished_at DATETIME NULL,
              success TINYINT(1) NOT NULL DEFAULT 0,
              fetched_count INT NOT NULL DEFAULT 0,
              upserted_count INT NOT NULL DEFAULT 0,
              error_message TEXT NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              INDEX idx_sync_type_started (sync_type, started_at)
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

def log_sync_start(sync_type: str, triggered_by: str) -> int:
    qbo_init_tables()
    with engine.begin() as conn:
        res = conn.execute(text("""
            INSERT INTO qbo_sync_runs (sync_type, triggered_by, started_at, success)
            VALUES (:sync_type, :triggered_by, UTC_TIMESTAMP(), 0)
        """), {"sync_type": sync_type, "triggered_by": triggered_by})
        return int(res.lastrowid)


def log_sync_finish(run_id: int, success: bool, fetched: int = 0, upserted: int = 0, error_message: str | None = None) -> None:
    with engine.begin() as conn:
        conn.execute(text("""
            UPDATE qbo_sync_runs
            SET finished_at = UTC_TIMESTAMP(),
                success = :success,
                fetched_count = :fetched,
                upserted_count = :upserted,
                error_message = :error_message
            WHERE id = :id
        """), {
            "id": run_id,
            "success": 1 if success else 0,
            "fetched": int(fetched or 0),
            "upserted": int(upserted or 0),
            "error_message": error_message,
        })

# FOR CUSTOMERS INTO qbo_customers TABLE
def fetch_customers(realm_id: str, access_token: str, page_size: int = 500) -> list[dict]:
    url = f"{QBO_API_BASE}/v3/company/{realm_id}/query"
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}

    all_rows: list[dict] = []
    start = 1  # STARTPOSITION is 1-based
    with httpx.Client(timeout=60) as client:
        while True:
            query = f"SELECT * FROM Customer STARTPOSITION {start} MAXRESULTS {int(page_size)}"
            r = client.get(url, headers=headers, params={"query": query})
            r.raise_for_status()
            data = r.json()
            rows = data.get("QueryResponse", {}).get("Customer", []) or []
            all_rows.extend(rows)

            if len(rows) < page_size:
                break
            start += page_size

    return all_rows

def upsert_customers(customers: list[dict]) -> int:
    qbo_init_tables()
    count = 0

    with engine.begin() as conn:
        for c in customers:
            qbo_id = str(c.get("Id") or "")
            if not qbo_id:
                continue

            display_name = c.get("DisplayName")
            pe = c.get("PrimaryEmailAddr") or {}
            email = pe.get("Address") if isinstance(pe, dict) else None

            job = _parse_bool(c.get("Job"))
            active = _parse_bool(c.get("Active"))
            is_project = _parse_bool(c.get("IsProject"))

            parent_qbo_id = None
            pref = c.get("ParentRef") or {}
            if isinstance(pref, dict) and pref.get("value"):
                parent_qbo_id = str(pref.get("value"))

            balance_with_jobs = _parse_decimal(c.get("BalanceWithJobs"))

            md = c.get("MetaData") or {}
            meta_create_time = _parse_qbo_dt(md.get("CreateTime")) if isinstance(md, dict) else None
            meta_last_updated_time = _parse_qbo_dt(md.get("LastUpdatedTime")) if isinstance(md, dict) else None

            conn.execute(text("""
                INSERT INTO qbo_customers (
                  qbo_id, display_name, email, raw_json,
                  job, active, is_project, parent_qbo_id,
                  balance_with_jobs, meta_create_time, meta_last_updated_time
                )
                VALUES (
                  :qbo_id, :display_name, :email, CAST(:raw AS JSON),
                  :job, :active, :is_project, :parent_qbo_id,
                  :balance_with_jobs, :meta_create_time, :meta_last_updated_time
                )
                ON DUPLICATE KEY UPDATE
                  display_name = VALUES(display_name),
                  email = VALUES(email),
                  raw_json = VALUES(raw_json),
                  job = VALUES(job),
                  active = VALUES(active),
                  is_project = VALUES(is_project),
                  parent_qbo_id = VALUES(parent_qbo_id),
                  balance_with_jobs = VALUES(balance_with_jobs),
                  meta_create_time = VALUES(meta_create_time),
                  meta_last_updated_time = VALUES(meta_last_updated_time)
            """), {
                "qbo_id": qbo_id,
                "display_name": display_name,
                "email": email,
                "raw": json.dumps(c),

                "job": job,
                "active": active,
                "is_project": is_project,
                "parent_qbo_id": parent_qbo_id,
                "balance_with_jobs": balance_with_jobs,
                "meta_create_time": meta_create_time,
                "meta_last_updated_time": meta_last_updated_time,
            })

            count += 1

    return count

def run_customers_sync(triggered_by: str = "manual") -> dict:
    run_id = log_sync_start("customers", triggered_by)
    try:
        realm_id, access_token = get_valid_access_token()
        customers = fetch_customers(realm_id, access_token)
        upserted = upsert_customers(customers)
        log_sync_finish(run_id, True, fetched=len(customers), upserted=upserted)
        return {
            "realm_id": realm_id,
            "customers_fetched": len(customers),
            "customers_upserted": upserted,
            "run_id": run_id,
        }
    except Exception as e:
        log_sync_finish(run_id, False, error_message=str(e))
        raise
