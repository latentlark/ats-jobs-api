import type { Ats, Board, FetchOptions, RawJob } from './types';
import { Budget, HttpError, clean, iso, num, parseJson, prettySlug, upstreamGet, workplace } from './util';

type Provider = (token: string, budget: Budget, opts: FetchOptions) => Promise<Board>;

const notFound = (ats: Ats, token: string, extra = '') =>
  new HttpError(404, 'board_not_found', `No public ${ats} job board found for "${token}".${extra}`, { ats, company: token });

function upstreamFail(ats: Ats, status: number): HttpError {
  return new HttpError(502, 'upstream_error', `${ats} returned HTTP ${status}.`, { ats, upstreamStatus: status });
}

function board(ats: Ats, token: string, company: string, jobs: RawJob[], budget: Budget, startUsed: number, total?: number): Board {
  return {
    ats,
    boardToken: token,
    company,
    jobs,
    totalAvailable: total ?? jobs.length,
    truncated: total !== undefined && total > jobs.length,
    fetchedAt: new Date().toISOString(),
    subrequests: budget.used - startUsed,
  };
}

function base(ats: Ats, token: string): Pick<RawJob, 'ats' | 'boardToken'> {
  return { ats, boardToken: token };
}

/** Removes duplicate ids that some boards return (and that paging can repeat). */
function dedupe(jobs: RawJob[]): RawJob[] {
  const seen = new Set<string>();
  const out: RawJob[] = [];
  for (const j of jobs) {
    if (!j.id || seen.has(j.id)) continue;
    seen.add(j.id);
    out.push(j);
  }
  return out;
}

/** EU fallback hosts: short timeout, no retry, and a network failure counts as "not on this host". */
async function fallbackGet(url: string, budget: Budget) {
  try {
    const r = await upstreamGet(url, budget, { timeoutMs: 4000, retries: 0 });
    // From Workers the Greenhouse EU host can answer 530 (origin unreachable): treat any non-200 as "not here".
    return r.status === 200 ? r : { status: 404, body: '' };
  } catch (e) {
    if (e instanceof HttpError && (e.code === 'upstream_error' || e.code === 'upstream_timeout')) return { status: 404, body: '' };
    throw e;
  }
}

// ---------------- Greenhouse ----------------
const greenhouse: Provider = async (token, budget, opts) => {
  const start = budget.used;
  let data: any = null;
  let lastStatus = 0;
  for (const host of ['boards-api.greenhouse.io', 'boards-api.eu.greenhouse.io']) {
    const url = `https://${host}/v1/boards/${encodeURIComponent(token)}/jobs${opts.withContent ? '?content=true' : ''}`;
    const r = host.includes('.eu.') ? await fallbackGet(url, budget) : await upstreamGet(url, budget);
    lastStatus = r.status;
    if (r.status === 200) {
      data = parseJson(r.body, host);
      break;
    }
    if (r.status !== 404) throw upstreamFail('greenhouse', r.status);
    if (budget.left - budget.reserve < 1) break; // keep calls for other companies in a batch
  }
  if (!data) {
    if (lastStatus === 404 || lastStatus === 0) throw notFound('greenhouse', token);
    throw upstreamFail('greenhouse', lastStatus);
  }
  const jobs: RawJob[] = (data.jobs ?? []).map((j: any): RawJob => {
    const loc = clean(j.location?.name);
    const offices = (j.offices ?? []).map((o: any) => clean(o?.name)).filter(Boolean) as string[];
    const wp = workplace({ raw: loc });
    const meta = Array.isArray(j.metadata) ? j.metadata : [];
    const empMeta = meta.find((m: any) => /employment|job type|commitment|time type/i.test(m?.name ?? ''));
    return {
      ...base('greenhouse', token),
      id: String(j.id),
      title: clean(j.title),
      company: clean(j.company_name) ?? prettySlug(token),
      location: loc,
      locations: loc ? [loc] : offices,
      country: null,
      remote: wp === 'remote',
      workplaceType: wp,
      department: (j.departments ?? []).map((d: any) => d?.name).filter(Boolean).join(', ') || null,
      team: null,
      employmentType: clean(typeof empMeta?.value === 'string' ? empMeta.value : Array.isArray(empMeta?.value) ? empMeta.value.join(', ') : null),
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      salaryInterval: null,
      salaryText: null,
      postedAt: iso(j.first_published ?? j.updated_at),
      updatedAt: iso(j.updated_at),
      url: j.absolute_url ?? null,
      applyUrl: j.absolute_url ?? null,
      descHtml: j.content ?? null,
      descPlain: null,
    };
  });
  const company = jobs[0]?.company ?? prettySlug(token);
  return board('greenhouse', token, company, dedupe(jobs), budget, start);
};

// ---------------- Lever ----------------
const lever: Provider = async (token, budget) => {
  const start = budget.used;
  let data: any[] | null = null;
  let lastStatus = 0;
  for (const host of ['api.lever.co', 'api.eu.lever.co']) {
    const lurl = `https://${host}/v0/postings/${encodeURIComponent(token)}?mode=json`;
    const r = host.includes('.eu.') ? await fallbackGet(lurl, budget) : await upstreamGet(lurl, budget);
    lastStatus = r.status;
    if (r.status === 200) {
      const parsed = parseJson(r.body, host);
      if (Array.isArray(parsed)) {
        data = parsed;
        if (parsed.length || host === 'api.eu.lever.co') break;
        // empty on the US host: try EU before accepting an empty board
        if (budget.left - budget.reserve < 1) break; // keep calls for other companies in a batch
        continue;
      }
    } else if (r.status !== 404) {
      throw upstreamFail('lever', r.status);
    }
    if (budget.left - budget.reserve < 1) break; // keep calls for other companies in a batch
  }
  if (!data) {
    if (lastStatus === 404 || lastStatus === 0) throw notFound('lever', token);
    throw upstreamFail('lever', lastStatus);
  }
  const jobs: RawJob[] = data.map((j: any): RawJob => {
    const c = j.categories ?? {};
    const sr = j.salaryRange ?? null;
    const wpRaw: string = j.workplaceType ?? '';
    const wp = wpRaw === 'remote' ? 'remote' : wpRaw === 'hybrid' ? 'hybrid' : wpRaw === 'on-site' || wpRaw === 'onsite' ? 'onsite' : workplace({ raw: c.location });
    const lists = (j.lists ?? []).map((l: any) => `<h3>${l?.text ?? ''}</h3><ul>${l?.content ?? ''}</ul>`).join('');
    const descHtml = (j.description ?? '') + lists + (j.additional ?? '');
    return {
      ...base('lever', token),
      id: String(j.id),
      title: clean(j.text),
      company: prettySlug(token),
      location: clean(c.location),
      locations: (c.allLocations ?? (c.location ? [c.location] : [])).map(clean).filter(Boolean),
      country: j.country ?? null,
      remote: wp === 'remote',
      workplaceType: wp,
      department: clean(c.department),
      team: clean(c.team),
      employmentType: clean(c.commitment),
      salaryMin: num(sr?.min),
      salaryMax: num(sr?.max),
      salaryCurrency: sr?.currency ?? null,
      salaryInterval: sr?.interval ?? null,
      salaryText: clean(j.salaryDescriptionPlain),
      postedAt: iso(j.createdAt),
      updatedAt: iso(j.updatedAt ?? null),
      url: j.hostedUrl ?? null,
      applyUrl: j.applyUrl ?? null,
      descHtml: descHtml || null,
      descPlain: null,
    };
  });
  return board('lever', token, prettySlug(token), dedupe(jobs), budget, start);
};

// ---------------- Ashby ----------------
const ashby: Provider = async (token, budget) => {
  const start = budget.used;
  const r = await upstreamGet(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`, budget);
  if (r.status === 404) throw notFound('ashby', token);
  if (r.status !== 200) throw upstreamFail('ashby', r.status);
  const data = parseJson(r.body, 'api.ashbyhq.com');
  const jobs: RawJob[] = [];
  for (const j of data.jobs ?? []) {
    if (j.isListed === false) continue;
    const comp = j.compensation ?? {};
    const sal = (comp.summaryComponents ?? []).find((c: any) => c?.compensationType === 'Salary');
    const wpRaw = String(j.workplaceType ?? '').toLowerCase();
    const wp = wpRaw === 'remote' ? 'remote' : wpRaw === 'hybrid' ? 'hybrid' : wpRaw === 'onsite' ? 'onsite' : workplace({ remote: j.isRemote, raw: j.location });
    const locs = [j.location, ...(j.secondaryLocations ?? []).map((s: any) => s?.location)].map(clean).filter(Boolean) as string[];
    jobs.push({
      ...base('ashby', token),
      id: String(j.id),
      title: clean(j.title),
      company: prettySlug(token),
      location: clean(j.location),
      locations: [...new Set(locs)],
      country: j.address?.postalAddress?.addressCountry ?? null,
      remote: j.isRemote === true || wp === 'remote',
      workplaceType: wp,
      department: clean(j.department),
      team: clean(j.team),
      employmentType: clean(j.employmentType),
      salaryMin: num(sal?.minValue),
      salaryMax: num(sal?.maxValue),
      salaryCurrency: sal?.currencyCode ?? null,
      salaryInterval: sal?.interval ?? null,
      salaryText: clean(comp.compensationTierSummary)?.replace(/[\u2014\u2013]/g, '-') ?? null,
      postedAt: iso(j.publishedAt),
      updatedAt: iso(j.updatedAt ?? null),
      url: j.jobUrl ?? null,
      applyUrl: j.applyUrl ?? null,
      descHtml: j.descriptionHtml ?? null,
      descPlain: j.descriptionPlain ?? null,
    });
  }
  return board('ashby', token, prettySlug(token), dedupe(jobs), budget, start);
};

// ---------------- SmartRecruiters (paginated, 100 per page) ----------------
const SR_PAGE = 100;
const smartrecruiters: Provider = async (token, budget, opts) => {
  const start = budget.used;
  const baseUrl = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings`;
  const q = opts.q ? `&q=${encodeURIComponent(opts.q)}` : '';
  const fetchPage = async (offset: number) => {
    const r = await upstreamGet(`${baseUrl}?limit=${SR_PAGE}&offset=${offset}${q}`, budget);
    if (r.status === 404) throw notFound('smartrecruiters', token);
    if (r.status !== 200) throw upstreamFail('smartrecruiters', r.status);
    return parseJson(r.body, 'api.smartrecruiters.com');
  };
  const first = await fetchPage(0);
  const total: number = Number(first.totalFound) || 0;
  if (total === 0 && !opts.q) {
    // SmartRecruiters answers 200 with 0 results for unknown companies too.
    throw notFound('smartrecruiters', token, ' SmartRecruiters returns an empty list for unknown company ids, so this can also mean the company has no open jobs. Ids are case-sensitive, for example BoschGroup.');
  }
  const pages = [first];
  const wanted = Math.min(Math.ceil(total / SR_PAGE), Math.max(1, opts.maxPages));
  // fetch remaining pages in parallel, in small waves, within the subrequest budget
  const offsets: number[] = [];
  for (let p = 1; p < wanted; p++) offsets.push(p * SR_PAGE);
  const WAVE = 6;
  for (let i = 0; i < offsets.length; i += WAVE) {
    const wave = offsets.slice(i, i + WAVE).filter(() => budget.left - budget.reserve >= 2);
    if (!wave.length) break;
    pages.push(...(await Promise.all(wave.map(fetchPage))));
  }
  const jobs: RawJob[] = [];
  for (const pg of pages) {
    for (const j of pg.content ?? []) {
      const loc = j.location ?? {};
      const wp = workplace({ remote: loc.remote, hybrid: loc.hybrid, raw: loc.fullLocation });
      const full = clean(loc.fullLocation);
      jobs.push({
        ...base('smartrecruiters', token),
        id: String(j.id),
        title: clean(j.name),
        company: clean(j.company?.name) ?? token,
        location: full,
        locations: full ? [full] : [],
        country: loc.country ? String(loc.country).toUpperCase() : null,
        remote: loc.remote === true,
        workplaceType: wp,
        department: clean(j.department?.label) ?? clean(j.function?.label),
        team: clean(j.department?.label) ? clean(j.function?.label) : null,
        employmentType: clean(j.typeOfEmployment?.label),
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        salaryInterval: null,
        salaryText: null,
        postedAt: iso(j.releasedDate),
        updatedAt: iso(j.releasedDate),
        url: `https://jobs.smartrecruiters.com/${encodeURIComponent(token)}/${j.id}`,
        applyUrl: `https://jobs.smartrecruiters.com/${encodeURIComponent(token)}/${j.id}`,
        descHtml: null,
        descPlain: null,
      });
    }
  }
  const deduped = dedupe(jobs);
  const company = deduped[0]?.company ?? token;
  return board('smartrecruiters', token, company, deduped, budget, start, total);
};

/** SmartRecruiters descriptions need one detail call per job. Only used for small result pages. */
export async function smartrecruitersDetails(jobs: RawJob[], budget: Budget): Promise<void> {
  await Promise.all(
    jobs.map(async (j) => {
      if (budget.left < 1) return;
      try {
        const r = await upstreamGet(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(j.boardToken)}/postings/${encodeURIComponent(j.id)}`, budget, { timeoutMs: 6000 });
        if (r.status !== 200) return;
        const d = JSON.parse(r.body);
        const secs = d?.jobAd?.sections ?? {};
        j.descHtml = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']
          .map((k) => secs[k])
          .filter((s: any) => s?.text)
          .map((s: any) => (s.title ? `<h3>${s.title}</h3>` : '') + s.text)
          .join('\n') || null;
        if (d?.applyUrl) j.applyUrl = d.applyUrl;
      } catch {
        /* description stays null for this job */
      }
    }),
  );
}

// ---------------- Workable ----------------
const workable: Provider = async (token, budget, opts) => {
  const start = budget.used;
  const r = await upstreamGet(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}${opts.withContent ? '?details=true' : ''}`, budget);
  if (r.status === 404) throw notFound('workable', token);
  if (r.status !== 200) throw upstreamFail('workable', r.status);
  const d = parseJson(r.body, 'apply.workable.com');
  const company = clean(d.name) ?? prettySlug(token);
  const jobs: RawJob[] = (d.jobs ?? []).map((j: any): RawJob => {
    const locs = (j.locations ?? []).filter((l: any) => !l?.hidden).map((l: any) => clean([l.city, l.region, l.country].filter(Boolean).join(', '))).filter(Boolean) as string[];
    const primary = clean([j.city, j.state, j.country].filter(Boolean).join(', '));
    const wp = workplace({ remote: j.telecommuting === true ? true : undefined, raw: primary });
    return {
      ...base('workable', token),
      id: String(j.shortcode),
      title: clean(j.title),
      company,
      location: primary,
      locations: locs.length ? [...new Set(locs)] : primary ? [primary] : [],
      country: (j.locations ?? []).find((l: any) => l?.countryCode)?.countryCode ?? null,
      remote: j.telecommuting === true,
      workplaceType: wp,
      department: clean(j.department),
      team: clean(j.function),
      employmentType: clean(j.employment_type),
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      salaryInterval: null,
      salaryText: null,
      postedAt: iso(j.published_on ?? j.created_at),
      updatedAt: iso(j.published_on ?? null),
      url: j.url ?? j.shortlink ?? null,
      applyUrl: j.application_url ?? null,
      descHtml: j.description ?? null,
      descPlain: null,
    };
  });
  return board('workable', token, company, dedupe(jobs), budget, start);
};

// ---------------- Recruitee ----------------
const recruitee: Provider = async (token, budget) => {
  const start = budget.used;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(token)) throw notFound('recruitee', token);
  let r;
  try {
    r = await upstreamGet(`https://${token.toLowerCase()}.recruitee.com/api/offers/`, budget);
  } catch (e) {
    // unknown subdomains can fail at DNS level
    if (e instanceof HttpError && e.code === 'upstream_error') throw notFound('recruitee', token);
    throw e;
  }
  if (r.status === 404) throw notFound('recruitee', token);
  if (r.status !== 200) throw upstreamFail('recruitee', r.status);
  const d = parseJson(r.body, 'recruitee.com');
  const jobs: RawJob[] = (d.offers ?? []).map((o: any): RawJob => {
    const locs = (o.locations ?? []).map((l: any) => clean([l?.city, l?.state, l?.country].filter(Boolean).join(', '))).filter(Boolean) as string[];
    const wp = workplace({ remote: o.remote, hybrid: o.hybrid, onsite: o.on_site, raw: o.location });
    const sal = o.salary ?? {};
    const hasSal = num(sal.min) !== null || num(sal.max) !== null;
    return {
      ...base('recruitee', token),
      id: String(o.id),
      title: clean(o.title),
      company: clean(o.company_name) ?? prettySlug(token),
      location: clean(o.location),
      locations: locs.length ? [...new Set(locs)] : o.location ? [clean(o.location)!] : [],
      country: o.country_code ?? null,
      remote: o.remote === true,
      workplaceType: wp,
      department: clean(o.department),
      team: null,
      employmentType: clean(o.employment_type_code),
      salaryMin: hasSal ? num(sal.min) : null,
      salaryMax: hasSal ? num(sal.max) : null,
      salaryCurrency: hasSal ? sal.currency ?? null : null,
      salaryInterval: hasSal ? sal.period ?? null : null,
      salaryText: null,
      postedAt: iso(o.published_at ?? o.created_at),
      updatedAt: iso(o.updated_at),
      url: o.careers_url ?? null,
      applyUrl: o.careers_apply_url ?? null,
      descHtml: [o.description, o.requirements].filter(Boolean).join('\n') || null,
      descPlain: null,
    };
  });
  return board('recruitee', token, jobs[0]?.company ?? prettySlug(token), dedupe(jobs), budget, start);
};

export const PROVIDERS: Record<Ats, Provider> = { greenhouse, lever, ashby, smartrecruiters, workable, recruitee };
