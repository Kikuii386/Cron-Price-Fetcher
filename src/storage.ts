// src/storage.ts — Supabase-backed storage (replacing Upstash/Redis)
import pkg from "@supabase/supabase-js";
const { createClient } = pkg;
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PriceResult } from "./types.js";

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

function init() {
  if (sb) return sb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  sb = createClient(url, key, { auth: { persistSession: false } });
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

  // append history only when we have a numeric price
  if (row.price_usd !== null && row.price_usd !== undefined) {
    const { error: histErr } = await client.from("prices_history").insert(row);
    if (histErr) {
      // don't throw — history is best-effort
      console.error("[supabase] insert history error:", histErr.message);
    }
  }
}

// Read a single latest record from `prices` by key
export async function cacheGet<T = any>(key: string): Promise<T | null> {
  if (!enabled()) return null;
  const client = init()!;
  const parsed = parseKey(key);
  if (!parsed) return null;

  const { data, error } = await client
    .from("prices")
    .select("chain,address,symbol,price_usd,source,at")
    .eq("chain", parsed.chain)
    .eq("address", parsed.address)
    .maybeSingle();

  if (error) {
    console.error("[supabase] select prices error:", error.message);
    return null;
  }
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
}

// Bulk store — used by the fetch cycle to write many results efficiently
export async function storeResults(results: PriceResult[]) {
  if (!enabled() || !results?.length) return;
  const client = init()!;

  const upserts = results.map((r) => ({
    chain: String(r.chain).toLowerCase(),
    address: String(r.address).toLowerCase(),
    symbol: r.symbol ?? null,
    price_usd: r.priceUsd ?? null,
    source: r.source ?? null,
    at: r.at ? new Date(r.at).toISOString() : new Date().toISOString(),
  }));

  // upsert latest batch
  const { error: upErr } = await client.from("prices").upsert(upserts, { onConflict: "chain,address" });
  if (upErr) console.error("[supabase] batch upsert prices error:", upErr.message);

  // insert history for rows that have price
  const history = upserts.filter((r) => r.price_usd !== null && r.price_usd !== undefined);
  if (history.length) {
    const { error: histErr } = await client.from("prices_history").insert(history);
    if (histErr) console.error("[supabase] batch insert history error:", histErr.message);
  }
}