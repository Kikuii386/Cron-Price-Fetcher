import axios from "axios";
import pRetry from "p-retry";
import { CFG } from "../config.js";

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
  const res = await pRetry(() => axios.get(url, { timeout: DEFAULT_TIMEOUT() }), { retries: 2, factor: 2 }).catch(() => null);
  const v = (res as any)?.data?.[id?.toLowerCase?.() ?? id]?.usd;
  return v != null ? Number(v) : null;
}

/**
 * Batch fetch by CoinGecko ids (slugs). Returns map of id -> price|null.
 * Defaults: batchSize≈150, delay≈250ms between batches, retry=2.
 */
export async function fetchCoingeckoBatchByIds(
  ids: string[],
  opts?: { batchSize?: number; delayMs?: number; timeoutMs?: number; retries?: number }
): Promise<Record<string, number | null>> {
  const batchSize = Math.max(1, Math.min(250, opts?.batchSize ?? 150));
  const delayMs = Math.max(0, opts?.delayMs ?? 250);
  const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT();
  const retries = opts?.retries ?? 2;

  const uniq = Array.from(new Set(ids.map(i => String(i || "").toLowerCase()).filter(Boolean)));
  const out: Record<string, number | null> = {};
  for (const id of uniq) out[id] = null;

  for (const part of chunk(uniq, batchSize)) {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${part.join(",")}&vs_currencies=usd`;
    const res = await pRetry(() => axios.get(url, { timeout }), { retries, factor: 2 }).catch(() => null);
    const data = (res as any)?.data || {};
    for (const id of part) {
      const v = data?.[id]?.usd;
      out[id] = v != null ? Number(v) : out[id];
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