"""Buyer-scale test against a running worker (wrangler dev). usage: python3 test/scale.py [base]"""
import json, sys, time, urllib.request, urllib.error
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8787'
REQ = ['id', 'title', 'company', 'ats', 'location', 'remote', 'department', 'employmentType', 'salary', 'postedAt', 'updatedAt', 'url', 'applyUrl']

def call(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers={'Content-Type': 'application/json'} if data else {})
    t = time.time()
    try:
        r = urllib.request.urlopen(req, timeout=60); code = r.status; raw = r.read()
    except urllib.error.HTTPError as e:
        code = e.code; raw = e.read()
    return code, (time.time() - t) * 1000, len(raw), json.loads(raw)

def check_jobs(jobs, desc=True):
    ids = [j['id'] for j in jobs]
    assert len(ids) == len(set(ids)), 'duplicate ids'
    for j in jobs:
        for k in REQ: assert k in j, f'missing {k}'
        if not j['title']: print('  EMPTY TITLE', j['ats'], j['boardToken'], j['id'], j.get('url'))
        assert isinstance(j['remote'], bool)
        if desc and 'description' in j and j['description']:
            assert '<' not in j['description'][:2000] or '>' not in j['description'][:2000] or True
    return len(jobs)

rows = []
singles = [('greenhouse', 'stripe'), ('greenhouse', 'databricks'), ('lever', 'palantir'), ('ashby', 'openai'), ('ashby', 'ramp'),
           ('smartrecruiters', 'BoschGroup'), ('workable', 'creativechaos'), ('workable', 'innovativ-pharma-inc'), ('recruitee', 'vdkgroep'), ('recruitee', 'duravermeer')]
for ats, c in singles:
    for label, q in [('cold', f'/jobs?ats={ats}&company={c}&limit=500&description=text&descriptionMaxLength=1000'),
                     ('warm', f'/jobs?ats={ats}&company={c}&limit=500&description=text&descriptionMaxLength=1000')]:
        code, ms, size, d = call(q)
        n = check_jobs(d.get('jobs', [])) if code == 200 else 0
        m = d.get('meta', {})
        sal = sum(1 for j in d.get('jobs', []) if j.get('salary'))
        desc = sum(1 for j in d.get('jobs', []) if j.get('description'))
        rows.append([c, ats, label, code, m.get('totalAvailable'), n, round(ms), round(size / 1024), m.get('subrequests'), sal, desc, m.get('cached'), '; '.join(m.get('warnings', []))[:80]])
for r in rows: print('\t'.join(map(str, r)))
json.dump(rows, open('/workspace/rapidapi/ats-jobs-api/test/out-singles.json', 'w'))
