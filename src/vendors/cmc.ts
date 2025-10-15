import axios from "axios";
import pRetry from "p-retry";
import * as cheerio from "cheerio";
import { CFG } from "../config.js";

// Fast + robust CMC (slug-only) implementation, aligned with a typical test-cmc style
// Order: data-api by slug → data-api by id (from HTML) → __NEXT_DATA__ parse → DOM fallback

const TIMEOUT = () => CFG.api.timeoutMs || 12000;
const HEADERS_JSON = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  accept: "application/json",
};
const HEADERS_HTML = {
  "user-agent": HEADERS_JSON["user-agent"],
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

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

function readUsdPriceFromQuoteStruct(obj: any): number | null {
  if (!obj || typeof obj !== "object") return null;
  const q = obj.USD || obj.usd || (Array.isArray(obj) ? obj.find((x) => x?.name === "USD") : null);
  if (!q) return null;
  const cand = toNum(q.price ?? q.lastPrice ?? q.spotPrice ?? q.close ?? q.value);
  return cand ?? null;
}

function readUsdPriceFromAny(data: any): number | null {
  if (!data) return null;
  // common shapes
  // 1) { data: [{ quote: { USD: { price } } }] }
  const d1 = Array.isArray(data?.data) ? data.data[0] : null;
  if (d1) {
    const p = readUsdPriceFromQuoteStruct(d1.quote);
    if (p != null) return p;
  }
  // 2) { data: { <id>: { quote: { USD: { price }}}}
  const d2 = data?.data && typeof data.data === "object" ? Object.values<any>(data.data)[0] : null;
  if (d2) {
    const p = readUsdPriceFromQuoteStruct(d2.quote);
    if (p != null) return p;
  }
  // 3) detail response variants
  const crypto = data?.data?.cryptoCurrency || data?.data?.cryptoCurrencyBySlug || data?.data;
  if (crypto) {
    const p1 = readUsdPriceFromQuoteStruct(crypto.quotes || crypto.quote);
    if (p1 != null) return p1;
    const stats = crypto.statistics || data?.data?.detail?.statistics;
    const p2 = toNum(stats?.price ?? stats?.spotPrice);
    if (p2 != null) return p2;
  }
  // 4) direct price field
  const p3 = toNum(data?.data?.price ?? data?.price);
  if (p3 != null) return p3;
  return null;
}

async function cmcDataApiQuoteBySlug(slug: string) {
  const url = `https://api.coinmarketcap.com/data-api/v3/cryptocurrency/quote/latest?slug=${encodeURIComponent(
    slug
  )}&convert=USD`;
  const res = await axios.get(url, {
    timeout: TIMEOUT(),
    headers: HEADERS_JSON,
    validateStatus: (s) => s >= 200 && s < 500,
  });
  if (res.status >= 400) throw new Error(`CMC quote slug HTTP ${res.status}`);
  return res.data;
}

async function cmcDataApiQuoteById(id: number) {
  const url = `https://api.coinmarketcap.com/data-api/v3/cryptocurrency/quote/latest?id=${id}&convert=USD`;
  const res = await axios.get(url, {
    timeout: TIMEOUT(),
    headers: HEADERS_JSON,
    validateStatus: (s) => s >= 200 && s < 500,
  });
  if (res.status >= 400) throw new Error(`CMC quote id HTTP ${res.status}`);
  return res.data;
}

async function fetchHtml(slug: string) {
  const url = `https://coinmarketcap.com/currencies/${encodeURIComponent(slug)}/`;
  const res = await axios.get<string>(url, {
    timeout: TIMEOUT(),
    headers: HEADERS_HTML,
    responseType: "text",
    validateStatus: (s) => s >= 200 && s < 500,
  });
  if (res.status >= 400) throw new Error(`CMC HTML ${res.status}`);
  return res.data || "";
}

function parseFromNextData(html: string): number | null {
  if (!html) return null;
  const $ = cheerio.load(html);
  let raw = ("" + $("#__NEXT_DATA__").first().html()) || ("" + $("#__NEXT_DATA__").first().text()) || "";
  if (!raw) {
    const m = String(html).match(/<script id=\"__NEXT_DATA__\"[^>]*>([\s\S]*?)<\/script>/i);
    if (m && m[1]) raw = m[1];
  }
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    // try a few common paths
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
    const pQ = readUsdPriceFromQuoteStruct(crypto?.quotes || crypto?.quote);
    if (pQ != null) return pQ;

    // statistics
    const stats = crypto?.statistics || detailRes?.detail?.statistics || pageProps?.detailRes?.data?.detail?.statistics;
    const pS = toNum(stats?.price ?? stats?.spotPrice);
    if (pS != null) return pS;

    // scan for price inside JSON string as last resort
    const m = JSON.stringify(j).match(/"USD"\s*:\s*\{[^}]*?"price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/);
    if (m) {
      const v = Number(m[1]);
      if (Number.isFinite(v)) return v;
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

/** Single slug → price */
export async function fetchCmcPriceBySlug(slug: string): Promise<number | null> {
  if (!slug) return null;

  // 1) data-api by slug (fast)
  try {
    const data = await pRetry(() => cmcDataApiQuoteBySlug(slug), { retries: 2, factor: 2 });
    const p = readUsdPriceFromAny(data);
    if (p != null) return p;
  } catch {}

  // 2) HTML → extract id → data-api by id
  try {
    const html = await pRetry(() => fetchHtml(slug), { retries: 1, factor: 2 });
    const id = extractIdFromHtml(html);
    if (id) {
      const data2 = await pRetry(() => cmcDataApiQuoteById(id), { retries: 2, factor: 2 });
      const p2 = readUsdPriceFromAny(data2);
      if (p2 != null) return p2;
    }

    // 3) __NEXT_DATA__ parse as fallback
    const p3 = parseFromNextData(html);
    if (p3 != null) return p3;
  } catch {}

  return null;
}

/** Batch by slugs with limited concurrency */
export async function fetchCmcBatchBySlugs(
  slugs: string[],
  opts?: { concurrency?: number; delayMs?: number; retries?: number }
): Promise<Record<string, number | null>> {
  const concurrency = Math.max(1, Math.min(10, opts?.concurrency ?? 4));
  const delayMs = Math.max(0, opts?.delayMs ?? 0);
  const retries = opts?.retries ?? 2;

  const uniq = Array.from(new Set(slugs.map((s) => String(s || "").toLowerCase()).filter(Boolean)));
  const out: Record<string, number | null> = {};
  for (const s of uniq) out[s] = null;

  for (let i = 0; i < uniq.length; i += concurrency) {
    const part = uniq.slice(i, i + concurrency);
    const results = await Promise.all(
      part.map((slug) => pRetry(() => fetchCmcPriceBySlug(slug), { retries, factor: 2 }))
    );
    for (let j = 0; j < part.length; j++) out[part[j]] = results[j];
    if (delayMs && i + concurrency < uniq.length) await sleep(delayMs);
  }

  return out;
}

// Compatibility stubs (kept so core compiles; we use slug-only in this profile)
export async function fetchCmcPriceByAddress(_address: string): Promise<number | null> { return null; }
export async function fetchCmcPriceById(_cmcId?: number | null): Promise<number | null> { return null; }