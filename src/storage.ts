// src/storage.ts — Supabase-backed storage (replacing Upstash/Redis)
import pkg from "@supabase/supabase-js";
const { createClient } = pkg;
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PriceResult } from "./types.js";
import pRetry from "p-retry";

function parseNumericLoose(x: any): number | null {
  if (x === null || x === undefined) return null;
  const s = String(x).trim();
  if (s === "") return null;
  // accept plain, decimal, and scientific notation
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function eqApprox(a: any, b: any, rel = 1e-9, abs = 1e-15): boolean {
  const na = parseNumericLoose(a);
  const nb = parseNumericLoose(b);
  if (na === null && nb === null) return true;
  if (na === null || nb === null) return false;
  const diff = Math.abs(na - nb);
  return diff <= Math.max(abs, rel * Math.max(Math.abs(na), Math.abs(nb)));
}

const SB_FETCH_TIMEOUT_MS = Number(process.env.SB_FETCH_TIMEOUT_MS || 30000);

function withTimeoutFetch(input: any, init: any = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), SB_FETCH_TIMEOUT_MS);
  const opts: RequestInit = {
    ...init,
    signal: controller.signal,
    // @ts-ignore keepalive exists in lib.dom
    keepalive: true,
  };
  return fetch(input as any, opts).finally(() => clearTimeout(id));
}

// ────────────────────────────────────────────────────────────────
// Supabase bootstrap
// Required envs (set these in Render/your runtime):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE (preferred) or SUPABASE_ANON_KEY
// Tables expected:
//   prices(chain text, address text, symbol text, price_usd numeric, source text, at timestamptz)
//   prices_history(id bigserial, chain text, address text, symbol text, price_usd numeric, source text, at timestamptz)
//   PRIMARY KEY(prices.chain, prices.address)
// ────────────────────────────────────────────────────────────────
let sb: SupabaseClient | null = null;

function mask(key?: string) {
  if (!key) return "";
  return key.length > 8 ? `${key.slice(0,4)}…${key.slice(-4)}` : "****";
}

function init() {
  if (sb) return sb;

  const url  = process.env.SUPABASE_URL;
  const sr   = process.env.SUPABASE_SERVICE_ROLE;   // prefer service role on server
  const anon = process.env.SUPABASE_ANON_KEY;       // fallback for public environments

  if (!url) {
    console.error("[supabase] missing SUPABASE_URL");
    return null;
  }
  if (!sr && !anon) {
    console.error("[supabase] missing both SUPABASE_SERVICE_ROLE and SUPABASE_ANON_KEY");
    return null;
  }

  const key = sr || anon;
  const which = sr ? "SERVICE_ROLE" : "ANON_KEY";
  console.log(`[supabase] init using ${which} (url=${url}, key=${mask(key)})`);

  sb = createClient(url, key!, {
    auth: { persistSession: false },
    global: { fetch: withTimeoutFetch as any },
  });
  return sb;
}

function enabled() {
  return !!init();
}

// Keep the same cache key format so the rest of the app doesn't change
export function cacheKey(chain: string, address: string) {
  return `price:${String(chain).toLowerCase()}:${String(address).toLowerCase()}`;
}

function parseKey(key: string): { chain: string; address: string } | null {
  const parts = String(key).split(":");
  if (parts.length < 3) return null;
  const chain = parts[1]?.toLowerCase();
  const address = parts.slice(2).join(":").toLowerCase(); // allow ':' in future keys just in case
  if (!chain || !address) return null;
  return { chain, address };
}

// Upsert a single record into `prices`; optionally record history in `prices_history`.
export async function cacheSet(key: string, value: any, _ttlSeconds?: number) {
  if (!enabled()) return;
  const client = init()!;
  const parsed = parseKey(key);
  if (!parsed) return;

  // accept 0 and preserve validity; convert to number for Postgres numeric
  const raw = value?.priceUsd;
  const s = raw == null ? null : String(raw).trim();
  const priceNum = parseNumericLoose(s);
  if (s === null || priceNum === null) {
    return; // skip only when truly invalid/null
  }

  const row = {
    chain: parsed.chain,
    address: parsed.address,
    symbol: value?.symbol ?? null,
    // keep as string for exactness; Postgres numeric will parse this precisely
    price_usd: s,
    source: value?.source ?? null,
    at: value?.at ? new Date(value.at).toISOString() : new Date().toISOString(),
  };

  const t0 = Date.now();
  try {
    await pRetry(async () => {
      const { error } = await (client
        .from('prices') as any)
        .upsert([row], { onConflict: 'chain,address', returning: 'minimal' });
      if (error) throw new Error(error.message);
    }, { retries: 2, minTimeout: 400, maxTimeout: 1200 });
    console.log(`[supabase] upsert prices ok: 1 row in ${Date.now() - t0}ms`);
  } catch (e: any) {
    console.error(`[supabase] upsert prices error after ${Date.now() - t0}ms:`, e?.message || e);
  }
}

// Read a single latest record from `prices` by key
export async function cacheGet<T = any>(key: string): Promise<T | null> {
  if (!enabled()) return null;
  const client = init()!;
  const parsed = parseKey(key);
  if (!parsed) return null;

  try {
    const data = await pRetry(async () => {
      const { data, error } = await client
        .from("prices")
        .select("chain,address,symbol,price_usd,source,at")
        .eq("chain", parsed.chain)
        .eq("address", parsed.address)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data as any;
    }, { retries: 2, minTimeout: 400, maxTimeout: 1200 });

    if (!data) return null;
    const mapped: any = {
      chain: data.chain,
      address: data.address,
      symbol: data.symbol ?? undefined,
      priceUsd: data.price_usd === null ? null : parseNumericLoose(data.price_usd),
      source: data.source ?? null,
      at: data.at ?? new Date().toISOString(),
    };
    return mapped as T;
  } catch (e: any) {
    // reduce noise; treat as cache miss when transient network errors happen
    console.warn("[supabase/read retry exhausted]", e?.message || e);
    return null;
  }
}

async function readExisting(client: SupabaseClient, rows: Array<{chain: string; address: string}>) {
  // Group addresses by chain, then query in small chunks to avoid very long URLs/body
  const CHUNK = 200;
  const byChain = new Map<string, string[]>();
  for (const r of rows) {
    const c = String(r.chain).toLowerCase();
    const a = String(r.address).toLowerCase();
    const list = byChain.get(c) ?? [];
    list.push(a);
    byChain.set(c, list);
  }

  const map = new Map<string, { price_usd: number | null; at: string | null; source: string | null }>();

  for (const [chain, allAddrs] of byChain) {
    for (let i = 0; i < allAddrs.length; i += CHUNK) {
      const batch = allAddrs.slice(i, i + CHUNK);
      const { data, error } = await client
        .from("prices")
        .select("chain,address,price_usd,at,source")
        .eq("chain", chain)
        .in("address", batch);

      if (error) {
        console.warn("[supabase] readExisting chunk error:", error.message, `(chain=${chain}, size=${batch.length})`);
        continue; // proceed with remaining chunks
      }

      for (const r of (data || [])) {
        const k = `${String(r.chain).toLowerCase()}|${String(r.address).toLowerCase()}`;
        const num = parseNumericLoose(r.price_usd);
        map.set(k, {
          price_usd: num,
          at: r.at ?? null,
          source: r.source ?? null,
        });
      }
    }
  }

  return map;
}

// Bulk store — used by the fetch cycle to write many results efficiently
export async function storeResults(results: PriceResult[], opts: { force?: boolean } = {}) {
  if (!enabled() || !results?.length) return;
  const client = init()!;
  const force = !!opts.force;

  // Build upserts as numbers; keep UTC now for 'at'
  const nowIso = new Date().toISOString();
  const upserts = results
    .map(r => {
      const s = (r as any).priceUsd == null ? null : String((r as any).priceUsd).trim();
      if (s == null || s === '') return null;
      const n = parseNumericLoose(s);
      if (n == null) return null;
      return {
        chain: String(r.chain).toLowerCase(),
        address: String(r.address).toLowerCase(),
        symbol: r.symbol ?? null,
        // keep the original string for exact decimal precision (Postgres numeric will parse it)
        price_usd: s,
        source: r.source ?? null,
        at: nowIso,
      };
    })
    .filter(Boolean) as Array<{ chain: string; address: string; symbol: string | null; price_usd: string | null; source: string | null; at: string }>;

  if (upserts.length === 0) {
    console.log("[supabase] nothing to upsert (no valid numeric prices)");
    return;
  }

  // Read existing for diff (and for force logic if needed)
  const beforeMap = await readExisting(client, upserts.map(u => ({ chain: u.chain, address: u.address })));

  // Optional "force": we don't delete; we rely on upsert, but we will log everything as changed
  if (force) {
    console.log("[supabase] force mode: will upsert all rows regardless of equality");
  }

  const t0 = Date.now();
  console.log('[supabase] preparing batch upsert, rows:', upserts.length, 'sample:', upserts.slice(0, 2));
  try {
    await pRetry(async () => {
      const { error } = await (client
        .from("prices") as any)
        .upsert( upserts, { onConflict: "chain,address", returning: "minimal" });
      if (error) throw new Error(error.message);
    }, { retries: 1, minTimeout: 500, maxTimeout: 1200 });
  } catch (e: any) {
    console.error(`[supabase] batch upsert prices error after ${Date.now() - t0}ms:`, e?.message || e);
    return;
  }

  // Read after and compute diffs
  const afterMap = await readExisting(client, upserts.map(u => ({ chain: u.chain, address: u.address })));
  const changed: any[] = [];
  for (const u of upserts) {
    const k = `${u.chain}|${u.address}`;
    const b = beforeMap.get(k) || { price_usd: null, at: null, source: null };
    const a = afterMap.get(k) || { price_usd: null, at: null, source: null };
    const diffPrice = !eqApprox(b.price_usd, a.price_usd);
    const diff = force || diffPrice || (b.at !== a.at) || (b.source !== a.source);
    if (diff) {
      changed.push({
        chain: u.chain,
        address: u.address,
        before_price: b.price_usd,
        after_price: a.price_usd,
        before_at: b.at,
        after_at: a.at,
        before_source: b.source,
        after_source: a.source,
      });
    }
  }
  console.log(`[supabase] batch upsert prices ok: ${upserts.length} rows in ${Date.now() - t0}ms; changed=${changed.length}`, changed.slice(0, 5));
}

// ────────────────────────────────────────────────────────────────
// Batched cache read helper (non-breaking, opt-in)
// ────────────────────────────────────────────────────────────────
export type CacheRow = {
  chain: string;
  address: string;
  price_usd: string | number | null;
  source: string | null;
  at: string | null;
};

/**
 * Read many cache rows at once, grouped by chain and chunked to avoid very long requests.
 * This does not alter existing cacheGet/storeResults behavior; callers can opt-in for speed.
 */
export async function readCacheBatch(tokens: { chain: string; contract_address: string }[]) {
  const client = init();
  const out = new Map<string, CacheRow>();
  if (!client || !tokens?.length) return out;

  // Group addresses by chain
  const byChain = new Map<string, string[]>();
  for (const t of tokens) {
    const c = String(t.chain).toLowerCase();
    const a = String(t.contract_address).toLowerCase();
    const arr = byChain.get(c) ?? [];
    arr.push(a);
    byChain.set(c, arr);
  }

  // Query in small chunks per chain
  const CHUNK = 200;
  for (const [chain, addrs] of byChain) {
    for (let i = 0; i < addrs.length; i += CHUNK) {
      const part = addrs.slice(i, i + CHUNK);
      const { data, error } = await client
        .from("prices")
        .select("chain,address,price_usd,source,at")
        .eq("chain", chain)
        .in("address", part);
      if (error) {
        console.warn("[supabase] readCacheBatch chunk error:", error.message, `(chain=${chain}, size=${part.length})`);
        continue;
      }
      for (const r of (data ?? []) as any[]) {
        const k = `${String(r.chain).toLowerCase()}|${String(r.address).toLowerCase()}`;
        out.set(k, r as CacheRow);
      }
    }
  }

  return out;
}
// ────────────────────────────────────────────────────────────────
// Diagnostics: quick ping to detect Supabase connectivity/timeout
// ────────────────────────────────────────────────────────────────
export async function pingSupabase(timeoutMs = 5000): Promise<{ ok: boolean; ms: number; error?: string }> {
  const client = init();
  const t0 = Date.now();
  if (!client) return { ok: false, ms: 0, error: 'supabase not initialized' };
  try {
    const { error } = await client
      .from('prices')
      .select('address', { head: true, count: 'exact' })
      .limit(1);
    if (error) return { ok: false, ms: Date.now() - t0, error: error.message };
    return { ok: true, ms: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, ms: Date.now() - t0, error: e?.message || String(e) };
  }
}