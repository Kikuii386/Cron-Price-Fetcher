import axios from "axios";
import pRetry from "p-retry";
import crypto from "node:crypto";
import { CFG } from "../config.js";

const GECKO_BATCH = Math.max(
  1,
  Math.min(250, Number(process.env.GECKO_BATCH || 250))
);
const GECKO_DELAY_MS = Math.max(0, Number(process.env.GECKO_DELAY_MS || 250));
const GECKO_MAX_RETRIES = Math.max(
  0,
  Number(process.env.GECKO_MAX_RETRIES || 3)
);

function geckoHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    "User-Agent": "cron-price-fetcher/1.0",
    "Cache-Control": "no-cache, no-store, max-age=0",
    Pragma: "no-cache",
    "X-Request-Id": crypto.randomUUID?.() || String(Date.now()),
  };
}

export interface GeckoPriceData {
  priceUsd: number | null;
  priceChangeH24: number | null;
  marketCap: number | null;
}

/**
 * CoinGecko (PUBLIC) – use ONLY ids (aka slugs), no contract/platform lookups.
 * This matches the user's original test style: `geckoId` only.
 */

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function toNum(x: any): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string") {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const DEFAULT_TIMEOUT = () => CFG.api.timeoutMs || 8000;

/**
 * Fetch single price by CoinGecko id (slug) using public endpoint.
 */
export async function fetchCoingeckoPriceById(
  id: string
): Promise<GeckoPriceData> {
  if (!id) return { priceUsd: null, priceChangeH24: null, marketCap: null };

  // เรียกใช้ Batch ฟังก์ชันเพื่อใช้ Logic เดียวกัน ไม่ต้องเขียนซ้ำ
  const map = await fetchCoingeckoBatchByIds([id], {
    delayMs: 0, // ตัวเดียวไม่ต้องรอ
    retries: GECKO_MAX_RETRIES,
  });

  const key = id.toLowerCase();
  return map[key] || { priceUsd: null, priceChangeH24: null, marketCap: null };
}

/**
 * Batch fetch by CoinGecko ids (slugs). Returns map of id -> price|null.
 * Defaults (env-overridable): batchSize≈GECKO_BATCH (<=250), delay≈GECKO_DELAY_MS ms, retries≈GECKO_MAX_RETRIES
 */
export async function fetchCoingeckoBatchByIds(
  ids: string[],
  opts?: {
    batchSize?: number;
    delayMs?: number;
    timeoutMs?: number;
    retries?: number;
  }
): Promise<Record<string, GeckoPriceData | null>> {
  const batchSize = Math.max(1, Math.min(250, opts?.batchSize ?? GECKO_BATCH));
  const delayMs = Math.max(0, opts?.delayMs ?? GECKO_DELAY_MS);
  const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT();
  const retries = Math.max(0, opts?.retries ?? GECKO_MAX_RETRIES);

  const uniq = Array.from(
    new Set(ids.map((i) => String(i || "").toLowerCase()).filter(Boolean))
  );
  const out: Record<string, GeckoPriceData | null> = {};
  for (const id of uniq) out[id] = null;

  // วนลูปทีละ Chunk
  for (let i = 0; i < uniq.length; i += batchSize) {
    const part = uniq.slice(i, i + batchSize);

    // ถ้าไม่ใช่รอบแรก ให้พักก่อนยิง (Rate Limit Protection)
    if (i > 0 && delayMs > 0) await sleep(delayMs);

    const query = part.join(","); // coins/markets ใช้ comma separated ได้เลย

    // ✅ เปลี่ยนมาใช้ /coins/markets
    const url = `https://api.coingecko.com/api/v3/coins/markets`;

    const res = await pRetry(
      async () => {
        const r = await axios.get(url, {
          params: {
            vs_currency: "usd",
            ids: query,
            order: "market_cap_desc",
            per_page: 250,
            page: 1,
            sparkline: false,
            locale: "en",
          },
          timeout: timeout,
          headers: geckoHeaders(),
          validateStatus: (s) => s >= 200 && s < 500,
        });
        if (r.status === 429) throw new Error("CG_429");
        return r;
      },
      {
        retries,
        factor: 2,
        onFailedAttempt: async (err) => {
          const attempt = (err as any).attemptNumber || 1;
          const base = 1500 * Math.pow(2, attempt - 1);
          const jitter = Math.floor(Math.random() * 600);
          await sleep(base + jitter);
        },
      }
    ).catch((err) => {
      console.error("[gecko/batch] Request failed:", err.message);
      return null;
    });

    const status = (res as any)?.status ?? "no-response";
    console.log("[gecko/batch] chunk ids=%d status=%s", part.length, status);

    // ✅ การแกะข้อมูลจาก Array (Response ของ markets เป็น Array [{}, {}])
    if (res && Array.isArray(res.data)) {
      for (const item of res.data) {
        if (!item || !item.id) continue;
        const pid = item.id.toLowerCase();

        if (pid === "russell" || pid === "ชื่อไอดีเหรียญที่คุณเทส") {
          console.log(`[DEBUG GECKO] ${pid}:`, {
            market_cap: item.market_cap,
            fdv: item.fully_diluted_valuation,
            total_supply: item.total_supply,
            max_supply: item.max_supply,
          });
        }

        // --- 🔥 LOGIC FALLBACK อยู่ตรงนี้ 🔥 ---
        let mcap = toNum(item.market_cap);

        // ถ้า Market Cap เป็น 0 หรือ null ให้ลองไปเอา FDV มาแทน
        if (!mcap || mcap === 0) {
          mcap = toNum(item.fully_diluted_valuation);
        }
        // --------------------------------------

        out[pid] = {
          priceUsd: toNum(item.current_price),
          priceChangeH24: toNum(item.price_change_percentage_24h),
          marketCap: mcap,
        };
      }
    }
  }

  return out;
}

/**
 * COMPAT WRAPPER for existing core code:
 *   fetchCoingeckoPrice(chain, address, fallbackId?)
 * We ignore chain/address entirely and use ONLY the provided fallbackId (slug).
 */
export async function fetchCoingeckoPrice(
  _chain: string,
  _address: string,
  fallbackId?: string
): Promise<GeckoPriceData> {
  if (!fallbackId)
    return { priceUsd: null, priceChangeH24: null, marketCap: null };
  return fetchCoingeckoPriceById(fallbackId);
}
