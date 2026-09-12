"""App-wide audit trail (#3 from OPI pipeline feedback).

One shared helper every router logs through, so any new endpoint gets auditing
for free. Rows land in audit_log (migration 0048): actor, action, target,
old→new diff and an optional user-supplied reason inside the detail JSON.

Conventions
-----------
action       "<area>.<verb>"  e.g. lookup.update, rate.create, contact.delete,
             auth.login / auth.login_failed, user.update, perms.update
target_type  the noun being changed: 'user' | 'role' | 'contact' |
             'lookup_value' | 'productivity_rate' | 'rental_rate' | ...
detail       JSON — {"changes": {field: [old, new]}, "reason": "...", ...}

Use diff_fields(old, new) to build the changes dict so updates always record
what the value was BEFORE the change, not just what it became.
"""
import json

from sqlalchemy import text


def record_audit(actor, action, target_type=None, target_id=None, target_label=None, detail=None):
    """Best-effort audit trail. Auditing must never break the action it records."""
    try:
        from .db import engine
        with engine.begin() as conn:
            conn.execute(text("""
                INSERT INTO audit_log (actor_user_id, actor_email, action, target_type, target_id, target_label, detail)
                VALUES (:aid, :aem, :act, :tt, :tid, :tl, :det)
            """), {
                "aid": (actor or {}).get("id"),
                "aem": (actor or {}).get("email"),
                "act": action,
                "tt": target_type,
                "tid": None if target_id is None else str(target_id),
                "tl": target_label,
                "det": json.dumps(detail, default=str) if detail is not None else None,
            })
    except Exception:
        pass


def diff_fields(old, new, fields):
    """{field: [old, new]} for the fields that actually changed. `old`/`new` are
    mappings (a DB row and a request payload both work)."""
    changes = {}
    for f in fields:
        ov = old.get(f) if old else None
        nv = new.get(f) if new else None
        # Normalise numerics so Decimal('5.00') vs 5.0 isn't a phantom change.
        try:
            if ov is not None and nv is not None and float(ov) == float(nv):
                continue
        except (TypeError, ValueError):
            pass
        if ov != nv:
            changes[f] = [ov, nv]
    return changes
