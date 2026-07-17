import csv, re, datetime

RR = 'C:/Users/jason/OPI/myapp/references/Jason Copy of OP.B151.Project Forecast - 2. Rolling Revenue.csv'
QBO = 'C:/tmp/cs/qbo_companies.tsv'
OUT = 'C:/tmp/cs/seed_rr.sql'

# ---- customer matcher (exact -> normalized -> substring) ----
comp = {}
with open(QBO, encoding='utf-8') as f:
    for line in f:
        p = line.rstrip('\n').split('\t')
        if len(p) >= 2:
            comp[p[1].strip()] = int(p[0])
def norm(s): return re.sub(r'[^a-z0-9]', '', s.lower())
comp_norm = {norm(k): v for k, v in comp.items()}
comp_list = [(norm(k), v) for k, v in comp.items()]
def match_customer(name):
    if not name: return None
    n = norm(name)
    if not n: return None
    if n in comp_norm: return comp_norm[n]
    # substring both directions, prefer the longest qbo name containing it
    cands = [(len(nn), cid) for nn, cid in comp_list if len(n) >= 3 and (n in nn or nn in n)]
    if cands:
        cands.sort()
        return cands[0][1]
    return None

# ---- status map: RR probability stage -> lifecycle status ----
def lifecycle(pstat):
    p = (pstat or '').lower()
    if 'won' in p or 'red flag' in p: return 'won'          # "Goes to Ops Tab"
    if 'lost' in p: return 'lost'
    if 'inactive' in p: return 'declined'
    return 'sent'  # 20/40/60/80% verbal — a quote exists, awaiting decision

def sql_str(v):
    if v is None or v == '': return 'NULL'
    return "'" + str(v).replace('\\', '\\\\').replace("'", "''") + "'"
def money(v):
    if not v: return None
    s = re.sub(r'[^0-9.\-]', '', v)
    try: return float(s) if s not in ('', '-', '.') else None
    except: return None
def pct(v):
    if not v: return None
    s = re.sub(r'[^0-9.\-]', '', v)
    try: return float(s) if s not in ('', '-', '.') else None
    except: return None
def num(v):
    if not v: return None
    s = re.sub(r'[^0-9.\-]', '', v)
    try: return float(s) if s not in ('', '-', '.') else None
    except: return None
def date(v):
    if not v: return None
    v = v.strip()
    for fmt in ('%m/%d/%Y', '%m/%d/%y', '%Y-%m-%d'):
        try: return datetime.datetime.strptime(v, fmt).strftime('%Y-%m-%d')
        except: pass
    return None

rows = list(csv.reader(open(RR, newline='', encoding='utf-8')))
def g(r, j): return r[j].strip() if j < len(r) else ''

out = []
matched = unmatched = 0
stats = {}
for i in range(8, len(rows)):
    r = rows[i]
    quote = g(r, 6)
    if not quote: continue
    cust_raw = g(r, 13)
    cid = match_customer(cust_raw)
    if cid: matched += 1
    else: unmatched += 1
    pstat = g(r, 1)
    # Align the RR status text to the estimate_pipeline_status lookup keys
    # (the Estimates page's status column), so the dropdown resolves it.
    if pstat == "20% Budgetary, Project Uncertain":
        pstat = "20% Verbal - Budgetary, Project Uncertain"
    lc = lifecycle(pstat)
    stats[lc] = stats.get(lc, 0) + 1
    cols = {
        'qbo_customer_id': cid if cid else 'NULL',
        'customer_name_raw': sql_str(cust_raw),
        'contact_name_raw': sql_str(g(r, 12)),
        'title': sql_str(g(r, 16)),
        'quote_number': sql_str(quote),
        'pipeline_status': sql_str(pstat),
        'status': sql_str(lc),
        # contact-logging summary (RR: Last Contact / Follow Up Qty / Comm Type / Revision date)
        'last_contact_date': sql_str(date(g(r, 2))),
        'follow_up_count': int(num(g(r, 3))) if num(g(r, 3)) is not None else 'NULL',
        'last_comm_type': sql_str(g(r, 4)) if g(r, 4) in ('LVM', 'PC', 'ES', 'ER') else 'NULL',
        'most_recent_revision_date': sql_str(date(g(r, 8))),
        'quoted_by': sql_str(g(r, 11)),
        'city': sql_str(g(r, 14)),
        'state': sql_str(g(r, 15)),
        'rfq_received_date': sql_str(date(g(r, 7))),
        'order_date': sql_str(date(g(r, 10))),
        'target_start_date': sql_str(date(g(r, 19))),
        'target_end_date': sql_str(date(g(r, 20))),
        'discounted_contract_value': money(g(r, 32)) if money(g(r, 32)) is not None else 'NULL',
        'metrics_source': "'rr'",
        'quote_sent_date': sql_str(date(g(r, 28))),
        'expected_decision_date': sql_str(date(g(r, 31))),
        'labor_days': num(g(r, 17)) if num(g(r, 17)) is not None else 'NULL',
        'travel_days': num(g(r, 18)) if num(g(r, 18)) is not None else 'NULL',
        'total_revisions': int(num(g(r, 23))) if num(g(r, 23)) is not None else 'NULL',
        'ohp_amount': money(g(r, 25)) if money(g(r, 25)) is not None else 'NULL',
        'ohp_pct': pct(g(r, 26)) if pct(g(r, 26)) is not None else 'NULL',
        'contract_value': money(g(r, 27)) if money(g(r, 27)) is not None else 'NULL',
        'order_value': money(g(r, 29)) if money(g(r, 29)) is not None else 'NULL',
        'source': "'rr_import'",
        'received_at': sql_str(date(g(r, 7))),
        'decided_at': sql_str(date(g(r, 10))) if lc in ('won','lost','declined') else 'NULL',
    }
    keys = ','.join(cols.keys())
    vals = ','.join(str(v) for v in cols.values())
    out.append(f"INSERT INTO opportunities ({keys}) VALUES ({vals});")

with open(OUT, 'w', encoding='utf-8') as f:
    f.write("DELETE FROM opportunities WHERE source='rr_import';\n")
    f.write('\n'.join(out) + '\n')

print(f"rows: {len(out)}  matched_customer: {matched}  unmatched: {unmatched}")
print("lifecycle:", stats)
print("SQL ->", OUT)
