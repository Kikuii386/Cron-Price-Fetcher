import axios from "axios";
import pRetry from "p-retry";
import { CFG } from "../config.js";

/**
 * Minimal types for Dexscreener API
 */
export type DexPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  priceUsd?: string | number | null;
  liquidity?: { usd?: number } | null;
  fdv?: number | null;
  marketCap?: number | null; // some chains return marketCap
  volume?: { h24?: number } | null;
  baseToken?: { address?: string; symbol?: string } | null;
  quoteToken?: { address?: string; symbol?: string } | null;
};

export type DexTokensResponse = {
  pairs?: DexPair[];
};

/**
 * Choose the most reliable pair: prioritize highest USD liquidity, then 24h volume, then has price.
 */
function pickBestPair(pairs: DexPair[] = []): DexPair | null {
  const candidates = pairs.filter((p) => p && p.priceUsd != null);
  if (!candidates.length) return null;
  return candidates
    .sort((a, b) => {
      const liqA = Number(a?.liquidity?.usd || 0);
      const liqB = Number(b?.liquidity?.usd || 0);
      if (liqB !== liqA) return liqB - liqA;
      const volA = Number(a?.volume?.h24 || 0);
      const volB = Number(b?.volume?.h24 || 0);
      if (volB !== volA) return volB - volA;
      // as a last resort, prefer those with marketCap/fdv present
      const capA = Number(a?.marketCap || a?.fdv || 0);
      const capB = Number(b?.marketCap || b?.fdv || 0);
      return capB - capA;
    })[0];
}

/**
 * Low-level: fetch raw pairs by token (contract address or Solana mint).
 */
export async function fetchDexscreenerPairsByToken(address: string): Promise<DexPair[]> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${address}`;
  const res = await axios.get<DexTokensResponse>(url, {
    timeout: CFG.api.timeoutMs,
    headers: { Accept: "application/json", "User-Agent": "cron-price-fetcher/1.0" },
    validateStatus: (s) => s >= 200 && s < 500,
  });
  return res.data?.pairs || [];
}

/**
 * High-level (used by cron): return price in USD or null.
 * Keeps signature compatible with existing code in core/fetchPrice.ts
 */
export async function fetchDexscreenerPrice(address: string): Promise<number | null> {
  return await pRetry(async () => {
    const pairs = await fetchDexscreenerPairsByToken(address);
    const best = pickBestPair(pairs);
    if (!best?.priceUsd) return null;
    const n = Number(best.priceUsd);
    return Number.isFinite(n) ? n : null;
  }, { retries: 2, factor: 2 });
}

/**
 * Helper for debugging/extra metadata consumers.
 */
export async function fetchDexscreenerQuote(address: string): Promise<{
  price: number | null;
  marketCap?: number | null;
  volume24h?: number | null;
  pairUrl?: string;
  dexId?: string;
  pairChainId?: string;
  liquidityUsd?: number | null;
}> {
  const pairs = await fetchDexscreenerPairsByToken(address);
  const best = pickBestPair(pairs);
  if (!best) {
    return { price: null };
  }
  const price = best.priceUsd != null ? Number(best.priceUsd) : null;
  return {
    price: Number.isFinite(Number(price)) ? Number(price) : null,
    marketCap: (best.marketCap ?? best.fdv) ?? null,
    volume24h: best.volume?.h24 ?? null,
    pairUrl: best.url,
    dexId: best.dexId,
    pairChainId: best.chainId,
    liquidityUsd: best.liquidity?.usd ?? null,
  };
}

/**
 * Batch fetch prices from Dexscreener with up to 30 addresses per request.
 * Returns a map of address (lowercased) -> priceUsd | null.
 *
 * Usage goal: reduce request count for large token sets (~1,500 addrs)
 * while keeping the same selection heuristic (liquidity -> vol -> fdv/mcap).
 */
export async function fetchDexscreenerBatchByTokens(
  addresses: string[],
  opts?: { batchSize?: number; delayMs?: number; timeoutMs?: number; retries?: number }
): Promise<Record<string, number | null>> {
  const batchSize = Math.max(1, Math.min(30, opts?.batchSize ?? 30));
  const delayMs = Math.max(0, opts?.delayMs ?? 300);
  const timeoutMs = opts?.timeoutMs ?? CFG.api.timeoutMs;
  const retries = opts?.retries ?? 2;

  // keep original for API calls; keep lowercase key for mapping/dedup
  const req = addresses
    .map((a) => ({ original: String(a || "").trim(), key: String(a || "").trim().toLowerCase() }))
    .filter((x) => !!x.original);
  const seen = new Set<string>();
  const uniq: { original: string; key: string }[] = [];
  for (const r of req) { if (!seen.has(r.key)) { seen.add(r.key); uniq.push(r); } }

  // prefill output
  const out: Record<string, number | null> = {};
  for (const r of uniq) out[r.key] = null;

  for (let i = 0; i < uniq.length; i += batchSize) {
    const chunk = uniq.slice(i, i + batchSize);
    const url = `https://api.dexscreener.com/latest/dex/tokens/${chunk.map(c => encodeURIComponent(c.original)).join(',')}`;

    const res = await pRetry(async () => {
      return axios.get(url, {
        timeout: timeoutMs,
        headers: { Accept: "application/json", "User-Agent": "cron-price-fetcher/1.0" },
        validateStatus: (s) => s >= 200 && s < 500,
      });
    }, { retries, factor: 2 });

    const pairs = (res.data?.pairs ?? []) as DexPair[];

    // group pairs back to requested addresses (match by base/quote token address)
    const setReq = new Set(chunk.map(c => c.key));
    const grouped: Record<string, DexPair[]> = {};
    for (const p of pairs) {
      const bKey = String(p.baseToken?.address || "").toLowerCase();
      const qKey = String(p.quoteToken?.address || "").toLowerCase();
      if (setReq.has(bKey)) (grouped[bKey] ||= []).push(p);
      if (setReq.has(qKey)) (grouped[qKey] ||= []).push(p);
    }

    // pick best pair and assign price (store under lowercase key)
    for (const c of chunk) {
      const best = grouped[c.key] ? pickBestPair(grouped[c.key]) : null;
      out[c.key] = best?.priceUsd != null ? Number(best.priceUsd) : null;
    }

    // Fallback: if batch returned empty pairs or we couldn't assign any price,
    // try per-address single endpoint to recover some results.
    if (!pairs.length || chunk.every(c => out[c.key] == null)) {
      for (const c of chunk) {
        try {
          const price = await pRetry(() => fetchDexscreenerPrice(c.original), { retries, factor: 2 });
          if (price != null) out[c.key] = price;
        } catch {}
      }
    }

    if (delayMs > 0 && i + batchSize < uniq.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return out;
}