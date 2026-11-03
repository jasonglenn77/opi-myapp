"""
The date on each Project Completion Form, read from the file itself:

  form_field   the Date answer on the online form's PDF
  typed        a date typed on the paper form's Date line
  form_header  the date printed at the top of the online form, when the answer is blank
  file_name    a spelled-out date in the file name ("... August 21 2025.pdf")
  not_readable scans, photos and handwriting. The form counts as on file, but its
               date can't be read, so the job keeps its last scheduled day.

Numeric dates in file names aren't used: "1.20.23" is the template's version.

Runs nightly and only reads new or changed files:
  python -m app.crewpay.form_dates
"""
import io
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime

from sqlalchemy import bindparam, text

from app.crewpay import forms as F
from app.db import engine
from app.s3 import s3_client

_MONTH = r"(?:January|February|March|April|May|June|July|August|September|October|November|December)"
_LONG = _MONTH + r"\s+\d{1,2},?\s+\d{4}"
_FIELD = re.compile(r"\bDate:?\s+(?:[A-Z][a-z]+day,\s*)?(" + _LONG + ")")
_HEADER = re.compile(r"^\s*(?:[A-Z][a-z]+day,\s*)?(" + _LONG + ")")
_TYPED = re.compile(r"\bDate:?\s*_*\s*(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})")
_NAME = re.compile(_LONG, re.I)
EARLIEST = date(2019, 1, 1)


def _long(s):
    try:
        return datetime.strptime(" ".join(s.replace(",", " ").split()).title(), "%B %d %Y").date()
    except ValueError:
        return None


def _typed(m):
    mo, d, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    try:
        return date(y + 2000 if y < 100 else y, mo, d)
    except ValueError:
        return None


def _usable(d, today):
    return d if d and EARLIEST <= d <= today else None


def read_date(name, data, today=None):
    """(date or None, how) for one file."""
    today = today or date.today()
    txt = ""
    if data[:4] == b"%PDF":
        import pypdf
        try:
            reader = pypdf.PdfReader(io.BytesIO(data))
            txt = " ".join((p.extract_text() or "") for p in reader.pages[:3])
        except Exception:
            txt = ""
    txt = re.sub(r"\s+", " ", txt)
    for how, rx, parse in (("form_field", _FIELD, lambda m: _long(m.group(1))), ("typed", _TYPED, _typed),
                           ("form_header", _HEADER, lambda m: _long(m.group(1)))):
        m = rx.search(txt)
        d = _usable(parse(m), today) if m else None
        if d:
            return d, how
    m = _NAME.search(name or "")
    d = _usable(_long(m.group(0)), today) if m else None
    return (d, "file_name") if d else (None, "not_readable")


def refresh():
    """Read Completion Forms that are new or changed. Returns counts."""
    logging.getLogger("pypdf").setLevel(logging.CRITICAL)
    with engine.connect() as conn:
        on_file = F.load(conn)
        ids = [f["id"] for g in on_file.values() for f in g.get("completion", []) if f.get("id") and not f["draft"]]
        if not ids:
            return {"read": 0}
        docs = conn.execute(text("""
            SELECT d.id, d.original_filename AS f, d.s3_bucket, d.s3_key, d.drive_md5 AS md5
            FROM documents d LEFT JOIN completion_form_dates c ON c.document_id = d.id
            WHERE d.id IN :ids AND (c.document_id IS NULL OR NOT (c.drive_md5 <=> d.drive_md5))
        """).bindparams(bindparam("ids", expanding=True)), {"ids": ids}).mappings().all()

    def fetch(d):
        try:
            return d, s3_client.get_object(Bucket=d["s3_bucket"], Key=d["s3_key"])["Body"].read()
        except Exception:
            return d, None

    rows, failed = [], 0
    with ThreadPoolExecutor(6) as ex:
        for d, data in ex.map(fetch, docs):
            if data is None:
                failed += 1                 # tried again tomorrow
                continue
            found, how = read_date(d["f"], data)
            rows.append({"id": d["id"], "md5": d["md5"], "d": found, "how": how})
    if rows:
        with engine.begin() as conn:
            conn.execute(text("""
                INSERT INTO completion_form_dates (document_id, drive_md5, form_date, how) VALUES (:id, :md5, :d, :how)
                ON DUPLICATE KEY UPDATE drive_md5 = VALUES(drive_md5), form_date = VALUES(form_date),
                                        how = VALUES(how), read_at = CURRENT_TIMESTAMP
            """), rows)
    return {"read": len(rows), "dated": sum(1 for r in rows if r["d"]), "failed": failed}


if __name__ == "__main__":
    print(refresh())
