import * as http from "http";
import axios from "axios";
import { CFG } from "./config.js";
import { fetchAllPrices } from "./core/fetchPrice.js";
import { storeResults, cacheGet, cacheKey } from "./storage.js";
import type { SheetTokenRow, PriceResult } from "./types.js";

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
  const address = String(x.contract || x.address || "").trim();
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
  const r = await axios.get(CFG.source.appsScriptUrl, {
    timeout: 20000,
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
            const prices = await runOnce();
            const summary = summarize(prices);
            console.log(
              `[run async] total=${summary.totals.total} ok=${summary.totals.withPrice} nulls=${summary.totals.nulls} src=${JSON.stringify(summary.bySource)}`
            );
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
      const redisEnabled = Boolean(CFG.cache.redisUrl && CFG.cache.redisToken);

      // Fallback: compute fresh if forced, or Redis disabled, or cache empty
      if (force || !redisEnabled || prices.length === 0) {
        prices = await fetchAllPrices(tokens);
        if (redisEnabled) await storeResults(prices);
      }

      const body: any = { asOf, prices };
      if (includeSummary) body.summary = summarize(prices);
      ok(res, body, 60);
      return;
    }

    if (req.method === "GET" && url.pathname === "/stats") {
      const tokens = await readTokensFromAppsScript();
      const keys = tokens.map((t) => cacheKey(t.chain, t.contract_address));
      const cached = await Promise.all(keys.map((k) => cacheGet<PriceResult>(k)));
      let prices = cached.filter((v): v is PriceResult => !!v);

      const force = url.searchParams.get("refresh") === "1";
      const redisEnabled = Boolean(CFG.cache.redisUrl && CFG.cache.redisToken);

      // ถ้า force หรือไม่มี Redis หรือ cache ว่าง ให้คำนวณสด
      if (force || !redisEnabled || prices.length === 0) {
        prices = await fetchAllPrices(tokens);
        if (redisEnabled) await storeResults(prices);
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

    bad(res, 404, "not found");
  } catch (e: any) {
    json(res, 500, { ok: false, error: e?.message || "internal error" });
  }
});

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => {
  console.log(`[server] listening on ${PORT}`);
});