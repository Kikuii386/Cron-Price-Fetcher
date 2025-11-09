import * as http from "http";
import axios from "axios";
import { CFG } from "./config.js";
import { fetchAllPrices } from "./core/fetchPrice.js";
import { storeResults, cacheGet, cacheKey } from "./storage.js";
import { pingSupabase } from './storage.js';
import type { SheetTokenRow, PriceResult } from "./types.js";
import { createClient } from '@supabase/supabase-js';

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
  return { totals: { total: prices.length, withPrice, nulls: prices.length - withPrice }, bySource };
}

function normalizeToken(x: any): SheetTokenRow | null {
  const chain = String(x.chain || x.cmcChain || "").trim().toLowerCase();
  const address = String(x.contract || x.address || "").trim().toLowerCase();
  if (!chain || !address) return null;
  const symbol = (x.name || x.symbol || "").toString().replace(/^\$/, "") || undefined;
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
  const prices = await fetchAllPrices(tokens);
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
    const prices = await fetchAllPrices(tokens);
    summary.fetch = {
      count: prices.length,
      ms: Date.now() - t2,
      bySource: prices.reduce((acc: any, p: any) => {
        const k = p.source || 'unknown';
        if (p.priceUsd != null && Number(p.priceUsd) > 0) acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {}),
    };

    const t3 = Date.now();
    await storeResults(prices);
    summary.store = { ms: Date.now() - t3 };

    summary.ok = true;
    summary.totalMs = Date.now() - t0;
    LAST_RUN_SUMMARY = summary;
  } catch (e: any) {
    summary.ok = false;
    summary.error = e?.message || String(e);
    summary.totalMs = Date.now() - t0;
    LAST_RUN_SUMMARY = summary;
  }
}

// --- Server ---
const server = http.createServer(async (req, res) => {
  try {
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

    const url = new URL(req.url || "/", `http://${req.headers.host}`);

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

      // Blocking mode (legacy): execute and return summary
      const prices = await runOnce();

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

      const summary = summarize(prices);
      ok(
        res,
        {
          ok: true,
          total: summary.totals.total,
          count: summary.totals.withPrice,
          nulls: summary.totals.nulls,
          bySource: summary.bySource,
          at: new Date().toISOString(),
        },
        30
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/prices") {
      // Read tokens → read cached prices in parallel → return compact payload
      const tokens = await readTokensFromAppsScript();
      const asOf = new Date().toISOString();
      if (!tokens.length) {
        ok(res, { asOf, prices: [] }, 15);
        return;
      }

      const keys = tokens.map((t) => cacheKey(t.chain, t.contract_address));
      const cached = await Promise.all(keys.map((k) => cacheGet<PriceResult>(k)));
      let prices = cached.filter((v): v is PriceResult => !!v);

      const force = url.searchParams.get("refresh") === "1";
      const includeSummary = url.searchParams.get("summary") === "1";

      // Refresh only when explicitly requested or cache empty
      if (force || prices.length === 0) {
        prices = await fetchAllPrices(tokens);
        await storeResults(prices);
      }

      const body: any = { asOf, prices };
      if (includeSummary) body.summary = summarize(prices);
      ok(res, body, 60);
      return;
    }

    if (req.method === "GET" && url.pathname === "/stats") {
      const refresh = url.searchParams.get("refresh") === "1";
      const asyncMode = url.searchParams.get("async") === "1";
      const silent = url.searchParams.get("silent") === "1";

      const tokens = await readTokensFromAppsScript();
      const keys = tokens.map((t) => cacheKey(t.chain, t.contract_address));
      const cached = await Promise.all(keys.map((k) => cacheGet<PriceResult>(k)));
      let prices = cached.filter((v): v is PriceResult => !!v);

      if (refresh) {
        if (asyncMode) {
          setImmediate(async () => {
            try {
              const fresh = await fetchAllPrices(tokens);
              await storeResults(fresh);
              const s = summarize(fresh);
              console.log(
                `[stats refresh async] total=${s.totals.total} ok=${s.totals.withPrice} nulls=${s.totals.nulls} src=${JSON.stringify(s.bySource)}`
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

    // Debug: quick CoinGecko probe to verify connectivity and ids
    if (req.method === "GET" && url.pathname === "/debug/gecko") {
      try {
        const tokens = await readTokensFromAppsScript();
        const ids = Array.from(
          new Set(
            tokens
              .map((t) => t.coingecko_id)
              .filter((x): x is string => !!x)
          )
        ).slice(0, 25); // probe first 25 ids

        if (ids.length === 0) {
          ok(res, { ok: true, note: "no coingecko_id in tokens" });
          return;
        }

        const urlCg = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.map(encodeURIComponent).join(",")}&vs_currencies=usd`;
        const cg = await axios.get(urlCg, {
          timeout: 15000,
          headers: { Accept: "application/json", "User-Agent": "cron-price-fetcher/1.0" },
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
          idsRequested: ids.length,
          idsReturned: have.length,
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
      sample: tokens.slice(0, 3).map(t => ({ chain: t.chain, address: t.contract_address, geckoId: t.coingecko_id })),
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
    const keyEnv = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_ANON_KEY;
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
    if (req.method === 'GET' && url.pathname === '/debug/pings') {
      try {
        const dsT0 = Date.now();
        let dsOk = false, dsMs = 0, dsErr: string | undefined;
        try {
          const ds = await axios.get(
            'https://api.dexscreener.com/latest/dex/tokens/0x88faea256f789f8dd50de54f9c807eef24f71b16',
            { timeout: 8000, validateStatus: s => s >= 200 && s < 500 }
          );
          dsOk = ds.status === 200;
          dsMs = Date.now() - dsT0;
          if (!dsOk) dsErr = `http ${ds.status}`;
        } catch (e: any) {
          dsMs = Date.now() - dsT0;
          dsErr = e?.message || String(e);
        }

        const sb = await pingSupabase(8000);

        ok(res, {
          asOf: new Date().toISOString(),
          dexscreener: { ok: dsOk, ms: dsMs, error: dsErr },
          supabase: sb,
        }, 5);
        return;
      } catch (e: any) {
        bad(res, 500, e?.message || String(e));
        return;
      }
    }

// Debug: show last run summary if available
if (req.method === 'GET' && url.pathname === '/debug/last-run') {
  ok(res, LAST_RUN_SUMMARY ?? { ok: false, error: 'no run yet' }, 0);
  return;
}

// Debug: ตรวจว่าทำไมราคา Dexscreener ไม่ตรง (ดูคู่/พูลทั้งหมดและตัวที่เลือก)
if (req.method === "GET" && url.pathname === "/debug/ds-why") {
  try {
    const chain = (url.searchParams.get("chain") || "").toLowerCase();
    const address = (url.searchParams.get("address") || "").toLowerCase();
    if (!address) {
      bad(res, 400, "missing address");
      return;
    }

    // ดึงทุกคู่ของ token นี้ (ปิด cache)
    const apiUrl = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}?_t=${Date.now()}`;
    const r = await axios.get(apiUrl, {
      timeout: 15000,
      headers: { "Cache-Control": "no-cache", "User-Agent": "cron-price-fetcher/1.0" },
      validateStatus: s => s >= 200 && s < 500,
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

    const rows = pairs.map(norm);

    // เลือก best โดย 2 เกณฑ์ให้เห็นความต่าง
    const byLiq = [...rows].sort((a,b) => (b.liq - a.liq))[0] || null;

    const QUOTES = ["USDC","USDT","WETH","SOL","WBTC","ETH","BUSD"];
    const rowsPreferred = rows.filter(r => QUOTES.includes(String(r.quote || "").toUpperCase()));
    const byPreferredThenLiq = (rowsPreferred.length ? rowsPreferred : rows)
      .sort((a,b) => (b.liq - a.liq))[0] || null;

    ok(res, {
      ok: true,
      queried: { chain, address },
      count: rows.length,
      top5: rows.sort((a,b)=>b.liq-a.liq).slice(0,5),
      pickByLiq: byLiq,
      pickPreferredThenLiq: byPreferredThenLiq,
    }, 5);
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

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => {
  console.log(`[server] listening on ${PORT}`);
});