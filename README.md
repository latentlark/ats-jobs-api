# ATS Jobs API

Open jobs from a company's own applicant tracking system (ATS) as one clean JSON schema, served from a Cloudflare Worker.

Supported ATS (each verified live on 18 Nov 2026 with a 100+ job board):

| ATS | Public endpoint used | Pagination | Salary | Example board |
|---|---|---|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` (EU host as fallback) | one response | no | `stripe` (793 jobs) |
| Lever | `api.lever.co/v0/postings/{site}?mode=json` (EU host as fallback) | one response | when published | `palantir` (306) |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true` | one response | often | `openai` (839) |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{id}/postings` | 100 per page, fetched in parallel | no | `BoschGroup` (5,121) |
| Workable | `apply.workable.com/api/v1/widget/accounts/{account}` | one response | no | `creativechaos` (182) |
| Recruitee | `{company}.recruitee.com/api/offers/` | one response | often | `vdkgroep` (707) |

No scraping, no logins, no proxies and no API keys: these are the feeds the ATS vendors publish for career sites. Recruiter mailbox addresses that some feeds expose are never returned.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/jobs` | Jobs for one company, with filters and pagination |
| POST | `/jobs/batch` | Up to 20 companies in one call, 6 fetched at a time |
| GET | `/detect` | Which ATS a careers URL or company slug uses |
| GET | `/health` | Liveness, version and limits |

Full contract: [`openapi.yaml`](openapi.yaml) (OpenAPI 3.0, lint clean).

### GET /jobs

```
GET /jobs?ats=greenhouse&company=stripe&q=engineer&remote=true&limit=50
GET /jobs?company=https://jobs.lever.co/palantir&location=london&description=none
GET /jobs?company=ashby:openai&department=research&sort=posted_desc
```

| Param | Notes |
|---|---|
| `company` | Board slug, `ats:slug`, or a job board URL. Required. |
| `ats` | `greenhouse`, `lever`, `ashby`, `smartrecruiters`, `workable`, `recruitee`. Optional when `company` is a URL or prefixed. Without it the API probes every ATS and picks the board with the most jobs. |
| `q` | Keywords, all must match, in title, department and team. Case and accent insensitive. `searchDescription=true` also searches descriptions. |
| `location`, `department` | Substring match. |
| `remote` | `true` or `false`. |
| `employmentType` | `full_time`, `part_time`, `contract`, `temporary`, `internship`, or part of the raw ATS value. |
| `postedWithinDays` | 1 to 3650. |
| `limit`, `offset` | Default 50, max 500 (higher values are capped with a warning). `meta.nextOffset` gives the next page. |
| `description` | `text` (default), `none` (fastest), or `html` (adds `descriptionHtml`). |
| `descriptionMaxLength` | Default 2000, max 20000. Text is cut at a word and ends with `...`; `descriptionTruncated` tells you. |
| `sort` | `none` (ATS order), `posted_desc`, `posted_asc`. |

### POST /jobs/batch

```json
{
  "companies": ["greenhouse:stripe", "https://jobs.lever.co/palantir", {"ats": "ashby", "company": "openai"}, "recruitee:vdkgroep"],
  "q": "engineer",
  "remote": true,
  "limitPerCompany": 100,
  "description": "none"
}
```

Same filters as `/jobs`. Each entry needs an ATS (prefix, URL or object); use `/detect` first if you do not know it. A failed company never fails the call: it comes back with `status: "error"` and a code. Duplicates are skipped and reported. In batch mode SmartRecruiters reads as many 100-job pages as the request budget allows; `truncated` says when there are more.

### GET /detect

```
GET /detect?url=https://www.notion.com/careers      -> ashby:notion (found in the page HTML)
GET /detect?company=databricks                       -> greenhouse:databricks (probe)
GET /detect?url=https://jobs.ashbyhq.com/openai      -> ashby:openai (URL pattern, no network)
```

## Job schema

`id, title, company, ats, boardToken, location, locations[], country, remote, workplaceType (remote|hybrid|onsite), department, team, employmentType, employmentTypeNormalized, salary {min, max, currency, interval, text} or null, postedAt, updatedAt, url, applyUrl, description, descriptionTruncated, descriptionHtml (html mode)`.

Fields are `null` when the ATS does not publish them (for example Greenhouse has no salary or employment type in its public feed).

## Errors

Every error is JSON: `{"error": {"status": 404, "code": "board_not_found", "message": "..."}}`.

| Status | Codes |
|---|---|
| 400 | `missing_parameter`, `invalid_parameter`, `invalid_json`, `too_many_companies`, `ats_required` |
| 403 | `forbidden` (only when `PROXY_SECRET` is set and the header is wrong) |
| 404 | `board_not_found`, `not_found` |
| 405, 413, 415 | wrong method, body over 64 KB, body not JSON |
| 502 | `upstream_error`, `upstream_bad_response` |
| 503 | `subrequest_budget_exhausted` |
| 504 | `upstream_timeout` |

## How it stays fast and inside Workers limits

- Every upstream call has an 8 second timeout and one retry on 429, 5xx or a network error (EU fallback hosts: 4 seconds, no retry).
- Boards are cached for 10 minutes (`CACHE_TTL_SECONDS`): an in-isolate LRU (32 MB) plus the Cache API. The Cache API only works on a custom domain; on `workers.dev` the in-isolate cache still works.
- Unknown boards are remembered for 5 minutes, so typos do not hammer the ATS.
- Only the description data a request needs is kept, and HTML is converted to text only for the jobs returned, only up to the requested length, and memoized.
- Every request counts its subrequests (fetches and Cache API calls share the Workers quota) and stays at 48 or fewer (Free plan limit: 50). This is why a batch is capped at 20 companies.
- Batch concurrency is 6, which matches the Workers limit of 6 open connections per request. A batch stops starting new companies after 25 seconds.

### Measured (18 Nov 2026, `wrangler dev`, live ATS)

| Company | ATS | Jobs on board | Returned | Cold latency | Warm latency | Response size |
|---|---|---|---|---|---|---|
| stripe | Greenhouse | 793 | 500 | 3.2 s | 11 ms | 786 KB |
| databricks | Greenhouse | 900 | 500 | 1.4 s | 11 ms | 830 KB |
| palantir | Lever | 306 | 306 | 2.5 s | 10 ms | 498 KB |
| openai | Ashby | 839 | 500 | 0.29 s | 16 ms | 866 KB |
| ramp | Ashby | 181 | 181 | 0.06 s | 16 ms | 321 KB |
| BoschGroup | SmartRecruiters | 5,121 | 500 (2,000 read in 20 pages) | 2.5 s | 8 ms | 334 KB |
| creativechaos | Workable | 182 | 182 | 0.24 s | 5 ms | 288 KB |
| innovativ-pharma-inc | Workable | 135 | 135 | 0.13 s | 5 ms | 218 KB |
| vdkgroep | Recruitee | 707 | 500 | 1.7 s | 11 ms | 842 KB |
| duravermeer | Recruitee | 381 | 381 | 1.2 s | 8 ms | 656 KB |

All with `limit=500&description=text&descriptionMaxLength=1000`. Batch of 20 real companies (all six ATS), 100 jobs each: 1,916 jobs, 4.4 s cold, 29 ms warm, 1.2 MB, 47 subrequests.

CPU time (from `npm run bench`, the same code in V8 with recorded upstream bodies): cache hits cost 3 to 7 ms. A cold read of a very large board costs 20 to 280 ms, mostly `JSON.parse` of a 5 to 15 MB upstream body. The Workers Free plan allows 10 ms CPU per request with some burst tolerance, so production traffic on large boards needs Workers Paid (30 s CPU by default).

## Run, test, deploy

```bash
npm install
npm run dev            # wrangler dev on http://127.0.0.1:8787
npm test               # offline unit tests (mocked upstreams)
python3 test/scale.py  # buyer-scale run against wrangler dev
python3 test/edge.py   # edge cases and error paths
python3 test/batch.py && python3 test/batch20.py
npm run bench          # CPU per request (needs test/fixtures, see test/bench.mjs)
npx wrangler deploy    # needs a Cloudflare login
```

Optional: `npx wrangler secret put PROXY_SECRET` makes the Worker require RapidAPI's `X-RapidAPI-Proxy-Secret` header. When it is not set, the header is not checked. `/health` is always open.

## Notes and limits

- SmartRecruiters ids are case-sensitive, and its API returns an empty list (not 404) for unknown ids, so an id with zero open jobs is reported as `board_not_found`.
- SmartRecruiters descriptions need one call per job, so `/jobs` adds them only when 20 or fewer jobs are returned.
- Workday and Personio are not included in this version.
- The data belongs to the companies that publish it. Use it in line with each board's terms.

The LatentLark team
