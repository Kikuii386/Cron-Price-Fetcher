import * as http from "http";
import axios from "axios";
import { pool } from "./shared/storage.js";
import { CFG } from "./shared/config.js";
import { fetchAllPrices } from "./core/fetchPrice.js";
import { handleAuthCheck } from "./api/auth.js";
import {
  storeResults,
  cacheGet,
  cacheKey,
  readCacheBatch,
} from "./shared/storage.js";
import { pingSupabase } from "./shared/storage.js";
import type { SheetTokenRow, PriceResult } from "./shared/types.js";

const AUTH_CHECK_PATH = "/auth/check-email";
const PORT = Number(process.env.PORT || 3000);

// Lightweight shape for Dexscreener normalized rows used in debug endpoints
export type DsRow = {
  chainId: string;
  dexId: string;
  pairAddress: string;
  quote?: string;
  liq: number;
  vol24h: number;
  priceUsd: number | null;
};
import { createClient } from "@supabase/supabase-js";

// --- Helpers ---

function json(
  res: http.ServerResponse,
  status: number,
  body: any,
  extraHeaders: Record<string, string> = {}
) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function ok(res: http.ServerResponse, body: any, cacheSeconds = 60) {
  json(res, 200, body, {
    "Cache-Control": `public, max-age=30, s-maxage=${cacheSeconds}, stale-while-revalidate=120`,
  });
}

function bad(res: http.ServerResponse, status = 400, msg = "bad request") {
  json(res, status, { ok: false, error: msg });
}

function summarize(prices: PriceResult[]) {
  const bySource = { dexscreener: 0, coingecko: 0, cmc: 0 };
  let withPrice = 0;
  for (const p of prices) {
    if (p && p.priceUsd != null) {
      withPrice++;
      if (p.source === "dexscreener") bySource.dexscreener++;
      else if (p.source === "coingecko") bySource.coingecko++;
      else if (p.source === "cmc") bySource.cmc++;
    }
  }
  return {
    totals: {
      total: prices.length,
      withPrice,
      nulls: prices.length - withPrice,
    },
    bySource,
  };
}

function normalizeToken(x: any): SheetTokenRow | null {
  const chain = String(x.chain || x.cmcChain || "")
    .trim()
    .toLowerCase();
  const address = String(x.contract || x.address || "")
    .trim()
    .toLowerCase();
  if (!chain || !address) return null;
  const symbol =
    (x.name || x.symbol || "").toString().replace(/^\$/, "") || undefined;
  const cmc_id =
    x.cmcId === "" || x.cmcId == null || Number.isNaN(Number(x.cmcId))
      ? null
      : Number(x.cmcId);
  return {
    chain,
    cmcChain: x.cmcChain ? String(x.cmcChain) : undefined,
    contract_address: address,
    symbol,
    decimals: null,
    coingecko_id: x.geckoId ? String(x.geckoId).toLowerCase() : null,
    cmc_id,
    cmc_slug: x.cmcSlug ? String(x.cmcSlug).toLowerCase() : null,
    logo: x.logo ? String(x.logo) : null,
    allocationPct:
      typeof x.allocationPct === "number"
        ? x.allocationPct
        : Number(x.allocationPct) || null,
  };
}

async function readTokensFromAppsScript(): Promise<SheetTokenRow[]> {
  if (!CFG.source.appsScriptUrl) throw new Error("Missing APPS_SCRIPT_URL");
  const u = new URL(CFG.source.appsScriptUrl);
  u.searchParams.set("_t", String(Date.now())); // cache buster to avoid stale data on Render/CDN
  const r = await axios.get(u.toString(), {
    timeout: 20000,
    headers: { "Cache-Control": "no-cache" },
    validateStatus: (s) => s >= 200 && s < 500,
  });
  const arr = Array.isArray(r.data) ? r.data : [];
  return arr.map(normalizeToken).filter(Boolean) as SheetTokenRow[];
}

async function runOnce(): Promise<PriceResult[]> {
  const tokens = await readTokensFromAppsScript();
  if (!tokens.length) return [];
  const prices = await fetchAllPrices(tokens, { bypassCache: true });
  await storeResults(prices);
  return prices;
}

function supaFetchWithTimeout(input: any, init: any = {}) {
  const ms = Number(process.env.SB_FETCH_TIMEOUT_MS || 15000);
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  const opts = { ...init, signal: controller.signal };
  // @ts-ignore
  return fetch(input, opts).finally(() => clearTimeout(id));
}

// --- Instrumentation for debug ---
let LAST_RUN_SUMMARY: any = null;

async function runOnceInstrumented(): Promise<void> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const summary: any = { ok: false, startedAt };
  try {
    const t1 = Date.now();
    const tokens = await readTokensFromAppsScript();
    summary.tokens = { count: tokens.length, ms: Date.now() - t1 };

    const t2 = Date.now();
    // Always fetch fresh prices (bypass cache)
    const prices = await fetchAllPrices(tokens, { bypassCache: true });
    const sampleRows = prices
      .filter((p) => p && p.priceUsd != null)
      .slice(0, 5)
      .map((p) => ({
        chain: p.chain,
        address: p.address,
        price_usd:
          typeof p.priceUsd === "number" ? p.priceUsd : Number(p.priceUsd),
        source: p.source,
      }));
    summary.fetch = {
      count: prices.length,
      ms: Date.now() - t2,
      bySource: prices.reduce((acc: any, p: any) => {
        const k = p.source || "unknown";
        if (p.priceUsd != null && Number(p.priceUsd) > 0)
          acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {}),
      sample: sampleRows,
    };

    const t3 = Date.now();
    await storeResults(prices);
    summary.store = { ms: Date.now() - t3 };
    summary.finishedAt = new Date().toISOString();

    summary.ok = true;
    summary.totalMs = Date.now() - t0;
    LAST_RUN_SUMMARY = summary;
  } catch (e: any) {
    summary.ok = false;
    summary.error = e?.message || String(e);
    summary.finishedAt = new Date().toISOString();
    summary.totalMs = Date.now() - t0;
    LAST_RUN_SUMMARY = summary;
  }
}

// --- Server ---
export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === AUTH_CHECK_PATH) {
      return handleAuthCheck(req, res);
    }
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      ok(res, { ok: true });
      return;
    }

    if (
      (req.method === "POST" || req.method === "GET") &&
      url.pathname === "/run"
    ) {
      // Optional auth with RUN_TOKEN
      const token = url.searchParams.get("token");
      if (process.env.RUN_TOKEN && token !== process.env.RUN_TOKEN) {
        res.writeHead(401, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }

      // Query flags
      const silent = url.searchParams.get("silent") === "1"; // respond with 204
      const asyncMode = url.searchParams.get("async") === "1"; // queue and return immediately

      if (asyncMode) {
        // run in background and return immediately
        setImmediate(async () => {
          try {
            await runOnceInstrumented();
          } catch (e: any) {
            console.error("[run async] error:", e?.message || e);
          }
        });

        if (silent) {
          res.writeHead(204, {
            "Content-Length": "0",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          });
          res.end();
          return;
        }

        ok(res, { ok: true, queued: true, at: new Date().toISOString() }, 5);
        return;
      }

      // Blocking mode: execute instrumented and return summary
      await runOnceInstrumented();
      if (silent) {
        res.writeHead(204, {
          "Content-Length": "0",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        });
        res.end();
        return;
      }
      ok(res, { ok: true, ...LAST_RUN_SUMMARY }, 0);
      return;
    }

    if (req.method === "GET" && url.pathname === "/prices") {
      // Read tokens → read cached prices in batch (fast path) → optionally refresh
      const tokens = await readTokensFromAppsScript();
      const asOf = new Date().toISOString();
      if (!tokens.length) {
        ok(res, { asOf, prices: [] }, 15);
        return;
      }

      const force = url.searchParams.get("refresh") === "1";
      const includeSummary = url.searchParams.get("summary") === "1";

      // Fast path: when not forcing refresh, return batch-cached prices ONLY (no vendor calls)
      if (!force) {
        const cacheMap = await readCacheBatch(tokens);
        const prices: PriceResult[] = tokens.map((t) => {
          const k = `${t.chain.toLowerCase()}|${t.contract_address.toLowerCase()}`;
          const r: any = cacheMap.get(k);
          return {
            chain: t.chain,
            address: t.contract_address,
            symbol: t.symbol ?? undefined,
            priceUsd: r?.price_usd != null ? Number(String(r.price_usd)) : null,
            priceChangeH24:
              r?.price_change_h24 != null ? Number(r.price_change_h24) : null,
            marketCap: r?.market_cap != null ? Number(r.market_cap) : null,
            source: r?.source ?? null,
            at: r?.at ?? null,
          };
        });

        const body: any = { asOf, prices };
        if (includeSummary) body.summary = summarize(prices);
        ok(res, body, 30);
        return;
      }

      // Slow path: explicit refresh → fetch from vendors (bypass cache) and store
      const fresh = await fetchAllPrices(tokens, { bypassCache: true });
      await storeResults(fresh);

      const body: any = { asOf, prices: fresh };
      if (includeSummary) body.summary = summarize(fresh);
      ok(res, body, 5);
      return;
    }

    if (req.method === "GET" && url.pathname === "/stats") {
      const refresh = url.searchParams.get("refresh") === "1";
      const asyncMode = url.searchParams.get("async") === "1";
      const silent = url.searchParams.get("silent") === "1";

      const tokens = await readTokensFromAppsScript();
      const keys = tokens.map((t) => cacheKey(t.chain, t.contract_address));
      const cached = await Promise.all(
        keys.map((k) => cacheGet<PriceResult>(k))
      );
      let prices = cached.filter((v): v is PriceResult => !!v);

      if (refresh) {
        if (asyncMode) {
          setImmediate(async () => {
            try {
              const fresh = await fetchAllPrices(tokens);
              await storeResults(fresh);
              const s = summarize(fresh);
              console.log(
                `[stats refresh async] total=${s.totals.total} ok=${
                  s.totals.withPrice
                } nulls=${s.totals.nulls} src=${JSON.stringify(s.bySource)}`
              );
            } catch (e: any) {
              console.error("[stats refresh async] error:", e?.message || e);
            }
          });

          if (silent) {
            res.writeHead(204, {
              "Content-Length": "0",
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
            });
            res.end();
            return;
          }

          ok(res, { ok: true, queued: true, at: new Date().toISOString() }, 5);
          return;
        }

        // Blocking refresh (use with care)
        prices = await fetchAllPrices(tokens);
        await storeResults(prices);
      }

      const summary = summarize(prices);
      ok(res, { asOf: new Date().toISOString(), ...summary }, 30);
      return;
    }

    // Debug: quick CoinGecko probe to verify connectivity and ids (supports ?id=mochi-3)
    if (req.method === "GET" && url.pathname === "/debug/gecko") {
      try {
        // If user supplies an explicit id or comma-separated ids, prefer those.
        const idParam =
          url.searchParams.get("id") || url.searchParams.get("ids");
        let ids: string[] = [];

        if (idParam && idParam.trim().length > 0) {
          ids = idParam
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
        } else {
          // Fallback: collect coingecko_id from Apps Script tokens
          const tokens = await readTokensFromAppsScript();
          ids = Array.from(
            new Set(
              tokens.map((t) => t.coingecko_id).filter((x): x is string => !!x)
            )
          ).slice(0, 25); // probe first 25 ids
        }

        if (ids.length === 0) {
          ok(res, { ok: true, note: "no coingecko_id provided or in tokens" });
          return;
        }

        const urlCg = `https://api.coingecko.com/api/v3/simple/price?ids=${ids
          .map(encodeURIComponent)
          .join(",")}&vs_currencies=usd`;

        const cg = await axios.get(urlCg, {
          timeout: 15000,
          headers: {
            Accept: "application/json",
            "User-Agent": "cron-price-fetcher/1.0",
          },
          validateStatus: (s) => s >= 200 && s < 500,
        });

        const body = cg.data || {};
        const have = Object.keys(body);
        const sample = have.slice(0, 5).reduce((acc: any, k) => {
          acc[k] = body[k]?.usd ?? null;
          return acc;
        }, {} as Record<string, number | null>);

        ok(res, {
          ok: true,
          status: cg.status,
          idsRequested: ids,
          idsReturned: have,
          sample,
        });
        return;
      } catch (err: any) {
        bad(res, 502, `gecko probe failed: ${err?.message || err}`);
        return;
      }
    }

    // Debug: show source URL and how many tokens returned
    if (req.method === "GET" && url.pathname === "/debug/source") {
      try {
        const src = CFG.source.appsScriptUrl || "(missing)";
        const tokens = await readTokensFromAppsScript();
        ok(res, {
          ok: true,
          appsScriptUrl: src,
          count: tokens.length,
          sample: tokens.slice(0, 3).map((t) => ({
            chain: t.chain,
            address: t.contract_address,
            geckoId: t.coingecko_id,
          })),
        });
      } catch (e: any) {
        bad(res, 502, e?.message || String(e));
      }
      return;
    }

    // Debug: Supabase connection check
    if (req.method === "GET" && url.pathname === "/debug/sb") {
      try {
        const urlEnv = process.env.SUPABASE_URL;
        const keyEnv =
          process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_ANON_KEY;
        if (!urlEnv || !keyEnv) {
          ok(res, { ok: false, error: "missing SUPABASE_URL or key" });
          return;
        }

        // Create client with a fetch that has a timeout
        const sb = createClient(urlEnv, keyEnv, {
          auth: { persistSession: false },
          global: { fetch: supaFetchWithTimeout as any },
        });

        // Lightweight probe: head + count only
        const { count, error } = await sb
          .from("prices")
          .select("*", { head: true, count: "estimated" });

        if (error) {
          ok(res, { ok: false, error: error.message });
          return;
        }

        ok(res, { ok: true, count: count ?? 0 });
      } catch (e: any) {
        ok(res, { ok: false, error: e?.message || String(e) });
      }
      return;
    }

    // Debug: latency and connectivity checks
    if (req.method === "GET" && url.pathname === "/debug/pings") {
      try {
        const dsT0 = Date.now();
        let dsOk = false,
          dsMs = 0,
          dsErr: string | undefined;
        try {
          const ds = await axios.get(
            "https://api.dexscreener.com/latest/dex/tokens/0x88faea256f789f8dd50de54f9c807eef24f71b16",
            { timeout: 8000, validateStatus: (s) => s >= 200 && s < 500 }
          );
          dsOk = ds.status === 200;
          dsMs = Date.now() - dsT0;
          if (!dsOk) dsErr = `http ${ds.status}`;
        } catch (e: any) {
          dsMs = Date.now() - dsT0;
          dsErr = e?.message || String(e);
        }

        const sb = await pingSupabase(8000);

        ok(
          res,
          {
            asOf: new Date().toISOString(),
            dexscreener: { ok: dsOk, ms: dsMs, error: dsErr },
            supabase: sb,
          },
          5
        );
        return;
      } catch (e: any) {
        bad(res, 500, e?.message || String(e));
        return;
      }
    }

    // Debug: show last run summary if available, always include asOf timestamp
    if (req.method === "GET" && url.pathname === "/debug/last-run") {
      const body = LAST_RUN_SUMMARY ?? { ok: false, error: "no run yet" };
      ok(res, { asOf: new Date().toISOString(), ...body }, 0);
      return;
    }

    // Debug: ตรวจว่าทำไมราคา Dexscreener ไม่ตรง (ดูคู่/พูลทั้งหมดและตัวที่เลือก)
    if (req.method === "GET" && url.pathname === "/debug/ds-why") {
      try {
        const chainParam = (
          url.searchParams.get("chain") ??
          url.searchParams.get("b") ??
          ""
        ).toLowerCase();
        const addressParam = (
          url.searchParams.get("address") ??
          url.searchParams.get("a") ??
          ""
        ).toLowerCase();
        const chain = chainParam;
        const address = addressParam;
        if (!address) {
          bad(res, 400, "missing address");
          return;
        }

        // ดึงทุกคู่ของ token นี้ (ปิด cache)
        const apiUrl = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(
          address
        )}?_t=${Date.now()}`;
        const r = await axios.get(apiUrl, {
          timeout: 15000,
          headers: {
            "Cache-Control": "no-cache",
            "User-Agent": "cron-price-fetcher/1.0",
          },
          validateStatus: (s) => s >= 200 && s < 500,
        });

        if (r.status !== 200 || !r.data?.pairs) {
          bad(res, 502, `dexscreener http ${r.status}`);
          return;
        }

        const pairs = r.data.pairs as any[];

        // คำนวณตัวช่วย
        const norm = (p: any) => ({
          chainId: p.chainId,
          dexId: p.dexId,
          pairAddress: p.pairAddress,
          quote: p.quoteToken?.symbol,
          liq: Number(p.liquidity?.usd ?? p.liquidityUsd ?? 0),
          vol24h: Number(p.volume?.h24 ?? p.volume24h ?? 0),
          priceUsd: p.priceUsd != null ? Number(p.priceUsd) : null,
        });

        const rows: DsRow[] = pairs.map(norm);

        // เลือก best โดย 2 เกณฑ์ให้เห็นความต่าง
        const byLiq =
          [...rows].sort((a: DsRow, b: DsRow) => b.liq - a.liq)[0] || null;

        const QUOTES = ["USDC", "USDT", "WETH", "SOL", "WBTC", "ETH", "BUSD"];
        const rowsPreferred = rows.filter((r: DsRow) =>
          QUOTES.includes(String(r.quote || "").toUpperCase())
        );
        const byPreferredThenLiq =
          (rowsPreferred.length ? rowsPreferred : rows).sort(
            (a: DsRow, b: DsRow) => b.liq - a.liq
          )[0] || null;

        ok(
          res,
          {
            ok: true,
            queried: { chain, address },
            count: rows.length,
            top5: rows.sort((a: DsRow, b: DsRow) => b.liq - a.liq).slice(0, 5),
            pickByLiq: byLiq,
            pickPreferredThenLiq: byPreferredThenLiq,
          },
          5
        );
        return;
      } catch (e: any) {
        bad(res, 500, e?.message || String(e));
        return;
      }
    }

    // --- เพิ่มด้านบนของไฟล์ร่วมกับ imports เดิม ---
    // ไม่มี import เพิ่ม เพราะเราใช้ axios และ helpers ในไฟล์นี้อยู่แล้ว

    // ... (โค้ดเดิมด้านบนคงเดิม)

    // ==== แทนที่ handler /debug/pipeline เดิมทั้งบล็อค ====
    if (req.method === "GET" && url.pathname === "/debug/pipeline") {
      try {
        const chainParam = (
          url.searchParams.get("chain") ??
          url.searchParams.get("b") ??
          ""
        ).toLowerCase();
        const addressParam = (
          url.searchParams.get("address") ??
          url.searchParams.get("a") ??
          ""
        ).toLowerCase();

        const truthy = (v: string | null) => {
          if (!v) return false;
          const s = v.toLowerCase();
          return s === "1" || s === "true" || s === "yes";
        };

        const upsert =
          truthy(url.searchParams.get("upsert")) ||
          truthy(url.searchParams.get("r"));
        const useDs =
          truthy(url.searchParams.get("useDs")) ||
          truthy(url.searchParams.get("use"));
        const auto = truthy(url.searchParams.get("auto"));

        const chain = chainParam;
        const address = addressParam;

        if (!address) {
          bad(res, 400, "missing address");
          return;
        }

        const t0 = Date.now();

        // 1) สร้าง token หนึ่งตัวจากพารามิเตอร์ (ถ้า Apps Script ไม่มีตัวนี้)
        const maybeTokens = await readTokensFromAppsScript().catch(() => []);
        const fromSheet = (maybeTokens || []).find(
          (t) => t.contract_address === address && (!chain || t.chain === chain)
        );
        const token = fromSheet ?? {
          chain: chain || "sol",
          contract_address: address,
          symbol: undefined,
          decimals: null,
          coingecko_id: null,
          cmc_id: null,
          cmc_slug: null,
          logo: null,
          allocationPct: null,
        };

        // 2) ดึง "ค่าจริงตามโปรดักชัน" ผ่าน fetchAllPrices
        const prodArr = await fetchAllPrices([token]);
        const prod = prodArr[0] || null;

        // 3) ดึง Dexscreener ตรงแบบ no-cache (ตรรกะเดียวกับ /debug/ds-why)
        const apiUrl = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(
          address
        )}?_t=${Date.now()}`;
        const r = await axios.get(apiUrl, {
          timeout: 15000,
          headers: {
            "Cache-Control": "no-cache",
            "User-Agent": "cron-price-fetcher/1.0",
          },
          validateStatus: (s) => s >= 200 && s < 500,
        });
        const pairs = Array.isArray(r.data?.pairs) ? r.data.pairs : [];

        const norm = (p: any) => ({
          chainId: p.chainId,
          dexId: p.dexId,
          pairAddress: p.pairAddress,
          quote: p?.quoteToken?.symbol,
          liq: Number(p?.liquidity?.usd ?? p?.liquidityUsd ?? 0),
          vol24h: Number(p?.volume?.h24 ?? p?.volume24h ?? 0),
          priceUsd: p?.priceUsd != null ? Number(p.priceUsd) : null,
        });
        const rows: DsRow[] = pairs.map(norm);

        // เลือก pool ตาม preferred quotes จาก /debug/ds-why
        const QUOTES = ["USDC", "USDT", "WETH", "SOL", "WBTC", "ETH", "BUSD"];
        const rowsPreferred = rows.filter((r: DsRow) =>
          QUOTES.includes(String(r.quote || "").toUpperCase())
        );
        const bestDs =
          (rowsPreferred.length ? rowsPreferred : rows)
            .filter((r: DsRow) => r.priceUsd != null)
            .sort((a: DsRow, b: DsRow) => b.liq - a.liq)[0] || null;

        // 4) เตรียมผลลัพธ์

        // คำนวณ diff ระหว่าง prod กับ DS สด
        const prodPrice = prod?.priceUsd != null ? Number(prod.priceUsd) : null;
        const dsPrice =
          bestDs?.priceUsd != null ? Number(bestDs.priceUsd) : null;
        let diffPct: number | null = null;
        let alert = false;
        if (prodPrice != null && dsPrice != null && dsPrice > 0) {
          diffPct = Math.abs((prodPrice - dsPrice) / dsPrice) * 100;
          // alert kept for backward compatibility but no longer used to gate upserts
          alert = false;
        }

        // Decide and perform upsert (supports ?useDs=1 and/or ?auto=1 to write DS when diff exceeds threshold)
        let upserted = false;
        let upsertSource: "ds" | "prod" | null = null;
        if (upsert) {
          const shouldUseDs = (useDs || auto) && bestDs?.priceUsd != null;

          const writeRow: PriceResult | null =
            shouldUseDs && prod
              ? {
                  chain: (prod.chain ?? token.chain) as string,
                  address: (prod.address ?? token.contract_address) as string,
                  priceChangeH24: (bestDs as any)?.priceChangeH24 ?? null,
                  marketCap: (bestDs as any)?.marketCap ?? null,
                  priceUsd: Number(bestDs!.priceUsd),
                  source: "dexscreener",
                  at: new Date().toISOString(),
                }
              : prod
              ? {
                  chain: prod.chain as string,
                  address: prod.address as string,
                  priceUsd: (prod.priceUsd ?? null) as number | null,
                  // เพิ่มข้อมูลจากตัวแปร prod (ดึงมาจาก Cache/Database)
                  priceChangeH24: (prod as any).priceChangeH24 ?? null,
                  marketCap: (prod as any).marketCap ?? null,
                  source: (prod.source ?? null) as any,
                  at: (prod.at ?? new Date().toISOString()) as string,
                }
              : null;

          if (writeRow) {
            await storeResults([writeRow]);
            upserted = true;
            upsertSource = shouldUseDs ? "ds" : "prod";
          }
        }

        ok(
          res,
          {
            ok: true,
            chain: token.chain,
            address: token.contract_address,
            ms: Date.now() - t0,
            prod: prod ?? null, // สิ่งที่โปรดักชันเลือกใช้จริง
            dsBest: bestDs ?? null, // สิ่งที่ DS สด ๆ เลือก (preferred quotes + liq)
            diffPct,
            alert, // true ถ้าต่างเกิน DIFF_ALERT %
            top5: rows.sort((a: DsRow, b: DsRow) => b.liq - a.liq).slice(0, 5),
            apiUrl, // ให้เห็น URL ที่ยิงจริง
            upserted,
            upsertSource,
          },
          3
        );
        return;
      } catch (e: any) {
        bad(res, 500, e?.message || String(e));
        return;
      }
    }

    bad(res, 404, "not found");
  } catch (e: any) {
    json(res, 500, { ok: false, error: e?.message || "internal error" });
  }
});
