// scripts/test-fdv.ts
import { fetchCoingeckoBatchByIds } from "../src/vendors/coingecko.js";

async function run() {
  const targetId = "pat"; // ไอดีเหรียญที่มีปัญหา (MC=0, FDV=มีค่า)

  console.log(`🔍 Testing Fallback Logic for token: '${targetId}'...`);
  
  // เรียกฟังก์ชันที่เราเพิ่งแก้
  const result = await fetchCoingeckoBatchByIds([targetId]);
  
  const data = result[targetId];
  
  if (!data) {
    console.error("❌ Failed to fetch data (Null response)");
    return;
  }

  console.log("\n---------------------------------------------------");
  console.log(`💰 Price:      $${data.priceUsd}`);
  console.log(`📉 Change 24h: ${data.priceChangeH24}%`);
  console.log(`💎 Market Cap: $${data.marketCap?.toLocaleString()}  <-- ค่านี้ต้องไม่ใช่ 0`);
  console.log("---------------------------------------------------\n");

  if (data.marketCap && data.marketCap > 0) {
    console.log("✅ SUCCESS: Code successfully used FDV as fallback!");
  } else {
    console.log("❌ FAILED: Market Cap is still 0. Check logic again.");
  }
}

run();