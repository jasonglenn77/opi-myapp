"""
Data Review items for the Google Drive -> app documents sync (category "documents").

docs_items(conn) -> list of items in review.py's _item() shape. Reads only the
tables the sync writes (drive_folders, drive_unmatched_folders,
drive_file_state, gsync_runs) plus qbo_customers / opportunities; it never
calls Drive. Returns [] until the first sync has run.

Item types (key = "documents:<type>:<id>"):
  unmatched_folder      A Drive folder whose files could not be filed on a
                        project or quote: kind no_number (no job #),
                        number_unmatched (the # matches nothing), estimate_only
                        (matches only a QuickBooks estimate - suggestion has the
                        estimate # and customer) or outside_project (company-level
                        files such as COIs). The files ARE in the app's holding
                        area. ref = {"drive_unmatched_id", "drive_folder_id",
                        "kind", "suggestion"}; the UI opens
                        openDriveLinkModal(ref) (frontend/src/utils/drive-link.js)
                        to link the folder to a project or quote, or ignore it.
                        Severity: medium when it holds files, low for
                        outside_project.
  ambiguous_folder      The folder's job # matches several projects or quotes;
                        ref.suggestion.candidates lists them. Same modal.
  project_without_drive_folder
                        A QuickBooks project with no Drive folder matched to it
                        (folder missing, misnamed, or filed under another #).
                        link = the project's documents page. Severity low.
  quote_folder_mislinked
                        A Drive folder's job # and the Pipeline disagree: the
                        folder matches project X by its number, but the
                        opportunity with that quote # is linked to project Y
                        (or the folder only reached a project through a quote
                        link whose project name shares nothing with the folder
                        name - e.g. a quote linked to the wrong project).
                        link = #/pipeline (ref.opp_id = the quote). Severity medium.
  copy_error            A Drive file failed to copy (retried each night until
                        it has failed 8 times). One item per file, capped at 100.
  sync_failed           The last Drive documents sync run failed.
"""
import collections
import json
import re

from sqlalchemy import text

from app.gsync.review import _item, _fp

CAT = "documents"
KIND_LABEL = {
    "no_number": "has no job number",
    "number_unmatched": "has a job # that matches no project or quote",
    "estimate_only": "matches only a QuickBooks estimate (no project or Pipeline quote)",
    "outside_project": "sits outside any project folder",
    "ambiguous": "matches more than one project or quote",
}
STOP = {"the", "and", "inc", "llc", "co", "of", "tx", "ca", "fl", "ga", "al", "nc", "sc", "tn", "oh", "ut", "wi",
        "pa", "il", "az", "wa", "or", "nj", "ny", "ok", "mo", "in", "ky", "va", "md", "mi", "mn", "ms", "la", "ar",
        "rack", "install", "installation", "project", "phase", "teardown", "new"}


def _mb(b):
    b = int(b or 0)
    return f"{b / 1073741824:.1f} GB" if b >= 1073741824 else f"{b / 1048576:.1f} MB"


def _words(s):
    return {w for w in re.findall(r"[a-z]{3,}", (s or "").lower()) if w not in STOP}


def _has(conn, table):
    return bool(conn.execute(text("""SELECT COUNT(*) FROM information_schema.tables
                                      WHERE table_schema = DATABASE() AND table_name = :t"""), {"t": table}).scalar())


def docs_items(conn):
    if not _has(conn, "drive_unmatched_folders"):
        return []
    synced = conn.execute(text("SELECT COUNT(*) FROM drive_folders")).scalar()
    if not synced:
        return []
    out = []

    # ── holding area ──
    for r in conn.execute(text("""
            SELECT id, drive_folder_id, path, company, folder_name, kind, guessed_job, suggestion, file_count, total_bytes
            FROM drive_unmatched_folders WHERE status = 'open' AND file_count > 0
            ORDER BY total_bytes DESC""")).mappings():
        sug = r["suggestion"]
        if isinstance(sug, str):
            sug = json.loads(sug) if sug else None
        ref = {"drive_unmatched_id": r["id"], "drive_folder_id": r["drive_folder_id"], "kind": r["kind"],
               "suggestion": sug, "path": r["path"]}
        hint = ""
        if r["kind"] == "estimate_only" and sug and sug.get("estimates"):
            e = sug["estimates"][0]
            hint = f" Suggestion: QuickBooks estimate #{e['doc_number']} ({e.get('customer') or 'no customer'})."
        elif r["kind"] == "ambiguous" and sug and sug.get("candidates"):
            hint = " Candidates: " + "; ".join(c["label"] for c in sug["candidates"][:4]) + "."
        typ = "ambiguous_folder" if r["kind"] == "ambiguous" else "unmatched_folder"
        sev = "low" if r["kind"] == "outside_project" else "medium"
        out.append(_item(CAT, typ, r["id"], sev,
                         f"Drive folder not filed: {r['folder_name'] or r['path']}",
                         f"\"{r['path']}\" {KIND_LABEL.get(r['kind'], r['kind'])}. "
                         f"{r['file_count']} file(s), {_mb(r['total_bytes'])}, copied to the holding area.{hint}",
                         fix="Link the folder to its project or quote (its files move there), or ignore it.",
                         sheet=r["path"], app=r["kind"], ref=ref,
                         fp=_fp(r["drive_folder_id"], r["kind"], r["file_count"])))

    # ── projects with no Drive folder ──
    covered = {str(x[0]) for x in conn.execute(text(
        "SELECT DISTINCT entity_id FROM drive_folders WHERE is_root = 1 AND entity_type = 'project'"))}
    opp_proj = {str(x[0]): str(x[1]) for x in conn.execute(text(
        "SELECT id, project_qbo_id FROM opportunities WHERE project_qbo_id IS NOT NULL"))}
    for x in conn.execute(text(
            "SELECT DISTINCT entity_id FROM drive_folders WHERE is_root = 1 AND entity_type = 'opportunity'")):
        if str(x[0]) in opp_proj:
            covered.add(opp_proj[str(x[0])])
    for r in conn.execute(text("""SELECT qbo_id, display_name FROM qbo_customers
                                  WHERE is_project = 1 AND COALESCE(active, 1) = 1 ORDER BY display_name""")).mappings():
        if str(r["qbo_id"]) in covered or (r["display_name"] or "").startswith("1000 -"):
            continue
        out.append(_item(CAT, "project_without_drive_folder", r["qbo_id"], "low",
                         f"No Drive folder for {r['display_name']}",
                         "No folder under Drive > Customers carries this project's job # (or a quote # linked to it), "
                         "so none of its Drive files are in the app.",
                         fix="Check the Drive folder name has the job # (\"... #NNNN\"), or link its folder from the "
                             "holding area.",
                         link=f"#/entity/project/{r['qbo_id']}", qbo=r["display_name"],
                         ref={"project_qbo_id": r["qbo_id"]}, fp=_fp(r["qbo_id"])))

    # ── Drive folder # vs Pipeline link disagreements ──
    projects = {str(r[0]): r[1] or "" for r in conn.execute(text(
        "SELECT qbo_id, display_name FROM qbo_customers WHERE is_project = 1"))}
    opps = collections.defaultdict(list)
    for r in conn.execute(text("""SELECT id, quote_number, project_qbo_id, title FROM opportunities
                                  WHERE quote_number IS NOT NULL AND project_qbo_id IS NOT NULL""")).mappings():
        opps[r["quote_number"].strip().split(".")[0]].append(dict(r))
    seen = set()
    for f in conn.execute(text("""SELECT drive_id, path, name, match_kind, entity_type, entity_id, nums
                                  FROM drive_folders WHERE is_root = 1 AND entity_type = 'project'""")).mappings():
        nums = [n for n in (f["nums"] or "").split(",") if n]
        x = str(f["entity_id"])
        for n in nums:
            for o in opps.get(n, []):
                y = str(o["project_qbo_id"])
                if y == x or y not in projects or (o["id"], f["drive_id"]) in seen:
                    continue
                y_head = re.split(r"\s+-\s+", projects[y], 1)[0]
                if any(m in re.findall(r"\d{3,5}", y_head) for m in nums):
                    continue          # the folder lists that project's # too
                seen.add((o["id"], f["drive_id"]))
                out.append(_item(CAT, "quote_folder_mislinked", f"{f['drive_id']}:{o['id']}", "medium",
                                 f"Quote #{o['quote_number']} is linked to a different project than its Drive folder",
                                 f"Drive folder \"{f['path']}\" is filed on {projects.get(x, x)} (its job #), but the "
                                 f"Pipeline links quote #{o['quote_number']} ({o['title'] or ''}) to {projects[y]}.",
                                 fix="Check which project the quote belongs to and fix the Pipeline link (or rename "
                                     "the Drive folder).",
                                 link="#/pipeline", sheet=f["path"], app=projects[y],
                                 qbo=projects.get(x), ref={"opp_id": o["id"], "drive_folder_id": f["drive_id"]},
                                 fp=_fp(f["drive_id"], o["id"], x, y)))
        if f["match_kind"] == "project_via_quote":
            fw = _words(re.sub(r"#\s*\d+", "", f["name"]))
            pw = _words(re.sub(r"^[\d\s&,]+-", "", projects.get(x, "")))
            if fw and pw and not (fw & pw):
                out.append(_item(CAT, "quote_folder_mislinked", f"{f['drive_id']}:name", "medium",
                                 f"Drive folder \"{f['name']}\" reaches {projects.get(x, x)} only through a quote link",
                                 f"The folder's # matches a Pipeline quote that is linked to {projects.get(x, x)}, "
                                 "but the names share nothing - the quote may be linked to the wrong project.",
                                 fix="Check the quote's project link on the Pipeline.",
                                 link=f"#/entity/project/{x}", sheet=f["path"], app=projects.get(x),
                                 ref={"drive_folder_id": f["drive_id"], "project_qbo_id": x},
                                 fp=_fp(f["drive_id"], x)))

    # ── copy errors ──
    errs = conn.execute(text("""SELECT drive_id, path, error, attempts, updated_at FROM drive_file_state
                                WHERE status = 'error' ORDER BY updated_at DESC LIMIT 100""")).mappings().all()
    for r in errs:
        out.append(_item(CAT, "copy_error", r["drive_id"], "low",
                         f"Drive file did not copy: {(r['path'] or r['drive_id']).split('/')[-1]}",
                         f"\"{r['path']}\" failed {r['attempts']} time(s): {(r['error'] or '')[:300]}",
                         fix="Retried automatically each night; if it keeps failing, check the file in Drive.",
                         sheet=r["path"], ref={"drive_file_id": r["drive_id"]}, fp=_fp(r["drive_id"], r["attempts"] >= 8)))

    last = conn.execute(text("""SELECT id, ok, error, started_at FROM gsync_runs WHERE source = 'drive_docs'
                                ORDER BY id DESC LIMIT 1""")).mappings().first()
    if last and last["ok"] == 0 and not (last["error"] or "").endswith("see drive_file_state"):
        out.append(_item(CAT, "sync_failed", last["id"], "medium", "The last Google Drive documents sync failed",
                         f"Run {last['id']} started {last['started_at']}: {(last['error'] or '')[:400]}",
                         fix="It runs again tonight; if it keeps failing, check the backend logs.",
                         ref={"run_id": last["id"]}, fp=_fp(last["id"])))
    return out
