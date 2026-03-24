import axios from "axios";
import pRetry from "p-retry";
import { CFG } from "../shared/config.js";
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
function toNum(v: any, d: number | null = null): number | null {
  const n = Number(v);
  return v !== null && v !== undefined && v !== "" && Number.isFinite(n)
    ? n
    : d;
}

const TRUSTED_QUOTES = new Set([
  "WETH",
  "ETH",
  "STETH",
  "CBETH",
  "WETH.E",
  "SOL",
  "WSOL",
  "MSOL",
  "JITOSOL",
  "WBNB",
  "BNB",
  "WMATIC",
  "MATIC",
  "WMATIC.E",
  "WAVAX",
  "AVAX",
  "WAVAX.E",
  "SUI",
  "WSUI",
  "WBTC",
  "BTC",
  "CBTC",
  "USDT",
  "USDT.E",
  "USDC",
  "USDC.E",
  "USDBC",
  "BUSD",
  "DAI",
  "FDUSD",
]);
const BLACKLIST_QUOTES = new Set(["KABOSU", "BITCOIN", "HARRYPOTTER", "OBAMA"]);

function topByLiquidity(pairs: DexPair[], minLiqUsd = 0): DexPair[] {
  const DEBUG_ADDR = "0x5950A5FB85eEbF62d86a332854D201db719942Ce".toLowerCase();
  const isTarget = pairs.some(
    (p) => p.baseToken?.address?.toLowerCase() === DEBUG_ADDR
  );

  const validPairs = (pairs || [])
    .map((p) => {
      const qSymbol = (p?.quoteToken?.symbol || "").toUpperCase().trim();
      const liq = toNum(p?.liquidity?.usd, 0) as number;
      // เช็คว่าเป็นเหรียญหลักที่น่าเชื่อถือหรือไม่
      const isTrusted = TRUSTED_QUOTES.has(qSymbol);

      return {
        ...p,
        _liq: liq,
        _price: toNum(p?.priceUsd, NaN) as number,
        _quoteSym: qSymbol,
        _isTrusted: isTrusted,
      };
    })
    .filter((p) => {
      // ⛔ 1. BLACKLIST CHECK: ถ้าเจอชื่อต้องห้าม ดีดทิ้งทันที ไม่สน Liquidity
      if (BLACKLIST_QUOTES.has(p._quoteSym)) {
        if (isTarget) console.log(`[FILTER] 🚫 Banned Quote: ${p._quoteSym}`);
        return false;
      }
      if (!Number.isFinite(p._price) || p._liq < minLiqUsd) return false;

      // 🛡️ 3. SPAM FILTER (ดัก Liquidity ปลอม):
      // ถ้าไม่ใช่ Trusted และ Liq สูงเวอร์ (> 10M) -> ทิ้ง
      if (!p._isTrusted && p._liq > 10_000_000) {
        if (isTarget) {
          console.log(
            `[FILTER] 🗑️ Suspicious Liq > 10M: ${p.baseToken?.symbol}/${p._quoteSym
            } ($${p._liq.toLocaleString()})`
          );
        }
        return false;
      }

      return true;
    });

  if (validPairs.length === 0) {
    if (isTarget)
      console.log(`[ETH6900] ❌ No valid pairs found after filter!`);
    return [];
  }

  // ✅ แก้ไขตรงนี้: เลิกระบบชนชั้น (ที่เอา Trusted ขึ้นก่อนเสมอ)
  // เปลี่ยนมาใช้ "ระบบแต้มต่อ" แทน (ถ้าเป็น Trusted ให้ถือว่า Liquidity เยอะกว่าปกติ 5 เท่าในการจัดอันดับ)
  validPairs.sort((a, b) => {
    const scoreA = a._liq * (a._isTrusted ? 5 : 1);
    const scoreB = b._liq * (b._isTrusted ? 5 : 1);
    return scoreB - scoreA; // เรียงจากคะแนนมากไปน้อย
  });

  // Log Winner
  if (isTarget) {
    const winner = validPairs[0] as any;
    console.log(
      `⭐⭐⭐ FINAL WINNER: ${winner.baseToken?.symbol}/${winner.quoteToken?.symbol} ` +
      `| Liq: $${Math.floor(winner.liquidity?.usd || 0).toLocaleString()} ` +
      `| Price: ${winner.priceUsd}`
    );
  }

  return validPairs as unknown as DexPair[];
}

function pickBestPriceData(
  pairs: DexPair[],
  opts?: { topN?: number; minLiqUsd?: number }
): DexPriceData {
  const minLiqUsd = Math.max(0, opts?.minLiqUsd ?? 0);
  const MAX_SAFE_MCAP = 1_000_000_000_000;
  const MAX_SAFE_PRICE = 100_000_000;
  let rows = topByLiquidity(pairs, minLiqUsd);
  rows = rows.filter((p) => {
    const price = toNum(p.priceUsd, null);
    const mcap = p.marketCap
      ? toNum(p.marketCap, null)
      : p.fdv
        ? toNum(p.fdv, null)
        : null;

    if (price && price > MAX_SAFE_PRICE) return false;
    if (mcap && mcap > MAX_SAFE_MCAP) return false;

    return true;
  });

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

  let foundChange =
    bestPair.priceChange?.h24 != null ? Number(bestPair.priceChange.h24) : null;

  if (foundChange === null) {
    for (const p of rows as any[]) {
      if (p.priceChange?.h24 != null) {
        foundChange = Number(p.priceChange.h24);
        break; // เจอแล้วหยุดเลย
      }
    }
  }
  // Debug Log (เปิดไว้ช่วยเช็คได้ครับ ถ้าเสถียรแล้วค่อยลบออก)
  // console.log(`[Dex] Best: ${bestPair.baseToken?.symbol} ($${bestPair.priceUsd}) | MC Found: ${foundMarketCap}`);
  if (foundMarketCap === 0) foundMarketCap = null;
  return {
    priceUsd: toNum(bestPair.priceUsd, null),
    priceChangeH24: foundChange,
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
      const qKey = String(p.quoteToken?.address || "").toLowerCase();

      if (setReq.has(bKey)) {
        (grouped[bKey] ||= []).push(p);
      } else if (setReq.has(qKey)) {
        (grouped[qKey] ||= []).push(p);
      }
    }

    for (const c of chunk) {
      const data = grouped[c.key]
        ? pickBestPriceData(grouped[c.key], { topN: 1, minLiqUsd: 0 })
        : { priceUsd: null, priceChangeH24: null, marketCap: null };
      out[c.key] = data;
    }

    for (const c of chunk) {
      if (out[c.key]?.priceUsd == null) {
        try {
          const data = await pRetry(() => fetchDexscreenerPrice(c.original), {
            retries,
            factor: 2,
          });
          if (data && data.priceUsd != null) {
            out[c.key] = data;
          }
        } catch (err: any) {
          console.warn(`[Dex Fallback] Failed for ${c.original}: ${err.message}`);
        }
      }
    }
  }
  return out;
}
