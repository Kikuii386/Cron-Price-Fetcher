import axios from "axios";
import pRetry from "p-retry";
import { CFG } from "../config.js";

const GECKO_BATCH = Math.max(1, Math.min(250, Number(process.env.GECKO_BATCH || 150)));
const GECKO_DELAY_MS = Math.max(0, Number(process.env.GECKO_DELAY_MS || 250));
const GECKO_MAX_RETRIES = Math.max(0, Number(process.env.GECKO_MAX_RETRIES || 3));

function geckoHeaders() {
  const apiKey = process.env.COINGECKO_API_KEY || "";
  const h: Record<string, string> = { Accept: "application/json", "User-Agent": "cron-price-fetcher/1.0" };
  if (apiKey) h["x-cg-api-key"] = apiKey; // supported on CG pro/free key
  return h;
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

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

const DEFAULT_TIMEOUT = () => CFG.api.timeoutMs || 8000;

/**
 * Fetch single price by CoinGecko id (slug) using public endpoint.
 */
export async function fetchCoingeckoPriceById(id: string): Promise<number | null> {
  if (!id) return null;
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`;
  const res = await pRetry(
    async () => {
      const r = await axios.get(url, {
        timeout: DEFAULT_TIMEOUT(),
        headers: geckoHeaders(),
        validateStatus: (s) => s >= 200 && s < 500,
      });
      if (r.status === 429) throw new Error("CG_429");
      return r;
    },
    {
      retries: GECKO_MAX_RETRIES,
      factor: 2,
      onFailedAttempt: async (err) => {
        const attempt = (err as any).attemptNumber || 1;
        const base = 1000 * Math.pow(2, attempt - 1);
        const jitter = Math.floor(Math.random() * 400);
        await sleep(base + jitter);
      },
    }
  ).catch(() => null);
  const v = (res as any)?.data?.[id?.toLowerCase?.() ?? id]?.usd;
  return v != null ? Number(v) : null;
}

/**
 * Batch fetch by CoinGecko ids (slugs). Returns map of id -> price|null.
 * Defaults (env-overridable): batchSize≈GECKO_BATCH (<=250), delay≈GECKO_DELAY_MS ms, retries≈GECKO_MAX_RETRIES
 */
export async function fetchCoingeckoBatchByIds(
  ids: string[],
  opts?: { batchSize?: number; delayMs?: number; timeoutMs?: number; retries?: number }
): Promise<Record<string, number | null>> {
  const batchSize = Math.max(1, Math.min(250, opts?.batchSize ?? GECKO_BATCH));
  const delayMs = Math.max(0, opts?.delayMs ?? GECKO_DELAY_MS);
  const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT();
  const retries = Math.max(0, opts?.retries ?? GECKO_MAX_RETRIES);

  const uniq = Array.from(new Set(ids.map((i) => String(i || "").toLowerCase()).filter(Boolean)));
  const out: Record<string, number | null> = {};
  for (const id of uniq) out[id] = null;

  for (const part of chunk(uniq, batchSize)) {
    const query = part.map((id) => encodeURIComponent(id)).join(",");
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${query}&vs_currencies=usd`;

    const res = await pRetry(
      async () => {
        const r = await axios.get(url, {
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
          // Exponential backoff with jitter; add extra wait if likely 429
          const base = 1500 * Math.pow(2, attempt - 1);
          const jitter = Math.floor(Math.random() * 600);
          await sleep(base + jitter);
        },
      }
    ).catch(() => null);

    const data = (res as any)?.data || {};
    for (const id of part) {
      const v = data?.[id]?.usd;
      if (v != null) out[id] = Number(v);
    }

    if (delayMs) await sleep(delayMs);
  }

  return out;
}

/**
 * COMPAT WRAPPER for existing core code:
 *   fetchCoingeckoPrice(chain, address, fallbackId?)
 * We ignore chain/address entirely and use ONLY the provided fallbackId (slug).
 */
export async function fetchCoingeckoPrice(_chain: string, _address: string, fallbackId?: string): Promise<number | null> {
  if (!fallbackId) return null;
  return fetchCoingeckoPriceById(fallbackId);
}