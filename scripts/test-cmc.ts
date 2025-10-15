// scripts/test-cmc-vendor.ts
import { fetchCmcPriceBySlug, fetchCmcBatchBySlugs } from "../src/vendors/cmc.js";

(async () => {
  console.log("single:", await fetchCmcPriceBySlug("bitcoin"));
  console.log("batch:", await fetchCmcBatchBySlugs(["bitcoin","ethereum","solana"], { concurrency: 4 }));
})();