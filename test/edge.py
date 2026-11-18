"""Edge-case and error-path checks against a running worker. usage: python3 test/edge.py [base]"""
import json, sys, time, urllib.request, urllib.error, urllib.parse
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8787'

def call(method, path, body=None, headers=None, raw_body=None):
    data = raw_body if raw_body is not None else (json.dumps(body).encode() if body is not None else None)
    h = {'Content-Type': 'application/json'} if data is not None else {}
    h.update(headers or {})
    req = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    t = time.time()
    try:
        r = urllib.request.urlopen(req, timeout=60); code, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        code, raw = e.code, e.read()
    try: d = json.loads(raw)
    except Exception: d = {'_raw': raw[:200].decode(errors='replace')}
    return code, round((time.time() - t) * 1000), len(raw), d

Q = urllib.parse.quote
cases = [
  ('missing company', 'GET', '/jobs?ats=greenhouse', None, 400),
  ('empty company', 'GET', '/jobs?ats=greenhouse&company=', None, 400),
  ('bad ats', 'GET', '/jobs?ats=taleo&company=stripe', None, 400),
  ('unknown GH board', 'GET', '/jobs?ats=greenhouse&company=nonexistentxyz123', None, 404),
  ('unknown Lever board', 'GET', '/jobs?ats=lever&company=nonexistentxyz123', None, 404),
  ('unknown Ashby board', 'GET', '/jobs?ats=ashby&company=nonexistentxyz123', None, 404),
  ('unknown SR company', 'GET', '/jobs?ats=smartrecruiters&company=nonexistentxyz123', None, 404),
  ('unknown Workable', 'GET', '/jobs?ats=workable&company=nonexistentxyz123', None, 404),
  ('unknown Recruitee (DNS)', 'GET', '/jobs?ats=recruitee&company=nonexistentxyz123', None, 404),
  ('unicode slug', 'GET', '/jobs?ats=greenhouse&company=' + Q('münchen-jobs'), None, 400),
  ('unicode q (Ü, accents)', 'GET', '/jobs?ats=recruitee&company=duravermeer&q=' + Q('Omgevingsmanager') + '&limit=5', None, 200),
  ('accent-insensitive q', 'GET', '/jobs?ats=smartrecruiters&company=BoschGroup&q=' + Q('Ingénieur'), None, 200),
  ('emoji q', 'GET', '/jobs?ats=greenhouse&company=stripe&q=' + Q('🚀'), None, 200),
  ('path traversal slug', 'GET', '/jobs?ats=greenhouse&company=' + Q('../../v1/boards/stripe'), None, 400),
  ('limit huge', 'GET', '/jobs?ats=greenhouse&company=stripe&limit=100000&description=none', None, 200),
  ('limit 0', 'GET', '/jobs?ats=greenhouse&company=stripe&limit=0', None, 400),
  ('limit not int', 'GET', '/jobs?ats=greenhouse&company=stripe&limit=abc', None, 400),
  ('negative offset', 'GET', '/jobs?ats=greenhouse&company=stripe&offset=-1', None, 400),
  ('offset past end', 'GET', '/jobs?ats=greenhouse&company=stripe&offset=99999', None, 200),
  ('filter 0 matches', 'GET', '/jobs?ats=greenhouse&company=stripe&q=zzzqqqxxx', None, 200),
  ('remote=true', 'GET', '/jobs?ats=greenhouse&company=stripe&remote=true&description=none&limit=500', None, 200),
  ('remote bad', 'GET', '/jobs?ats=greenhouse&company=stripe&remote=maybe', None, 400),
  ('description bad', 'GET', '/jobs?ats=greenhouse&company=stripe&description=pdf', None, 400),
  ('description html', 'GET', '/jobs?ats=greenhouse&company=stripe&description=html&limit=2', None, 200),
  ('descMaxLen huge', 'GET', '/jobs?ats=lever&company=palantir&descriptionMaxLength=999999&limit=3', None, 200),
  ('location+department', 'GET', '/jobs?ats=ashby&company=openai&location=san%20francisco&department=research&description=none&limit=500', None, 200),
  ('employmentType', 'GET', '/jobs?ats=recruitee&company=duravermeer&employmentType=part_time&description=none&limit=500', None, 200),
  ('postedWithinDays', 'GET', '/jobs?ats=smartrecruiters&company=BoschGroup&postedWithinDays=7&description=none&limit=500', None, 200),
  ('sort posted_desc', 'GET', '/jobs?ats=lever&company=palantir&sort=posted_desc&description=none&limit=5', None, 200),
  ('ats:slug form', 'GET', '/jobs?company=greenhouse:databricks&limit=3&description=none', None, 200),
  ('board URL form', 'GET', '/jobs?company=' + Q('https://jobs.lever.co/palantir/xyz') + '&limit=3&description=none', None, 200),
  ('ats mismatch', 'GET', '/jobs?ats=ashby&company=greenhouse:stripe', None, 400),
  ('auto-detect slug', 'GET', '/jobs?company=ramp&limit=3&description=none', None, 200),
  ('SR descriptions small page', 'GET', '/jobs?ats=smartrecruiters&company=BoschGroup&limit=5', None, 200),
  ('SR server-side q', 'GET', '/jobs?ats=smartrecruiters&company=BoschGroup&q=python&description=none&limit=500', None, 200),
  ('detect url careers page', 'GET', '/detect?url=' + Q('https://jobs.ashbyhq.com/openai'), None, 200),
  ('detect slug probe', 'GET', '/detect?company=databricks', None, 200),
  ('detect domain', 'GET', '/detect?url=' + Q('https://www.notion.com/careers'), None, None),
  ('detect nothing', 'GET', '/detect?company=zzqqxxnonexistent', None, 404),
  ('detect missing', 'GET', '/detect', None, 400),
  ('detect private ip', 'GET', '/detect?url=' + Q('http://127.0.0.1:8787/health'), None, 400),
  ('unknown route', 'GET', '/nope', None, 404),
  ('wrong method', 'POST', '/jobs', {}, 405),
  ('batch not json', 'POST', '/jobs/batch', None, 400, b'{bad'),
  ('batch empty', 'POST', '/jobs/batch', {'companies': []}, 400),
  ('batch 21', 'POST', '/jobs/batch', {'companies': ['greenhouse:x%d' % i for i in range(21)]}, 400),
  ('batch mixed bad', 'POST', '/jobs/batch', {'companies': ['greenhouse:stripe', 'greenhouse:stripe', 'stripe', 42, 'lever:nonexistentxyz123'], 'limitPerCompany': 5}, 200),
]
fails = 0
out = []
for c in cases:
    name, m, p, body, exp = c[:5]
    raw = c[5] if len(c) > 5 else None
    code, ms, size, d = call(m, p, body, raw_body=raw)
    meta = d.get('meta', {}) if isinstance(d, dict) else {}
    info = ''
    if 'jobs' in d: info = f"returned={meta.get('returned')} matched={meta.get('totalMatched')} warn={meta.get('warnings')}"
    if 'error' in d: info = f"{d['error'].get('code')}: {d['error'].get('message')[:90]}"
    if 'matches' in d: info = f"matches={[(x['ats'], x['company'], x['source']) for x in d['matches']]} req={d.get('subrequests')}"
    if 'results' in d: info = json.dumps([(r['status'], r.get('error', {}).get('code'), r.get('returned')) for r in d['results']])
    ok = exp is None or code == exp
    fails += not ok
    line = f"{'PASS' if ok else 'FAIL'} {code} {ms}ms {size}B  {name}: {info}"
    print(line); out.append(line)
    if name == 'remote=true':
        assert all(j['remote'] for j in d['jobs'])
    if name == 'description html':
        assert d['jobs'][0].get('descriptionHtml', '').startswith('<'), 'html not unescaped'
    if name == 'descMaxLen huge':
        assert all(not j['descriptionTruncated'] for j in d['jobs'])
    if name == 'sort posted_desc':
        ps = [j['postedAt'] for j in d['jobs']]; assert ps == sorted(ps, reverse=True)
    if name == 'location+department':
        assert all('san francisco' in ' '.join(j['locations']).lower() for j in d['jobs'])
print('FAILS', fails)
open('/workspace/rapidapi/ats-jobs-api/test/out-edge.txt', 'w').write('\n'.join(out))
