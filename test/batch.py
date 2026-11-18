"""Batch and concurrency checks. usage: python3 test/batch.py [base]"""
import json, sys, time, urllib.request, urllib.error, concurrent.futures as cf
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8787'
def post(body):
    req = urllib.request.Request(BASE + '/jobs/batch', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    t = time.time()
    try: r = urllib.request.urlopen(req, timeout=90); code, raw = r.status, r.read()
    except urllib.error.HTTPError as e: code, raw = e.code, e.read()
    return code, round((time.time() - t) * 1000), len(raw), json.loads(raw)
def get(path):
    t = time.time()
    try: r = urllib.request.urlopen(BASE + path, timeout=90); code, raw = r.status, r.read()
    except urllib.error.HTTPError as e: code, raw = e.code, e.read()
    return code, round((time.time() - t) * 1000), len(raw), json.loads(raw)

companies = ['greenhouse:airbnb', 'greenhouse:cloudflare', 'greenhouse:datadog', 'greenhouse:gitlab', 'lever:spotify', 'lever:plaid',
             'ashby:notion', 'ashby:linear', 'ashby:cohere', 'smartrecruiters:Visa', 'workable:local-490', 'recruitee:careyn',
             {'ats': 'greenhouse', 'company': 'figma'}, 'https://jobs.lever.co/zoox', 'ashby:deel']
for label, body in [('15 companies, no desc, 100/company', {'companies': companies, 'limitPerCompany': 100}),
                    ('same 15, warm cache', {'companies': companies, 'limitPerCompany': 100}),
                    ('15 companies, text desc 500 chars, q=engineer', {'companies': companies, 'limitPerCompany': 500, 'q': 'engineer', 'description': 'text', 'descriptionMaxLength': 500}),
                    ('20 SmartRecruiters-heavy (budget)', {'companies': ['smartrecruiters:BoschGroup', 'smartrecruiters:Visa', 'smartrecruiters:McDonaldsCorporation', 'smartrecruiters:Ubisoft2', 'smartrecruiters:LinkedIn3'] + ['greenhouse:x%dnotreal' % i for i in range(15)], 'limitPerCompany': 500})]:
    code, ms, size, d = post(body)
    m = d.get('meta', {})
    print(f"\n== {label}: HTTP {code} {ms}ms {size // 1024}KB jobs={m.get('totalJobs')} ok={m.get('succeeded')} failed={m.get('failed')} upstream={m.get('subrequests')} warn={m.get('warnings')}")
    for r in d.get('results', []):
        print('  ', r['status'], r.get('ats'), r.get('boardToken'), 'avail', r.get('totalAvailable'), 'matched', r.get('totalMatched'), 'returned', r.get('returned'), r.get('cached'), (r.get('error') or {}).get('code', ''))
    ids = [(j['ats'], j['boardToken'], j['id']) for r in d.get('results', []) for j in r.get('jobs', [])]
    assert len(ids) == len(set(ids)), 'dup ids in batch'

# concurrency: 12 parallel single requests (mixed cold/warm) plus 2 parallel batches
paths = [f'/jobs?ats=greenhouse&company={c}&limit=200&description=text&descriptionMaxLength=300' for c in ['stripe', 'databricks', 'airbnb', 'robinhood', 'discord', 'reddit']] + \
        [f'/jobs?ats=ashby&company={c}&limit=200' for c in ['openai', 'ramp', 'notion', 'vercel']] + ['/jobs?ats=lever&company=palantir&limit=200', '/jobs?ats=recruitee&company=vdkgroep&limit=200']
t = time.time()
with cf.ThreadPoolExecutor(14) as ex:
    futs = [ex.submit(get, p) for p in paths] + [ex.submit(post, {'companies': companies[:10], 'limitPerCompany': 50}) for _ in range(2)]
    res = [f.result() for f in futs]
print(f"\n== concurrency 14 parallel: wall {round((time.time() - t) * 1000)}ms; codes {[r[0] for r in res]}; slowest {max(r[1] for r in res)}ms")
