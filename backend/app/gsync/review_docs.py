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
  removed_in_drive      Copied files later trashed/deleted/moved out of
                        Customers in Drive (documents.drive_removed_at), one
                        item per project / quote / holding folder with counts
                        and sample names. The app keeps the copies; Ignore =
                        confirmed (re-opens when more files are removed).
  reconcile_mismatch    Latest unfiltered docs_sync.reconcile() run: one item
                        per Drive folder whose files and the app's rows differ
                        (missing, changed, misfiled, extra), capped at 200.

Category "old_estimates" (Data Review tab "Old estimate folders"):
  estimate_folder       Held folders of kind estimate_only (match only a
                        QuickBooks estimate - mostly 2023-24 jobs). Same Link
                        folder... action; item.group = estimate year (y2024),
                        title "<customer folder> - <folder>" so they sort by
                        customer within a year.
"""
import collections
import json
import re

from sqlalchemy import bindparam, text

from app.gsync.review import _item, _fp

CAT = "documents"
CAT_OLD = "old_estimates"
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


def _old_estimate_item(r, sug, est_date):
    """Held folder that matches only a QuickBooks estimate (mostly 2023-24 jobs
    that never became a project or Pipeline quote): own category, grouped by
    the estimate's year, titled "<customer folder> - <folder>" so the list
    sorts by customer."""
    ests = (sug or {}).get("estimates") or []
    e = ests[0] if ests else None
    dates = [d for d in (est_date.get(str(x["qbo_id"])) for x in ests) if d]
    year = max(dates).year if dates else None
    hint = ""
    if e:
        hint = f" QuickBooks estimate #{e['doc_number']} ({e.get('customer') or 'no customer'}" + \
            (f", {max(dates).isoformat()}" if dates else "") + ")."
        if len(ests) > 1:
            hint += f" {len(ests) - 1} more estimate(s) share the number."
    ref = {"drive_unmatched_id": r["id"], "drive_folder_id": r["drive_folder_id"], "kind": r["kind"],
           "suggestion": sug, "path": r["path"]}
    it = _item(CAT_OLD, "estimate_folder", r["id"], "low",
               f"{r['company'] or '(top level)'} — {r['folder_name'] or r['path']}",
               f"\"{r['path']}\": {r['file_count']} file(s), {_mb(r['total_bytes'])}, kept in the holding area.{hint}",
               fix="Link it if the job became a project or quote under another number; otherwise Ignore "
                   "(the files stay in the holding area).",
               sheet=r["path"], app=r["kind"], ref=ref, fp=_fp(r["drive_folder_id"], r["kind"], r["file_count"]))
    it["group"] = f"y{year}" if year else "y0000"
    it["group_label"] = f"Estimates from {year}" if year else "Estimate date unknown"
    return it


def _entity_labels(conn, keys):
    """{(entity_type, entity_id): (label, link)} for projects, quotes and holding folders."""
    out = {}
    ids = collections.defaultdict(set)
    for t, i in keys:
        ids[t].add(str(i))
    q = {"project": ("SELECT qbo_id, display_name FROM qbo_customers WHERE qbo_id IN :ids", "#/entity/project/{}"),
         "opportunity": ("SELECT id, CONCAT('Quote #', COALESCE(quote_number, id), ' ', COALESCE(title, '')) "
                         "FROM opportunities WHERE id IN :ids", "#/pipeline"),
         "drive_hold": ("SELECT id, CONCAT('Holding area: ', path) FROM drive_unmatched_folders WHERE id IN :ids", None)}
    for t, (sql, link) in q.items():
        if ids.get(t):
            for x in conn.execute(text(sql).bindparams(bindparam("ids", expanding=True)), {"ids": sorted(ids[t])}):
                out[(t, str(x[0]))] = ((x[1] or "").strip(), link.format(x[0]) if link else None)
    return out


def _removed_items(conn):
    """Copied Drive files that were later removed in Drive, one item per record."""
    rows = conn.execute(text("""
        SELECT entity_type, entity_id, COUNT(*) n, SUM(size_bytes) b, MIN(drive_removed_at) first_at,
               MAX(drive_removed_at) last_at,
               SUBSTRING_INDEX(GROUP_CONCAT(COALESCE(drive_path, original_filename) ORDER BY drive_removed_at DESC
                               SEPARATOR '|'), '|', 6) AS sample,
               GROUP_CONCAT(DISTINCT drive_removed_reason) AS reasons
        FROM documents WHERE drive_removed_at IS NOT NULL
        GROUP BY entity_type, entity_id ORDER BY last_at DESC LIMIT 500""")).mappings().all()
    if not rows:
        return []
    labels = _entity_labels(conn, [(r["entity_type"], r["entity_id"]) for r in rows])
    from app.gsync.docs_sync import REMOVED_REASONS
    out = []
    for r in rows:
        label, link = labels.get((r["entity_type"], str(r["entity_id"])), (f"{r['entity_type']} {r['entity_id']}", None))
        names = ", ".join(x.split("/")[-1] for x in (r["sample"] or "").split("|")[:5]) + (", …" if r["n"] > 5 else "")
        why = "; ".join(REMOVED_REASONS.get(x, x) for x in (r["reasons"] or "").split(",") if x)
        first, last = str(r["first_at"])[:10], str(r["last_at"])[:10]
        when = first if first == last else f"{first} – {last}"
        out.append(_item(CAT, "removed_in_drive", f"{r['entity_type']}:{r['entity_id']}",
                         "low" if r["entity_type"] == "drive_hold" else "medium",
                         f"{r['n']} file(s) removed from Google Drive — {label}",
                         f"Removed in Drive on {when}: {names}. Reason: {why}. The app keeps its copies "
                         f"({_mb(r['b'])}), marked \"Removed from Google Drive\" in the documents list.",
                         fix="Check the removal was intended. Keep the copies, or delete them from the documents "
                             "page. Ignore = confirmed (comes back if more files are removed).",
                         link=link, app=label, ref={"entity_type": r["entity_type"], "entity_id": r["entity_id"]},
                         fp=_fp(r["entity_type"], r["entity_id"], r["n"], str(r["last_at"]))))
    return out


def _reconcile_items(conn):
    """Per-folder Drive vs app differences from the latest unfiltered reconcile run."""
    # id first, then the (large) summary by primary key - sorting rows that carry
    # the JSON summary runs MySQL out of sort memory
    rid = None
    for (i,) in conn.execute(text("""SELECT id FROM gsync_runs WHERE source = 'drive_reconcile'
                                     ORDER BY id DESC LIMIT 20""")).all():
        if conn.execute(text("SELECT JSON_EXTRACT(summary, '$.filtered') = false FROM gsync_runs WHERE id = :i"),
                        {"i": i}).scalar():
            rid = i
            break
    if not rid:
        return []
    run = conn.execute(text("SELECT id, finished_at, summary FROM gsync_runs WHERE id = :i"), {"i": rid}).mappings().first()
    s = json.loads(run["summary"]) if isinstance(run["summary"], str) else (run["summary"] or {})
    recs = (s.get("folders") or [])[:200]
    labels = _entity_labels(conn, [(r["entity_type"], r["entity_id"]) for r in recs if r.get("entity_type")])
    out = []
    tot, n_bad = s.get("totals") or {}, s.get("folders_mismatched") or 0
    if n_bad > len(recs):
        out.append(_item(CAT, "reconcile_mismatch", "_totals", "medium",
                         f"Drive vs app check: {n_bad:,} of {s.get('folders_checked', 0):,} Drive folders differ "
                         f"(the {len(recs)} largest are listed)",
                         f"Drive {tot.get('drive_files', 0):,} files ({_mb(tot.get('drive_bytes'))}) · app "
                         f"{tot.get('app_files', 0):,} ({_mb(tot.get('app_bytes'))}). Missing in the app "
                         f"{tot.get('missing', 0):,} ({_mb(tot.get('missing_bytes'))}), copy errors "
                         f"{tot.get('errors', 0):,}, changed {tot.get('changed', 0):,}, misfiled "
                         f"{tot.get('misfiled', 0):,}, removed in Drive {tot.get('extra', 0):,} "
                         f"({tot.get('extra_unflagged', 0):,} not yet marked). Checked {str(run['finished_at'])[:16]}.",
                         fix="Expected while the backfill is still copying; after it completes this should drop to "
                             "a handful of folders.",
                         ref={"run_id": run["id"]}, fp=_fp(n_bad, tot.get("missing"), tot.get("changed"))))
    for r in recs:
        label, link = labels.get((r.get("entity_type"), str(r.get("entity_id"))), (None, None))
        where = r.get("path") or label or r["key"]
        bits = []
        if r.get("missing"):
            ex = ", ".join(x.split("/")[-1] for x in r.get("missing_examples", [])[:3])
            bits.append(f"{r['missing']} missing in the app ({_mb(r.get('missing_bytes'))}; e.g. {ex})")
        if r.get("errors"):
            bits.append(f"{r['errors']} with copy errors")
        if r.get("changed"):
            bits.append(f"{r['changed']} changed in Drive since copied")
        if r.get("misfiled"):
            bits.append(f"{r['misfiled']} filed on a different record or folder than the Drive folder's match")
        if r.get("extra_unflagged"):
            ex = ", ".join(x.split("/")[-1] for x in r.get("extra_examples", [])[:3])
            bits.append(f"{r['extra_unflagged']} in the app but no longer in Drive, not yet marked removed (e.g. {ex})")
        if r.get("stale_flag"):
            bits.append(f"{r['stale_flag']} marked removed but back in Drive")
        sev = "medium" if (r.get("missing") or r.get("changed") or r.get("misfiled") or r.get("errors")) else "low"
        name = where.split("/")[-1] if r.get("path") else where
        out.append(_item(CAT, "reconcile_mismatch", r["key"], sev, f"Drive vs app differs: {name}",
                         f"\"{where}\"{' → ' + label if label and r.get('path') else ''}. "
                         f"Drive {r.get('drive_files', 0)} file(s), {_mb(r.get('drive_bytes'))} · app "
                         f"{r.get('app_files', 0)}, {_mb(r.get('app_bytes'))}: " + "; ".join(bits) +
                         f". Checked {str(run['finished_at'])[:16]}.",
                         fix="The nightly sync normally closes these (copies missing or changed files, re-files "
                             "rows). If it is still listed after the next weekly check, look at the copy errors or "
                             "the folder in Drive.",
                         link=link, sheet=r.get("path"), app=label,
                         ref={"drive_folder_id": r["key"], "run_id": run["id"]},
                         fp=_fp(r["key"], *(r.get(k, 0) for k in ("missing", "errors", "changed", "misfiled",
                                                                 "extra_unflagged", "stale_flag")))))
    return out


def docs_items(conn):
    if not _has(conn, "drive_unmatched_folders"):
        return []
    synced = conn.execute(text("SELECT COUNT(*) FROM drive_folders")).scalar()
    if not synced:
        return []
    out = []

    # ── holding area ──
    held = conn.execute(text("""
            SELECT id, drive_folder_id, path, company, folder_name, kind, guessed_job, suggestion, file_count, total_bytes
            FROM drive_unmatched_folders WHERE status = 'open' AND file_count > 0
            ORDER BY total_bytes DESC""")).mappings().all()
    est_ids = set()
    for r in held:
        if r["kind"] == "estimate_only" and r["suggestion"]:
            sug = json.loads(r["suggestion"]) if isinstance(r["suggestion"], str) else r["suggestion"]
            est_ids.update(str(e["qbo_id"]) for e in (sug or {}).get("estimates") or [])
    est_date, est_list = {}, sorted(est_ids)
    for i in range(0, len(est_list), 1000):
        est_date.update({str(x[0]): x[1] for x in conn.execute(text(
            "SELECT qbo_id, txn_date FROM qbo_transactions WHERE entity_type = 'Estimate' AND qbo_id IN :ids"
        ).bindparams(bindparam("ids", expanding=True)), {"ids": est_list[i:i + 1000]})})
    for r in held:
        sug = r["suggestion"]
        if isinstance(sug, str):
            sug = json.loads(sug) if sug else None
        if r["kind"] == "estimate_only":
            out.append(_old_estimate_item(r, sug, est_date))
            continue
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

    out += _removed_items(conn)
    out += _reconcile_items(conn)

    last = conn.execute(text("""SELECT id, ok, error, started_at FROM gsync_runs WHERE source = 'drive_docs'
                                ORDER BY id DESC LIMIT 1""")).mappings().first()
    if last and last["ok"] == 0 and not (last["error"] or "").endswith("see drive_file_state"):
        out.append(_item(CAT, "sync_failed", last["id"], "medium", "The last Google Drive documents sync failed",
                         f"Run {last['id']} started {last['started_at']}: {(last['error'] or '')[:400]}",
                         fix="It runs again tonight; if it keeps failing, check the backend logs.",
                         ref={"run_id": last["id"]}, fp=_fp(last["id"])))
    return out
