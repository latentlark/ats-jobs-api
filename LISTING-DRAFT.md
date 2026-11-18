# RapidAPI listing draft: ATS Jobs API

**Status:** PROPOSAL ONLY. Not on RapidAPI, not public, no prices set. Prices need Mohamed's own OK before anything goes live.
Code: https://github.com/latentlark/ats-jobs-api (standalone Cloudflare Worker, no Apify calls, no tokens).

## Name and tagline

- **Name:** ATS Jobs API: Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee
- **Short description (under 100 characters):** Live open jobs from 6 ATS job boards in one JSON schema. Batch 20 companies per call.
- **Category:** Jobs

## Long description

Get every open job from a company's own career board as clean, normalized JSON. One API covers six applicant tracking systems: Greenhouse, Lever, Ashby, SmartRecruiters, Workable and Recruitee, including the EU-heavy SmartRecruiters, Workable and Recruitee that most ATS APIs skip.

- **Live, not a stale index.** Each call reads the ATS's official public job-board feed (cached for up to 10 minutes). Any company on a supported ATS works, not a fixed list.
- **One schema for six ATS:** id, title, company, location and all locations, country, remote flag, workplace type (remote, hybrid, onsite), department, team, employment type (raw and normalized), salary min, max, currency and interval when the company publishes it, posted and updated dates, job URL, apply URL, and the description as capped plain text (or HTML on request).
- **Big boards in one call:** up to 500 jobs per page with `nextOffset`. Tested on Stripe (793 jobs), OpenAI (839), Databricks (900), Bosch (5,121) and more.
- **Batch:** up to 20 companies per request, fetched in parallel. A failed company never fails the call.
- **Detect:** give a careers URL or a company name and get the ATS and board slug back.
- **Filters:** keywords (accent insensitive), location, remote, department, employment type, posted within N days, sort by date.
- **Clean errors:** JSON with stable codes. 400 bad input, 404 unknown board, 502 or 504 when the ATS fails (after one retry).

No scraping, logins or proxies. Recruiter email addresses that some feeds expose are never returned.

## Endpoints (match openapi.yaml)

| Endpoint | Use |
|---|---|
| `GET /jobs?company=stripe&ats=greenhouse&q=&location=&remote=&department=&employmentType=&postedWithinDays=&limit=&offset=&description=&descriptionMaxLength=&sort=` | One company's jobs |
| `POST /jobs/batch` with `{"companies": ["greenhouse:stripe", "https://jobs.lever.co/palantir", ...], "q": "...", "limitPerCompany": 100}` | Up to 20 companies |
| `GET /detect?url=https://www.notion.com/careers` or `?company=databricks` | Find the ATS and slug |
| `GET /health` | Status, version, limits |

## Use cases

- Hiring-signal lead lists for sales teams and agencies (a company opening 30 data roles is shopping for data tools).
- Niche job boards and aggregators (remote Rust jobs, AI jobs in Berlin, climate tech).
- Recruiter and competitor hiring monitors.
- AI agents and RAG pipelines that need structured jobs with plain-text descriptions.
- Salary research where boards publish pay (Ashby, Lever, Recruitee).

## Test numbers to quote (18 Nov 2026, wrangler dev, live ATS)

| Company | ATS | Jobs on board | Returned in one call | Cold | Cached | Size |
|---|---|---|---|---|---|---|
| Stripe | Greenhouse | 793 | 500 | 3.2 s | 11 ms | 786 KB |
| Databricks | Greenhouse | 900 | 500 | 1.4 s | 11 ms | 830 KB |
| Palantir | Lever | 306 | 306 | 2.5 s | 10 ms | 498 KB |
| OpenAI | Ashby | 839 | 500 | 0.29 s | 16 ms | 866 KB |
| Bosch | SmartRecruiters | 5,121 | 500 (2,000 read) | 2.5 s | 8 ms | 334 KB |
| Creative Chaos | Workable | 182 | 182 | 0.24 s | 5 ms | 288 KB |
| VDK Groep | Recruitee | 707 | 500 | 1.7 s | 11 ms | 842 KB |
| 20 companies, all 6 ATS (batch) | mixed | | 1,916 | 4.4 s | 29 ms | 1.2 MB |

## Comparable RapidAPI jobs APIs (listing pages as indexed on 18 Nov 2026; recheck before pricing)

| API | Coverage | Free | Paid tiers |
|---|---|---|---|
| JSearch (OpenWeb Ninja) | Google for Jobs aggregate, 10 jobs per page | 200 requests/mo | $25 (10k), $75 (50k), $150 (200k) |
| Jobs API: Workday, Greenhouse, Lever, Ashby & more | 4+ ATS | 50 requests/mo | $9.99 (2,500), $29.99 (10,000) |
| ATS Jobs API (productra) | 3 ATS, fixed list of 67 companies | 100 requests/mo | $12, $39, $149 |
| ATS Jobs API: Greenhouse, Lever & Ashby (PENGCHENGLI) | 3 ATS, live, cached | yes | $15, $45 |
| Career Board Proof | 3 ATS, one board per call | 20 requests/mo | $19 (500) |
| Ashby Jobs Unofficial API | Ashby only | yes | from $19.99 |

Our edge: 6 ATS instead of 3 (SmartRecruiters, Workable and Recruitee add EU coverage), any company rather than a fixed list, 20-company batch, detection, normalized salary and employment type. Market reality: at least two near-identical 3-ATS listings exist, one with almost the same name, so price at or slightly under them and compete on coverage.

## Proposed plans (PROPOSAL for Mohamed, not set anywhere)

| Plan | Price / month | Requests / month | Batch calls / month (inside the request quota) | Overage | Rate limit |
|---|---|---|---|---|---|
| BASIC | $0 | **100, hard limit** (not the 1M default) | 10 | none, blocked at the cap | 1 request/second |
| PRO | $12 | 5,000 | 500 | $0.003 / request | 5 requests/second |
| ULTRA | $39 | 25,000 | 2,500 | $0.002 / request | 10 requests/second |
| MEGA | $129 | 150,000 | 15,000 | $0.001 / request | 20 requests/second |

How to set it in RapidAPI: one "Requests" quota on all endpoints plus a second quota object "Batch calls" on `POST /jobs/batch` only, because one batch call can read 20 boards. If the plan editor cannot do a second object, fall back to a hard 20-company cap with no separate batch quota (already enforced by the API).

**Why these prices:**
- PRO $12 matches the cheapest comparable ATS API entry tier ($9.99 to $15) while giving 2x the requests of the $9.99 plan and 6 ATS.
- ULTRA $39 sits under PENGCHENGLI's $45 and equal to productra's $39, with batch and detection included.
- MEGA $129 is under productra's $149 and JSearch's $150. JSearch's 200k requests return 10 jobs each; ours return up to 500.
- BASIC is a hard 100 calls so free users can test (including 10 batches) but cannot run production on it.

**After the RapidAPI fee (25%):** PRO nets $9.00, ULTRA $29.25, MEGA $96.75 per subscriber per month. Overage nets 75% of the listed rate.

**Our running cost:** Cloudflare Workers Free covers 100,000 requests a day, but its 10 ms CPU limit is exceeded by cold reads of very large boards (measured 20 to 280 ms CPU; cache hits 3 to 7 ms). Before paid traffic, the Worker should move to Workers Paid at $5/month (needs Mohamed's OK; it is new spend). One PRO subscriber covers it. Cache API also needs a custom domain; without one, the in-isolate cache still works.

**Bandwidth note for buyers:** RapidAPI meters bandwidth (10 GB a month included, then $0.001 per MB on comparable listings). The defaults (`limit=50`, `description=text`, 2,000 characters) keep a typical response at 100 to 300 KB. Tell heavy users to pass `description=none` when they only need titles and links.

## FAQ

**Which ATS?** Greenhouse, Lever, Ashby, SmartRecruiters, Workable and Recruitee. Workday and Personio are not in this version.
**How do I find the slug?** It is in the careers URL (`job-boards.greenhouse.io/stripe` is `stripe`). Or call `/detect` with the careers page URL.
**Why 404 for a SmartRecruiters company?** Ids are case-sensitive (`BoschGroup`), and SmartRecruiters returns an empty list for unknown ids, so a company with zero open jobs also shows as not found.
**How fresh is the data?** Read live from the ATS, cached up to 10 minutes. `meta.fetchedAt` shows when.
**Is salary always there?** Only when the company publishes it. `salary` is `null` otherwise.
**Do I get only new jobs since my last call?** Not in this version. Store job `id`s on your side and compare.

The LatentLark team
