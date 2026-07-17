import csv, re

CSV = 'C:/Users/jason/OPI/myapp/references/CustomersList.csv'
OUT = 'C:/tmp/cs/seed_contacts.sql'

def norm(s): return re.sub(r'[^a-z0-9]', '', (s or '').lower())

# qbo_customers id map (all rows)
by_norm = {}
comp_list = []
for line in open('C:/tmp/cs/qbo_all.tsv', encoding='utf-8'):
    p = line.rstrip('\n').split('\t')
    if len(p) >= 2:
        cid = int(p[0]); nm = p[1].strip()
        by_norm.setdefault(norm(nm), cid)
        comp_list.append((norm(nm), cid, nm))
def match_customer(name):
    n = norm(name)
    if not n: return None
    if n in by_norm: return by_norm[n]
    cands = [(len(nn), cid) for nn, cid, _ in comp_list if len(n) >= 4 and (n in nn or nn in n)]
    if cands: cands.sort(); return cands[0][1]
    return None

# existing contacts for dedup: {cid: {norm(full_name), ...}}
existing = {}
for line in open('C:/tmp/cs/existing_contacts.tsv', encoding='utf-8'):
    p = line.rstrip('\n').split('\t')
    if len(p) >= 2:
        existing.setdefault(int(p[0]), set()).add(norm(p[1]))

def sql(v):
    if v is None or v == '': return 'NULL'
    return "'" + str(v).replace('\\', '\\\\').replace("'", "''") + "'"
def first_email(e):
    if not e: return None
    for part in re.split(r'[,;]', e):
        part = part.strip()
        if '@' in part and 'onpointinstallers.com' not in part.lower():
            return part
    # fall back to any email
    for part in re.split(r'[,;]', e):
        if '@' in part: return part.strip()
    return None

rows = []
skipped_nocust = skipped_dup = skipped_junk = 0
seen_new = {}  # dedup within this batch too
with open(CSV, newline='', encoding='utf-8-sig') as f:
    for r in csv.DictReader(f):
        name = r['Name']
        if ':' not in name: continue
        parent, child = name.split(':', 1)
        parent = parent.strip(); child = child.strip()
        # contact rows are Parent:PersonName (skip jobs Parent:#### - ...)
        if re.match(r'^\d', child) or re.search(r'\b\d{3,}\b', child): continue
        if child.lower() in ('tbd', 'ap', 'accounts payable', '') or '@' in child:
            skipped_junk += 1; continue
        cid = match_customer(parent)
        if not cid: skipped_nocust += 1; continue
        nn = norm(child)
        if nn in existing.get(cid, set()) or nn in seen_new.get(cid, set()):
            skipped_dup += 1; continue
        seen_new.setdefault(cid, set()).add(nn)
        parts = child.split()
        first = parts[0] if parts else None
        last = ' '.join(parts[1:]) if len(parts) > 1 else None
        email = first_email(r['Email'])
        phone = (r['Phone'] or '').strip() or None
        rows.append((cid, first, last, child, email, phone))

with open(OUT, 'w', encoding='utf-8') as f:
    f.write("DELETE FROM contacts WHERE source='qbo_csv';\n")
    for cid, first, last, full, email, phone in rows:
        f.write("INSERT INTO contacts (qbo_customer_id, first_name, last_name, full_name, email, phone, is_primary, active, source) VALUES "
                f"({cid},{sql(first)},{sql(last)},{sql(full)},{sql(email)},{sql(phone)},0,1,'qbo_csv');\n")

print(f"new contacts to insert: {len(rows)}")
print(f"skipped: no-customer={skipped_nocust}  dup-of-existing={skipped_dup}  junk={skipped_junk}")
print("SQL ->", OUT)
