import { ATS_LIST, type Ats } from './types';
import { Budget, HttpError, upstreamGet } from './util';

export interface Detection {
  ats: Ats;
  company: string;
  source: 'url_pattern' | 'page_html' | 'probe';
  /** Open jobs seen while probing (Lever is capped at 100). Only set for probes. */
  openJobs?: number;
  jobsUrl?: string;
}

const PATTERNS: [Ats, RegExp][] = [
  ['greenhouse', /boards-api(?:\.eu)?\.greenhouse\.io\/v1\/boards\/([A-Za-z0-9_-]+)/i],
  ['greenhouse', /(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([A-Za-z0-9_-]+)/i],
  ['lever', /api\.(?:eu\.)?lever\.co\/v0\/postings\/([A-Za-z0-9._-]+)/i],
  ['lever', /jobs\.(?:eu\.)?lever\.co\/([A-Za-z0-9._-]+)/i],
  ['ashby', /api\.ashbyhq\.com\/posting-api\/job-board\/([A-Za-z0-9._%-]+)/i],
  ['ashby', /jobs\.ashbyhq\.com\/([A-Za-z0-9._%-]+)/i],
  ['workable', /apply\.workable\.com\/api\/v\d\/widget\/accounts\/([A-Za-z0-9_-]+)/i],
  ['workable', /apply\.workable\.com\/(?!api\b|j\/)([A-Za-z0-9_-]+)/i],
  ['smartrecruiters', /api\.smartrecruiters\.com\/v1\/companies\/([A-Za-z0-9_-]+)/i],
  ['smartrecruiters', /(?:careers|jobs)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/i],
  ['recruitee', /\b([a-z0-9][a-z0-9-]*)\.recruitee\.com/i],
];
const BAD = new Set(['embed', 'api', 'www', 'jobs', 'careers', 'static', 'assets', 'cdn', 'j', 'v1', 'js', 'oauth', 'login', 'app', 'widget', 'search']);

export function detectFromText(text: string): Detection | null {
  for (const [ats, re] of PATTERNS) {
    const m = re.exec(text);
    if (m && m[1] && !BAD.has(m[1].toLowerCase())) {
      let company = decodeURIComponent(m[1]);
      if (ats === 'lever' || ats === 'recruitee') company = company.toLowerCase();
      return { ats, company, source: 'url_pattern' };
    }
  }
  return null;
}

/** "greenhouse:stripe" style input. */
export function parsePrefixed(input: string): { ats: Ats; company: string } | null {
  const m = /^([a-z]+):(.+)$/i.exec(input.trim());
  if (!m) return null;
  const ats = m[1].toLowerCase() as Ats;
  if (!ATS_LIST.includes(ats)) return null;
  return { ats, company: m[2].trim() };
}

export const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function slugCandidates(input: string): string[] {
  const s = input.trim();
  // turn a domain or name into likely board tokens
  const host = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0];
  const root = host.includes('.') ? host.split('.').slice(0, -1).join('.').split('.').pop()! : host;
  const name = root.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const out = new Set<string>();
  const a = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const b = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (a) out.add(a);
  if (b) out.add(b);
  return [...out].filter((x) => SLUG_RE.test(x)).slice(0, 2);
}

/** Returns the open job count (Lever is capped at 100) or null when the board does not exist. */
async function probe(ats: Ats, slug: string, budget: Budget): Promise<number | null> {
  const e = encodeURIComponent(slug);
  const urls: Record<Ats, string> = {
    greenhouse: `https://boards-api.greenhouse.io/v1/boards/${e}/jobs`,
    lever: `https://api.lever.co/v0/postings/${e}?mode=json&limit=100`,
    ashby: `https://api.ashbyhq.com/posting-api/job-board/${e}`,
    workable: `https://apply.workable.com/api/v1/widget/accounts/${e}`,
    smartrecruiters: `https://api.smartrecruiters.com/v1/companies/${e}/postings?limit=1`,
    recruitee: `https://${slug.toLowerCase()}.recruitee.com/api/offers/`,
  };
  if (ats === 'recruitee' && !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(slug)) return null;
  try {
    const r = await upstreamGet(urls[ats], budget, { timeoutMs: 5000, retries: 0 });
    if (r.status !== 200) return null;
    const d = JSON.parse(r.body);
    let n: number | null = null;
    if (ats === 'smartrecruiters') n = Number(d?.totalFound) || 0;
    else if (ats === 'lever') n = Array.isArray(d) ? d.length : null;
    else if (ats === 'recruitee') n = Array.isArray(d?.offers) ? d.offers.length : null;
    else n = Array.isArray(d?.jobs) ? d.jobs.filter((j: any) => j?.isListed !== false).length : null;
    // SmartRecruiters and Lever answer 200 with an empty list for unknown boards, so 0 means "not found" there.
    if (n === 0 && (ats === 'smartrecruiters' || ats === 'lever')) return null;
    return n;
  } catch {
    return null;
  }
}

/**
 * Detect the ATS for a careers URL, an "ats:slug" value, or a company slug/name.
 * Order: prefix, URL pattern (no network), careers page HTML (1 request), then parallel probes.
 */
export async function detect(input: { company?: string | null; url?: string | null }, budget: Budget): Promise<{ matches: Detection[]; tried: string[] }> {
  const tried: string[] = [];
  const raw = (input.url ?? input.company ?? '').trim();
  if (!raw) throw new HttpError(400, 'missing_parameter', 'Pass company (slug or name) or url.');
  if (raw.length > 2048) throw new HttpError(400, 'invalid_parameter', 'Input is too long.');

  const pre = parsePrefixed(raw);
  if (pre) return { matches: [{ ...pre, source: 'url_pattern' }], tried };

  const fromUrl = detectFromText(raw);
  if (fromUrl) return { matches: [fromUrl], tried };

  const looksUrl = /^https?:\/\//i.test(raw) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(raw);
  if (looksUrl && input.url) {
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpError(400, 'invalid_parameter', 'url is not a valid URL.');
    }
    if (!/^https?:$/.test(parsed.protocol) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(parsed.hostname)) {
      throw new HttpError(400, 'invalid_parameter', 'url must be a public http(s) URL.');
    }
    tried.push(`page:${parsed.host}`);
    try {
      const r = await upstreamGet(parsed.toString(), budget, { accept: 'text/html,*/*', timeoutMs: 6000 });
      if (r.status === 200) {
        const hit = detectFromText(r.body.slice(0, 1_500_000));
        if (hit) return { matches: [{ ...hit, source: 'page_html' }], tried };
      }
    } catch {
      /* fall through to probes */
    }
  }

  const slugs = slugCandidates(raw);
  if (!slugs.length) throw new HttpError(400, 'invalid_parameter', 'Could not derive a board slug from the input.');
  const jobs: Promise<Detection | null>[] = [];
  for (const slug of slugs) {
    for (const ats of ATS_LIST) {
      if (budget.left < 2) break;
      tried.push(`${ats}:${slug}`);
      jobs.push(probe(ats, slug, budget).then((n) => (n === null ? null : { ats, company: slug, source: 'probe' as const, openJobs: n })));
    }
  }
  // Best match first: the board with the most open jobs (a stale or test board on another ATS loses).
  const results = ((await Promise.all(jobs)).filter(Boolean) as Detection[]).sort((a, b) => (b.openJobs ?? 0) - (a.openJobs ?? 0));
  return { matches: results, tried };
}
