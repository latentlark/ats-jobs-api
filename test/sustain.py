"""Sustained heavy load: N rounds over large boards (mostly cache hits that still parse big cached boards).
usage: python3 test/sustain.py base rounds"""
import sys, time, json, urllib.request, urllib.error, concurrent.futures as cf
BASE, ROUNDS = sys.argv[1], int(sys.argv[2])
P = [f'/jobs?ats={a}&company={c}&limit=500&description={l}&descriptionMaxLength=1000' for a, c in [('greenhouse', 'stripe'), ('greenhouse', 'databricks'), ('ashby', 'openai'), ('recruitee', 'vdkgroep'), ('lever', 'palantir'), ('greenhouse', 'cloudflare')] for l in ('text', 'html')]
def one(p):
    t = time.time()
    try: r = urllib.request.urlopen(urllib.request.Request(BASE + p, headers={'User-Agent': 'ats-jobs-api-test/1.0'}), timeout=90); code, raw = r.status, r.read()
    except urllib.error.HTTPError as e: code, raw = e.code, e.read()
    except Exception as e: code, raw = 0, str(e).encode()
    return code, round((time.time() - t) * 1000), raw[:100]
res = []
with cf.ThreadPoolExecutor(6) as ex:
    for _ in range(ROUNDS): res += list(ex.map(one, P))
codes = {}
for c, _, _ in res: codes[c] = codes.get(c, 0) + 1
lat = sorted(r[1] for r in res)
print('requests', len(res), 'codes', codes, 'p50', lat[len(lat) // 2], 'p95', lat[int(len(lat) * .95)], 'max', lat[-1])
for c, ms, raw in res:
    if c != 200: print('  FAIL', c, ms, raw); 
