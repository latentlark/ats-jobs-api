// Offline unit tests: the bundled Worker with a mocked fetch. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const gh = {
  jobs: [
    { id: 1, title: 'Senior Engineer', company_name: 'Acme', absolute_url: 'https://acme/1', location: { name: 'Remote - US' }, departments: [{ name: 'Engineering' }],
      updated_at: '2026-11-10T10:00:00-05:00', first_published: '2026-11-01T10:00:00-05:00',
      content: '&lt;p&gt;Build &amp;amp; ship&lt;/p&gt;&lt;ul&gt;&lt;li&gt;TypeScript&lt;/li&gt;&lt;/ul&gt;' + '&lt;p&gt;' + 'word '.repeat(2000) + '&lt;/p&gt;' },
    { id: 1, title: 'Duplicate id', absolute_url: 'https://acme/1b', location: { name: 'Berlin' } },
    { id: 2, title: 'Ingénieur Données', company_name: 'Acme', absolute_url: 'https://acme/2', location: { name: 'Paris, France' }, departments: [] },
  ],
};
let calls = [];
globalThis.fetch = async (url) => {
  url = String(url); calls.push(url);
  if (url.includes('greenhouse.io/v1/boards/acme/jobs')) return new Response(JSON.stringify(gh));
  if (url.includes('.eu.')) throw new TypeError('tls');
  return new Response('{}', { status: 404 });
};
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const { default: worker } = await import('../dist/worker.mjs');
const env = { CACHE_TTL_SECONDS: '0' };
const ctx = { waitUntil() {} };
const get = async (p, e = env, init) => { const r = await worker.fetch(new Request('http://x' + p, init), e, ctx); return [r.status, await r.json()]; };

test('normalizes greenhouse, dedupes ids, decodes escaped HTML, caps text', async () => {
  const [s, d] = await get('/jobs?company=greenhouse:acme&descriptionMaxLength=100');
  assert.equal(s, 200);
  assert.equal(d.jobs.length, 2);
  const j = d.jobs[0];
  assert.equal(j.remote, true);
  assert.equal(j.department, 'Engineering');
  assert.ok(j.description.startsWith('Build & ship\n'), j.description);
  assert.ok(j.description.includes('- TypeScript'));
  assert.ok(j.description.length <= 103);
  assert.equal(j.descriptionTruncated, true);
  assert.equal(j.postedAt, '2026-11-01T15:00:00.000Z');
});
test('accent-insensitive q, zero-match filter, remote filter', async () => {
  assert.equal((await get('/jobs?ats=greenhouse&company=acme&q=ingenieur'))[1].jobs.length, 1);
  assert.equal((await get('/jobs?ats=greenhouse&company=acme&q=nothinghere'))[1].meta.totalMatched, 0);
  assert.equal((await get('/jobs?ats=greenhouse&company=acme&remote=false'))[1].jobs[0].id, '2');
});
test('error codes', async () => {
  assert.equal((await get('/jobs?ats=greenhouse'))[0], 400);
  assert.equal((await get('/jobs?ats=nope&company=x'))[0], 400);
  assert.equal((await get('/jobs?ats=greenhouse&company=' + encodeURIComponent('a/b')))[0], 400);
  const [s, d] = await get('/jobs?ats=greenhouse&company=missingco');
  assert.equal(s, 404); assert.equal(d.error.code, 'board_not_found'); // EU fallback TLS error counts as not found
  assert.equal((await get('/nope'))[0], 404);
  assert.equal((await get('/jobs?ats=greenhouse&company=acme&limit=0'))[0], 400);
});
test('limit cap warns instead of failing', async () => {
  const [s, d] = await get('/jobs?ats=greenhouse&company=acme&limit=999999');
  assert.equal(s, 200); assert.equal(d.meta.limit, 500); assert.ok(d.meta.warnings.length);
});
test('batch validation', async () => {
  const post = (b) => get('/jobs/batch', env, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  assert.equal((await post({ companies: [] }))[0], 400);
  assert.equal((await post({ companies: Array.from({ length: 21 }, (_, i) => 'greenhouse:a' + i) }))[0], 400);
  const [s, d] = await post({ companies: ['greenhouse:acme', 'greenhouse:ACME', 'acme', 'greenhouse:missingco'] });
  assert.equal(s, 200);
  assert.deepEqual(d.results.map((r) => r.status), ['ok', 'error', 'error', 'error']);
  assert.deepEqual(d.results.slice(1).map((r) => r.error.code), ['duplicate', 'ats_required', 'board_not_found']);
});
test('proxy secret only enforced when set', async () => {
  const e = { ...env, PROXY_SECRET: 'abc' };
  assert.equal((await get('/jobs?company=greenhouse:acme', e))[0], 403);
  assert.equal((await get('/jobs?company=greenhouse:acme', e, { headers: { 'X-RapidAPI-Proxy-Secret': 'abc' } }))[0], 200);
  assert.equal((await get('/health', e))[0], 200);
});
test('detect from URL needs no network', async () => {
  calls = [];
  const [s, d] = await get('/detect?url=' + encodeURIComponent('https://job-boards.greenhouse.io/acme/jobs/123'));
  assert.equal(s, 200); assert.equal(d.matches[0].ats, 'greenhouse'); assert.equal(d.matches[0].company, 'acme'); assert.equal(calls.length, 0);
});
