import axios from "axios";
import pRetry from "p-retry";
import { CFG } from "../config.js";
import crypto from "node:crypto";

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
 * Utilities for robust price selection without hardcoding quote symbols.
 * Strategy: take the median of top-N liquidity pools (defaults: N=3, minLiq=$50).
 */
function toNum(v: any, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function computeMedian(nums: number[]): number | null {
  if (!nums.length) return null;
  const a = nums.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

const TRUSTED_QUOTES = new Set([
  "USDC", "USDT", "DAI", // Stablecoins
  "WETH", "ETH",         // Ethereum
  "SOL", "WSOL",         // Solana
  "WBTC", "BTC",         // Bitcoin
  "BUSD", "USDbC"        // Others
]);

function topByLiquidity(pairs: DexPair[], minLiqUsd = 0): DexPair[] {
  const rows = (pairs || [])
    .filter(p => p && p.priceUsd != null)
    .map(p => ({
      ...p,
      _liq: toNum(p?.liquidity?.usd, 0),
      _price: toNum(p?.priceUsd, NaN),
      // ดึง Symbol ของ Quote Token มาเตรียมไว้เช็ค
      _quoteSym: p?.quoteToken?.symbol?.toUpperCase() || ""
    }))
    .filter(p => Number.isFinite(p._price) && p._liq >= minLiqUsd)
    .sort((a: any, b: any) => {
      // Logic ใหม่: เช็คว่าเป็น Trusted Quote หรือไม่?
      const aTrusted = TRUSTED_QUOTES.has(a._quoteSym);
      const bTrusted = TRUSTED_QUOTES.has(b._quoteSym);

      // ถ้าคนนึง Trusted แต่อีกคนไม่ ให้คน Trusted ชนะเสมอ
      if (aTrusted && !bTrusted) return -1;
      if (!aTrusted && bTrusted) return 1;

      // ถ้าสถานะเหมือนกัน (Trusted ทั้งคู่ หรือ ไม่ใช่ทั้งคู่) ให้วัดกันที่ Liquidity
      return b._liq - a._liq;
    });

  return rows as unknown as DexPair[];
}

/**
 * Choose the most reliable pair: prioritize highest USD liquidity, then 24h volume, then has price.
 */
function pickBestPrice(pairs: DexPair[], opts?: { topN?: number; minLiqUsd?: number }): number | null {
  // ใช้ topN = 1 เพื่อเอาตัวที่ Liquidity สูงสุดตัวเดียว (Winner Takes All)
  const topN = Math.max(1, Math.min(10, opts?.topN ?? 1));
  const minLiqUsd = Math.max(0, opts?.minLiqUsd ?? 0);
  
  let rows = topByLiquidity(pairs, minLiqUsd);
  if (!rows.length) return null;

  // กรองเฉพาะ Trusted Quote
  const trustedRows = rows.filter((r: any) => TRUSTED_QUOTES.has(r._quoteSym));
  
  if (trustedRows.length > 0) {
    // *** แก้ตรงนี้ ***
    // ใช้ (r as any)._price หรือ Number(r.priceUsd)
    return (trustedRows[0] as any)._price;
  }

  // กรณีไม่เจอ Trusted Quote เลย ให้ใช้ Logic เดิม (Median)
  const slice = rows.slice(0, topN);
  const prices = slice.map((r:any) => toNum(r.priceUsd, NaN)).filter(Number.isFinite);
  
  return computeMedian(prices);
}

/**
 * Low-level: fetch raw pairs by token (contract address or Solana mint).
 */
export async function fetchDexscreenerPairsByToken(address: string): Promise<DexPair[]> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}?_t=${Date.now()}`;
  const res = await pRetry(() => axios.get<DexTokensResponse>(url, {
    timeout: CFG.api.timeoutMs,
    headers: {
      Accept: "application/json",
      "User-Agent": "cron-price-fetcher/1.0",
      "Cache-Control": "no-cache, no-store, max-age=0",
      Pragma: "no-cache",
      "X-Request-Id": (crypto.randomUUID?.() || String(Date.now())),
    },
    validateStatus: (s) => s >= 200 && s < 500,
  }), { retries: 2, factor: 2 });
  return res.data?.pairs || [];
}

/**
 * High-level (used by cron): return price in USD or null.
 * Keeps signature compatible with existing code in core/fetchPrice.ts
 */
export async function fetchDexscreenerPrice(address: string): Promise<number | null> {
  return await pRetry(async () => {
    const pairs = await fetchDexscreenerPairsByToken(address);
    const price = pickBestPrice(pairs);
    return price != null && Number.isFinite(price) ? price : null;
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
  const rows = topByLiquidity(pairs, 50);
  if (!rows.length) return { price: null };
  const price = pickBestPrice(pairs, { topN: 1, minLiqUsd: 0 });
  const best = rows[0] as DexPair;
  return {
    price: price != null && Number.isFinite(price) ? price : null,
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
    const url = `https://api.dexscreener.com/latest/dex/tokens/${chunk.map(c => encodeURIComponent(c.original)).join(',')}?_t=${Date.now()}`;

    const res = await pRetry(async () => {
      return axios.get(url, {
        timeout: timeoutMs,
        headers: {
          Accept: "application/json",
          "User-Agent": "cron-price-fetcher/1.0",
          "Cache-Control": "no-cache, no-store, max-age=0",
          Pragma: "no-cache",
          "X-Request-Id": (crypto.randomUUID?.() || String(Date.now())),
        },
        validateStatus: (s) => s >= 200 && s < 500,
      });
    }, { retries, factor: 2 });

    const pairs = (res.data?.pairs ?? []) as DexPair[];

    // group pairs back to requested addresses (match by base token address only)
    const setReq = new Set(chunk.map(c => c.key));
    const grouped: Record<string, DexPair[]> = {};
    for (const p of pairs) {
      const bKey = String(p.baseToken?.address || "").toLowerCase();
      // Only group by BASE token to avoid mixing quote-token prices.
      if (setReq.has(bKey)) (grouped[bKey] ||= []).push(p);
    }

    // pick best pair and assign price (store under lowercase key)
    for (const c of chunk) {
      const price = grouped[c.key] ? pickBestPrice(grouped[c.key], { topN: 1, minLiqUsd: 0 }) : null;
      out[c.key] = price != null && Number.isFinite(price) ? price : null;
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