"""
Lightweight SQL migration runner.

Replaces the manual "copy SQL into DBeaver, run on local, then run on prod"
workflow. Migrations are plain .sql files in backend/migrations/, named with a
zero-padded sequence prefix (0001_..., 0002_...). Each file is applied at most
once; applied versions are recorded in a `schema_migrations` table so re-running
is safe and idempotent.

Usage (from the backend/ directory or inside the backend container):

    python -m app.migrate            # apply all pending migrations
    python -m app.migrate --status   # show applied vs pending, apply nothing

Point it at a database the same way the app does: via DB_HOST/DB_NAME/DB_USER/
DB_PASSWORD env vars (set LOAD_DOTENV=1 to read backend/.env locally). To run
against prod, run it in the prod environment, e.g.:

    docker compose exec backend python -m app.migrate

Note: MySQL auto-commits DDL, so a migration file that fails partway cannot be
rolled back. Keep each migration focused, and fix-forward if one half-applies.
"""

import sys
from pathlib import Path

from sqlalchemy import text

from .db import engine

MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"


def _split_statements(sql_text: str):
    """Split a migration file into individual statements.

    Strips full-line `--` comments and splits on semicolons. This is sufficient
    for our DDL/DML migrations (no semicolons inside string literals, no stored
    procedures). If we ever need those, switch to a delimiter-aware parser.
    """
    lines = []
    for line in sql_text.splitlines():
        if line.strip().startswith("--"):
            continue
        lines.append(line)
    joined = "\n".join(lines)
    return [s.strip() for s in joined.split(";") if s.strip()]


def _ensure_tracking_table():
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
              version VARCHAR(255) PRIMARY KEY,
              applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """))


def _applied_versions():
    with engine.connect() as conn:
        return set(conn.execute(text("SELECT version FROM schema_migrations")).scalars().all())


def _migration_files():
    if not MIGRATIONS_DIR.exists():
        return []
    return sorted(MIGRATIONS_DIR.glob("*.sql"), key=lambda p: p.name)


def status():
    _ensure_tracking_table()
    done = _applied_versions()
    files = _migration_files()
    print(f"migrations dir: {MIGRATIONS_DIR}")
    for path in files:
        mark = "applied" if path.name in done else "PENDING"
        print(f"  [{mark}] {path.name}")
    pending = [p.name for p in files if p.name not in done]
    print(f"\n{len(pending)} pending, {len(done)} applied")
    return pending


def run():
    _ensure_tracking_table()
    done = _applied_versions()
    applied = []
    for path in _migration_files():
        version = path.name
        if version in done:
            continue
        statements = _split_statements(path.read_text(encoding="utf-8"))
        print(f"applying {version} ({len(statements)} statement(s))...")
        with engine.begin() as conn:
            for stmt in statements:
                conn.execute(text(stmt))
            conn.execute(
                text("INSERT INTO schema_migrations (version) VALUES (:v)"),
                {"v": version},
            )
        applied.append(version)
        print(f"  ok: {version}")
    if not applied:
        print("no pending migrations")
    else:
        print(f"applied {len(applied)} migration(s)")
    return applied


if __name__ == "__main__":
    if "--status" in sys.argv:
        status()
    else:
        run()
