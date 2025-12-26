import axios from "axios";
import pRetry from "p-retry";
import * as cheerio from "cheerio";
import { CFG } from "../shared/config.js";
import crypto from "node:crypto";

// Fast + robust CMC (slug-only) implementation, aligned with a typical test-cmc style
// Order: data-api by slug → data-api by id (from HTML) → __NEXT_DATA__ parse → DOM fallback

const TIMEOUT = () => CFG.api.timeoutMs || 12000;

// ✅ 1. เพิ่ม Headers เพื่อป้องกันการโดนบล็อก (Anti-Bot)
function HEADERS_COMMON() {
  return {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "accept-language": "en-US,en;q=0.9",
    Referer: "https://coinmarketcap.com/",
    Origin: "https://coinmarketcap.com",
    "Cache-Control": "no-cache, no-store, max-age=0",
    Pragma: "no-cache",
    "X-Request-Id": crypto.randomUUID?.() || String(Date.now()),
  };
}

function HEADERS_JSON() {
  return {
    ...HEADERS_COMMON(),
    accept: "application/json, text/plain, */*",
  };
}

function HEADERS_HTML() {
  return {
    ...HEADERS_COMMON(),
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Upgrade-Insecure-Requests": "1",
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toNum(x: any): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string") {
    const n = Number(x.replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ✅ 2. นิยาม Interface ใหม่ให้รองรับข้อมูลครบถ้วน
export interface CmcPriceData {
  priceUsd: number | null;
  priceChangeH24: number | null;
  marketCap: number | null;
}

// ✅ 3. ปรับ Logic การแกะข้อมูลให้ดึง 24h Change และ Market Cap
function readCmcDataFromQuoteStruct(obj: any): CmcPriceData {
  const empty = { priceUsd: null, priceChangeH24: null, marketCap: null };
  if (!obj || typeof obj !== "object") return empty;

  // หา Object ของ USD (บางทีเป็น Key USD, usd หรืออยู่ใน Array)
  const q =
    obj.USD ||
    obj.usd ||
    (Array.isArray(obj) ? obj.find((x: any) => x?.name === "USD") : null);
  if (!q) return empty;

  const mc = toNum(q.marketCap ?? q.marketCapUsd);
  const fdv = toNum(q.fullyDilutedMarketCap);

  return {
    priceUsd: toNum(
      q.price ?? q.lastPrice ?? q.spotPrice ?? q.close ?? q.value
    ),
    priceChangeH24: toNum(
      q.percentChange24h ??
        q.percentChange24H ??
        q.priceChange24h ??
        q.change24h
    ),
    // ถ้า mc มีค่าและมากกว่า 0 ให้ใช้ mc, ถ้าไม่ให้ fallback ไปใช้ fdv
    marketCap: mc && mc > 0 ? mc : fdv,
  };
}

function readCmcDataFromAny(data: any): CmcPriceData {
  const empty = { priceUsd: null, priceChangeH24: null, marketCap: null };
  if (!data) return empty;

  // 1) { data: [{ quote: { USD: { ... } } }] }
  const d1 = Array.isArray(data?.data) ? data.data[0] : null;
  if (d1) {
    const res = readCmcDataFromQuoteStruct(d1.quote);
    if (res.priceUsd != null) return res;
  }

  // 2) { data: { <id>: { quote: { USD: { ... }}}}
  const d2 =
    data?.data && typeof data.data === "object"
      ? Object.values<any>(data.data)[0]
      : null;
  if (d2) {
    const res = readCmcDataFromQuoteStruct(d2.quote);
    if (res.priceUsd != null) return res;
  }

  // 3) detail response variants (cryptoCurrency object)
  const crypto =
    data?.data?.cryptoCurrency ||
    data?.data?.cryptoCurrencyBySlug ||
    data?.data;
  if (crypto) {
    // ลองหาใน quotes ก่อน
    const res1 = readCmcDataFromQuoteStruct(crypto.quotes || crypto.quote);
    if (res1.priceUsd != null) return res1;

    // ถ้าไม่มี quotes ลองหาใน statistics
    const stats = crypto.statistics || data?.data?.detail?.statistics;
    const p2 = toNum(stats?.price ?? stats?.spotPrice);
    if (p2 != null) {
      // ดึงค่า MC และ FDV จาก statistics
      const mc = toNum(stats?.marketCap ?? stats?.marketCapUsd);
      const fdv = toNum(stats?.fullyDilutedMarketCap);

      return {
        priceUsd: p2,
        priceChangeH24: toNum(
          stats?.priceChangePercentage24h ?? stats?.priceChange24h
        ),
        // Logic เดียวกัน: ถ้า mc เป็น 0 ให้ใช้ fdv
        marketCap: mc && mc > 0 ? mc : fdv,
      };
    }
  }

  // 4) direct price field (fallback สุดท้าย)
  const p3 = toNum(data?.data?.price ?? data?.price);
  if (p3 != null) {
    return {
      priceUsd: p3,
      priceChangeH24: null,
      marketCap: null,
    };
  }

  return empty;
}

// ... (cmcDataApiQuoteBySlug, cmcDataApiQuoteById, fetchHtml เหมือนเดิม แต่ใช้ Headers ใหม่) ...

async function cmcDataApiQuoteBySlug(slug: string) {
  const url = `https://api.coinmarketcap.com/data-api/v3/cryptocurrency/quote/latest?slug=${encodeURIComponent(
    slug
  )}&convert=USD&_t=${Date.now()}`;
  const res = await axios.get(url, {
    timeout: TIMEOUT(),
    headers: HEADERS_JSON(),
    validateStatus: (s) => s >= 200 && s < 500,
  });
  if (res.status >= 400) throw new Error(`CMC quote slug HTTP ${res.status}`);
  return res.data;
}

async function cmcDataApiQuoteById(id: number) {
  const url = `https://api.coinmarketcap.com/data-api/v3/cryptocurrency/quote/latest?id=${id}&convert=USD&_t=${Date.now()}`;
  const res = await axios.get(url, {
    timeout: TIMEOUT(),
    headers: HEADERS_JSON(),
    validateStatus: (s) => s >= 200 && s < 500,
  });
  if (res.status >= 400) throw new Error(`CMC quote id HTTP ${res.status}`);
  return res.data;
}

async function fetchHtml(slug: string) {
  const url = `https://coinmarketcap.com/currencies/${encodeURIComponent(
    slug
  )}/?_t=${Date.now()}`;
  const res = await axios.get<string>(url, {
    timeout: TIMEOUT(),
    headers: HEADERS_HTML(),
    responseType: "text",
    validateStatus: (s) => s >= 200 && s < 500,
  });
  if (res.status >= 400) throw new Error(`CMC HTML ${res.status}`);
  return res.data || "";
}

function parseFromNextData(html: string): CmcPriceData | null {
  if (!html) return null;
  const $ = cheerio.load(html);
  let raw =
    "" + $("#__NEXT_DATA__").first().html() ||
    "" + $("#__NEXT_DATA__").first().text() ||
    "";
  if (!raw) {
    const m = String(html).match(
      /<script id=\"__NEXT_DATA__\"[^>]*>([\s\S]*?)<\/script>/i
    );
    if (m && m[1]) raw = m[1];
  }
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    const pageProps = j?.props?.pageProps ?? j?.props ?? {};
    const detailRes = pageProps?.detailRes?.data ?? pageProps?.detailRes ?? {};
    const crypto =
      detailRes?.cryptoCurrency ||
      detailRes?.cryptoCurrencyBySlug ||
      detailRes ||
      pageProps?.overviewRes?.data?.cryptoCurrency ||
      pageProps?.overviewRes?.data ||
      pageProps?.infoRes?.data ||
      {};

    // quotes
    const resQ = readCmcDataFromQuoteStruct(crypto?.quotes || crypto?.quote);
    if (resQ.priceUsd != null) return resQ;

    // statistics fallback
    const stats =
      crypto?.statistics ||
      detailRes?.detail?.statistics ||
      pageProps?.detailRes?.data?.detail?.statistics;
    const pS = toNum(stats?.price ?? stats?.spotPrice);
    if (pS != null) {
      const mc = toNum(stats?.marketCap ?? stats?.marketCapUsd);
      const fdv = toNum(stats?.fullyDilutedMarketCap);
      return {
        priceUsd: pS,
        priceChangeH24: toNum(
          stats?.priceChangePercentage24h ?? stats?.priceChange24h
        ),
        // ✅ ใช้ Logic เดียวกัน: ถ้า MC ไม่มี ให้เอา FDV
        marketCap: mc && mc > 0 ? mc : fdv,
      };
    }
  } catch {}
  return null;
}
function extractIdFromHtml(html: string): number | null {
  const m = String(html).match(/"id"\s*:\s*(\d{1,9})/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// ✅ 4. Main Function: Single slug → CmcPriceData
export async function fetchCmcPriceBySlug(slug: string): Promise<CmcPriceData> {
  const empty = { priceUsd: null, priceChangeH24: null, marketCap: null };
  if (!slug) return empty;

  // 1) data-api by slug (fast)
  try {
    const data = await pRetry(() => cmcDataApiQuoteBySlug(slug), {
      retries: 2,
      factor: 2,
    });
    const res = readCmcDataFromAny(data);
    if (res.priceUsd != null) return res;
  } catch (err: any) {
    console.error(`[CMC Error] API slug '${slug}':`, err.message);
  }

  // 2) HTML → extract id → data-api by id
  try {
    const html = await pRetry(() => fetchHtml(slug), { retries: 1, factor: 2 });
    const id = extractIdFromHtml(html);
    if (id) {
      const data2 = await pRetry(() => cmcDataApiQuoteById(id), {
        retries: 2,
        factor: 2,
      });
      const res2 = readCmcDataFromAny(data2);
      if (res2.priceUsd != null) return res2;
    }

    // 3) __NEXT_DATA__ parse as fallback
    const res3 = parseFromNextData(html);
    if (res3 && res3.priceUsd != null) return res3;
  } catch (err: any) {
    console.error(`[CMC Error] HTML fallback '${slug}':`, err.message);
  }

  return empty;
}

// ✅ 5. Batch Function: Slugs → Record<slug, CmcPriceData>
export async function fetchCmcBatchBySlugs(
  slugs: string[],
  opts?: { concurrency?: number; delayMs?: number; retries?: number }
): Promise<Record<string, CmcPriceData | null>> {
  const concurrency = Math.max(1, Math.min(10, opts?.concurrency ?? 4));
  const delayMs = Math.max(0, opts?.delayMs ?? 0);
  const retries = opts?.retries ?? 2;

  const uniq = Array.from(
    new Set(slugs.map((s) => String(s || "").toLowerCase()).filter(Boolean))
  );
  const out: Record<string, CmcPriceData | null> = {};
  for (const s of uniq) out[s] = null;

  for (let i = 0; i < uniq.length; i += concurrency) {
    const part = uniq.slice(i, i + concurrency);
    const results = await Promise.all(
      part.map((slug) =>
        pRetry(() => fetchCmcPriceBySlug(slug), { retries, factor: 2 })
      )
    );
    for (let j = 0; j < part.length; j++) out[part[j]] = results[j];
    if (delayMs && i + concurrency < uniq.length) await sleep(delayMs);
  }

  return out;
}

// Compatibility stubs
export async function fetchCmcPriceByAddress(
  _address: string
): Promise<CmcPriceData> {
  return { priceUsd: null, priceChangeH24: null, marketCap: null };
}
export async function fetchCmcPriceById(
  _cmcId?: number | null
): Promise<CmcPriceData> {
  return { priceUsd: null, priceChangeH24: null, marketCap: null };
}
