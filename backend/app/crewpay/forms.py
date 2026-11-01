"""
Crew forms on file, per project. Crews have filed forms in Drive for years, and
the Crew Portal adds its own, so both count:

  kickoff     Crew Project Kickoff Checklist (the customer's checklist isn't a crew form)
  daily       JHAs, stand-ups, forklift and lift inspections, daily reports
  completion  Project Completion Form
  other       the Crew Portal's truck, trailer and gear forms (listed, not expected)

Drive files carry no form type, so they're matched by name inside the project
folders (6 Project Management, 7 Notes, 10 Crew Documents). A file with the same
contents on three or more projects is a blank copy, not a filled-in form.

A Word copy of the Completion Form has blank signature lines (checked on a sample
10/2026), so it counts as a draft: it's listed, but the form still shows as missing.
A PDF or photo is taken as signed, because a file name can't prove it.

Daily forms have never been filed on most jobs, so a missing one shows on the
Crew forms tab but doesn't become an issue.
"""
import json
import re
from collections import defaultdict

from sqlalchemy import text

GROUPS = {"kickoff": "Crew kickoff checklist", "daily": "Daily and safety forms",
          "completion": "Project Completion Form", "other": "Other crew forms"}
BLANK_COPY_MIN = 3           # projects sharing identical contents
APP_GROUP = {"kickoff_update": "kickoff", "daily_update": "daily", "daily_jha": "daily", "completion": "completion"}

_SKIP = re.compile(r"\.(mp4|mov|avi|wmv|m4v|mp3|m4a|msg|eml|vtt|zip)$")
_DRAFT = re.compile(r"\.docx?$")
_COMPLETION = re.compile(r"completion.{0,30}(form|sign|cert)|(sign|form).{0,30}completion")
_KICKOFF = re.compile(r"kick-? ?off.{0,40}(checklist|form)")
_DAILY = re.compile(r"(^|[^a-z])jha([^a-z]|$)|job hazard|forklift|lift (daily|inspection)|stand-?up"
                    r"|daily[ _-]*(form|progress|report|update|check|log)|tool ?box|^installing-|^assembly-")


def kind_of(filename):
    n = (filename or "").lower().strip()
    if _SKIP.search(n) or "guideline" in n:
        return None
    if _COMPLETION.search(n):
        return "completion"
    if _KICKOFF.search(n):
        return None if "customer" in n else "kickoff"
    return "daily" if _DAILY.search(n) else None


def expected(state):
    """What a job should have by now. A job that hasn't started needs nothing."""
    if state == "finished":
        return ["kickoff", "daily", "completion"]
    return ["kickoff", "daily"] if state == "active" else []


def load(conn):
    """{entity_id: {group: [form]}} for every project with a form on file."""
    docs = conn.execute(text("""
        SELECT id, entity_type, entity_id, folder, original_filename AS f, drive_md5 AS md5,
               COALESCE(LEFT(drive_modified, 10), DATE(created_at)) AS d
        FROM documents
        WHERE entity_type IN ('project', 'opportunity') AND drive_removed_at IS NULL
          AND (folder LIKE '6%' OR folder LIKE '7%' OR folder LIKE '10%')
          AND original_filename REGEXP 'completion|kick-? ?off|jha|hazard|forklift|lift |stand-?up|daily|tool ?box|^installing-|^assembly-'
    """)).mappings().all()
    opp = {str(r[0]): str(r[1]) for r in conn.execute(text(
        "SELECT id, project_qbo_id FROM opportunities WHERE project_qbo_id IS NOT NULL")).all()}

    projects_by_hash = defaultdict(set)
    for d in docs:
        if d["md5"]:
            projects_by_hash[d["md5"]].add((d["entity_type"], d["entity_id"]))

    out = defaultdict(lambda: defaultdict(list))
    seen = set()
    for d in docs:
        g = kind_of(d["f"])
        e = str(d["entity_id"]) if d["entity_type"] == "project" else opp.get(str(d["entity_id"]))
        if not g or not e or len(projects_by_hash.get(d["md5"], ())) >= BLANK_COPY_MIN:
            continue
        if d["md5"] and (e, d["md5"]) in seen:     # a linked opportunity can hold the same file
            continue
        seen.add((e, d["md5"]))
        out[e][g].append({"id": d["id"], "name": d["f"], "date": str(d["d"]) if d["d"] else None,
                          "draft": g == "completion" and bool(_DRAFT.search(d["f"].lower().strip()))})

    titles = dict(conn.execute(text("SELECT code, title FROM form_templates")).all())
    for r in conn.execute(text("""
        SELECT id, project_qbo_id AS e, form_code, COALESCE(report_date, DATE(submitted_at)) AS d, answers
        FROM form_submissions
    """)).mappings():
        try:
            answers = json.loads(r["answers"]) if isinstance(r["answers"], (str, bytes)) else r["answers"]
        except ValueError:
            answers = None
        out[str(r["e"])][APP_GROUP.get(r["form_code"], "other")].append(
            {"sub_id": r["id"], "name": titles.get(r["form_code"]) or r["form_code"], "date": str(r["d"]) if r["d"] else None,
             "draft": False, "answers": answers})
    for r in conn.execute(text("SELECT DISTINCT entity_id FROM project_kickoff_responses WHERE form_key = 'crew'")).all():
        out[str(r[0])]["kickoff"].append({"name": "Crew kickoff filled in on the project", "date": None, "draft": False, "kickoff_tab": True})
    return out


def row(job, files, crew, paid):
    """One job on the Crew forms tab."""
    c = {g: sum(1 for f in files.get(g, []) if not f["draft"]) for g in GROUPS}
    missing = [g for g in expected(job["state"]) if not c[g]]
    return {"entity_id": job["id"], "job": job["name"], "pm": job["pm"], "state": job["state"], "end": job["end"], "crew": crew,
            "paid": round(paid, 2), "kickoff": c["kickoff"], "daily": c["daily"], "completion": c["completion"], "other": c["other"],
            "draft": sum(1 for f in files.get("completion", []) if f["draft"]),
            "missing": missing, "none": not any(c.values())}


def for_job(conn, entity_id):
    files = load(conn).get(str(entity_id), {})
    return [{"key": g, "label": label, "files": sorted(files.get(g, []), key=lambda f: f["date"] or "", reverse=True)}
            for g, label in GROUPS.items()]
