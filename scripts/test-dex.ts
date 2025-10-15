// scripts/test-dex.ts
import { fetchDexscreenerPrice, fetchDexscreenerQuote, fetchDexscreenerBatchByTokens }
  from "../src/vendors/dexscreener.js";

async function main() {
  // ตัวอย่างจากที่คุณส่งมาก่อนหน้า
  const solMint = "FqvtZ2UFR9we82Ni4LeacC1zyTiQ77usDo31DUokpump"; // $SLOP (Solana)
  const ethAddr = "0xc8F69A9B46B235DE8d0b77c355FFf7994F1B090f";     // $SPEEDY (Ethereum)

  console.log("=== Single price ===");
  console.log("SOL SLOP:", await fetchDexscreenerPrice(solMint));
  console.log("ETH SPEEDY:", await fetchDexscreenerPrice(ethAddr));

  console.log("\n=== Quote (with metadata) ===");
  console.log("SLOP quote:", await fetchDexscreenerQuote(solMint));

  console.log("\n=== Batch (≤30 ต่อคำขอ) ===");
  const batch = await fetchDexscreenerBatchByTokens([
    solMint,
    ethAddr,
    // ใส่เพิ่มได้เรื่อย ๆ …
  ], { batchSize: 30, delayMs: 300 });
  console.log(batch);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});