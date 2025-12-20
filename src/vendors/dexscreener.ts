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

// src/vendors/dexscreener.ts
export interface DexPriceData {
  // ต้องมีคำว่า export
  priceUsd: number | null;
  priceChangeH24: number | null;
  marketCap: number | null;
}

/**
 * Utilities for robust price selection without hardcoding quote symbols.
 * Strategy: take the median of top-N liquidity pools (defaults: N=3, minLiq=$50).
 */
function toNum(v: any, d: number | null = 0): number | null {
  const n = Number(v);
  return v !== null && v !== undefined && v !== "" && Number.isFinite(n)
    ? n
    : d;
}

function computeMedian(nums: number[]): number | null {
  if (!nums.length) return null;
  const a = nums.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

const TRUSTED_QUOTES = new Set([
  "USDC",
  "USDT",
  "DAI", // Stablecoins
  "WETH",
  "ETH", // Ethereum
  "SOL",
  "WSOL", // Solana
  "WBTC",
  "BTC", // Bitcoin
  "BUSD",
  "USDbC", // Others
]);

function topByLiquidity(pairs: DexPair[], minLiqUsd = 0): DexPair[] {
  const rows = (pairs || [])
    .filter((p) => p && p.priceUsd != null)
    .map((p) => ({
      ...p,
      _liq: toNum(p?.liquidity?.usd, 0) as number,
      _price: toNum(p?.priceUsd, NaN) as number,
      _quoteSym: p?.quoteToken?.symbol?.toUpperCase() || "",
    }))
    // เปลี่ยนจาก (p) เป็น (p: any)
    .filter((p: any) => Number.isFinite(p._price) && p._liq >= minLiqUsd)
    .sort((a: any, b: any) => {
      const aTrusted = TRUSTED_QUOTES.has(a._quoteSym);
      const bTrusted = TRUSTED_QUOTES.has(b._quoteSym);
      if (aTrusted && !bTrusted) return -1;
      if (!aTrusted && bTrusted) return 1;
      return b._liq - a._liq;
    });

  return rows as unknown as DexPair[];
}

/**
 * Choose the most reliable pair: prioritize highest USD liquidity, then 24h volume, then has price.
 */
/**
 * แก้ไขจาก pickBestPrice เดิม ให้คืนค่าข้อมูลครบชุด
 */

const MAX_SAFE_MCAP = 10_000_000_000_000; // 10 Trillion USD (เกินกว่านี้คือ Glitch)
const MAX_SAFE_PRICE = 100_000_000;
/**
 * เลือกราคาที่ดีที่สุด + กรองข้อมูลขยะ + หา Market Cap สำรอง
 */
function pickBestPriceData(
  pairs: DexPair[],
  opts?: { topN?: number; minLiqUsd?: number }
): DexPriceData {
  // 1. ตั้งค่า Liquidity ขั้นต่ำ (แนะนำ $50 เพื่อกัน Pool ผีที่สร้างมาหลอก)
  const minLiqUsd = Math.max(0, opts?.minLiqUsd ?? 0);

  // 2. ดึง Pair มาเรียงลำดับ (Liquidity สูงสุด + Trusted Quote ขึ้นก่อน)
  let rows = topByLiquidity(pairs, minLiqUsd);

  // 3. 🛡️ SANITY CHECK: กรอง Pair ที่ราคาหรือ MC เวอร์เกินจริง
  rows = rows.filter((p) => {
    const price = toNum(p.priceUsd, 0);
    const mcap = p.marketCap
      ? toNum(p.marketCap, 0)
      : p.fdv
      ? toNum(p.fdv, 0)
      : 0;

    // กฎ: ราคาสูงเกิน หรือ MC สูงระดับ Quadrillion ให้ดีดทิ้ง
    if (price && price > MAX_SAFE_PRICE) return false;
    if (mcap && mcap > MAX_SAFE_MCAP) return false;

    return true;
  });

  // ถ้ากรองแล้วไม่เหลืออะไรเลย ให้คืนค่าว่าง
  if (!rows.length)
    return { priceUsd: null, priceChangeH24: null, marketCap: null };

  const bestPair = rows[0] as any;

  // 4. 🔄 MC FALLBACK: วนหา Market Cap จาก Pair รอง (กรณี Pair แรกไม่มี)
  let foundMarketCap: number | null = null;
  for (const p of rows as any[]) {
    // เช็ค MarketCap ก่อน
    if (p.marketCap != null) {
      const val = Number(p.marketCap);
      if (val < MAX_SAFE_MCAP) {
        // เช็คซ้ำอีกทีเพื่อความชัวร์
        foundMarketCap = val;
        break;
      }
    }
    // ถ้าไม่มี ให้ดู FDV
    if (p.fdv != null) {
      const val = Number(p.fdv);
      if (val < MAX_SAFE_MCAP) {
        foundMarketCap = val;
        break;
      }
    }
  }

  // Debug Log (เปิดไว้ช่วยเช็คได้ครับ ถ้าเสถียรแล้วค่อยลบออก)
  // console.log(`[Dex] Best: ${bestPair.baseToken?.symbol} ($${bestPair.priceUsd}) | MC Found: ${foundMarketCap}`);

  return {
    priceUsd: toNum(bestPair.priceUsd, null),
    priceChangeH24:
      bestPair.priceChange?.h24 != null
        ? Number(bestPair.priceChange.h24)
        : null,
    marketCap: foundMarketCap,
  };
}

/**
 * Low-level: fetch raw pairs by token (contract address or Solana mint).
 */
export async function fetchDexscreenerPairsByToken(
  address: string
): Promise<DexPair[]> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(
    address
  )}?_t=${Date.now()}`;
  const res = await pRetry(
    () =>
      axios.get<DexTokensResponse>(url, {
        timeout: CFG.api.timeoutMs,
        headers: {
          Accept: "application/json",
          "User-Agent": "cron-price-fetcher/1.0",
          "Cache-Control": "no-cache, no-store, max-age=0",
          Pragma: "no-cache",
          "X-Request-Id": crypto.randomUUID?.() || String(Date.now()),
        },
        validateStatus: (s) => s >= 200 && s < 500,
      }),
    { retries: 2, factor: 2 }
  );
  return res.data?.pairs || [];
}

/**
 * High-level (used by cron): return price in USD or null.
 * Keeps signature compatible with existing code in core/fetchPrice.ts
 */
export async function fetchDexscreenerPrice(
  address: string
): Promise<DexPriceData> {
  return await pRetry(
    async () => {
      const pairs = await fetchDexscreenerPairsByToken(address);
      return pickBestPriceData(pairs); // เรียกใช้ฟังก์ชันที่เราแก้ใหม่
    },
    { retries: 2, factor: 2 }
  );
}

/**
 * Helper สำหรับดึงข้อมูล Metadata พร้อมราคา, Market Cap และ Price Change 24h
 */
export async function fetchDexscreenerQuote(address: string): Promise<{
  price: number | null;
  priceChangeH24?: number | null; // เพิ่มใหม่
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

  // 1. เรียกใช้ฟังก์ชันที่ปรับปรุงใหม่ (คืนค่าเป็น Object ครบชุด)
  const data = pickBestPriceData(pairs, { topN: 1, minLiqUsd: 10 });

  // 2. เลือก Pair ที่ดีที่สุดอันดับ 1 มาแกะข้อมูลดิบอื่นๆ
  const best = rows[0] as any;

  return {
    price: data.priceUsd, // ใช้ค่าจาก pickBestPriceData
    priceChangeH24: data.priceChangeH24, // ใช้ค่าจาก pickBestPriceData
    marketCap: data.marketCap, // ใช้ค่าจาก pickBestPriceData (ที่มี logic เลือก MC หรือ FDV)
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
  opts?: {
    batchSize?: number;
    delayMs?: number;
    timeoutMs?: number;
    retries?: number;
  }
): Promise<Record<string, DexPriceData | null>> {
  const batchSize = Math.max(1, Math.min(30, opts?.batchSize ?? 30));
  const delayMs = Math.max(0, opts?.delayMs ?? 300);
  const timeoutMs = opts?.timeoutMs ?? CFG.api.timeoutMs;
  const retries = opts?.retries ?? 2;

  // keep original for API calls; keep lowercase key for mapping/dedup
  const req = addresses
    .map((a) => ({
      original: String(a || "").trim(),
      key: String(a || "")
        .trim()
        .toLowerCase(),
    }))
    .filter((x) => !!x.original);
  const seen = new Set<string>();
  const uniq: { original: string; key: string }[] = [];
  for (const r of req) {
    if (!seen.has(r.key)) {
      seen.add(r.key);
      uniq.push(r);
    }
  }

  // prefill output
  const out: Record<string, DexPriceData | null> = {};
  for (const r of uniq) out[r.key] = null;

  for (let i = 0; i < uniq.length; i += batchSize) {
    const chunk = uniq.slice(i, i + batchSize);
    const url = `https://api.dexscreener.com/latest/dex/tokens/${chunk
      .map((c) => encodeURIComponent(c.original))
      .join(",")}?_t=${Date.now()}`;

    const res = await pRetry(
      async () => {
        return axios.get(url, {
          timeout: timeoutMs,
          headers: {
            Accept: "application/json",
            "User-Agent": "cron-price-fetcher/1.0",
            "Cache-Control": "no-cache, no-store, max-age=0",
            Pragma: "no-cache",
            "X-Request-Id": crypto.randomUUID?.() || String(Date.now()),
          },
          validateStatus: (s) => s >= 200 && s < 500,
        });
      },
      { retries, factor: 2 }
    );

    const pairs = (res.data?.pairs ?? []) as DexPair[];

    // group pairs back to requested addresses (match by base token address only)
    const setReq = new Set(chunk.map((c) => c.key));
    const grouped: Record<string, DexPair[]> = {};
    for (const p of pairs) {
      const bKey = String(p.baseToken?.address || "").toLowerCase();
      // Only group by BASE token to avoid mixing quote-token prices.
      if (setReq.has(bKey)) (grouped[bKey] ||= []).push(p);
    }

    for (const c of chunk) {
      const data = grouped[c.key]
        ? pickBestPriceData(grouped[c.key], { topN: 1, minLiqUsd: 0 })
        : { priceUsd: null, priceChangeH24: null, marketCap: null };
      out[c.key] = data;
    }

    if (!pairs.length || chunk.every((c) => out[c.key]?.priceUsd == null)) {
      for (const c of chunk) {
        try {
          const data = await pRetry(() => fetchDexscreenerPrice(c.original), {
            retries,
            factor: 2,
          });
          if (data && data.priceUsd != null) {
            out[c.key] = data;
          }
        } catch (err) {}
      }
    }
    // ...
  }
  return out;
}
