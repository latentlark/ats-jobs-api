"""Cold reads of large boards on fresh cache keys (each description level is its own cache key).
usage: python3 test/coldround.py base [levels]"""
import json, sys, time, urllib.request, urllib.error, concurrent.futures as cf
BASE = sys.argv[1]; LEVELS = (sys.argv[2] if len(sys.argv) > 2 else 'none,text,html').split(',')
UA = 'ats-jobs-api-test/1.0'
BOARDS = [('greenhouse', 'stripe'), ('greenhouse', 'databricks'), ('greenhouse', 'cloudflare'), ('greenhouse', 'datadog'), ('greenhouse', 'airbnb'),
          ('lever', 'palantir'), ('lever', 'zoox'), ('ashby', 'openai'), ('ashby', 'notion'), ('ashby', 'ramp'), ('smartrecruiters', 'BoschGroup'),
          ('recruitee', 'vdkgroep'), ('recruitee', 'duravermeer'), ('recruitee', 'careyn')]
def one(ats, c, lvl):
    url = f'{BASE}/jobs?ats={ats}&company={c}&limit=500&description={lvl}&descriptionMaxLength=1000'
    t = time.time()
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=90); code, raw = r.status, r.read()
    except urllib.error.HTTPError as e: code, raw = e.code, e.read()
    except Exception as e: code, raw = 0, str(e).encode()
    ms = round((time.time() - t) * 1000)
    try: d = json.loads(raw); cached = d.get('meta', {}).get('cached'); n = d.get('meta', {}).get('returned'); err = (d.get('error') or {}).get('code')
    except Exception: cached = n = None; err = raw[:120].decode(errors='replace').replace('\n', ' ')
    return (ats, c, lvl, code, n, cached, ms, len(raw) // 1024, err)
rows = []
with cf.ThreadPoolExecutor(4) as ex:
    for r in ex.map(lambda a: one(*a), [(a, c, l) for l in LEVELS for a, c in BOARDS]): rows.append(r); print('\t'.join(map(str, r)), flush=True)
fails = [r for r in rows if r[3] != 200]
print(f'cold round: {len(rows)} requests, {len(fails)} failed ({100 * len(fails) / len(rows):.0f}%), cold (not cached) {sum(1 for r in rows if r[5] is False)}')
