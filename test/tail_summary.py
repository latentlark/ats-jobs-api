"""Summarize `wrangler tail --format json` output: outcome and CPU per request. usage: python3 test/tail_summary.py file [since_ms]"""
import json, sys, urllib.parse
raw = open(sys.argv[1]).read(); since = int(sys.argv[2]) if len(sys.argv) > 2 else 0
dec = json.JSONDecoder(); i = 0; ev = []
while i < len(raw):
    while i < len(raw) and raw[i] in ' \r\n\t': i += 1
    if i >= len(raw): break
    try: o, i = dec.raw_decode(raw, i); ev.append(o)
    except Exception: break
rows = []
for e in ev:
    if e.get('eventTimestamp', 0) < since: continue
    r = (e.get('event') or {}).get('request') or {}
    u = urllib.parse.urlparse(r.get('url', '')); q = urllib.parse.parse_qs(u.query)
    label = u.path + ' ' + ','.join(f"{k}={v[0]}" for k, v in q.items() if k in ('ats', 'company', 'limit', 'description', 'v'))
    rows.append((e.get('outcome'), e.get('cpuTime'), e.get('wallTime'), (e.get('event') or {}).get('response', {}).get('status'), label))
for r in rows: print('\t'.join(map(str, r)))
oc = {}
for r in rows: oc[r[0]] = oc.get(r[0], 0) + 1
print('outcomes', oc, 'n', len(rows))
