import type { PriceResult, Chain } from "../shared/types.js";

/**
 * แปลงผลลัพธ์ราคาที่ได้จากแหล่งต่าง ๆ (Dexscreener, Gecko, CMC)
 * ให้อยู่ในรูปแบบเดียวกันทั้งหมด (รวม Price Change และ Market Cap)
 */
export function toPriceResult(
  chain: Chain,
  address: string,
  // แก้ไขจุดนี้: รับเป็นก้อนข้อมูลจาก Vendors
  data: {
    priceUsd: number | null;
    priceChangeH24: number | null;
    marketCap: number | null;
  },
  source: PriceResult["source"],
  symbol?: string
): PriceResult {
  return {
    chain,
    address: address.toLowerCase(),
    symbol,
    priceUsd: data.priceUsd,
    // เพิ่ม 2 ฟิลด์นี้เข้าไป เพื่อไม่ให้ข้อมูลที่ดึงมาสูญหาย
    priceChangeH24: data.priceChangeH24,
    marketCap: data.marketCap,
    source: data.priceUsd == null ? null : source,
    at: new Date().toISOString(),
  };
}
