// README.md
// ---
// Cron Price Fetcher – Dexscreener → CoinGecko → CoinMarketCap (TypeScript)
//
// โครงการนี้เป็นสคริปต์ cronjob สำหรับดึงราคาคริปโตตามรายการเหรียญจาก Google Sheets
// โดยเรียก API ตามลำดับ fallback: Dexscreener → CoinGecko → CMC
// รองรับ:
// - อ่านรายการเหรียญจาก Google Sheets (Service Account)
// - ดึงราคาพร้อม timeout + retry + backoff
// - รวมผลและ normalize ให้ได้ราคาเป็น USD พร้อม timestamp
// - เก็บ cache ชั่วคราว (Upstash Redis — ไม่บังคับ)
// - ตั้งเวลา cron ได้ทั้งแบบรันในเครื่อง/เซิร์ฟเวอร์ หรือผ่าน GitHub Actions/Vercel Cron
//
// โครงสร้างไฟล์
// .
// ├─ src/
// │  ├─ core/
// │  │  ├─ fetchPrice.ts        // ลำดับ fallback + รวมผล
// │  │  └─ normalize.ts         // มาตรฐานผลลัพธ์
// │  ├─ vendors/
// │  │  ├─ dexscreener.ts
// │  │  ├─ coingecko.ts
// │  │  └─ cmc.ts
// │  ├─ sources/
// │  │  ├─ sheets.ts            // อ่าน Google Sheets (service account)
// │  │  └─ appsScript.ts        // อ่าน JSON จาก Apps Script Web App (URL)
// │  ├─ storage.ts              // (ตัวเลือก) cache ที่ Upstash Redis
// │  ├─ config.ts
// │  ├─ index.ts                // จุดรัน cron
// │  └─ types.ts
// ├─ package.json
// ├─ tsconfig.json
// ├─ .env.example
// └─ README.md (ไฟล์นี้)
//
// ตัวอย่าง Google Sheet (แนะนำคอลัมน์):
// | chain | contract_address                    | symbol | decimals | coingecko_id | cmc_id |
// |------|-------------------------------------|--------|----------|--------------|--------|
// | bsc  | 0x...                               | PEPE   | 18       | pepe         | 24478  |
// | eth  | 0x...                               | SHIB   | 18       | shiba-inu    | 5994   |
//
// สิ่งที่ต้องเตรียม
// 1) Service Account JSON จาก Google Cloud (เพิ่มอีเมลของ service account ไปที่ Google Sheet ให้สิทธิ์อ่าน)
// 2) API key:
//    - CoinGecko (v3/v3 pro ตามแพลน)
//    - CoinMarketCap (Pro API)
// 3) (ตัวเลือก) Upstash Redis URL และ TOKEN ถ้าต้องการ cache
//
// วิธีใช้งานโดยย่อ
// - คัดลอกไฟล์ .env.example → .env แล้วใส่ค่าให้ครบ
// - pnpm i (หรือ npm/yarn ก็ได้)
// - pnpm build
// - pnpm start (รันครั้งเดียว)
// - หรือ pnpm cron (รันแบบหน่วงเวลาตาม CRON_SCHEDULE)
//
// การดีพลอย
// - ใช้ pm2/systemd บน VPS ก็ได้
// - หรือใช้ GitHub Actions + cron schedule เรียก `pnpm start`
// - หรือสร้าง HTTP endpoint (เช่น Cloud Run/Functions) แล้วเรียกด้วย Cloud Scheduler/Vercel Cron


// package.json
// ---
{
  "name": "cron-price-fetcher",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "build": "tsc -p .",
    "start": "node dist/index.js",
    "cron": "node dist/index.js",
    "dev": "tsx watch src/index.ts"
  },
  "dependencies": {
    "axios": "^1.7.0",
    "googleapis": "^129.0.0",
    "p-retry": "^6.0.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.2"
  }
}


// tsconfig.json
// ---
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "resolveJsonModule": true
  },
  "include": ["src"]
}


// .env.example
// ---
// # เลือกแหล่งข้อมูล: "sheets" หรือ "apps_script"
// DATA_SOURCE=apps_script
//
// # ถ้าใช้ Google Sheets
// GOOGLE_SHEETS_SPREADSHEET_ID=your_sheet_id
// GOOGLE_SHEETS_RANGE=A2:F
// GOOGLE_APPLICATION_CREDENTIALS_JSON={"type":"service_account",...}
//
// # ถ้าใช้ Apps Script (Web App JSON URL)
// APPS_SCRIPT_URL=https://script.google.com/macros/s/xxxxxxxx/exec
//
// COINGECKO_API_KEY=xxxxx
// CMC_API_KEY=xxxxx
//
// REDIS_URL= # optional (Upstash: https://xxxxx.upstash.io)
// REDIS_TOKEN= # optional
//
// CRON_SCHEDULE=*/5 * * * *   # ทุก 5 นาที (ใช้เมื่อรันผ่าน node-cron/pm2)


// src/types.ts
// ---
export type Chain = "eth" | "bsc" | "polygon" | "base" | "solana" | "sol" | string;

export interface SheetTokenRow {
  chain: Chain;                   // ตัวอย่าง: "eth", "bsc", "polygon", "base", "sol"/"solana"
  contract_address: string;       // contract หรือ mint address (บน Solana ให้ใช้ mint)
  symbol?: string;
  decimals?: number | null;
  coingecko_id?: string | null;   // ตัวอย่าง "pepe"
  cmc_id?: number | null;         // ตัวอย่าง 33596
  cmc_slug?: string | null;       // ตัวอย่าง "pepe"
}

export interface PriceResult {
  chain: Chain;
  address: string;
  symbol?: string;
  priceUsd: number | null; // null ถ้าดึงไม่ได้
  source: "dexscreener" | "coingecko" | "cmc" | null;
  at: string; // ISO timestamp
}


// src/config.ts
// ---
import dotenv from "dotenv";
dotenv.config();

export const CFG = {
  dataSource: process.env.DATA_SOURCE || "apps_script", // "sheets" | "apps_script"
  sheet: {
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID!,
    range: process.env.GOOGLE_SHEETS_RANGE || "A2:F",
    saJson: process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
  },
  appsScript: {
    url: process.env.APPS_SCRIPT_URL,
  },
  api: {
    coingeckoKey: process.env.COINGECKO_API_KEY,
    cmcKey: process.env.CMC_API_KEY,
    timeoutMs: 8000,
  },
  cache: {
    redisUrl: process.env.REDIS_URL,
    redisToken: process.env.REDIS_TOKEN,
    ttlSeconds: 120,
  },
};


// src/sources/sheets.ts
// ---
import { google } from "googleapis";
import { SheetTokenRow } from "../types.js";
import { CFG } from "../config.js";

function getAuth() {
  if (!CFG.sheet.saJson) throw new Error("Missing GOOGLE_APPLICATION_CREDENTIALS_JSON");
  const creds = JSON.parse(CFG.sheet.saJson);
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

export async function readTokensFromSheet(): Promise<SheetTokenRow[]> {
  const auth = await getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: CFG.sheet.spreadsheetId,
    range: CFG.sheet.range,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = (res.data.values || []) as any[][];
  return rows
    .map((r) => ({
      chain: String(r[0] || "").toLowerCase(),
      contract_address: String(r[1] || "").toLowerCase(),
      symbol: r[2] ? String(r[2]) : undefined,
      decimals: r[3] != null ? Number(r[3]) : null,
      coingecko_id: r[4] ? String(r[4]) : null,
      cmc_id: r[5] != null ? Number(r[5]) : null,
      cmc_slug: r[6] ? String(r[6]) : null,
    }))
    .filter((t) => t.chain && t.contract_address);
});
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: CFG.sheet.spreadsheetId,
    range: CFG.sheet.range,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = (res.data.values || []) as any[][];
  return rows
    .map((r) => ({
      chain: String(r[0] || "").toLowerCase(),
      contract_address: String(r[1] || "").toLowerCase(),
      symbol: r[2] ? String(r[2]) : undefined,
      decimals: r[3] != null ? Number(r[3]) : null,
      coingecko_id: r[4] ? String(r[4]) : null,
      cmc_id: r[5] != null ? Number(r[5]) : null,
    }))
    .filter((t) => t.chain && t.contract_address);
}


// src/vendors/dexscreener.ts
// ---
import axios from "axios";
import pRetry from "p-retry";
import { CFG } from "../config.js";

export async function fetchDexscreenerPrice(address: string) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${address}`; // รองรับ , คั่นหลาย address ได้
  return await pRetry(async () => {
    const res = await axios.get(url, { timeout: CFG.api.timeoutMs });
    // รูปแบบผลลัพธ์: { pairs: [{ priceUsd: "0.000123", ...}, ...] }
    const pairs = res.data?.pairs || [];
    // เลือก pair ที่มี priceUsd มากที่สุด/น่าเชื่อ (ที่มี liquidity สูงสุด)
    const best = pairs
      .filter((p: any) => p.priceUsd)
      .sort((a: any, b: any) => (Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0)))[0];
    if (!best?.priceUsd) return null;
    return Number(best.priceUsd);
  }, { retries: 2, factor: 2 });
}


// src/vendors/coingecko.ts
// ---
import axios from "axios";
import pRetry from "p-retry";
import { CFG } from "../config.js";

// พยายามใช้ endpoint token price โดยระบุ platform ตาม chain (eth = ethereum, bsc = binance-smart-chain, polygon-pos, base, solana)
const PLATFORM_MAP: Record<string, string> = {
  eth: "ethereum",
  ethereum: "ethereum",
  bsc: "binance-smart-chain",
  bnb: "binance-smart-chain",
  polygon: "polygon-pos",
  matic: "polygon-pos",
  base: "base",
  sol: "solana",
  solana: "solana",
};

export async function fetchCoingeckoPrice(chain: string, address: string, fallbackId?: string) {
  return await pRetry(async () => {
    const platform = PLATFORM_MAP[chain?.toLowerCase()] || chain?.toLowerCase();
    const headers: any = {};
    if (CFG.api.coingeckoKey) headers["x-cg-pro-api-key"] = CFG.api.coingeckoKey;

    // ทางเลือกที่ 1: contract price
    if (platform) {
      const url = `https://api.coingecko.com/api/v3/simple/token_price/${platform}?contract_addresses=${address}&vs_currencies=usd`;
      const r1 = await axios.get(url, { timeout: CFG.api.timeoutMs, headers });
      const v1 = r1.data?.[address?.toLowerCase()]?.usd;
      if (v1 != null) return Number(v1);
    }

    // ทางเลือกที่ 2: โดนัทเป็น id ตรง ๆ (ใช้เมื่อให้ coingecko_id)
    if (fallbackId) {
      const url2 = `https://api.coingecko.com/api/v3/simple/price?ids=${fallbackId}&vs_currencies=usd`;
      const r2 = await axios.get(url2, { timeout: CFG.api.timeoutMs, headers });
      const v2 = r2.data?.[fallbackId]?.usd;
      if (v2 != null) return Number(v2);
    }

    return null;
  }, { retries: 2, factor: 2 });
}


// src/vendors/cmc.ts
// ---
import axios from "axios";
import pRetry from "p-retry";
import { CFG } from "../config.js";

export async function fetchCmcPriceByAddress(address: string) {
  if (!CFG.api.cmcKey) return null;
  return await pRetry(async () => {
    const url = `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?address=${address}`;
    const res = await axios.get(url, { timeout: CFG.api.timeoutMs, headers: { "X-CMC_PRO_API_KEY": CFG.api.cmcKey! } });
    const data = res.data?.data;
    // data เป็น object keyed โดย address → อาจมีหลายเหรียญถ้าหลาย chain
    const first = data && Object.values<any>(data)?.[0]?.[0];
    const price = first?.quote?.USD?.price;
    return price != null ? Number(price) : null;
  }, { retries: 2, factor: 2 });
}

export async function fetchCmcPriceById(cmcId?: number | null) {
  if (!CFG.api.cmcKey || !cmcId) return null;
  return await pRetry(async () => {
    const url = `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?id=${cmcId}`;
    const res = await axios.get(url, { timeout: CFG.api.timeoutMs, headers: { "X-CMC_PRO_API_KEY": CFG.api.cmcKey! } });
    const first = res.data?.data?.[cmcId]?.quote?.USD?.price;
    return first != null ? Number(first) : null;
  }, { retries: 2, factor: 2 });
}


// src/core/normalize.ts
// ---
import { PriceResult } from "../types.js";

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


// src/storage.ts
// ---
// (ตัวเลือก) เก็บ cache/ล่าสุด ลง Redis แบบ Upstash HTTP API เพื่อกัน rate limit
import axios from "axios";
import { CFG } from "./config.js";
import { PriceResult } from "./types.js";

function enabled() { return !!(CFG.cache.redisUrl && CFG.cache.redisToken); }

export async function cacheSet(key: string, value: any, ttl = CFG.cache.ttlSeconds) {
  if (!enabled()) return;
  const url = `${CFG.cache.redisUrl}/SET/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}?EX=${ttl}`;
  await axios.get(url, { headers: { Authorization: `Bearer ${CFG.cache.redisToken}` }, timeout: 5000 }).catch(() => {});
}

export async function cacheGet<T = any>(key: string): Promise<T | null> {
  if (!enabled()) return null;
  const url = `${CFG.cache.redisUrl}/GET/${encodeURIComponent(key)}`;
  try {
    const res = await axios.get(url, { headers: { Authorization: `Bearer ${CFG.cache.redisToken}` }, timeout: 5000 });
    if (res.data?.result) return JSON.parse(res.data.result);
  } catch {}
  return null;
}

export function cacheKey(chain: string, address: string) {
  return `price:${chain}:${address.toLowerCase()}`;
}

export async function storeResults(results: PriceResult[]) {
  await Promise.all(results.map(r => cacheSet(cacheKey(r.chain, r.address), r)));
}

// ---
// (ตัวเลือก) เก็บ cache/ล่าสุด ลง Redis แบบ Upstash HTTP API เพื่อกัน rate limit
import axios from "axios";
import { CFG } from "./config.js";
import { PriceResult } from "./types.js";

function enabled() { return !!(CFG.cache.redisUrl && CFG.cache.redisToken); }

export async function cacheSet(key: string, value: any, ttl = CFG.cache.ttlSeconds) {
  if (!enabled()) return;
  const url = `${CFG.cache.redisUrl}/SET/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}?EX=${ttl}`;
  await axios.get(url, { headers: { Authorization: `Bearer ${CFG.cache.redisToken}` }, timeout: 5000 }).catch(() => {});
}

export async function cacheGet<T = any>(key: string): Promise<T | null> {
  if (!enabled()) return null;
  const url = `${CFG.cache.redisUrl}/GET/${encodeURIComponent(key)}`;
  try {
    const res = await axios.get(url, { headers: { Authorization: `Bearer ${CFG.cache.redisToken}` }, timeout: 5000 });
    if (res.data?.result) return JSON.parse(res.data.result);
  } catch {}
  return null;
}

export function cacheKey(chain: string, address: string) {
  return `price:${chain}:${address.toLowerCase()}`;
}

export async function storeResults(results: PriceResult[]) {
  // เก็บทีละตัว (หรือจะรวมเป็น HASH ก็ได้)
  await Promise.all(results.map(r => cacheSet(cacheKey(r.chain, r.address), r)));
}


// src/core/fetchPrice.ts
// ---
import { fetchDexscreenerPrice } from "../vendors/dexscreener.js";
import { fetchCoingeckoPrice } from "../vendors/coingecko.js";
import { fetchCmcPriceByAddress, fetchCmcPriceById } from "../vendors/cmc.js";
import { toPriceResult } from "./normalize.js";
import { PriceResult, SheetTokenRow } from "../types.js";
import { cacheGet, cacheKey } from "../storage.js";

export async function fetchPriceForToken(t: SheetTokenRow): Promise<PriceResult> {
  const { chain, contract_address, symbol, coingecko_id, cmc_id } = t;

  // ลองอ่านจาก cache ก่อน
  const cached = await cacheGet<PriceResult>(cacheKey(chain, contract_address));
  if (cached) return cached;

  // 1) Dexscreener
  const p1 = await fetchDexscreenerPrice(contract_address).catch(() => null);
  if (p1 != null) return toPriceResult(chain, contract_address, p1, "dexscreener", symbol);

  // 2) CoinGecko (by contract → id)
  const p2 = await fetchCoingeckoPrice(chain, contract_address, coingecko_id || undefined).catch(() => null);
  if (p2 != null) return toPriceResult(chain, contract_address, p2, "coingecko", symbol);

  // 3) CMC (by address → id → quote)
  const p3 = await fetchCmcPriceByAddress(contract_address).catch(() => null);
  if (p3 != null) return toPriceResult(chain, contract_address, p3, "cmc", symbol);

  // 3b) CMC by explicit id
  const p3b = await fetchCmcPriceById(cmc_id).catch(() => null);
  if (p3b != null) return toPriceResult(chain, contract_address, p3b, "cmc", symbol);

  // ทั้งหมดล้มเหลว
  return toPriceResult(chain, contract_address, null, null, symbol);
}

export async function fetchAllPrices(tokens: SheetTokenRow[]): Promise<PriceResult[]> {
  const out: PriceResult[] = [];
  // จำกัด concurrency แบบง่าย ๆ เพื่อเลี่ยง rate limit (ขยายทีหลังได้)
  const BATCH = 6;
  for (let i = 0; i < tokens.length; i += BATCH) {
    const slice = tokens.slice(i, i + BATCH);
    const got = await Promise.all(slice.map(fetchPriceForToken));
    out.push(...got);
  }
  return out;
}


// src/index.ts
// ---
import { fetchAllPrices } from "./core/fetchPrice.js";
import { storeResults } from "./storage.js";
import { CFG } from "./config.js";
import type { SheetTokenRow } from "./types.js";
import axios from "axios";

// dynamic import sources to avoid bundling unused deps
async function getTokens(): Promise<SheetTokenRow[]> {
  if (CFG.dataSource === "sheets") {
    const m = await import("./sources/sheets.js");
    return m.readTokensFromSheet();
  }
  // default: apps_script JSON URL
  if (!CFG.appsScript.url) throw new Error("APPS_SCRIPT_URL is required when DATA_SOURCE=apps_script");
  const r = await axios.get(CFG.appsScript.url, { timeout: 15000, validateStatus: (s) => s >= 200 && s < 500 });
  const arr = Array.isArray(r.data) ? r.data : ([] as any[]);
  return arr.map((x: any) => {
    // Normalize chain (e.g. "SOL" -> "sol")
    const chainRaw = String(x.chain || x.cmcChain || "");
    const chain = chainRaw.toLowerCase();

    // Parse CMC id like "UCID=33596" → 33596
    let cmc_id: number | null = null;
    const cmcIdStr = String(x.cmcId || "");
    const m = cmcIdStr.match(/(\d{1,9})/);
    if (m) cmc_id = Number(m[1]);

    return {
      chain,
      contract_address: String(x.contract || x.address || "").toLowerCase(),
      symbol: String(x.name || x.symbol || "").replace(/^\$/,'') || undefined,
      decimals: null,
      coingecko_id: x.geckoId ? String(x.geckoId) : null,
      cmc_id,
      cmc_slug: x.cmcSlug ? String(x.cmcSlug) : null,
    } satisfies SheetTokenRow;
  }).filter((t: SheetTokenRow) => t.chain && t.contract_address);
}

async function runOnce() {
  const tokens = await getTokens();
  if (!tokens.length) {
    console.log("No tokens from data source");
    return;
  }
  const prices = await fetchAllPrices(tokens);
  await storeResults(prices);
  console.table(prices.map(p => ({ chain: p.chain, address: p.address, priceUsd: p.priceUsd, source: p.source })));
}

runOnce().catch((e) => {
  console.error(e);
  process.exit(1);
});((e) => {
  console.error(e);
  process.exit(1);
});

// หมายเหตุ: ถ้าต้องการรันแบบ node-cron ภายใน process เดียว ให้เพิ่มตัวจัดตารางด้านล่าง
// import cron from "node-cron";
// cron.schedule(process.env.CRON_SCHEDULE || "*/5 * * * *", () => runOnce());
// console.log("Cron scheduled", process.env.CRON_SCHEDULE || "*/5 * * * *");
