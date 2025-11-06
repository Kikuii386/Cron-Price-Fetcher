// src/storage.ts — Supabase-backed storage (replacing Upstash/Redis)
import pkg from "@supabase/supabase-js";
const { createClient } = pkg;
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PriceResult } from "./types.js";
import pRetry from "p-retry";

const SB_FETCH_TIMEOUT_MS = Number(process.env.SB_FETCH_TIMEOUT_MS || 15000);

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

  const row = {
    chain: parsed.chain,
    address: parsed.address,
    symbol: value?.symbol ?? null,
    price_usd: value?.priceUsd ?? null,
    source: value?.source ?? null,
    at: value?.at ? new Date(value.at).toISOString() : new Date().toISOString(),
  };

  // upsert latest
  const { error: upErr } = await client.from("prices").upsert(row, { onConflict: "chain,address" });
  if (upErr) {
    console.error("[supabase] upsert prices error:", upErr.message);
  }
  else console.log("[supabase] upsert prices ok: 1 row");

  // History insertion disabled — we only keep latest snapshot in `prices` now
  // if (row.price_usd !== null && row.price_usd !== undefined) {
  //   const { error: histErr } = await client.from("prices_history").insert(row);
  //   if (histErr) {
  //     console.error("[supabase] insert history error:", histErr.message);
  //   }
  // }
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
      priceUsd: data.price_usd === null ? null : Number(data.price_usd),
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

// Bulk store — used by the fetch cycle to write many results efficiently
export async function storeResults(results: PriceResult[]) {
  if (!enabled() || !results?.length) return;
  const client = init()!;

  // ✅ เขียนเฉพาะแถวที่มีราคาจริง
  const upserts = results
    .filter(r => r.priceUsd != null && Number.isFinite(r.priceUsd as number))
    .map(r => ({
      chain: String(r.chain).toLowerCase(),
      address: String(r.address).toLowerCase(),
      symbol: r.symbol ?? null,
      price_usd: r.priceUsd as number,
      source: r.source ?? null,
      at: new Date().toISOString(),
    }));

  if (upserts.length === 0) {
    console.log("[supabase] nothing to upsert (no real prices this round)");
    return;
  }

  // upsert เฉพาะแถวที่มีราคาจริง
  const { error: upErr } = await client.from("prices").upsert(upserts, { onConflict: "chain,address" });
  if (upErr) console.error("[supabase] batch upsert prices error:", upErr.message);
  else console.log(`[supabase] batch upsert prices ok: ${upserts.length} rows`);
}