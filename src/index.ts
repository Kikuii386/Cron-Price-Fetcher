// src/index.ts
import axios from "axios";
import { fetchAllPrices } from "./core/fetchPrice.js";
import { storeResults } from "./shared/storage.js";
import type { SheetTokenRow } from "./shared/types.js";
import { CFG } from "./shared/config.js";
import { server } from "./server.js";

const PORT = Number(process.env.PORT || 3000);

function normalizeToken(x: any): SheetTokenRow | null {
  const chain = String(x.chain || x.cmcChain || "")
    .trim()
    .toLowerCase();
  const address = String(x.contract || x.address || "")
    .trim()
    .toLowerCase();
  if (!chain || !address) return null;

  const symbol =
    (x.name ? String(x.name) : x.symbol ? String(x.symbol) : "").replace(
      /^\$/,
      ""
    ) || undefined;

  const cmc_id =
    x.cmcId === "" || x.cmcId == null || Number.isNaN(Number(x.cmcId))
      ? null
      : Number(x.cmcId);

  return {
    chain,
    contract_address: address,
    symbol,
    decimals: null,
    coingecko_id: x.geckoId ? String(x.geckoId).toLowerCase() : null, // ใช้ slug เท่านั้น
    cmc_id,
    cmc_slug: x.cmcSlug ? String(x.cmcSlug).toLowerCase() : null, // ใช้ slug เท่านั้น
  };
}

async function getTokensFromAppsScript(url: string): Promise<SheetTokenRow[]> {
  const r = await axios.get(url, {
    timeout: 15000,
    validateStatus: (s) => s >= 200 && s < 500,
  });
  const arr = Array.isArray(r.data) ? r.data : [];
  return arr.map(normalizeToken).filter(Boolean) as SheetTokenRow[];
}

async function runPriceSync() {
  try {
    const url = CFG.source?.appsScriptUrl || process.env.APPS_SCRIPT_URL;
    if (!url) {
      console.error("❌ Missing APPS_SCRIPT_URL");
      return;
    }

    console.log(
      `⏰ [${new Date().toLocaleTimeString()}] Starting Price Sync...`
    );
    const tokens = await getTokensFromAppsScript(url);
    if (!tokens.length) return;

    const prices = await fetchAllPrices(tokens, { bypassCache: true });
    await storeResults(prices);
    console.log(`✅ Sync Success: Updated ${prices.length} tokens.`);
  } catch (e: any) {
    console.error("❌ Sync Error:", e?.message || e);
  }
}
// --- Start Server ---
server.listen(PORT, () => {
  console.log(`🚀 API Gateway & Auth Server online at port ${PORT}`);
});

runPriceSync();

const ONE_MINUTE = 1 * 60 * 1000;
setInterval(runPriceSync, ONE_MINUTE);
