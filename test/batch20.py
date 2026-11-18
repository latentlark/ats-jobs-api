"""20 real companies, cold, one call. usage: python3 test/batch20.py [base]"""
import json, sys, time, urllib.request
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8787'
C = ['greenhouse:stripe', 'greenhouse:databricks', 'greenhouse:airbnb', 'greenhouse:cloudflare', 'greenhouse:datadog', 'greenhouse:gitlab',
     'greenhouse:figma', 'greenhouse:robinhood', 'greenhouse:discord', 'greenhouse:reddit', 'lever:palantir', 'lever:spotify', 'lever:zoox',
     'ashby:openai', 'ashby:ramp', 'ashby:notion', 'ashby:cohere', 'smartrecruiters:BoschGroup', 'workable:creativechaos', 'recruitee:vdkgroep']
for label, extra in [('cold, no descriptions', {}), ('warm, no descriptions', {}), ('text 300 chars (Greenhouse/Workable refetch with content)', {'description': 'text', 'descriptionMaxLength': 300})]:
    body = {'companies': C, 'limitPerCompany': 100, **extra}
    t = time.time()
    raw = urllib.request.urlopen(urllib.request.Request(BASE + '/jobs/batch', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'}), timeout=120).read()
    d = json.loads(raw); m = d['meta']
    print(f"== 20 companies, {label}: {round((time.time() - t) * 1000)}ms, {len(raw) // 1024}KB, jobs {m['totalJobs']}, ok {m['succeeded']}/{m['companies']}, subrequests {m['subrequests']}")
    for r in d['results']:
        print(f"   {r['status']:5} {r['ats']:15} {r['boardToken']:15} avail {r.get('totalAvailable')} returned {r.get('returned')} {r.get('durationMs')}ms {r.get('cached')} {(r.get('error') or {}).get('code', '')}")
