import type { PriceResult } from "../types.js";

/**
 * แปลงผลลัพธ์ราคาที่ได้จากแหล่งต่าง ๆ (Dexscreener, Gecko, CMC)
 * ให้อยู่ในรูปแบบเดียวกันทั้งหมด
 */
export function toPriceResult(
  chain: string,
  address: string,
  priceUsd: number | null,
  source: PriceResult["source"],
  symbol?: string
): PriceResult {
  return {
    chain,
    address: address.toLowerCase(),
    symbol,
    priceUsd: priceUsd ?? null,
    source: priceUsd == null ? null : source,
    at: new Date().toISOString(),
  };
}