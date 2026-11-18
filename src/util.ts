export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Record<string, unknown>) {
    super(message);
  }
}

export const UPSTREAM_TIMEOUT_MS = 8000;
const UA = 'ats-jobs-api/1.0 (+https://github.com/latentlark/ats-jobs-api)';

/** Counts subrequests so one request never goes past the Workers free-plan limit of 50. */
export class Budget {
  used = 0;
  /** Calls kept free for work that must still happen (batch: one per company not fetched yet). */
  reserve = 0;
  constructor(public limit: number) {}
  /** For optional calls such as Cache API reads and writes, which share the subrequest quota. */
  tryTake(): boolean {
    if (this.used + this.reserve >= this.limit) return false;
    this.used++;
    return true;
  }
  take(): void {
    if (this.used >= this.limit) throw new HttpError(503, 'subrequest_budget_exhausted', 'Upstream request budget for this call is used up. Ask for fewer companies or pages.');
    this.used++;
  }
  get left(): number {
    return this.limit - this.used;
  }
}

export interface UpstreamResult {
  status: number;
  body: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET with an 8s timeout per attempt and one retry on 429/5xx/network error.
 * Returns status + text. Throws HttpError(502/504) when the upstream keeps failing.
 */
export async function upstreamGet(url: string, budget: Budget, init: { accept?: string; timeoutMs?: number; retries?: number } = {}): Promise<UpstreamResult> {
  const timeoutMs = init.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  let lastErr = '';
  const attempts = 1 + (init.retries ?? 1);
  for (let attempt = 0; attempt < attempts; attempt++) {
    budget.take();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: init.accept ?? 'application/json' },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      const body = await res.text();
      clearTimeout(timer);
      if ((res.status === 429 || res.status >= 500) && attempt < attempts - 1) {
        lastErr = `HTTP ${res.status}`;
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 && ra <= 2 ? ra * 1000 : 400);
        continue;
      }
      return { status: res.status, body };
    } catch (e) {
      clearTimeout(timer);
      const aborted = ctrl.signal.aborted;
      lastErr = aborted ? `timeout after ${timeoutMs}ms` : String((e as Error)?.message ?? e);
      if (attempt < attempts - 1 && budget.left > 0) {
        await sleep(300);
        continue;
      }
      throw new HttpError(aborted ? 504 : 502, aborted ? 'upstream_timeout' : 'upstream_error', `Upstream request failed: ${lastErr}`, { upstream: hostOf(url) });
    }
  }
  throw new HttpError(502, 'upstream_error', `Upstream request failed: ${lastErr}`, { upstream: hostOf(url) });
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

export function parseJson<T = any>(body: string, upstream: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new HttpError(502, 'upstream_bad_response', 'Upstream returned a response that is not valid JSON.', { upstream });
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', bull: '-', middot: '-', copy: '(c)', reg: '(R)', trade: '(TM)', euro: 'EUR' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
    if (g[0] === '#') {
      const cp = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return '';
      if (cp === 0x2014 || cp === 0x2013) return '-';
      return String.fromCodePoint(cp);
    }
    const v = ENTITIES[g.toLowerCase()];
    return v ?? m;
  });
}

/** HTML to readable plain text. Linear regex passes only, no DOM. */
export function htmlToText(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input;
  // Greenhouse content is HTML-escaped once more.
  if (/^\s*&lt;/.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|li|h[1-6]|ul|ol|tr|section)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s)
    .replace(/[\u2014\u2013]/g, '-')
    .replace(/[ \t\r\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s || null;
}

/**
 * Plain text of at most maxLen characters. Converts only a prefix of the HTML (growing it when
 * needed), so a 30 KB description capped at 1,000 characters costs a few KB of regex work.
 */
export function htmlToTextCapped(html: string | null | undefined, maxLen: number): { text: string | null; cut: boolean } {
  if (!html) return { text: null, cut: false };
  const escaped = /^\s*&lt;/.test(html); // Greenhouse escapes its HTML once more
  let take = Math.max(2048, maxLen * (escaped ? 6 : 4));
  for (;;) {
    const partial = take < html.length;
    let chunk = partial ? html.slice(0, take) : html;
    if (escaped) chunk = decodeEntities(chunk.replace(/&[#a-z0-9]*$/i, ''));
    if (partial) chunk = chunk.replace(/<[^>]*$/, ''); // drop a tag cut in half
    const text = htmlToText(chunk) ?? '';
    if (text.length > maxLen) {
      let t = text.slice(0, maxLen);
      const sp = t.lastIndexOf(' ');
      if (sp > maxLen * 0.8) t = t.slice(0, sp);
      return { text: t.trimEnd() + '...', cut: true };
    }
    if (!partial) return { text: text || null, cut: false };
    take *= 4;
  }
}

export function unescapeHtmlOnce(s: string | null | undefined): string | null {
  if (!s) return null;
  return /^\s*&lt;/.test(s) ? decodeEntities(s) : s;
}

export function iso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const str = String(v).trim();
  // "2026-11-18 11:13:56 UTC" (Recruitee)
  const fixed = str.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/, '$1T$2Z');
  const d = new Date(fixed);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function clean(s: unknown): string | null {
  if (s === null || s === undefined) return null;
  if (typeof s !== 'string' && typeof s !== 'number') return null; // upstream schema drift: never print [object Object]
  const t = String(s).replace(/\s+/g, ' ').replace(/(,\s*)+,/g, ',').replace(/^[,\s]+|[,\s]+$/g, '').trim();
  return t || null;
}

export function prettySlug(slug: string): string {
  return slug.split(/[-_]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || slug;
}

const REMOTE_RE = /\b(remote|anywhere|work from home|wfh|home[- ]?office|telecommute|fully distributed)\b/i;
const HYBRID_RE = /\bhybrid\b/i;

export function workplace(opts: { remote?: unknown; hybrid?: unknown; onsite?: unknown; raw?: unknown }): 'remote' | 'hybrid' | 'onsite' | null {
  const raw = typeof opts.raw === 'string' ? opts.raw.toLowerCase() : '';
  if (opts.hybrid === true || HYBRID_RE.test(raw)) return 'hybrid';
  if (opts.remote === true || REMOTE_RE.test(raw)) return 'remote';
  if (opts.onsite === true || /\b(on-?site|in[- ]office|onsite)\b/.test(raw)) return 'onsite';
  if (opts.remote === false) return 'onsite';
  return null;
}

export function jsonResponse(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', ...extra },
  });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    return jsonResponse({ error: { status: e.status, code: e.code, message: e.message, ...(e.details ?? {}) } }, e.status);
  }
  console.error('internal_error', (e as Error)?.stack ?? e);
  return jsonResponse({ error: { status: 500, code: 'internal_error', message: 'Unexpected error.' } }, 500);
}
