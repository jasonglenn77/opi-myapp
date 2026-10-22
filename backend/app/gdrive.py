"""
Google Drive access for the app (read-only), via a Google Cloud service account.

OPI shares its Drive folders/files with the service account's email; the app
then reads them server-side (document backfill into S3, B151/payment-schedule
analysis, nightly Drive → app sync). Scopes are drive.readonly +
spreadsheets.readonly — the app can never change or delete anything in OPI's Drive.

Credentials: env GOOGLE_SA_JSON_B64 = base64 of the service-account key JSON
(kept in .env / .env.prod, never in git). Auth is a self-signed JWT exchanged
for an access token (no Google client library needed).

CLI (inside the backend container):
  python -m app.gdrive whoami            # service account email + token check
  python -m app.gdrive shared            # everything shared with the account
  python -m app.gdrive ls <folderId>     # a folder's children
"""
import base64
import json
import os
import sys
import time
import threading

import httpx
from jose import jwt

SCOPE = ("https://www.googleapis.com/auth/drive.readonly "
         "https://www.googleapis.com/auth/spreadsheets.readonly")
API = "https://www.googleapis.com/drive/v3"
FOLDER = "application/vnd.google-apps.folder"
FIELDS = "id,name,mimeType,size,modifiedTime,parents,md5Checksum,owners(emailAddress)"

_tok = {"value": None, "exp": 0}
_lock = threading.Lock()


class DriveNotConfigured(RuntimeError):
    pass


def _creds():
    raw = os.getenv("GOOGLE_SA_JSON_B64", "").strip()
    if not raw:
        raise DriveNotConfigured("GOOGLE_SA_JSON_B64 is not set")
    return json.loads(base64.b64decode(raw).decode("utf-8"))


def service_email():
    return _creds()["client_email"]


def _token():
    with _lock:
        if _tok["value"] and _tok["exp"] - 60 > time.time():
            return _tok["value"]
        c = _creds()
        now = int(time.time())
        assertion = jwt.encode(
            {"iss": c["client_email"], "scope": SCOPE, "aud": c["token_uri"],
             "iat": now, "exp": now + 3600},
            c["private_key"], algorithm="RS256", headers={"kid": c.get("private_key_id")})
        r = httpx.post(c["token_uri"], timeout=30, data={
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion})
        r.raise_for_status()
        d = r.json()
        _tok["value"], _tok["exp"] = d["access_token"], now + int(d.get("expires_in", 3600))
        return _tok["value"]


def _get(path, params=None, stream=False):
    h = {"Authorization": f"Bearer {_token()}"}
    for attempt in range(5):
        r = httpx.get(f"{API}{path}", params=params, headers=h, timeout=120)
        if r.status_code in (429, 500, 502, 503) and attempt < 4:
            time.sleep(2 ** attempt)
            continue
        r.raise_for_status()
        return r
    r.raise_for_status()


def list_files(q, page_size=1000):
    """All files matching a Drive query (handles paging)."""
    out, token = [], None
    while True:
        params = {"q": q, "fields": f"nextPageToken,files({FIELDS})", "pageSize": page_size,
                  "supportsAllDrives": "true", "includeItemsFromAllDrives": "true"}
        if token:
            params["pageToken"] = token
        d = _get("/files", params).json()
        out.extend(d.get("files", []))
        token = d.get("nextPageToken")
        if not token:
            return out


def children(folder_id):
    return list_files(f"'{folder_id}' in parents and trashed = false")


def shared_with_me():
    return list_files("sharedWithMe = true and trashed = false")


def get(file_id):
    return _get(f"/files/{file_id}", {"fields": FIELDS, "supportsAllDrives": "true"}).json()


def download(file_id):
    """Raw bytes of a binary file (PDF, image, xlsx, …)."""
    return _get(f"/files/{file_id}", {"alt": "media", "supportsAllDrives": "true"}).content


def export(file_id, mime):
    """Google-native file (Sheet/Doc) exported to `mime` (e.g. xlsx, pdf)."""
    return _get(f"/files/{file_id}/export", {"mimeType": mime}).content


XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def sheet_values(sheet_id, a1_range):
    """Cell values of a Google Sheet range via the Sheets API (read-only).
    Unformatted numbers; dates as serial numbers (days since 1899-12-30)."""
    h = {"Authorization": f"Bearer {_token()}"}
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{sheet_id}/values/{a1_range}"
    for attempt in range(5):
        r = httpx.get(url, headers=h, timeout=180, params={
            "valueRenderOption": "UNFORMATTED_VALUE", "dateTimeRenderOption": "SERIAL_NUMBER"})
        if r.status_code in (429, 500, 502, 503) and attempt < 4:
            time.sleep(2 ** attempt)
            continue
        r.raise_for_status()
        return r.json().get("values", [])


def sheet_links(sheet_id, a1_range, first_row):
    """{row: url} for the cell hyperlinks in a one-column range (Sheets API)."""
    h = {"Authorization": f"Bearer {_token()}"}
    r = httpx.get(f"https://sheets.googleapis.com/v4/spreadsheets/{sheet_id}", headers=h, timeout=180, params={
        "ranges": a1_range, "fields": "sheets(data(rowData(values(hyperlink))))"})
    r.raise_for_status()
    out = {}
    for sh in r.json().get("sheets", []):
        for d in sh.get("data", []):
            for i, rd in enumerate(d.get("rowData", [])):
                v = (rd.get("values") or [{}])[0].get("hyperlink")
                if v and v.startswith("http"):
                    out[first_row + i] = v
    return out


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "whoami"
    if cmd == "whoami":
        print("service account:", service_email())
        _token()
        print("token: ok")
    elif cmd == "shared":
        for f in shared_with_me():
            print(f"{f['mimeType'] == FOLDER and 'DIR ' or 'FILE'}  {f['id']}  {f['name']}")
    elif cmd == "ls":
        for f in children(sys.argv[2]):
            print(f"{f['mimeType'] == FOLDER and 'DIR ' or 'FILE'}  {f['id']}  {f.get('size') or '-':>10}  {f['name']}")
    else:
        print(__doc__)
