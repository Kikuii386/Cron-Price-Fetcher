

import axios from "axios";
import { CFG } from "./config.js";
import type { PriceResult } from "./types.js";

// Check if cache is enabled
function enabled() {
  return !!(CFG.cache.redisUrl && CFG.cache.redisToken);
}

/**
 * Set a value in Upstash Redis cache
 * @param key Cache key
 * @param value Value to store (will be JSON.stringified)
 * @param ttl Time to live in seconds (default from config)
 */
export async function cacheSet(key: string, value: any, ttl = CFG.cache.ttlSeconds) {
  if (!enabled()) return;
  try {
    const url = `${CFG.cache.redisUrl}/SET/${encodeURIComponent(key)}/${encodeURIComponent(
      JSON.stringify(value)
    )}?EX=${ttl}`;
    await axios.get(url, {
      headers: { Authorization: `Bearer ${CFG.cache.redisToken}` },
      timeout: 5000,
      validateStatus: (s) => s >= 200 && s < 500,
    });
  } catch (e) {
    // ignore silently
  }
}

/**
 * Get a value from Upstash Redis cache
 * @param key Cache key
 * @returns Parsed value or null
 */
export async function cacheGet<T = any>(key: string): Promise<T | null> {
  if (!enabled()) return null;
  try {
    const url = `${CFG.cache.redisUrl}/GET/${encodeURIComponent(key)}`;
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${CFG.cache.redisToken}` },
      timeout: 5000,
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (res.data?.result) return JSON.parse(res.data.result);
  } catch {}
  return null;
}

/**
 * Build a cache key for a price result
 * @param chain Chain identifier
 * @param address Token address
 * @returns Cache key string
 */
export function cacheKey(chain: string, address: string) {
  return `price:${chain}:${address.toLowerCase()}`;
}

/**
 * Store an array of PriceResult objects in cache
 * @param results Array of PriceResult
 */
export async function storeResults(results: PriceResult[]) {
  if (!enabled()) return;
  await Promise.all(results.map((r) => cacheSet(cacheKey(r.chain, r.address), r)));
}