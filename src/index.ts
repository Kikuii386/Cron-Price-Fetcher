// src/index.ts
import axios from "axios";
import { fetchAllPrices } from "./core/fetchPrice.js";
import { storeResults } from "./storage.js";
import type { SheetTokenRow } from "./types.js";
import { CFG } from "./config.js";

function normalizeToken(x: any): SheetTokenRow | null {
  const chain = String(x.chain || x.cmcChain || "").trim().toLowerCase();
  const address = String(x.contract || x.address || "").trim().toLowerCase();
  if (!chain || !address) return null;

  // สัญลักษณ์ ตัด $ ออก
  const symbol =
    (x.name ? String(x.name) : (x.symbol ? String(x.symbol) : "")).replace(/^\$/, "") || undefined;

  // cmcId ใน Apps Script ถูก parse เป็นเลขแล้ว ถ้าไม่มีจะเป็น "" → แปลงเป็น null
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
    cmc_slug: x.cmcSlug ? String(x.cmcSlug).toLowerCase() : null,     // ใช้ slug เท่านั้น
  };
}

async function getTokensFromAppsScript(url: string): Promise<SheetTokenRow[]> {
  const r = await axios.get(url, { timeout: 15000, validateStatus: s => s >= 200 && s < 500 });
  const arr = Array.isArray(r.data) ? r.data : [];
  return arr.map(normalizeToken).filter(Boolean) as SheetTokenRow[];
}

async function runOnce() {
  const url = CFG.source?.appsScriptUrl || process.env.APPS_SCRIPT_URL;
  if (!url) throw new Error("Missing APPS_SCRIPT_URL in .env");

  const tokens = await getTokensFromAppsScript(url);
  if (!tokens.length) {
    console.log("No tokens from Apps Script");
    return;
  }

  // ไปหาราคาตามลำดับ (ตอนนี้ยังใช้ flow เดิมใน core; เดี๋ยวเราจะค่อยปรับเป็น batch hybrid)
  const prices = await fetchAllPrices(tokens);
  await storeResults(prices);

  console.table(
    prices.map(p => ({
      chain: p.chain,
      address: p.address,
      priceUsd: p.priceUsd,
      source: p.source,
    }))
  );
}

runOnce().catch((e) => {
  console.error(e);
  process.exit(1);
});