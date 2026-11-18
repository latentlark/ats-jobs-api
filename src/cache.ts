import type { Ats, Board } from './types';
import type { Budget } from './util';

/**
 * Two cache layers for normalized boards:
 * 1. A small in-isolate LRU (works everywhere, including workers.dev, survives while the isolate is warm).
 * 2. The Cloudflare Cache API (per data center; only active on a custom domain, it is a no-op on workers.dev).
 */
const MEM_MAX_BYTES = 32 * 1024 * 1024;
const mem = new Map<string, { exp: number; size: number; board: Board }>();
let memBytes = 0;

/** level: 0 = no descriptions stored, 1 = text-ready descriptions, 2 = HTML kept. */
export function cacheKey(ats: Ats, token: string, level: 0 | 1 | 2, maxPages: number, q?: string): string {
  const t = ats === 'smartrecruiters' ? token : token.toLowerCase();
  return `https://cache.ats-jobs-api.internal/v2/${ats}/${encodeURIComponent(t)}?l=${level}&p=${maxPages}&q=${encodeURIComponent((q ?? '').toLowerCase())}`;
}

export function memGet(key: string): Board | null {
  const hit = mem.get(key);
  if (!hit) return null;
  if (hit.exp < Date.now()) {
    mem.delete(key);
    memBytes -= hit.size;
    return null;
  }
  mem.delete(key);
  mem.set(key, hit); // LRU bump
  return hit.board;
}

export function memPut(key: string, board: Board, approxBytes: number, ttlSec: number): void {
  if (approxBytes > MEM_MAX_BYTES / 2) return;
  const old = mem.get(key);
  if (old) {
    mem.delete(key);
    memBytes -= old.size;
  }
  mem.set(key, { exp: Date.now() + ttlSec * 1000, size: approxBytes, board });
  memBytes += approxBytes;
  for (const [k, v] of mem) {
    if (memBytes <= MEM_MAX_BYTES) break;
    mem.delete(k);
    memBytes -= v.size;
  }
}

export async function edgeGet(key: string, budget: Budget): Promise<Board | null> {
  if (!budget.tryTake()) return null;
  try {
    const res = await caches.default.match(key);
    if (!res) return null;
    return (await res.json()) as Board;
  } catch {
    return null;
  }
}

export function edgePut(key: string, board: Board, ttlSec: number, budget: Budget): { promise: Promise<void>; bytes: number } {
  const body = JSON.stringify(board, (k, v) => (k === '_text' ? undefined : v));
  if (!budget.tryTake()) return { promise: Promise.resolve(), bytes: body.length };
  const res = new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttlSec}` } });
  const promise = caches.default.put(key, res).catch(() => undefined);
  return { promise, bytes: body.length };
}
