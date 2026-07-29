"""
Pull the OPI quoting-metrics workbooks' LIVE formulas from Google Sheets, so they can
be audited against the app's calc engine (frontend/src/utils/qm-rollup.js +
frontend/src/pages/base-quoting-metrics.js).

Reading via the Sheets API returns the real formula strings (userEnteredValue.
formulaValue) — it never re-exports the sheet, so the "download to Excel breaks some
formulas" problem does not apply.

Setup (one-time):
  pip install google-api-python-client google-auth
  - A Google Cloud service account with the Sheets API + Drive API enabled.
  - Its JSON key shared as Viewer on the "Quoting Metrics" folder (or each workbook).

Usage:
  python audit_workbook_formulas.py --key /path/to/sa.json --folder <drive_folder_id>
  # or target specific spreadsheets:
  python audit_workbook_formulas.py --key /path/to/sa.json --sheets <id1>,<id2>

Output: one "<workbook title>.formulas.json" per workbook under ./formula_dump/,
each mapping tab -> 2D grid of cells (formula string for formula cells, else the
literal value). That dump is what we diff against the app.
"""
import argparse
import json
import os

from google.oauth2 import service_account
from googleapiclient.discovery import build

SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
]


def clients(key_path):
    creds = service_account.Credentials.from_service_account_file(key_path, scopes=SCOPES)
    return (build("drive", "v3", credentials=creds),
            build("sheets", "v4", credentials=creds))


def list_spreadsheets(drive, folder_id):
    q = (f"'{folder_id}' in parents "
         "and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false")
    files, page = [], None
    while True:
        r = drive.files().list(q=q, fields="nextPageToken, files(id,name)",
                               pageToken=page, pageSize=1000).execute()
        files += r.get("files", [])
        page = r.get("nextPageToken")
        if not page:
            break
    return [(f["id"], f["name"]) for f in files]


def _cell(c):
    uev = (c or {}).get("userEnteredValue") or {}
    if "formulaValue" in uev:
        return uev["formulaValue"]            # the raw =FORMULA(...) string
    for k in ("stringValue", "numberValue", "boolValue"):
        if k in uev:
            return uev[k]
    return ""


def dump_workbook(sheets, spreadsheet_id):
    meta = sheets.spreadsheets().get(
        spreadsheetId=spreadsheet_id, includeGridData=True,
        fields="properties.title,sheets(properties.title,data.rowData.values.userEnteredValue)",
    ).execute()
    out = {"id": spreadsheet_id, "title": meta["properties"]["title"], "tabs": {}}
    for sh in meta.get("sheets", []):
        tab = sh["properties"]["title"]
        rows = ((sh.get("data") or [{}])[0].get("rowData")) or []
        out["tabs"][tab] = [[_cell(c) for c in (row.get("values") or [])] for row in rows]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", required=True, help="path to the service-account JSON key")
    ap.add_argument("--folder", help="Drive folder id containing the workbooks")
    ap.add_argument("--sheets", help="comma-separated spreadsheet ids (instead of --folder)")
    ap.add_argument("--out", default="./formula_dump")
    a = ap.parse_args()

    drive, sheets = clients(a.key)
    targets = []
    if a.folder:
        targets += list_spreadsheets(drive, a.folder)
    if a.sheets:
        targets += [(s.strip(), s.strip()) for s in a.sheets.split(",") if s.strip()]
    if not targets:
        raise SystemExit("Nothing to read — pass --folder or --sheets.")

    os.makedirs(a.out, exist_ok=True)
    for sid, name in targets:
        data = dump_workbook(sheets, sid)
        safe = "".join(ch if (ch.isalnum() or ch in "-_ .") else "_" for ch in data["title"])[:90]
        path = os.path.join(a.out, safe + ".formulas.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=1, ensure_ascii=False)
        print(f"dumped: {data['title']} ({len(data['tabs'])} tabs) -> {path}")


if __name__ == "__main__":
    main()
