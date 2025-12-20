// scripts/test-pipeline.ts
import "dotenv/config";
import { fetchAllPrices } from "../src/core/fetchPrice.js";
import type { SheetTokenRow } from "../src/types.js";

async function testAllSources() {
  console.log("🚀 Testing Data Integrity from All Sources...");

  // จำลอง Token ที่มีข้อมูลครบในทุกแหล่ง (เช่น SOL)
  const testTokens: SheetTokenRow[] = [
    {
      chain: "sol", // หรือ chain ที่ Pat อยู่
      contract_address: "...", // ไม่สำคัญสำหรับ gecko test
      symbol: "PAT",
      coingecko_id: "pat", // ✅ สำคัญ: ต้องใส่ id ให้ถูก
      cmc_slug: "pat",
    },
  ];

  try {
    // รัน Pipeline จริง
    const results = await fetchAllPrices(testTokens, { bypassCache: true });

    console.log("\n--- TEST RESULTS ---");
    results.forEach((r) => {
      console.log(`📍 Token: ${r.symbol}`);
      console.log(`💰 Price: $${r.priceUsd ?? "N/A"}`);
      console.log(`📈 24h Change: ${r.priceChangeH24 ?? "N/A"}%`);
      console.log(`💎 Market Cap: $${r.marketCap?.toLocaleString() ?? "N/A"}`);
      console.log(`🔗 Source Used: ${r.source}`);

      // ตรวจสอบความถูกต้อง
      if (r.priceChangeH24 !== null && r.marketCap !== null) {
        console.log("✅ SUCCESS: Data is complete.");
      } else {
        console.log("⚠️ WARNING: Some fields are missing.");
      }
    });
  } catch (err) {
    console.error("❌ Test Error:", err);
  }
}

testAllSources();
