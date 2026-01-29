import os
from sqlalchemy import create_engine, text

# In production, we rely on real environment variables (from Docker / Lightsail).
# If you want dotenv loading locally, set LOAD_DOTENV=1 in your local env and keep a backend/.env file.
if os.getenv("LOAD_DOTENV", "0") == "1":
    from pathlib import Path
    from dotenv import load_dotenv

    BACKEND_DIR = Path(__file__).resolve().parents[1]  # .../backend
    ENV_PATH = BACKEND_DIR / ".env"
    load_dotenv(dotenv_path=ENV_PATH, override=False)

DB_HOST = os.getenv("DB_HOST")
DB_PORT = os.getenv("DB_PORT", "3306")
DB_NAME = os.getenv("DB_NAME")
DB_USER = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")

if not all([DB_HOST, DB_NAME, DB_USER, DB_PASSWORD]):
    raise RuntimeError(
        "Missing DB env vars. Need DB_HOST, DB_NAME, DB_USER, DB_PASSWORD (and optional DB_PORT)."
    )

MYSQL_SSL_MODE = os.getenv("MYSQL_SSL_MODE", "").lower()

DATABASE_URL = f"mysql+pymysql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"

connect_args = {}
if MYSQL_SSL_MODE in ("require", "required"):
    # PyMySQL expects ssl to be a dict, not a string.
    # This requests TLS without CA verification (good starter setting for managed DBs).
    connect_args["ssl"] = {}

engine = create_engine(DATABASE_URL, pool_pre_ping=True, connect_args=connect_args)

def db_check() -> dict:
    with engine.connect() as conn:
        version = conn.execute(text("SELECT VERSION()")).scalar()
    return {"connected": True, "mysql_version": version}

def db_config_safe() -> dict:
    return {
        "db_host": DB_HOST,
        "db_port": DB_PORT,
        "db_name": DB_NAME,
        "db_user": DB_USER,
    }

def notes_add_and_list(message: str) -> dict:
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS notes (
              id INT AUTO_INCREMENT PRIMARY KEY,
              message VARCHAR(255) NOT NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """))

        conn.execute(
            text("INSERT INTO notes (message) VALUES (:message)"),
            {"message": message},
        )

        rows = conn.execute(text("""
            SELECT id, message, created_at
            FROM notes
            ORDER BY id DESC
            LIMIT 10
        """)).mappings().all()

    return {"inserted": True, "latest": [dict(r) for r in rows]}
