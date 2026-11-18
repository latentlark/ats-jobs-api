import { cacheKey, edgeGet, edgePut, memGet, memPut } from './cache';
import { detect, detectFromText, parsePrefixed, SLUG_RE } from './detect';
import { PROVIDERS, smartrecruitersDetails } from './providers';
import { ATS_LIST, type Ats, type Board, type Job, type RawJob } from './types';
import { Budget, HttpError, errorResponse, htmlToText, htmlToTextCapped, jsonResponse, unescapeHtmlOnce } from './util';

export interface Env {
  PROXY_SECRET?: string;
  CACHE_TTL_SECONDS?: string;
  /** Workable rate-limits requests that come from Cloudflare Workers (error 1015), so it is off unless set to "true". */
  ENABLE_WORKABLE?: string;
}

function enabledAts(env: Env): Ats[] {
  return ATS_LIST.filter((a) => a !== 'workable' || env.ENABLE_WORKABLE === 'true');
}

function assertEnabled(ats: Ats, env: Env): void {
  if (!enabledAts(env).includes(ats)) {
    throw new HttpError(503, 'ats_unavailable', `${ats} blocks requests from this host right now, so it is not available on this API.`, { ats });
  }
}

const VERSION = '1.0.0';
/** Workers Free allows 50 subrequests per request. Keep 2 spare. */
const SUBREQUEST_LIMIT = 48;
const MAX_BATCH = 20;
const BATCH_CONCURRENCY = 6;
/** Companies not started within this time are reported as skipped instead of making the call hang. */
const BATCH_DEADLINE_MS = 25000;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;
const MAX_DESC = 20000;
const DEFAULT_DESC = 2000;
const SR_DETAIL_MAX = 20;
const SR_MAX_PAGES_SINGLE = 20;

type DescMode = 'none' | 'text' | 'html';

interface Filters {
  q: string[];
  searchDescription: boolean;
  location: string | null;
  remote: boolean | null;
  department: string | null;
  employmentType: string | null;
  postedWithinDays: number | null;
}

interface OutputOpts {
  description: DescMode;
  descriptionMaxLength: number;
  limit: number;
  offset: number;
  sort: 'none' | 'posted_desc' | 'posted_asc';
}

// ---------------- parameter parsing ----------------
function fold(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function parseBool(v: unknown, name: string): boolean | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).toLowerCase();
  if (['true', '1', 'yes'].includes(s) || v === true) return true;
  if (['false', '0', 'no'].includes(s) || v === false) return false;
  throw new HttpError(400, 'invalid_parameter', `${name} must be true or false.`);
}

function parseInt0(v: unknown, name: string, def: number, min: number, max: number, warnings: string[], clamp = true): number {
  if (v === undefined || v === null || v === '') return def;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isInteger(n)) throw new HttpError(400, 'invalid_parameter', `${name} must be an integer.`);
  if (n < min) throw new HttpError(400, 'invalid_parameter', `${name} must be >= ${min}.`);
  if (n > max) {
    if (!clamp) throw new HttpError(400, 'invalid_parameter', `${name} must be <= ${max}.`);
    warnings.push(`${name} was capped at ${max}.`);
    return max;
  }
  return n;
}

function str(v: unknown, name: string, maxLen = 200): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, 'invalid_parameter', `${name} must be a string.`);
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > maxLen) throw new HttpError(400, 'invalid_parameter', `${name} is too long (max ${maxLen} characters).`);
  return s;
}

function parseFilters(get: (k: string) => unknown): Filters {
  const q = str(get('q'), 'q');
  const days = get('postedWithinDays');
  const w: string[] = [];
  return {
    q: q ? fold(q).split(/\s+/).filter(Boolean).slice(0, 10) : [],
    searchDescription: parseBool(get('searchDescription'), 'searchDescription') ?? false,
    location: (() => {
      const l = str(get('location'), 'location');
      return l ? fold(l) : null;
    })(),
    remote: parseBool(get('remote'), 'remote'),
    department: (() => {
      const d = str(get('department'), 'department');
      return d ? fold(d) : null;
    })(),
    employmentType: (() => {
      const d = str(get('employmentType'), 'employmentType');
      return d ? fold(d) : null;
    })(),
    postedWithinDays: days === undefined || days === null || days === '' ? null : parseInt0(days, 'postedWithinDays', 0, 1, 3650, w, false),
  };
}

function parseOutput(get: (k: string) => unknown, warnings: string[], defLimit = DEFAULT_LIMIT, defDesc: DescMode = 'text'): OutputOpts {
  const d = (str(get('description'), 'description') ?? defDesc).toLowerCase();
  if (!['none', 'text', 'html'].includes(d)) throw new HttpError(400, 'invalid_parameter', 'description must be none, text or html.');
  const sort = (str(get('sort'), 'sort') ?? 'none').toLowerCase();
  if (!['none', 'posted_desc', 'posted_asc'].includes(sort)) throw new HttpError(400, 'invalid_parameter', 'sort must be none, posted_desc or posted_asc.');
  return {
    description: d as DescMode,
    descriptionMaxLength: parseInt0(get('descriptionMaxLength'), 'descriptionMaxLength', DEFAULT_DESC, 0, MAX_DESC, warnings),
    limit: parseInt0(get('limit'), 'limit', defLimit, 1, MAX_LIMIT, warnings),
    offset: parseInt0(get('offset'), 'offset', 0, 0, 1_000_000, warnings, false),
    sort: sort as OutputOpts['sort'],
  };
}

/** Resolve company + optional ats into a concrete board, without network calls. */
function resolveTarget(atsParam: string | null, company: string | null): { ats: Ats | null; token: string } {
  if (!company) throw new HttpError(400, 'missing_parameter', 'company is required (board slug, ats:slug or job board URL).');
  if (company.length > 300) throw new HttpError(400, 'invalid_parameter', 'company is too long.');
  let ats: Ats | null = null;
  if (atsParam) {
    const a = atsParam.toLowerCase() as Ats;
    if (!ATS_LIST.includes(a)) throw new HttpError(400, 'invalid_parameter', `ats must be one of: ${ATS_LIST.join(', ')}.`);
    ats = a;
  }
  const pre = parsePrefixed(company);
  if (pre) {
    if (ats && ats !== pre.ats) throw new HttpError(400, 'invalid_parameter', 'ats does not match the ats: prefix in company.');
    ats = pre.ats;
    company = pre.company;
  } else {
    const hit = detectFromText(company);
    if (hit) {
      if (ats && ats !== hit.ats) throw new HttpError(400, 'invalid_parameter', `company URL points to ${hit.ats}, not ${ats}.`);
      ats = hit.ats;
      company = hit.company;
    }
  }
  if (!SLUG_RE.test(company)) {
    throw new HttpError(400, 'invalid_parameter', 'company must be a board slug like "stripe" (letters, digits, dot, dash, underscore), an ats:slug value, or a job board URL.');
  }
  return { ats, token: company };
}

// ---------------- board loading with cache ----------------
const notFoundCache = new Map<string, { exp: number; err: HttpError }>();
const STORED_HTML_MAX = 60000;

/** Drop description data the request level does not need, so cached boards stay small. */
function shrink(board: Board, level: 0 | 1 | 2): Board {
  for (const j of board.jobs) {
    if (level === 0) {
      j.descHtml = null;
      j.descPlain = null;
      continue;
    }
    if (level === 1 && j.descPlain) j.descHtml = null;
    if (j.descHtml && j.descHtml.length > STORED_HTML_MAX) j.descHtml = j.descHtml.slice(0, STORED_HTML_MAX);
    if (j.descPlain && j.descPlain.length > MAX_DESC + 100) j.descPlain = j.descPlain.slice(0, MAX_DESC + 100);
  }
  return board;
}

async function loadBoard(ats: Ats, token: string, budget: Budget, env: Env, ctx: ExecutionContext, opts: { level: 0 | 1 | 2; maxPages: number; q?: string }): Promise<{ board: Board; cached: 'memory' | 'edge' | false }> {
  assertEnabled(ats, env);
  const ttlRaw = Number(env.CACHE_TTL_SECONDS ?? 600);
  const ttl = Number.isFinite(ttlRaw) ? Math.max(0, Math.min(3600, Math.floor(ttlRaw))) : 600;
  const q = ats === 'smartrecruiters' ? opts.q : undefined;
  const maxPages = ats === 'smartrecruiters' ? opts.maxPages : 1;
  // SmartRecruiters list pages carry no descriptions, so every level is the same board there.
  const level: 0 | 1 | 2 = ats === 'smartrecruiters' ? 0 : opts.level;
  if (ttl > 0) {
    // A board stored with more description data can serve a request that needs less.
    for (let l = level; l <= 2; l++) {
      const m = memGet(cacheKey(ats, token, l as 0 | 1 | 2, maxPages, q));
      if (m) return { board: m, cached: 'memory' };
    }
    const k = cacheKey(ats, token, level, maxPages, q);
    const e = await edgeGet(k, budget);
    if (e) {
      memPut(k, e, 2 * 1024 * 1024, ttl);
      return { board: e, cached: 'edge' };
    }
  }
  const negKey = `${ats}:${ats === 'smartrecruiters' ? token : token.toLowerCase()}`;
  const neg = notFoundCache.get(negKey);
  if (neg && neg.exp > Date.now()) throw neg.err;
  let board: Board;
  try {
    board = await PROVIDERS[ats](token, budget, { withContent: level > 0, maxPages, q });
  } catch (e) {
    // Remember unknown boards for a few minutes so repeated typos do not hit the ATS again.
    if (e instanceof HttpError && e.status === 404 && ttl > 0) {
      if (notFoundCache.size > 2000) notFoundCache.clear();
      notFoundCache.set(negKey, { exp: Date.now() + Math.min(ttl, 300) * 1000, err: e });
    }
    throw e;
  }
  shrink(board, level);
  if (ttl > 0) {
    const key = cacheKey(ats, token, level, maxPages, q);
    if (level === 2) {
      // HTML boards are the largest; serializing them for the Cache API costs more CPU than it saves.
      memPut(key, board, board.jobs.reduce((n, j) => n + (j.descHtml?.length ?? 0) + (j.descPlain?.length ?? 0) + 600, 0), ttl);
    } else {
      const put = edgePut(key, board, ttl, budget);
      ctx.waitUntil(put.promise);
      memPut(key, board, put.bytes, ttl);
    }
  }
  return { board, cached: false };
}

// ---------------- filtering and output ----------------
function levelFor(o: OutputOpts, f: Filters): 0 | 1 | 2 {
  if (o.description === 'html') return 2;
  return o.description === 'text' || f.searchDescription ? 1 : 0;
}

function matches(j: RawJob, f: Filters, now: number): boolean {
  if (f.remote !== null && j.remote !== f.remote) return false;
  if (f.postedWithinDays !== null) {
    const t = j.postedAt ? Date.parse(j.postedAt) : NaN;
    if (!Number.isFinite(t) || now - t > f.postedWithinDays * 86400000) return false;
  }
  if (f.location) {
    const hay = fold([j.location, ...j.locations, j.country].filter(Boolean).join(' | '));
    if (!hay.includes(f.location)) return false;
  }
  if (f.department) {
    const hay = fold([j.department, j.team].filter(Boolean).join(' | '));
    if (!hay.includes(f.department)) return false;
  }
  if (f.employmentType) {
    const want = f.employmentType.replace(/[-_ ]/g, '');
    const norm = (normEmployment(j.employmentType, j.title) ?? '').replace(/_/g, '');
    if (norm !== want && !(j.employmentType && fold(j.employmentType).replace(/[-_ ]/g, '').includes(want))) return false;
  }
  if (f.q.length) {
    let hay = fold([j.title, j.department, j.team].filter(Boolean).join(' '));
    const missing = f.q.filter((t) => !hay.includes(t));
    if (missing.length) {
      if (!f.searchDescription) return false;
      hay = fold(j.descPlain ?? htmlToText(j.descHtml) ?? '');
      if (!missing.every((t) => hay.includes(t))) return false;
    }
  }
  return true;
}

function truncate(s: string, max: number): { text: string; cut: boolean } {
  if (s.length <= max) return { text: s, cut: false };
  let cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  if (sp > max * 0.8) cut = cut.slice(0, sp);
  return { text: cut.trimEnd() + '...', cut: true };
}

function normEmployment(e: string | null, title: string | null): Job['employmentTypeNormalized'] {
  const s = fold(e ?? '').replace(/[^a-z]/g, '');
  const t = fold(title ?? '');
  if (/intern|werkstudent|trainee|apprentice|stage/.test(s) || /\b(intern|internship|werkstudent)\b/.test(t)) return 'internship';
  if (/contract|freelance|contractor/.test(s)) return 'contract';
  if (/temp|fixedterm|seasonal/.test(s) && !/fulltimefixedterm|parttimefixedterm/.test(s)) return 'temporary';
  if (/parttime/.test(s)) return 'part_time';
  if (/fulltime|permanent|regular/.test(s)) return 'full_time';
  return null;
}

function toJob(j: RawJob, o: OutputOpts): Job {
  const hasSalary = j.salaryMin !== null || j.salaryMax !== null || j.salaryText !== null;
  const out: Job = {
    id: j.id,
    title: j.title,
    company: j.company,
    ats: j.ats,
    boardToken: j.boardToken,
    location: j.location,
    locations: j.locations,
    country: j.country,
    remote: j.remote,
    workplaceType: j.workplaceType,
    department: j.department,
    team: j.team,
    employmentType: j.employmentType,
    employmentTypeNormalized: normEmployment(j.employmentType, j.title),
    salary: hasSalary ? { min: j.salaryMin, max: j.salaryMax, currency: j.salaryCurrency, interval: j.salaryInterval, text: j.salaryText } : null,
    postedAt: j.postedAt,
    updatedAt: j.updatedAt,
    url: j.url,
    applyUrl: j.applyUrl,
  };
  if (o.description !== 'none') {
    if (o.descriptionMaxLength === 0) {
      out.description = null;
      out.descriptionTruncated = false;
    } else if (j.descPlain) {
      const t = truncate(j.descPlain.replace(/[\u2014\u2013]/g, '-').trim(), o.descriptionMaxLength);
      out.description = t.text || null;
      out.descriptionTruncated = t.cut;
    } else {
      let t = j._text && j._text.max === o.descriptionMaxLength ? j._text : null;
      if (!t) {
        const r = htmlToTextCapped(j.descHtml, o.descriptionMaxLength);
        t = { max: o.descriptionMaxLength, text: r.text, cut: r.cut };
        j._text = t;
      }
      out.description = t.text;
      out.descriptionTruncated = t.cut;
    }
    if (o.description === 'html') out.descriptionHtml = unescapeHtmlOnce(j.descHtml);
  }
  return out;
}

function select(board: Board, f: Filters, o: OutputOpts): { matched: RawJob[]; page: RawJob[] } {
  const now = Date.now();
  let matched = board.jobs.filter((j) => matches(j, f, now));
  if (o.sort !== 'none') {
    const dir = o.sort === 'posted_desc' ? -1 : 1;
    matched = [...matched].sort((a, b) => dir * ((a.postedAt ? Date.parse(a.postedAt) : 0) - (b.postedAt ? Date.parse(b.postedAt) : 0)));
  }
  return { matched, page: matched.slice(o.offset, o.offset + o.limit) };
}

// ---------------- handlers ----------------
/** Whole-response cache key: same query (params sorted) = same bytes, no JSON parsing on a hit. */
function responseKey(url: URL): string {
  const sp = [...url.searchParams.entries()].sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1));
  return `https://cache.ats-jobs-api.internal/r2${url.pathname}?${new URLSearchParams(sp).toString()}`;
}

async function handleJobsCached(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const ttl = Math.max(0, Math.min(3600, Math.floor(Number(env.CACHE_TTL_SECONDS ?? 600)) || 0));
  if (ttl === 0) return handleJobs(url, env, ctx);
  const key = responseKey(url);
  try {
    const hit = await caches.default.match(key);
    if (hit) {
      const h = new Headers(hit.headers);
      h.set('X-ATS-Cache', 'response');
      return new Response(hit.body, { status: 200, headers: h });
    }
  } catch {
    /* cache unavailable: compute */
  }
  const res = await handleJobs(url, env, ctx, 1);
  if (res.status === 200) {
    const body = await res.arrayBuffer();
    const headers = new Headers(res.headers);
    const stored = new Headers(headers);
    stored.set('Cache-Control', `public, max-age=${Math.min(ttl, 300)}`);
    ctx.waitUntil(caches.default.put(key, new Response(body, { headers: stored })).catch(() => undefined));
    headers.set('X-ATS-Cache', 'miss');
    return new Response(body, { status: 200, headers });
  }
  return res;
}

async function handleJobs(url: URL, env: Env, ctx: ExecutionContext, usedSubrequests = 0): Promise<Response> {
  const t0 = Date.now();
  const sp = url.searchParams;
  const get = (k: string) => sp.get(k);
  const warnings: string[] = [];
  const f = parseFilters(get);
  const o = parseOutput(get, warnings);
  const budget = new Budget(SUBREQUEST_LIMIT - 1 - usedSubrequests); // 1 kept for the response-cache write
  let { ats, token } = resolveTarget(str(get('ats'), 'ats', 40), str(get('company'), 'company', 300) ?? str(get('url'), 'url', 2048));
  let detected = false;
  if (!ats) {
    const d = await detect({ company: token }, budget, enabledAts(env));
    if (!d.matches.length) throw new HttpError(404, 'board_not_found', `No public job board found for "${token}" on ${enabledAts(env).join(', ')}. Pass ats= or a job board URL.`, { company: token, tried: d.tried });
    ats = d.matches[0].ats;
    token = d.matches[0].company;
    detected = true;
    if (d.matches.length > 1) warnings.push(`Several ATS matched (${d.matches.map((m) => `${m.ats}:${m.company} ${m.openJobs ?? '?'} jobs`).join(', ')}); using the largest, ${ats}. Pass ats= to choose.`);
  }
  const { board, cached } = await loadBoard(ats, token, budget, env, ctx, {
    level: levelFor(o, f),
    maxPages: SR_MAX_PAGES_SINGLE,
    q: f.q.length && ats === 'smartrecruiters' && !f.searchDescription ? f.q.join(' ') : undefined,
  });
  const { matched, page } = select(board, f, o);
  if (ats === 'smartrecruiters' && o.description !== 'none') {
    const need = page.filter((j) => !j.descHtml);
    if (need.length && need.length <= SR_DETAIL_MAX) await smartrecruitersDetails(need, budget);
    else if (need.length) warnings.push(`SmartRecruiters descriptions need one upstream call per job, so they are only added when limit <= ${SR_DETAIL_MAX}.`);
  }
  if (board.truncated) warnings.push(`This board has ${board.totalAvailable} jobs; the first ${board.jobs.length} were read. Use q, or narrow filters, to search the rest.`);
  const jobs = page.map((j) => toJob(j, o));
  const next = o.offset + page.length < matched.length ? o.offset + page.length : null;
  return jsonResponse(
    {
      meta: {
        ats,
        boardToken: token,
        company: board.company,
        detected,
        totalAvailable: board.totalAvailable,
        totalFetched: board.jobs.length,
        totalMatched: matched.length,
        returned: jobs.length,
        offset: o.offset,
        limit: o.limit,
        nextOffset: next,
        truncated: board.truncated,
        cached,
        fetchedAt: board.fetchedAt,
        subrequests: budget.used,
        durationMs: Date.now() - t0,
        warnings,
      },
      jobs,
    },
    200,
    { 'Cache-Control': 'public, max-age=60' },
  );
}

interface BatchItem {
  input: unknown;
  ats?: Ats | null;
  token?: string;
  error?: { status: number; code: string; message: string };
}

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      await fn(items[k], k);
    }
  });
  await Promise.all(workers);
}

async function handleBatch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const t0 = Date.now();
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) throw new HttpError(415, 'unsupported_media_type', 'Send a JSON body with Content-Type: application/json.');
  const raw = await req.text();
  if (raw.length > 64 * 1024) throw new HttpError(413, 'payload_too_large', 'Request body is larger than 64 KB.');
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_body', 'Body must be a JSON object with a companies array.');
  if (!Array.isArray(body.companies) || !body.companies.length) throw new HttpError(400, 'missing_parameter', 'companies must be a non-empty array.');
  if (body.companies.length > MAX_BATCH) throw new HttpError(400, 'too_many_companies', `companies can hold at most ${MAX_BATCH} entries per request.`, { max: MAX_BATCH });
  const warnings: string[] = [];
  const get = (k: string) => body[k];
  const f = parseFilters(get);
  const o = parseOutput((k) => (k === 'limit' ? body.limitPerCompany ?? body.limit : body[k]), warnings, 100, 'none');
  if (o.offset) throw new HttpError(400, 'invalid_parameter', 'offset is not supported on /jobs/batch. Use GET /jobs to page one company.');

  // resolve inputs (no auto-probing in batch: it would cost 6+ upstream calls per company)
  const seen = new Set<string>();
  const items: BatchItem[] = body.companies.map((c: any): BatchItem => {
    try {
      let atsP: string | null = null;
      let comp: string | null = null;
      if (typeof c === 'string') comp = c;
      else if (c && typeof c === 'object') {
        atsP = str(c.ats, 'ats', 40);
        comp = str(c.company ?? c.url, 'company', 2048);
      } else throw new HttpError(400, 'invalid_parameter', 'Each entry must be "ats:slug", a board URL, or {"ats","company"}.');
      const r = resolveTarget(atsP, comp);
      if (!r.ats) throw new HttpError(400, 'ats_required', 'Batch entries need an ATS: use {"ats":"greenhouse","company":"stripe"}, "greenhouse:stripe" or a board URL. Use GET /detect first if unsure.');
      const key = `${r.ats}:${r.ats === 'smartrecruiters' ? r.token : r.token.toLowerCase()}`;
      if (seen.has(key)) throw new HttpError(400, 'duplicate', `Duplicate entry ${key} skipped.`);
      seen.add(key);
      return { input: c, ats: r.ats, token: r.token };
    } catch (e) {
      const he = e instanceof HttpError ? e : new HttpError(400, 'invalid_parameter', 'Invalid entry.');
      return { input: c, error: { status: he.status, code: he.code, message: he.message } };
    }
  });

  const valid = items.filter((x) => !x.error);
  const nSR = valid.filter((x) => x.ats === 'smartrecruiters').length;
  // Each company needs 1 fetch, plus up to 2 optional Cache API calls; SmartRecruiters gets what is left for extra pages.
  const srPages = nSR ? Math.max(1, Math.min(10, Math.floor((SUBREQUEST_LIMIT - 2 * valid.length) / nSR) + 1)) : 1;
  const budget = new Budget(SUBREQUEST_LIMIT);
  budget.reserve = valid.length;
  const results: any[] = items.map((x) => ({ input: x.input, ats: x.ats ?? null, boardToken: x.token ?? null, status: x.error ? 'error' : 'pending', ...(x.error ? { error: x.error } : {}) }));

  await pool(items, BATCH_CONCURRENCY, async (x, i) => {
    if (x.error) return;
    const ts = Date.now();
    if (ts - t0 > BATCH_DEADLINE_MS) {
      results[i] = { input: x.input, ats: x.ats, boardToken: x.token, status: 'error', error: { status: 504, code: 'batch_deadline', message: `Skipped: the batch passed its ${BATCH_DEADLINE_MS / 1000}s time budget. Retry this company alone.` } };
      return;
    }
    try {
      let loaded;
      try {
        loaded = await loadBoard(x.ats!, x.token!, budget, env, ctx, {
          level: levelFor(o, f),
          maxPages: srPages,
          q: f.q.length && x.ats === 'smartrecruiters' && !f.searchDescription ? f.q.join(' ') : undefined,
        });
      } finally {
        budget.reserve = Math.max(0, budget.reserve - 1); // this company's own fetch is done
      }
      const { board, cached } = loaded;
      const { matched, page } = select(board, f, o);
      results[i] = {
        input: x.input,
        ats: x.ats,
        boardToken: x.token,
        status: 'ok',
        company: board.company,
        totalAvailable: board.totalAvailable,
        totalMatched: matched.length,
        returned: page.length,
        truncated: board.truncated || matched.length > page.length,
        cached,
        durationMs: Date.now() - ts,
        jobs: page.map((j) => toJob(j, o)),
      };
    } catch (e) {
      const he = e instanceof HttpError ? e : new HttpError(502, 'upstream_error', 'Upstream failed.');
      results[i] = { input: x.input, ats: x.ats, boardToken: x.token, status: 'error', durationMs: Date.now() - ts, error: { status: he.status, code: he.code, message: he.message } };
    }
  });
  if (o.description !== 'none' && nSR) warnings.push('SmartRecruiters descriptions are not included in batch results. Use GET /jobs with limit <= 20.');
  const ok = results.filter((r) => r.status === 'ok');
  return jsonResponse({
    meta: {
      companies: items.length,
      succeeded: ok.length,
      failed: items.length - ok.length,
      totalJobs: ok.reduce((s, r) => s + r.returned, 0),
      limitPerCompany: o.limit,
      subrequests: budget.used,
      durationMs: Date.now() - t0,
      warnings,
    },
    results,
  });
}

async function handleDetect(url: URL, env: Env): Promise<Response> {
  const t0 = Date.now();
  const company = str(url.searchParams.get('company'), 'company', 300);
  const u = str(url.searchParams.get('url'), 'url', 2048);
  const budget = new Budget(SUBREQUEST_LIMIT);
  const d = await detect({ company, url: u }, budget, enabledAts(env));
  return jsonResponse(
    {
      input: u ?? company,
      found: d.matches.length > 0,
      matches: d.matches.map((m) => ({ ...m, jobsEndpoint: `/jobs?ats=${m.ats}&company=${encodeURIComponent(m.company)}` })),
      tried: d.tried,
      subrequests: budget.used,
      durationMs: Date.now() - t0,
    },
    d.matches.length ? 200 : 404,
  );
}

function checkProxySecret(req: Request, env: Env): void {
  if (!env.PROXY_SECRET) return;
  const got = req.headers.get('X-RapidAPI-Proxy-Secret') ?? '';
  // constant-time-ish compare
  const a = new TextEncoder().encode(got);
  const b = new TextEncoder().encode(env.PROXY_SECRET);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  if (diff !== 0) throw new HttpError(403, 'forbidden', 'Missing or invalid X-RapidAPI-Proxy-Secret header.');
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-RapidAPI-Key, X-RapidAPI-Host' } });
      }
      if (path === '/health') {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Use GET.');
        return jsonResponse({ status: 'ok', version: VERSION, supportedAts: enabledAts(env), limits: { maxBatchCompanies: MAX_BATCH, maxLimit: MAX_LIMIT, maxDescriptionLength: MAX_DESC }, time: new Date().toISOString() });
      }
      checkProxySecret(req, env);
      if (path === '/jobs') {
        if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Use GET /jobs, or POST /jobs/batch for several companies.');
        return await handleJobsCached(url, env, ctx);
      }
      if (path === '/jobs/batch') {
        if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST with a JSON body.');
        return await handleBatch(req, env, ctx);
      }
      if (path === '/detect') {
        if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Use GET.');
        return await handleDetect(url, env);
      }
      if (path === '/') {
        return jsonResponse({ name: 'ATS Jobs API', version: VERSION, endpoints: ['GET /jobs', 'POST /jobs/batch', 'GET /detect', 'GET /health'], docs: 'https://github.com/latentlark/ats-jobs-api' });
      }
      throw new HttpError(404, 'not_found', `Unknown endpoint ${path}.`);
    } catch (e) {
      return errorResponse(e);
    }
  },
};
