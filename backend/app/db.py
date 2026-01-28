from pathlib import Path
import os
from dotenv import load_dotenv
from sqlalchemy import create_engine, text

# Always load the .env file from the backend folder, no matter where uvicorn is started from.
BACKEND_DIR = Path(__file__).resolve().parents[1]  # .../backend
ENV_PATH = BACKEND_DIR / ".env"
load_dotenv(dotenv_path=ENV_PATH, override=True)

DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
DB_PORT = os.getenv("DB_PORT", "3307")
DB_NAME = os.getenv("DB_NAME", "myapp")
DB_USER = os.getenv("DB_USER", "myappuser")
DB_PASSWORD = os.getenv("DB_PASSWORD", "myapppassword")

DATABASE_URL = f"mysql+pymysql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"

engine = create_engine(DATABASE_URL, pool_pre_ping=True)

def db_check() -> dict:
    with engine.connect() as conn:
        version = conn.execute(text("SELECT VERSION()")).scalar()
    return {"connected": True, "mysql_version": version}

def db_config_safe() -> dict:
    # Never return the password
    return {
        "env_path": str(ENV_PATH),
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
