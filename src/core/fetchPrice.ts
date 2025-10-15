

import type { SheetTokenRow, PriceResult } from "../types.js";
import { toPriceResult } from "./normalize.js";
import { cacheGet, cacheKey } from "../storage.js";
import { fetchDexscreenerBatchByTokens, fetchDexscreenerPrice } from "../vendors/dexscreener.js";
import { fetchCoingeckoBatchByIds, fetchCoingeckoPrice } from "../vendors/coingecko.js";
import { fetchCmcBatchBySlugs, fetchCmcPriceBySlug } from "../vendors/cmc.js";

// Utility
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch price for a single token using the agreed priority:
 *   Dexscreener → CoinGecko (slug) → CMC (slug)
 * This is used rarely (debug/compat). For bulk, use fetchAllPrices().
 */
export async function fetchPriceForToken(t: SheetTokenRow): Promise<PriceResult> {
  const { chain, contract_address, symbol, coingecko_id, cmc_slug } = t;

  // cache first
  const cached = await cacheGet<PriceResult>(cacheKey(chain, contract_address));
  if (cached) return cached;

  // 1) Dexscreener (single)
  const p1 = await fetchDexscreenerPrice(contract_address).catch(() => null);
  if (p1 != null) return toPriceResult(chain, contract_address, p1, "dexscreener", symbol);

  // 2) CoinGecko by id (slug only)
  if (coingecko_id) {
    const p2 = await fetchCoingeckoPrice("", "", coingecko_id).catch(() => null);
    if (p2 != null) return toPriceResult(chain, contract_address, p2, "coingecko", symbol);
  }

  // 3) CMC by slug (scrape)
  if (cmc_slug) {
    const p3 = await fetchCmcPriceBySlug(cmc_slug).catch(() => null);
    if (p3 != null) return toPriceResult(chain, contract_address, p3, "cmc", symbol);
  }

  return toPriceResult(chain, contract_address, null, null, symbol);
}

/**
 * Hybrid batch pipeline for ~1,500 tokens every 5 minutes.
 * Order: Dexscreener batch → CoinGecko batch (slug) → CMC batch (slug).
 * - Preserves input order in the returned array.
 * - Reads cache first; writing to cache is handled by storeResults() outside.
 */
export async function fetchAllPrices(tokens: SheetTokenRow[]): Promise<PriceResult[]> {
  // Prepare structures
  const results: PriceResult[] = new Array(tokens.length);
  const needFetchIdx: number[] = [];

  // 0) Try cache first to reduce calls within short TTL windows
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const c = await cacheGet<PriceResult>(cacheKey(t.chain, t.contract_address));
    if (c) {
      results[i] = c; // already normalized
    } else {
      needFetchIdx.push(i);
    }
  }
  if (!needFetchIdx.length) return results; // all from cache

  // A helper to apply a map back to pending indices
  const applyMap = (
    map: Record<string, number | null>,
    source: PriceResult["source"],
    markSet = new Set<string>()
  ) => {
    for (const i of needFetchIdx) {
      if (results[i]) continue; // already filled
      const t = tokens[i];
      const key = t.contract_address.toLowerCase();
      if (key in map && map[key] != null) {
        results[i] = toPriceResult(t.chain, t.contract_address, map[key]!, source, t.symbol);
        markSet.add(key);
      }
    }
    return markSet;
  };

  // 1) Dexscreener batch (≤30 per request)
  {
    const addresses = needFetchIdx.map((i) => tokens[i].contract_address);
    const dexMap = await fetchDexscreenerBatchByTokens(addresses, {
      batchSize: 30,
      delayMs: 300,
      timeoutMs: 8000,
      retries: 2,
    }).catch(() => ({} as Record<string, number | null>));
    applyMap(dexMap, "dexscreener");
  }

  // 2) CoinGecko batch (slug ids only) for the rest
  {
    const ids: string[] = [];
    const idxForId: number[] = [];
    for (const i of needFetchIdx) {
      if (results[i]) continue;
      const id = tokens[i].coingecko_id?.toLowerCase();
      if (id) {
        ids.push(id);
        idxForId.push(i);
      }
    }
    if (ids.length) {
      const geckoMap = await fetchCoingeckoBatchByIds(ids, {
        batchSize: 150,
        delayMs: 250,
        timeoutMs: 8000,
        retries: 2,
      }).catch(() => ({} as Record<string, number | null>));
      for (const i of idxForId) {
        if (results[i]) continue;
        const id = tokens[i].coingecko_id!.toLowerCase();
        const v = geckoMap[id];
        if (v != null) {
          const t = tokens[i];
          results[i] = toPriceResult(t.chain, t.contract_address, v, "coingecko", t.symbol);
        }
      }
    }
  }

  // 3) CMC batch (slug) for the remaining ones
  {
    const slugs: string[] = [];
    const idxForSlug: number[] = [];
    for (const i of needFetchIdx) {
      if (results[i]) continue;
      const slug = tokens[i].cmc_slug?.toLowerCase();
      if (slug) {
        slugs.push(slug);
        idxForSlug.push(i);
      }
    }
    if (slugs.length) {
      const cmcMap = await fetchCmcBatchBySlugs(slugs, {
        concurrency: 4,
        delayMs: 0,
        retries: 2,
      }).catch(() => ({} as Record<string, number | null>));
      for (const i of idxForSlug) {
        if (results[i]) continue;
        const slug = tokens[i].cmc_slug!.toLowerCase();
        const v = cmcMap[slug];
        if (v != null) {
          const t = tokens[i];
          results[i] = toPriceResult(t.chain, t.contract_address, v, "cmc", t.symbol);
        }
      }
    }
  }

  // 4) Fill any remaining as null (explicitly) to keep array fully populated
  for (const i of needFetchIdx) {
    if (!results[i]) {
      const t = tokens[i];
      results[i] = toPriceResult(t.chain, t.contract_address, null, null, t.symbol);
    }
  }

  return results;
}