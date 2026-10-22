"""
Google Drive "Customers" folder -> app documents (one-time backfill + nightly sync).

Every file under OPI's Drive Customers folder is copied into S3 and gets a
`documents` row on the app record it belongs to, filed in the app folder that
matches its Drive subfolder. Drive is only ever READ (gdrive.py is read-only).

Matching (per project/quote folder):
  * Project folders are found by structure (a folder whose children include at
    least two of the standard numbered folders "1 Request for Quote",
    "4 Quotes", "6 Project Management", ...), so umbrella folders such as
    "ABCO Systems/Tesla/..." work at any depth. Depth-2 folders with a #number
    but no standard children count too ("loose" folders).
  * Job number: "#NNNN" in the name, else a leading 4-digit number; a folder
    with no number takes its nearest numbered ancestor's.
  * (1) QBO project whose display_name starts with that number, or an
    opportunity with that quote # that is linked to a QBO project
    -> (2) Pipeline opportunity by quote_number
    -> else UNMATCHED (held). A folder that matches only a QBO estimate is held
    with the estimate as a suggestion. A manual link made in the app (holding
    area) always wins.
  * Ownership follows documents/routes.py: estimate folders (1-5) of a project
    go to its linked opportunity; project folders (6-10) of a linked
    opportunity go to its project; an unlinked opportunity keeps them (the
    documents page then shows those folders on the opportunity).

Holding area: files that cannot be matched (no number, number not found,
ambiguous, estimate-only, or outside any project folder) are STILL copied, to
S3 under "<prefix>/drive-hold/", as documents rows with entity_type
'drive_hold' and entity_id = drive_unmatched_folders.id. Linking the folder in
the app moves the rows (no re-upload) and the next sync keeps that link.

What is skipped (reported in the summary):
  * byte-identical copies of the known blank templates INSIDE project folders
    (a checksum present in 20+ different project folders: Job Notes.docx,
    kickoff checklists, Bid Metrics.xlsx...). The template folder itself is
    copied (holding area), so one copy of each template is kept.
  * junk: ~$ Office lock files, .tmp, .lnk, desktop.ini, thumbs.db, .DS_Store.
  * files a user deleted from the app (drive_file_state deleted_in_app).
Google Sheets/Docs/Slides are exported (xlsx/docx/pptx) and keep drive_link to
the live file; when the export exceeds Drive's 10 MB export limit the row is
link-only. Shortcuts/Forms are link-only rows.

S3 keys: "<prefix>/drive/<driveFileId><ext>" (held: "<prefix>/drive-hold/...").
Deterministic, so an interrupted upload is simply overwritten by the re-run and
a changed file overwrites its own object.

Modes
  full         walk the whole tree (about 10 min, batched), plan every file,
               copy what is missing or changed, re-home rows whose match
               changed. Records the Changes-API token taken BEFORE the walk;
               when a full run finishes with no filters it marks the backfill
               complete.
  incremental  Drive Changes API since the saved token (new, edited, moved
               files and folders), plus a retry of earlier per-file errors,
               plus re-homing of existing rows whose match changed (a new QBO
               project, an opportunity linked, a folder linked in the app).
  auto         (nightly) nothing until the backfill completed; then a full
               walk if the last one is older than 7 days, else incremental.

CLI (inside the backend container):
  python -m app.gsync.docs_sync --dry-run                 # full plan, counts only
  python -m app.gsync.docs_sync --apply                   # full backfill / resume
  python -m app.gsync.docs_sync --apply --incremental     # changes since last run
  options: --limit N  --only-job NNNN  --only-path TEXT  --only-file DRIVEID
           --prefix KEYPREFIX  --workers N  --budget-min M  --reuse-walk  --quiet
Progress + summary: gsync_runs (source 'drive_docs'); per-file errors:
drive_file_state (retried by the next run). Only one run at a time
(MySQL GET_LOCK), so cron and a manual run cannot overlap.
"""
import argparse
import collections
import hashlib
import io
import json
import os
import queue
import re
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone

import httpx
from sqlalchemy import bindparam, text

from app.db import engine
from app import gdrive as g

ROOT = "1Et_Zd3qvaQCkfat6AFfCUw4t7vSgVjsM"          # Drive "Customers"
FOLDER = g.FOLDER
SOURCE = "drive_docs"
LOCK_NAME = "opi_drive_docs_sync"
WALK_FIELDS = "nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,md5Checksum)"
FILE_FIELDS = "id,name,mimeType,size,modifiedTime,parents,md5Checksum,trashed"
CHANGE_FIELDS = f"nextPageToken,newStartPageToken,changes(fileId,removed,file({FILE_FIELDS}))"
TEMPLATE_MIN_ROOTS = 20
FULL_EVERY_DAYS = 7
MAX_ATTEMPTS = 8
UNMAPPED_FOLDER = "7_notes"      # files at a project root or in an unrecognised subfolder

EST = {"1_request_for_quote", "2_drawings_calcs", "3_bill_of_materials", "4_quotes", "5_purchase_orders"}
STD = re.compile(r"^\s*\d{1,2}\s+(request|rfq|drawings|bill of|quotes|purchase|po'?s|project management|notes|"
                 r"receipts|marketing|order ack)", re.I)
TEMPLATE_PATH = re.compile(r"template", re.I)
JUNK = re.compile(r"^(~\$|~WRL|\.~lock)|\.tmp$|^desktop\.ini$|^thumbs\.db$|^\.ds_store$|\.lnk$", re.I)
EXPORT = {  # Google-native -> (export mime, extension)
    "application/vnd.google-apps.spreadsheet": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"),
    "application/vnd.google-apps.document": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"),
    "application/vnd.google-apps.presentation": ("application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"),
    "application/vnd.google-apps.drawing": ("application/pdf", "pdf"),
}
LINK_URL = {
    "application/vnd.google-apps.spreadsheet": "https://docs.google.com/spreadsheets/d/{}/edit",
    "application/vnd.google-apps.document": "https://docs.google.com/document/d/{}/edit",
    "application/vnd.google-apps.presentation": "https://docs.google.com/presentation/d/{}/edit",
}


def drive_link(fid, mime):
    return LINK_URL.get(mime, "https://drive.google.com/file/d/{}/view").format(fid)


def folder_url(fid):
    return f"https://drive.google.com/drive/folders/{fid}"


def _now():
    return time.time()


def _log(msg, quiet=False):
    if not quiet:
        print(time.strftime("%H:%M:%S"), msg, flush=True)


# ── Drive HTTP (read-only) with backoff ──────────────────────────────────────

class DriveError(RuntimeError):
    pass


class ExportTooLarge(DriveError):
    pass


def _retryable(status, body):
    if status in (429, 500, 502, 503, 504):
        return True
    return status == 403 and ("rateLimitExceeded" in body or "userRateLimitExceeded" in body)


def _drive_get(path, params):
    for attempt in range(7):
        try:
            r = httpx.get(f"{g.API}{path}", params=params, headers={"Authorization": f"Bearer {g._token()}"},
                          timeout=httpx.Timeout(60, read=180))
        except httpx.TransportError as e:
            if attempt == 6:
                raise DriveError(f"network: {e!r}")
            time.sleep(min(60, 2 ** attempt))
            continue
        if r.status_code < 400:
            return r
        if _retryable(r.status_code, r.text) and attempt < 6:
            time.sleep(min(60, 2 ** attempt))
            continue
        if r.status_code == 403 and "exportSizeLimitExceeded" in r.text:
            raise ExportTooLarge("export exceeds Drive's 10 MB limit")
        raise DriveError(f"{r.status_code} {r.text[:300]}")


@contextmanager
def _drive_stream(path, params):
    for attempt in range(7):
        try:
            with httpx.stream("GET", f"{g.API}{path}", params=params,
                              headers={"Authorization": f"Bearer {g._token()}"},
                              timeout=httpx.Timeout(60, read=300)) as r:
                if r.status_code >= 400:
                    body = r.read().decode("utf-8", "replace")
                    if _retryable(r.status_code, body) and attempt < 6:
                        time.sleep(min(60, 2 ** attempt))
                        continue
                    raise DriveError(f"{r.status_code} {body[:300]}")
                yield r
                return
        except httpx.TransportError as e:
            if attempt == 6:
                raise DriveError(f"network: {e!r}")
            time.sleep(min(60, 2 ** attempt))


def _list(q):
    out, token = [], None
    while True:
        params = {"q": q, "fields": WALK_FIELDS, "pageSize": 1000,
                  "supportsAllDrives": "true", "includeItemsFromAllDrives": "true"}
        if token:
            params["pageToken"] = token
        d = _drive_get("/files", params).json()
        out.extend(d.get("files", []))
        token = d.get("nextPageToken")
        if not token:
            return out


def start_page_token():
    return _drive_get("/changes/startPageToken", {"supportsAllDrives": "true"}).json()["startPageToken"]


def _file_meta(fid):
    return _drive_get(f"/files/{fid}", {"fields": FILE_FIELDS, "supportsAllDrives": "true"}).json()


# ── walk ─────────────────────────────────────────────────────────────────────

def _ftuple(k, parent):
    """Compact file record: (id, name, mime, size, modified, md5, parent)."""
    return (k["id"], k["name"], k["mimeType"], int(k.get("size") or 0), k.get("modifiedTime") or "",
            k.get("md5Checksum") or "", parent)


def walk(quiet=False, threads=8, batch=40):
    """Batched BFS of Customers. Returns (folders {id: [parent, name]}, files [tuple])."""
    folders, files = {}, []
    lock = threading.Lock()
    t0 = _now()

    def ls(chunk):
        q = "(" + " or ".join(f"'{fid}' in parents" for fid in chunk) + ") and trashed = false"
        kids = _list(q)
        want = set(chunk)
        nxt = []
        with lock:
            for k in kids:
                par = next((p for p in (k.get("parents") or []) if p in want), None)
                if par is None:
                    continue
                if k["mimeType"] == FOLDER:
                    if k["id"] not in folders:
                        folders[k["id"]] = [par, k["name"]]
                        nxt.append(k["id"])
                else:
                    files.append(_ftuple(k, par))
        return nxt

    from concurrent.futures import ThreadPoolExecutor
    frontier, level = [ROOT], 0
    with ThreadPoolExecutor(threads) as ex:
        while frontier:
            level += 1
            futs = [ex.submit(ls, frontier[i:i + batch]) for i in range(0, len(frontier), batch)]
            nxt = []
            for f in futs:
                nxt.extend(f.result())
            _log(f"walk level {level}: {len(frontier)} folders listed, {len(folders)} folders / {len(files)} files "
                 f"so far, {_now() - t0:.0f}s", quiet)
            frontier = nxt
    seen, uniq = set(), []
    for f in files:                       # a file with two parents is listed twice
        if f[0] not in seen:
            seen.add(f[0])
            uniq.append(f)
    return folders, uniq


def _walk_cache_path():
    return os.getenv("DRIVE_WALK_CACHE") or os.path.join(tempfile.gettempdir(), "opi_drive_walk.json")


# ── folder tree, project-folder detection, subfolder -> app folder ────────────

def nums_of(name):
    ns = re.findall(r"#\s*(\d{3,5})(?!\d)", name or "")
    if not ns:
        m = re.match(r"^\s*(\d{4})(?!\d)", name or "")
        ns = [m.group(1)] if m else []
    return list(dict.fromkeys(ns))


class Tree:
    def __init__(self, folders):
        self.f = folders                          # id -> [parent, name]
        self._path = {ROOT: ""}
        self.kids = collections.defaultdict(list)
        for fid, (par, _) in folders.items():
            self.kids[par].append(fid)
        self._root_of = {}

    def path(self, fid):
        """Path below Customers ('' for Customers itself), None if not under it."""
        if fid in self._path:
            return self._path[fid]
        chain, cur = [], fid
        while cur not in self._path:
            if cur not in self.f or len(chain) > 60:
                for c in chain:
                    self._path[c] = None
                return None
            chain.append(cur)
            cur = self.f[cur][0]
        base = self._path[cur]
        for c in reversed(chain):
            if base is None:
                self._path[c] = None
                continue
            nm = self.f[c][1]
            base = f"{base}/{nm}" if base else nm
            self._path[c] = base
        return self._path[fid]

    def name(self, fid):
        return "Customers" if fid == ROOT else self.f[fid][1]

    def compute_roots(self):
        roots = set()
        for fid, (par, name) in self.f.items():
            p = self.path(fid)
            if not p or "/" not in p or STD.match(name) or TEMPLATE_PATH.search(p):
                continue
            if sum(1 for k in self.kids.get(fid, ()) if STD.match(self.f[k][1])) >= 2:
                roots.add(fid)
        anc = set()
        for r in roots:
            cur = self.f[r][0]
            while cur in self.f and cur not in anc:
                anc.add(cur)
                cur = self.f[cur][0]
        loose = set()
        for fid, (par, name) in self.f.items():
            p = self.path(fid)
            if p and p.count("/") == 1 and fid not in roots and fid not in anc and nums_of(name) \
                    and not TEMPLATE_PATH.search(p):
                loose.add(fid)
        self.roots = roots | loose
        self.structural = roots
        self._root_of = {}
        return self.roots

    def root_of(self, fid):
        """Deepest project folder containing folder `fid` (fid itself counts)."""
        if fid in self._root_of:
            return self._root_of[fid]
        chain, cur, found = [], fid, None
        while cur in self.f:
            if cur in self._root_of:
                found = self._root_of[cur]
                break
            chain.append(cur)
            if cur in self.roots:
                found = cur
                break
            cur = self.f[cur][0]
        for c in chain:
            self._root_of[c] = found
        return found

    def hold_group(self, fid):
        """Holding group for a file outside any project folder: its company
        (level-1) folder, or Customers itself for top-level files."""
        cur, last = fid, ROOT
        while cur in self.f:
            last = cur
            if self.f[cur][0] == ROOT:
                return cur
            cur = self.f[cur][0]
        return ROOT if fid == ROOT else last

    def rel(self, base, fid):
        """Folder segments from `base` down to `fid`."""
        bp, fp = self.path(base) or "", self.path(fid) or ""
        if fid == base:
            return []
        r = fp[len(bp) + 1:] if bp else fp
        return r.split("/") if r else []


def cls_top(seg):
    s = seg.lower().strip()
    if re.search(r"request|rfq", s): return "1_request_for_quote"
    if re.search(r"^\d*\s*drawings?\b|calcs", s): return "2_drawings_calcs"
    if re.search(r"bill of material|\bboms?\b", s): return "3_bill_of_materials"
    if re.search(r"^\d*\s*(old )?quotes?\b", s): return "4_quotes"
    if re.search(r"purchase order|\bpo'?s\b|order ack", s): return "5_purchase_orders"
    if re.search(r"project management", s): return "6_project_management"
    if re.search(r"^\d*\s*(job )?notes?\b|see notes", s): return "7_notes"
    if re.search(r"receipts?", s): return "8_receipts"
    if re.search(r"marketing", s): return "9_marketing"
    if re.search(r"crew doc", s): return "10_crew_documents"
    return None


def cls_con(seg):
    s = seg.lower()
    if "before" in s: return "1_before_pictures"
    if re.search(r"active pic|site photo|photo update|^\d*\s*photos?\b|drone|wire guid", s): return "2_active_pictures"
    if re.search(r"\bbol", s): return "3_bols"
    if re.search(r"drawing update|layout update", s): return "4_drawing_updates"
    if "anchor" in s: return "5_anchor_installation"
    if "complet" in s: return "6_project_completion"
    return None


def map_rel(segs):
    """Folder segments below the project folder -> app folder key."""
    if not segs:
        return UNMAPPED_FOLDER
    top = cls_top(segs[0])
    if top is None:
        return UNMAPPED_FOLDER
    key = top
    if top == "6_project_management" and len(segs) > 1:
        s1 = segs[1].lower()
        if "kick" in s1:
            key = "6_project_management/1_kickoff"
        elif re.search(r"construction|progress", s1):
            key = "6_project_management/2_construction"
            if len(segs) > 2 and cls_con(segs[2]):
                key += "/" + cls_con(segs[2])
        elif "complet" in s1:
            key = "6_project_management/2_construction/6_project_completion"
        elif re.search(r"\bbol", s1):
            key = "6_project_management/2_construction/3_bols"
    elif top == "8_receipts" and len(segs) > 1:
        s1 = segs[1].lower()
        if "material" in s1:
            key = "8_receipts/materials"
        elif re.search(r"travel|hotel|flight", s1):
            key = "8_receipts/travel"
    return key


# ── matching folders to app records ──────────────────────────────────────────

HOLD_KINDS = {"no_number": "no_number", "number_unmatched": "number_unmatched",
              "ambiguous_project": "ambiguous", "ambiguous_opportunity": "ambiguous",
              "qbo_estimate": "estimate_only", "ambiguous_estimate": "estimate_only"}


class Matcher:
    def __init__(self, conn):
        self.proj = {}
        self.proj_by_num = collections.defaultdict(list)
        for r in conn.execute(text("SELECT qbo_id, display_name FROM qbo_customers WHERE is_project = 1")).mappings():
            self.proj[str(r["qbo_id"])] = r["display_name"] or ""
            head = re.split(r"\s+-\s+", r["display_name"] or "", 1)[0]
            for n in dict.fromkeys(re.findall(r"\d{3,5}", head)):
                self.proj_by_num[n].append(str(r["qbo_id"]))
        self.opp = {}
        self.opp_by_num = collections.defaultdict(list)
        self.latest_opp_by_proj = {}
        for r in conn.execute(text("""SELECT id, quote_number, project_qbo_id, status, title, customer_name_raw
                                      FROM opportunities ORDER BY id""")).mappings():
            o = dict(r)
            o["id"] = str(o["id"])
            o["project_qbo_id"] = str(o["project_qbo_id"]) if o["project_qbo_id"] else None
            self.opp[o["id"]] = o
            q = (o["quote_number"] or "").strip()
            if q:
                self.opp_by_num[q.split(".")[0]].append(o)
            if o["project_qbo_id"]:
                self.latest_opp_by_proj[o["project_qbo_id"]] = o["id"]     # ORDER BY id -> last = newest
        self.est_by_num = collections.defaultdict(list)
        for r in conn.execute(text("""
                SELECT t.qbo_id, t.doc_number, c.display_name AS cust
                FROM qbo_transactions t LEFT JOIN qbo_customers c ON c.qbo_id = t.customer_qbo_id
                WHERE t.entity_type = 'Estimate' AND t.doc_number IS NOT NULL""")).mappings():
            self.est_by_num[re.split(r"[-.]", r["doc_number"].strip())[0]].append(
                {"qbo_id": str(r["qbo_id"]), "doc_number": r["doc_number"], "customer": r["cust"]})
        self.manual = {r["drive_folder_id"]: (r["linked_entity_type"], str(r["linked_entity_id"]))
                       for r in conn.execute(text("""SELECT drive_folder_id, linked_entity_type, linked_entity_id
                            FROM drive_unmatched_folders WHERE status = 'linked' AND linked_entity_type IS NOT NULL
                              AND COALESCE(linked_by_email, '') <> 'auto'""")).mappings()}

    def match(self, fid, tree):
        name = tree.name(fid)
        path = tree.path(fid) or ""
        ns = nums_of(name)
        if not ns:
            parts = path.split("/")
            for k in range(len(parts) - 1, 1, -1):
                ns = nums_of(parts[k - 1])
                if ns:
                    break
        res = {"kind": None, "entity_type": None, "entity_id": None, "nums": ns, "note": "", "suggestion": None}
        if fid in self.manual:
            et, eid = self.manual[fid]
            res.update(kind="manual", entity_type=et, entity_id=eid, note="linked in the app")
            return res
        if not ns:
            res["kind"] = "no_number"
            return res
        first = self.proj_by_num.get(ns[0], [])
        if len(first) == 1:
            res.update(kind="project", entity_type="project", entity_id=first[0], note=self.proj[first[0]])
            return res
        ps = list(dict.fromkeys(p for x in ns for p in self.proj_by_num.get(x, [])))
        via = False
        for x in ns:
            for o in self.opp_by_num.get(x, []):
                if o["project_qbo_id"] in self.proj and o["project_qbo_id"] not in ps:
                    ps.append(o["project_qbo_id"])
                    via = True
        if len(ps) == 1:
            res.update(kind="project_via_quote" if via else "project", entity_type="project", entity_id=ps[0],
                       note=self.proj[ps[0]])
            return res
        if len(ps) > 1:
            res.update(kind="ambiguous_project",
                       note=" | ".join(f"{p}:{self.proj[p]}" for p in ps),
                       suggestion={"candidates": [{"type": "project", "id": p, "label": self.proj[p]} for p in ps]})
            return res
        os_ = list({o["id"]: o for x in ns for o in self.opp_by_num.get(x, [])}.values())
        if len(os_) > 1 and len(self.opp_by_num.get(ns[0], [])) == 1:
            os_ = self.opp_by_num[ns[0]]
        if len(os_) == 1:
            o = os_[0]
            res.update(kind="opportunity", entity_type="opportunity", entity_id=o["id"],
                       note=f"#{o['quote_number']} {o['customer_name_raw'] or ''} / {o['title'] or ''} / {o['status']}")
            return res
        if len(os_) > 1:
            res.update(kind="ambiguous_opportunity",
                       note=" | ".join(f"{o['id']}:#{o['quote_number']}:{o['status']}" for o in os_),
                       suggestion={"candidates": [{"type": "opportunity", "id": o["id"],
                                                   "label": f"#{o['quote_number']} {o['title'] or ''} ({o['status']})"}
                                                  for o in os_]})
            return res
        es = self.est_by_num.get(ns[0], []) or [e for x in ns for e in self.est_by_num.get(x, [])]
        if es:
            res.update(kind="qbo_estimate" if len(es) == 1 else "ambiguous_estimate",
                       note=" | ".join(f"Estimate {e['doc_number']} / {e['customer'] or ''}" for e in es[:5]),
                       suggestion={"estimates": es[:5]})
            return res
        res.update(kind="number_unmatched", suggestion={"nums": ns})
        return res

    def owner(self, et, eid, folder):
        top = folder.split("/")[0]
        if et == "project" and top in EST:
            o = self.latest_opp_by_proj.get(str(eid))
            if o:
                return "opportunity", o
        elif et == "opportunity" and top not in EST:
            p = (self.opp.get(str(eid)) or {}).get("project_qbo_id")
            if p:
                return "project", p
        return et, str(eid)


class Resolver:
    """Where a Drive file belongs: (entity_type, entity_id | hold group, folder, drive_path)."""

    def __init__(self, tree, matcher):
        self.t, self.m = tree, matcher
        self.matches = {}
        self.holds = {}          # group folder id -> hold info

    def match(self, root):
        if root not in self.matches:
            self.matches[root] = self.m.match(root, self.t)
        return self.matches[root]

    def resolve(self, parent, filename):
        if self.t.path(parent) is None:
            return None
        root = self.t.root_of(parent) if parent != ROOT else None
        if root:
            m = self.match(root)
            folder = map_rel(self.t.rel(root, parent))
            dpath = "/".join(self.t.rel(root, parent) + [filename])
            if m["entity_type"]:
                et, eid = self.m.owner(m["entity_type"], m["entity_id"], folder)
                return {"etype": et, "eid": eid, "folder": folder, "drive_path": dpath, "root": root, "group": None}
            self._hold(root, HOLD_KINDS.get(m["kind"], m["kind"]), m)
            return {"etype": "drive_hold", "eid": None, "folder": folder, "drive_path": dpath, "root": root, "group": root}
        grp = self.t.hold_group(parent)
        rel = self.t.rel(grp, parent) if grp != ROOT else []
        dpath = "/".join(rel + [filename])
        if grp in self.m.manual:          # a company-level folder linked in the app
            et, eid = self.m.owner(*self.m.manual[grp], UNMAPPED_FOLDER)
            return {"etype": et, "eid": eid, "folder": UNMAPPED_FOLDER, "drive_path": dpath, "root": None, "group": None}
        self._hold(grp, "outside_project", None)
        return {"etype": "drive_hold", "eid": None, "folder": UNMAPPED_FOLDER, "drive_path": dpath,
                "root": None, "group": grp}

    def _hold(self, fid, kind, m):
        if fid in self.holds:
            return
        path = self.t.path(fid) or ""
        self.holds[fid] = {"drive_folder_id": fid, "path": path or "(Customers top level)",
                           "company": path.split("/")[0] if path else None,
                           "folder_name": self.t.name(fid), "kind": kind,
                           "guessed_job": ",".join(m["nums"])[:64] if m and m["nums"] else None,
                           "suggestion": (m or {}).get("suggestion")}


# ── state helpers ────────────────────────────────────────────────────────────

def get_state(conn, k, default=None):
    v = conn.execute(text("SELECT v FROM drive_sync_state WHERE k = :k"), {"k": k}).scalar()
    return default if v is None else v


def set_state(conn, k, v):
    conn.execute(text("""INSERT INTO drive_sync_state (k, v) VALUES (:k, :v)
                         ON DUPLICATE KEY UPDATE v = VALUES(v)"""), {"k": k, "v": v})


def _load_folders(conn):
    return {r[0]: [r[1], r[2]] for r in conn.execute(text("SELECT drive_id, parent_id, name FROM drive_folders"))}


def _write_folders(tree, resolver, quiet):
    """Sync drive_folders with the in-memory tree (diff: insert/update/delete)."""
    with engine.connect() as conn:
        cur = {r[0]: tuple(r[1:]) for r in conn.execute(text(
            "SELECT drive_id, parent_id, name, path, is_root, match_kind, entity_type, entity_id, nums FROM drive_folders"))}
    want = {}
    for fid, (par, name) in tree.f.items():
        p = tree.path(fid)
        if p is None:
            continue
        is_root = 1 if fid in tree.roots else 0
        m = resolver.match(fid) if is_root else None
        want[fid] = (par, name[:512], p[:1024], is_root,
                     m["kind"] if m else None, m["entity_type"] if m else None,
                     m["entity_id"] if m else None, ",".join(m["nums"])[:255] if m and m["nums"] else None,
                     (m["note"] or "")[:1024] if m else None)
    ups = [dict(zip(("id", "par", "name", "path", "root", "mk", "et", "eid", "nums", "note"), (fid,) + w))
           for fid, w in want.items() if cur.get(fid) != w[:8]]
    gone = [fid for fid in cur if fid not in want]
    with engine.begin() as conn:
        for i in range(0, len(ups), 1000):
            conn.execute(text("""
                INSERT INTO drive_folders (drive_id, parent_id, name, path, is_root, match_kind, entity_type, entity_id,
                                           nums, match_note)
                VALUES (:id, :par, :name, :path, :root, :mk, :et, :eid, :nums, :note)
                ON DUPLICATE KEY UPDATE parent_id = VALUES(parent_id), name = VALUES(name), path = VALUES(path),
                  is_root = VALUES(is_root), match_kind = VALUES(match_kind), entity_type = VALUES(entity_type),
                  entity_id = VALUES(entity_id), nums = VALUES(nums), match_note = VALUES(match_note)"""), ups[i:i + 1000])
        for i in range(0, len(gone), 1000):
            conn.execute(text("DELETE FROM drive_folders WHERE drive_id IN :ids").bindparams(
                bindparam("ids", expanding=True)), {"ids": gone[i:i + 1000]})
    _log(f"drive_folders: {len(ups)} upserted, {len(gone)} removed", quiet)


def _upsert_holds(holds):
    """Insert/refresh holding-area rows; returns {drive_folder_id: id}."""
    if holds:
        rows = [{"f": h["drive_folder_id"], "p": h["path"][:1024], "c": (h["company"] or "")[:255] or None,
                 "n": (h["folder_name"] or "")[:512], "k": h["kind"], "j": h["guessed_job"],
                 "s": json.dumps(h["suggestion"]) if h["suggestion"] else None} for h in holds.values()]
        with engine.begin() as conn:
            for i in range(0, len(rows), 500):
                conn.execute(text("""
                    INSERT INTO drive_unmatched_folders (drive_folder_id, path, company, folder_name, kind, guessed_job,
                                                         suggestion)
                    VALUES (:f, :p, :c, :n, :k, :j, :s)
                    ON DUPLICATE KEY UPDATE path = VALUES(path), company = VALUES(company),
                      folder_name = VALUES(folder_name), kind = VALUES(kind), guessed_job = VALUES(guessed_job),
                      suggestion = VALUES(suggestion),
                      status = IF(status = 'linked' AND linked_by_email = 'auto', 'open', status)"""), rows[i:i + 500])
    with engine.connect() as conn:
        return {r[0]: str(r[1]) for r in conn.execute(text("SELECT drive_folder_id, id FROM drive_unmatched_folders"))}


def _auto_resolve_holds(resolver):
    """Open holding rows whose folder now matches (new QBO project, opp link)
    are marked linked (auto); their rows move in the re-home pass."""
    n = 0
    with engine.begin() as conn:
        for r in conn.execute(text("""SELECT id, drive_folder_id FROM drive_unmatched_folders
                                       WHERE status = 'open'""")).mappings().all():
            fid = r["drive_folder_id"]
            if fid not in resolver.t.roots or fid in resolver.holds:
                continue
            m = resolver.match(fid)
            if m["entity_type"]:
                conn.execute(text("""UPDATE drive_unmatched_folders SET status = 'linked', linked_entity_type = :t,
                                       linked_entity_id = :i, linked_by_email = 'auto', linked_at = NOW() WHERE id = :id"""),
                             {"t": m["entity_type"], "i": m["entity_id"], "id": r["id"]})
                n += 1
    return n


def _refresh_hold_counts():
    with engine.begin() as conn:
        conn.execute(text("""
            UPDATE drive_unmatched_folders u
            LEFT JOIN (SELECT entity_id, COUNT(*) n, SUM(size_bytes) b FROM documents
                       WHERE entity_type = 'drive_hold' GROUP BY entity_id) d ON d.entity_id = CAST(u.id AS CHAR) COLLATE utf8mb4_unicode_ci
            SET u.file_count = COALESCE(d.n, 0), u.total_bytes = COALESCE(d.b, 0)"""))


# ── S3 streaming ─────────────────────────────────────────────────────────────

class _HashingReader(io.RawIOBase):
    """File-like over an iterator of byte chunks; md5 + byte count as read."""

    def __init__(self, it):
        self.it, self.buf, self.md5, self.n = it, bytearray(), hashlib.md5(), 0

    def readable(self):
        return True

    def read(self, size=-1):
        while size is None or size < 0 or len(self.buf) < size:
            try:
                self.buf.extend(next(self.it))
            except StopIteration:
                break
        if size is None or size < 0:
            out = bytes(self.buf)
            self.buf.clear()
        else:
            out = bytes(self.buf[:size])
            del self.buf[:size]
        self.md5.update(out)
        self.n += len(out)
        return out


def _disposition(filename):
    from urllib.parse import quote
    return f"inline; filename*=UTF-8''{quote(filename or 'file')}"


def _s3():
    from app.s3 import s3_client, AWS_BUCKET
    return s3_client, AWS_BUCKET


def _transfer_config():
    from boto3.s3.transfer import TransferConfig
    mb = 1024 * 1024
    # 8 MB parts x 2 threads keeps each worker's buffer around 24 MB, and
    # 10,000 parts x 8 MB = 80 GB max object (largest Drive file is 6.3 GB).
    return TransferConfig(multipart_threshold=16 * mb, multipart_chunksize=8 * mb, max_concurrency=2, use_threads=True)


def _ext(name):
    return "." + name.rsplit(".", 1)[1].lower()[:10] if "." in name else ""


# ── planning ─────────────────────────────────────────────────────────────────

def _load_docs():
    with engine.connect() as conn:
        out = {}
        for r in conn.execute(text("""
                SELECT id, source_drive_id, entity_type, entity_id, folder, drive_path, drive_parent_id, drive_md5,
                       drive_modified, s3_key, original_filename
                FROM documents WHERE source_drive_id IS NOT NULL ORDER BY id""")).mappings():
            out.setdefault(r["source_drive_id"], dict(r))
        skips = {r[0] for r in conn.execute(text(
            "SELECT drive_id FROM drive_file_state WHERE status = 'deleted_in_app'"))}
    return out, skips


def plan_file(f, res, docs, skips, template_md5, prefix):
    """One file tuple -> task dict (action + target), or None if outside Customers."""
    fid, name, mime, size, modified, md5, parent = f
    tgt = res.resolve(parent, name)
    if tgt is None:
        return None
    t = {"id": fid, "name": name, "mime": mime, "size": size, "modified": modified, "md5": md5, "parent": parent,
         **tgt}
    ex = docs.get(fid)
    t["existing"] = ex
    if JUNK.search(name):
        t["action"] = "skip_junk"
    elif fid in skips:
        t["action"] = "skip_deleted_in_app"
    elif md5 and md5 in template_md5 and tgt["root"]:
        t["action"] = "skip_template"
    elif ex and ((md5 and ex["drive_md5"] == md5) or (not md5 and ex["drive_modified"] == modified)):
        t["action"] = "unchanged"
    elif mime in EXPORT:
        t["action"] = "update_export" if ex else "export"
    elif mime.startswith("application/vnd.google-apps."):
        t["action"] = "update_link" if ex else "link_only"
    else:
        t["action"] = "update" if ex else "copy"
    hold = tgt["etype"] == "drive_hold"
    if mime in EXPORT:
        ext = "." + EXPORT[mime][1]
        t["filename"] = name if name.lower().endswith(ext) else name + ext
    else:
        ext = _ext(name)
        t["filename"] = name
    t["s3_key"] = f"{prefix}/{'drive-hold' if hold else 'drive'}/{fid}{ext}"
    return t


# ── execution ────────────────────────────────────────────────────────────────

def _dt(iso):
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(timezone.utc).replace(tzinfo=None)
    except Exception:
        return None


def _do(t):
    """Copy one file (S3 + documents row). Returns bytes stored."""
    s3, bucket = _s3()
    key, ctype, size, link = t["s3_key"], t["mime"], t["size"], None
    act = t["action"]
    if act in ("copy", "update"):
        with _drive_stream(f"/files/{t['id']}", {"alt": "media", "supportsAllDrives": "true"}) as r:
            rd = _HashingReader(r.iter_bytes(1024 * 1024))
            s3.upload_fileobj(rd, bucket, key, Config=_transfer_config(), ExtraArgs={
                "ContentType": ctype or "application/octet-stream", "ContentDisposition": _disposition(t["filename"])})
        if t["md5"] and rd.md5.hexdigest() != t["md5"]:
            s3.delete_object(Bucket=bucket, Key=key)
            raise DriveError(f"md5 mismatch after copy ({rd.n} bytes)")
        size = rd.n
    elif act in ("export", "update_export"):
        emime, _ = EXPORT[t["mime"]]
        link = drive_link(t["id"], t["mime"])
        try:
            body = _drive_get(f"/files/{t['id']}/export", {"mimeType": emime}).content
            s3.put_object(Bucket=bucket, Key=key, Body=body, ContentType=emime,
                          ContentDisposition=_disposition(t["filename"]))
            ctype, size = emime, len(body)
        except ExportTooLarge:
            key, size, t["filename"], act = "", 0, t["name"], "link_only"
    if act in ("link_only", "update_link"):
        key, size, link, bucket = "", 0, drive_link(t["id"], t["mime"]), ""
        t["filename"] = t["name"]
    p = {"t": t["etype"], "i": str(t["eid"]), "f": t["folder"], "b": bucket if key else "", "k": key,
         "fn": t["filename"][:255], "ct": (ctype or "")[:100], "sz": size, "d": t["id"], "m5": t["md5"] or None,
         "mod": t["modified"] or None, "dp": t["drive_path"][:1024], "dl": link, "par": t["parent"],
         "ca": _dt(t["modified"]) or datetime.utcnow()}
    ex = t["existing"]
    with engine.begin() as conn:
        if ex:
            conn.execute(text("""
                UPDATE documents SET entity_type = :t, entity_id = :i, folder = :f, s3_bucket = :b, s3_key = :k,
                  original_filename = :fn, content_type = :ct, size_bytes = :sz, drive_md5 = :m5, drive_modified = :mod,
                  drive_path = :dp, drive_link = :dl, drive_parent_id = :par
                WHERE id = :id"""), {**p, "id": ex["id"]})
        else:
            conn.execute(text("""
                INSERT INTO documents (entity_type, entity_id, folder, s3_bucket, s3_key, original_filename, content_type,
                  size_bytes, created_at, source_drive_id, drive_md5, drive_modified, drive_path, drive_link,
                  drive_parent_id)
                VALUES (:t, :i, :f, :b, :k, :fn, :ct, :sz, :ca, :d, :m5, :mod, :dp, :dl, :par)
                ON DUPLICATE KEY UPDATE folder = VALUES(folder), s3_bucket = VALUES(s3_bucket), s3_key = VALUES(s3_key),
                  original_filename = VALUES(original_filename), content_type = VALUES(content_type),
                  size_bytes = VALUES(size_bytes), drive_md5 = VALUES(drive_md5), drive_modified = VALUES(drive_modified),
                  drive_path = VALUES(drive_path), drive_link = VALUES(drive_link),
                  drive_parent_id = VALUES(drive_parent_id)"""), p)
        conn.execute(text("DELETE FROM drive_file_state WHERE drive_id = :d AND status = 'error'"), {"d": t["id"]})
    if ex and ex.get("s3_key") and ex["s3_key"] != key:
        try:
            s3.delete_object(Bucket=_s3()[1], Key=ex["s3_key"])
        except Exception:
            pass
    return size


def _record_error(t, err):
    with engine.begin() as conn:
        conn.execute(text("""
            INSERT INTO drive_file_state (drive_id, status, path, error, attempts) VALUES (:d, 'error', :p, :e, 1)
            ON DUPLICATE KEY UPDATE status = 'error', path = VALUES(path), error = VALUES(error), attempts = attempts + 1
        """), {"d": t["id"], "p": (t.get("full_path") or t["drive_path"])[:1024], "e": str(err)[:2000]})


def _move(t):
    """Matching changed but bytes did not: re-file the row, no re-upload."""
    with engine.begin() as conn:
        conn.execute(text("""UPDATE documents SET entity_type = :t, entity_id = :i, folder = :f, drive_path = :dp,
                               drive_parent_id = :par WHERE id = :id"""),
                     {"t": t["etype"], "i": str(t["eid"]), "f": t["folder"], "dp": t["drive_path"][:1024],
                      "par": t["parent"], "id": t["existing"]["id"]})


def _needs_move(t):
    ex = t.get("existing")
    return ex and (ex["entity_type"], str(ex["entity_id"]), ex["folder"], ex["drive_path"] or "", ex["drive_parent_id"]) != \
        (t["etype"], str(t["eid"]), t["folder"], t["drive_path"][:1024], t["parent"])


class Progress:
    def __init__(self, run_id, total, quiet):
        self.c = collections.Counter()
        self.lock = threading.Lock()
        self.run_id, self.total, self.quiet = run_id, total, quiet
        self.t0 = _now()
        self.stop = threading.Event()
        self.extra = {}

    def add(self, **kw):
        with self.lock:
            self.c.update(kw)

    def snapshot(self):
        with self.lock:
            d = dict(self.c)
        el = _now() - self.t0
        d.update(self.extra, queued=self.total, elapsed_s=int(el),
                 mb_per_s=round(d.get("bytes", 0) / 1048576 / el, 1) if el > 0 else 0, running=True)
        return d

    def loop(self):
        while not self.stop.wait(30):
            s = self.snapshot()
            _log(f"progress: {s.get('done', 0)}/{self.total} files, {s.get('bytes', 0) / 1073741824:.2f} GB, "
                 f"{s['mb_per_s']} MB/s, errors {s.get('errors', 0)}", self.quiet)
            if self.run_id:
                with engine.begin() as conn:
                    conn.execute(text("UPDATE gsync_runs SET summary = :s WHERE id = :id"),
                                 {"s": json.dumps(s, default=str), "id": self.run_id})


def execute(tasks, workers, deadline, prog):
    q = queue.Queue()
    for t in tasks:
        q.put(t)

    def worker():
        while True:
            if deadline and _now() > deadline:
                return
            try:
                t = q.get_nowait()
            except queue.Empty:
                return
            try:
                n = _do(t)
                prog.add(done=1, bytes=n, **{t["action"]: 1})
            except Exception as e:
                prog.add(done=1, errors=1)
                try:
                    _record_error(t, f"{type(e).__name__}: {e}")
                except Exception:
                    pass
    th = [threading.Thread(target=worker, daemon=True) for _ in range(max(1, workers))]
    for x in th:
        x.start()
    for x in th:
        x.join()
    return q.qsize()


# ── run ──────────────────────────────────────────────────────────────────────

def _acquire():
    conn = engine.connect()
    conn.execute(text("SET SESSION wait_timeout = 172800"))     # a backfill can run for hours
    got = conn.execute(text("SELECT GET_LOCK(:n, 0)"), {"n": LOCK_NAME}).scalar()
    if got != 1:
        conn.close()
        return None
    return conn


def _release(conn):
    try:
        conn.execute(text("SELECT RELEASE_LOCK(:n)"), {"n": LOCK_NAME})
    except Exception:
        pass          # connection gone = lock already released by MySQL
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _start_run(who, mode):
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO gsync_runs (source, triggered_by, summary) VALUES (:s, :w, :m)"),
                     {"s": SOURCE, "w": who, "m": json.dumps({"mode": mode, "running": True})})
        return conn.execute(text("SELECT LAST_INSERT_ID()")).scalar()


def _finish_run(run_id, ok, summary=None, error=None):
    with engine.begin() as conn:
        conn.execute(text("UPDATE gsync_runs SET finished_at = NOW(), ok = :ok, summary = :s, error = :e WHERE id = :id"),
                     {"id": run_id, "ok": 1 if ok else 0, "s": json.dumps(summary, default=str) if summary else None,
                      "e": (error or "")[:4000] or None})


def _template_md5(tree, files):
    roots_by_md5 = collections.defaultdict(set)
    names = {}
    for f in files:
        if f[5]:
            r = tree.root_of(f[6])
            if r:
                roots_by_md5[f[5]].add(r)
                names.setdefault(f[5], f[1])
    return {m: names[m] for m, s in roots_by_md5.items() if len(s) >= TEMPLATE_MIN_ROOTS}


def _changes(token, quiet):
    """All changes since `token`: (changed folders, changed files, removed ids, new token)."""
    folders, files, removed = {}, {}, set()
    tok, new = token, None
    while tok:
        d = _drive_get("/changes", {"pageToken": tok, "pageSize": 1000, "fields": CHANGE_FIELDS,
                                    "supportsAllDrives": "true", "includeItemsFromAllDrives": "true",
                                    "includeRemoved": "true"}).json()
        for c in d.get("changes", []):
            f = c.get("file") or {}
            if c.get("removed") or f.get("trashed"):
                removed.add(c.get("fileId"))
                folders.pop(c.get("fileId"), None)
                files.pop(c.get("fileId"), None)
                continue
            par = (f.get("parents") or [None])[0]
            if f.get("mimeType") == FOLDER:
                folders[f["id"]] = [par, f["name"]]
            elif f.get("id"):
                files[f["id"]] = _ftuple(f, par)
        tok = d.get("nextPageToken")
        new = d.get("newStartPageToken") or new
    _log(f"changes: {len(folders)} folders, {len(files)} files, {len(removed)} removed", quiet)
    return folders, files, removed, new


def run(mode="full", apply=False, limit=None, only_job=None, only_path=None, only_file=None, prefix=None,
        workers=None, budget_min=None, who="cli", reuse_walk=False, quiet=False):
    """Plan (and with apply=True, execute) a Drive -> documents sync. Returns a summary dict."""
    from app.s3 import S3_PREFIX
    prefix = (prefix or os.getenv("DRIVE_SYNC_S3_PREFIX") or S3_PREFIX).strip("/")
    workers = workers or int(os.getenv("DRIVE_SYNC_WORKERS", "6"))
    filtered = bool(limit or only_job or only_path or only_file)
    lock = None
    run_id = None
    if apply:
        lock = _acquire()
        if not lock:
            return {"busy": True, "note": "another Drive documents sync is running"}
    try:
        with engine.connect() as conn:
            backfill_done = get_state(conn, "backfill_completed_at")
            token = get_state(conn, "changes_page_token")
            last_full = get_state(conn, "last_full_walk_at")
            tmpl = json.loads(get_state(conn, "template_md5", "{}") or "{}")
        if mode == "auto":
            if not backfill_done:
                return {"skipped": "the initial Drive backfill has not completed yet"}
            stale = not last_full or (_now() - float(last_full)) > FULL_EVERY_DAYS * 86400
            mode = "full" if stale or not token else "incremental"
        if mode == "incremental" and not token:
            return {"skipped": "no saved Drive changes token - run a full sync first"}
        if apply:
            run_id = _start_run(who, mode)
        t0 = _now()
        deadline = t0 + budget_min * 60 if budget_min else None
        summary = {"mode": mode, "prefix": prefix, "filtered": filtered}
        removed = set()

        if mode == "full":
            cache = _walk_cache_path()
            if reuse_walk and os.path.exists(cache) and _now() - os.path.getmtime(cache) < 36 * 3600:
                w = json.load(open(cache, encoding="utf-8"))
                new_token, folders, files = w["token"], w["folders"], [tuple(x) for x in w["files"]]
                _log(f"reusing walk cache {cache}: {len(folders)} folders, {len(files)} files", quiet)
            else:
                new_token = start_page_token()
                folders, files = walk(quiet)
                try:
                    with open(cache, "w", encoding="utf-8") as fh:
                        json.dump({"token": new_token, "folders": folders, "files": files}, fh)
                except OSError:
                    pass
            tree = Tree(folders)
            tree.compute_roots()
            tmpl = _template_md5(tree, files)
            summary["walk"] = {"folders": len(folders), "files": len(files),
                               "bytes": sum(f[3] for f in files), "project_folders": len(tree.roots)}
        else:
            with engine.connect() as conn:
                folders = _load_folders(conn)
            cf, cfiles, removed, new_token = _changes(token, quiet)
            folders.update(cf)
            for r in removed:
                folders.pop(r, None)
            with engine.connect() as conn:
                retry = [r[0] for r in conn.execute(text(
                    "SELECT drive_id FROM drive_file_state WHERE status = 'error' AND attempts < :a"), {"a": MAX_ATTEMPTS})]
            for fid in retry:
                if fid in cfiles:
                    continue
                try:
                    m = _file_meta(fid)
                    if not m.get("trashed"):
                        cfiles[fid] = _ftuple(m, (m.get("parents") or [None])[0])
                except Exception:
                    pass
            files = list(cfiles.values())
            tree = Tree(folders)
            tree.compute_roots()
            summary["changes"] = {"folders": len(cf), "files": len(cfiles), "removed": len(removed),
                                  "error_retries": len(retry)}

        with engine.connect() as conn:
            matcher = Matcher(conn)
        res = Resolver(tree, matcher)
        docs, skips = _load_docs()

        def keep(f):
            if only_file and f[0] != only_file:
                return False
            if only_job or only_path:
                p = (tree.path(f[6]) or "")
                if only_path and only_path.lower() not in p.lower():
                    return False
                if only_job:
                    r = tree.root_of(f[6])
                    if not r or only_job not in res.match(r)["nums"]:
                        return False
            return True

        tasks = []
        for f in files:
            if filtered and not keep(f):
                continue
            t = plan_file(f, res, docs, skips, tmpl, prefix)
            if t:
                t["full_path"] = ((tree.path(f[6]) or "") + "/" + f[1]).strip("/")
                tasks.append(t)

        planned_ids = {t["id"] for t in tasks}
        # re-home existing rows not in this plan (incremental), by their parent folder
        rehome = []
        if not filtered or mode == "incremental":
            for did, ex in docs.items():
                if did in planned_ids or not ex["drive_parent_id"]:
                    continue
                tgt = res.resolve(ex["drive_parent_id"], (ex["drive_path"] or ex["original_filename"] or "").split("/")[-1])
                if tgt:
                    rehome.append({"id": did, "existing": ex, "parent": ex["drive_parent_id"], **tgt})
        if mode == "full" and not filtered:
            summary["removed_in_drive"] = sum(1 for d in docs if d not in planned_ids)
        else:
            summary["removed_in_drive"] = sum(1 for r in removed if r in docs)

        acts = collections.Counter(t["action"] for t in tasks)
        abytes = collections.Counter()
        by_ent = collections.Counter()
        by_ent_bytes = collections.Counter()
        for t in tasks:
            abytes[t["action"]] += t["size"]
            if not t["action"].startswith("skip"):
                by_ent[t["etype"]] += 1
                by_ent_bytes[t["etype"]] += t["size"]
        with engine.connect() as conn:          # existing holding rows, so held files compare by id
            known_holds = {r[0]: str(r[1]) for r in conn.execute(text(
                "SELECT drive_folder_id, id FROM drive_unmatched_folders"))}
        for t in tasks + rehome:
            if t["etype"] == "drive_hold":
                t["eid"] = known_holds.get(t["group"])
        moves = [t for t in tasks if t["action"] in ("unchanged", "skip_template", "skip_junk", "skip_deleted_in_app")
                 and _needs_move(t)] + [t for t in rehome if _needs_move(t)]
        work = [t for t in tasks if t["action"] in ("copy", "update", "export", "update_export", "link_only",
                                                    "update_link")]
        # videos last, otherwise by path, so whole project folders fill in first
        work.sort(key=lambda t: (t["mime"].startswith("video/"), t["full_path"]))
        if limit:
            work = work[:limit]
        tmpl_skipped = acts.get("skip_template", 0)
        summary.update({
            "actions": dict(acts), "action_gb": {k: round(v / 1073741824, 2) for k, v in abytes.items()},
            "by_entity_type": dict(by_ent), "by_entity_gb": {k: round(v / 1073741824, 2) for k, v in by_ent_bytes.items()},
            "to_copy": len(work), "to_copy_gb": round(sum(t["size"] for t in work) / 1073741824, 2),
            "video_to_copy": sum(1 for t in work if t["mime"].startswith("video/")),
            "moves": len(moves), "hold_groups": len(res.holds),
            "hold_kinds": dict(collections.Counter(h["kind"] for h in res.holds.values())),
            "matched_folders": dict(collections.Counter(m["kind"] for m in res.matches.values())),
            "template_note": (f"Skipped {tmpl_skipped} byte-identical copies of {len(tmpl)} known blank template files "
                              f"(same checksum in {TEMPLATE_MIN_ROOTS}+ project folders); one copy of each stays in the "
                              "template folder's holding area.") if tmpl_skipped else None,
        })
        if not apply:
            summary["dry_run"] = True
            summary["plan_s"] = int(_now() - t0)
            return summary

        # apply: folder mirror + holding rows first (held rows need their ids)
        _write_folders(tree, res, quiet)
        hold_ids = _upsert_holds(res.holds)
        for t in work + moves:
            if t["etype"] == "drive_hold":
                t["eid"] = hold_ids[t["group"]]
        prog = Progress(run_id, len(work), quiet)
        prog.extra = {"mode": mode, "prefix": prefix}
        th = threading.Thread(target=prog.loop, daemon=True)
        th.start()
        for t in moves:
            try:
                _move(t)
                prog.add(moved=1)
            except Exception as e:
                prog.add(move_errors=1)
                _log(f"move failed {t['id']}: {e}", quiet)
        left = execute(work, workers, deadline, prog)
        prog.stop.set()
        auto = _auto_resolve_holds(res)
        _refresh_hold_counts()
        done = prog.snapshot()
        done.pop("running", None)
        summary.update({"result": done, "deferred": left, "auto_linked_holds": auto, "partial": bool(left)})
        with engine.begin() as conn:
            set_state(conn, "template_md5", json.dumps(tmpl))
            if not filtered and not left:
                set_state(conn, "changes_page_token", new_token)
                if mode == "full":
                    set_state(conn, "last_full_walk_at", str(t0))
                    if not backfill_done:
                        set_state(conn, "backfill_completed_at", datetime.utcnow().isoformat(timespec="seconds"))
        summary["elapsed_s"] = int(_now() - t0)
        _finish_run(run_id, done.get("errors", 0) == 0, summary,
                    error=f"{done.get('errors')} file(s) failed - see drive_file_state" if done.get("errors") else None)
        return summary
    except Exception as e:
        if run_id:
            _finish_run(run_id, False, error=f"{type(e).__name__}: {e}")
        raise
    finally:
        if lock:
            _release(lock)


def nightly(who="cron"):
    """Called from run.refresh_all after the sheet refreshes. Cron: auto mode
    (weekly full walk) with a 3 h budget; the Data Review button: incremental
    only, 10 min budget. Re-runs continue where a budget-stopped run left off."""
    if who == "cron":
        return run(mode="auto", apply=True, who=who, budget_min=180, quiet=True)
    with engine.connect() as conn:
        if not get_state(conn, "backfill_completed_at"):
            return {"skipped": "the initial Drive backfill has not completed yet"}
    return run(mode="incremental", apply=True, who=who, budget_min=10, quiet=True)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m app.gsync.docs_sync", description=__doc__.split("\n\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="plan only (default)")
    ap.add_argument("--apply", action="store_true", help="copy files and write rows")
    ap.add_argument("--incremental", action="store_true", help="Drive Changes since the last run")
    ap.add_argument("--auto", action="store_true", help="what the nightly job does")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--only-job")
    ap.add_argument("--only-path")
    ap.add_argument("--only-file")
    ap.add_argument("--prefix", help="S3 key prefix override (default S3_PREFIX)")
    ap.add_argument("--workers", type=int)
    ap.add_argument("--budget-min", type=float)
    ap.add_argument("--reuse-walk", action="store_true", help="reuse the last walk (< 36 h old) instead of re-walking")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    mode = "auto" if a.auto else "incremental" if a.incremental else "full"
    s = run(mode=mode, apply=a.apply and not a.dry_run, limit=a.limit, only_job=a.only_job, only_path=a.only_path,
            only_file=a.only_file, prefix=a.prefix, workers=a.workers, budget_min=a.budget_min, who="cli",
            reuse_walk=a.reuse_walk, quiet=a.quiet)
    print(json.dumps(s, indent=1, default=str))


if __name__ == "__main__":
    main()
