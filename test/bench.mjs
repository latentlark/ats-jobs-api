// CPU-time bench + failure injection. Runs the bundled Worker in Node with a mocked fetch that
// serves saved upstream bodies, so only the Worker's own CPU work is measured.
// usage: npx esbuild src/index.ts --bundle --format=esm --platform=neutral --outfile=dist/worker.mjs && node test/bench.mjs
import { readFileSync, existsSync } from 'node:fs';
const FX = new URL('./fixtures/', import.meta.url);
const fx = (n) => readFileSync(new URL(n, FX), 'utf8');

const routes = [
  [/greenhouse\.io\/v1\/boards\/stripe\/jobs\?content=true/, 'gh_stripe_c.json'],
  [/greenhouse\.io\/v1\/boards\/stripe\/jobs$/, 'gh_stripe.json'],
  [/greenhouse\.io\/v1\/boards\/databricks\/jobs\?content=true/, 'gh_databricks_c.json'],
  [/lever\.co\/v0\/postings\/palantir/, 'lever_palantir.json'],
  [/ashbyhq\.com\/posting-api\/job-board\/openai/, 'ashby_openai.json'],
  [/ashbyhq\.com\/posting-api\/job-board\/ramp/, 'ashby_ramp.json'],
  [/workable\.com\/api\/v1\/widget\/accounts\/creativechaos/, 'wk_creativechaos_c.json'],
  [/vdkgroep\.recruitee\.com/, 'rc_vdkgroep.json'],
];
const bodies = new Map();
let calls = 0;
const inject = { mode: null, count: 0 };
globalThis.fetch = async (url, init = {}) => {
  url = String(url); calls++;
  if (inject.mode && url.includes('flaky')) {
    inject.count++;
    if (inject.mode === '429once' && inject.count === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
    if (inject.mode === '500always') return new Response('boom', { status: 500 });
    if (inject.mode === 'badjson') return new Response('<html>not json</html>', { status: 200 });
    if (inject.mode === 'timeout') return new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    if (inject.mode === 'neterr') throw new TypeError('network down');
    return new Response(JSON.stringify({ jobs: [{ id: 1, title: 'Flaky Job', absolute_url: 'https://x/1', location: { name: 'Remote' } }] }), { status: 200 });
  }
  const m = /smartrecruiters\.com\/v1\/companies\/BoschGroup\/postings\?limit=100&offset=(\d+)/.exec(url);
  let file = m ? `sr_bosch_${m[1]}.json` : routes.find(([re]) => re.test(url))?.[1];
  if (!file || !existsSync(new URL(file, FX))) return new Response('{"status":404}', { status: 404 });
  if (!bodies.has(file)) bodies.set(file, fx(file));
  return new Response(bodies.get(file), { status: 200 });
};
const store = new Map();
globalThis.caches = { default: { match: async (k) => (store.has(k) ? new Response(store.get(k)) : undefined), put: async (k, r) => { store.set(k, await r.text()); } } };
const { default: worker } = await import('../dist/worker.mjs');
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function run(label, path, { method = 'GET', body, env = { CACHE_TTL_SECONDS: '0' } } = {}) {
  calls = 0;
  if (globalThis.gc) globalThis.gc();
  const c0 = process.cpuUsage(); const t0 = performance.now();
  const res = await worker.fetch(new Request('http://x' + path, { method, body: body && JSON.stringify(body), headers: body ? { 'content-type': 'application/json' } : {} }), env, ctx);
  const text = await res.text();
  const c = process.cpuUsage(c0); const wall = performance.now() - t0;
  const cpu = (c.user + c.system) / 1000;
  let n = '';
  try { const d = JSON.parse(text); n = d.meta?.returned ?? d.meta?.totalJobs ?? d.error?.code ?? ''; } catch {}
  console.log([label, res.status, n, `cpu ${cpu.toFixed(1)}ms`, `wall ${wall.toFixed(0)}ms`, `${(text.length / 1024).toFixed(0)}KB`, `upstream ${calls}`].join('\t'));
  return { status: res.status, text };
}

console.log('--- CPU per request, cache OFF (cold parse every time) ---');
// warm-up JIT once
await run('warmup', '/jobs?ats=ashby&company=ramp&limit=10');
for (const [l, p] of [
  ['gh stripe 500 no-desc', '/jobs?ats=greenhouse&company=stripe&limit=500&description=none'],
  ['gh stripe 100 text', '/jobs?ats=greenhouse&company=stripe&limit=100&descriptionMaxLength=1000'],
  ['gh stripe 500 text', '/jobs?ats=greenhouse&company=stripe&limit=500&descriptionMaxLength=1000'],
  ['gh databricks 500 text', '/jobs?ats=greenhouse&company=databricks&limit=500&descriptionMaxLength=1000'],
  ['lever palantir 306 text', '/jobs?ats=lever&company=palantir&limit=500&descriptionMaxLength=1000'],
  ['lever palantir 100 none', '/jobs?ats=lever&company=palantir&limit=100&description=none'],
  ['ashby openai 500 text', '/jobs?ats=ashby&company=openai&limit=500&descriptionMaxLength=1000'],
  ['ashby openai 100 none', '/jobs?ats=ashby&company=openai&limit=100&description=none'],
  ['ashby ramp 181 text', '/jobs?ats=ashby&company=ramp&limit=500&descriptionMaxLength=1000'],
  ['sr bosch 2000 read, 500 out', '/jobs?ats=smartrecruiters&company=BoschGroup&limit=500&description=none'],
  ['workable creativechaos text', '/jobs?ats=workable&company=creativechaos&limit=500&descriptionMaxLength=1000'],
  ['recruitee vdkgroep 500 text', '/jobs?ats=recruitee&company=vdkgroep&limit=500&descriptionMaxLength=1000'],
  ['gh stripe q=engineer searchDescription', '/jobs?ats=greenhouse&company=stripe&q=engineer%20payments&searchDescription=true&limit=100'],
]) await run(l, p);

console.log('--- same requests, cache ON, second call (memory hit) ---');
const on = { CACHE_TTL_SECONDS: '600' };
for (const [l, p] of [
  ['gh stripe 500 text', '/jobs?ats=greenhouse&company=stripe&limit=500&descriptionMaxLength=1000'],
  ['ashby openai 100 none', '/jobs?ats=ashby&company=openai&limit=100&description=none'],
  ['ashby openai 50 text (default)', '/jobs?ats=ashby&company=openai'],
  ['lever palantir 50 text (default)', '/jobs?ats=lever&company=palantir'],
]) { await run(l + ' [fill]', p, { env: on }); await run(l + ' [hit]', p, { env: on }); }
const batchBody = { companies: ['greenhouse:stripe', 'greenhouse:databricks', 'lever:palantir', 'ashby:openai', 'ashby:ramp', 'workable:creativechaos', 'recruitee:vdkgroep', 'smartrecruiters:BoschGroup'], limitPerCompany: 100 };
await run('batch 8 big boards cold, no desc', '/jobs/batch', { method: 'POST', body: batchBody });
await run('batch 8 big boards [hit]', '/jobs/batch', { method: 'POST', body: batchBody, env: on });
await run('batch 8 big boards [hit2]', '/jobs/batch', { method: 'POST', body: batchBody, env: on });

console.log('--- failure injection ---');
for (const mode of ['429once', '500always', 'badjson', 'timeout', 'neterr']) {
  inject.mode = mode; inject.count = 0;
  const t = Date.now();
  const r = await run(`inject ${mode}`, '/jobs?ats=ashby&company=flaky&limit=5');
  console.log(`   -> ${r.text.slice(0, 160)} (${Date.now() - t}ms, upstream attempts ${inject.count})`);
}
inject.mode = null;
console.log('--- proxy secret ---');
const sec = { PROXY_SECRET: 's3cr3t-test', CACHE_TTL_SECONDS: '0' };
for (const [l, h] of [['no header', {}], ['wrong header', { 'X-RapidAPI-Proxy-Secret': 'nope' }], ['right header', { 'X-RapidAPI-Proxy-Secret': 's3cr3t-test' }]]) {
  const res = await worker.fetch(new Request('http://x/jobs?ats=ashby&company=ramp&limit=1', { headers: h }), sec, ctx);
  console.log(`secret ${l}: ${res.status}`);
}
const h = await worker.fetch(new Request('http://x/health'), sec, ctx);
console.log(`secret /health without header: ${h.status}`);
