// src/storage.ts
import { Pool } from "pg";
import type { PriceResult } from "./types.js";

// --- Config: เชื่อมต่อ Localhost Docker ---
export const pool = new Pool({
  user: "postgres",
  host: "127.0.0.1",
  database: "postgres",
  password: "Ch@mp5621375112",
  port: 5433,
  max: 20,
  idleTimeoutMillis: 30000,
});

// --- Helper: เปรียบเทียบทศนิยม (เหมือนไฟล์เก่า) ---
function parseNumericLoose(x: any): number | null {
  if (x === null || x === undefined) return null;
  const s = String(x).trim();
  if (s === "") return null;
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function eqApprox(a: any, b: any, rel = 1e-9, abs = 1e-15): boolean {
  const na = parseNumericLoose(a);
  const nb = parseNumericLoose(b);
  if (na === null && nb === null) return true;
  if (na === null || nb === null) return false;
  const diff = Math.abs(na - nb);
  return diff <= Math.max(abs, rel * Math.max(Math.abs(na), Math.abs(nb)));
}

export function cacheKey(chain: string, address: string) {
  return `price:${String(chain).toLowerCase()}:${String(
    address
  ).toLowerCase()}`;
}

// --- Helper: อ่านค่าเก่าจาก DB (Read Before) ---
async function readExistingTokens(
  keys: { chain: string; address: string }[]
): Promise<Map<string, any>> {
  if (keys.length === 0) return new Map();

  // สร้าง list สำหรับ query เช่น ($1, $2), ($3, $4)...
  const tuples = keys
    .map((_, i) => `($${i * 2 + 1}::text, $${i * 2 + 2}::text)`)
    .join(",");
  const values = keys.flatMap((k) => [k.chain, k.address]);

  const query = `
    SELECT chain, address, price_usd, price_change_h24, market_cap, source, at
    FROM prices
    WHERE (chain, address) IN (${tuples})
  `;

  try {
    const res = await pool.query(query, values);
    const map = new Map<string, any>();
    for (const row of res.rows) {
      const k = `${row.chain}|${row.address}`; // key เป็นตัวเล็กแน่นอนจาก DB
      map.set(k, {
        price_usd: row.price_usd ? Number(row.price_usd) : null,
        price_change_h24: row.price_change_h24
          ? Number(row.price_change_h24)
          : null,
        market_cap: row.market_cap ? Number(row.market_cap) : null,
        source: row.source,
        at: row.at,
      });
    }
    return map;
  } catch (e) {
    console.error("[readExisting] error:", e);
    return new Map();
  }
}

// --- Main Function: Store Results (Logic เก่า: Read -> Upsert -> Diff) ---
export async function storeResults(results: PriceResult[]) {
  if (!results.length) return;

  // 1. Prepare Data & Normalize (บังคับตัวเล็กแก้ปัญหาหาไม่เจอ)
  const inputs = results
    .map((r) => {
      const priceVal = parseNumericLoose(r.priceUsd);
      if (priceVal === null) return null; // ข้ามถ้าไม่มีราคา

      return {
        chain: r.chain.toLowerCase().trim(),
        address: r.address.toLowerCase().trim(),
        symbol: r.symbol || null,
        price_usd: priceVal,
        price_change_h24: parseNumericLoose(r.priceChangeH24),
        market_cap: parseNumericLoose(r.marketCap),
        source: r.source || "unknown",
        at: r.at ? new Date(r.at).toISOString() : new Date().toISOString(),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (inputs.length === 0) return;

  const t0 = Date.now();

  // 2. Read Existing (อ่านค่าเก่าก่อน)
  const keys = inputs.map((i) => ({ chain: i.chain, address: i.address }));
  const beforeMap = await readExistingTokens(keys);

  console.log(
    `[PG] preparing upsert ${inputs.length} rows (sample: ${
      inputs[0]?.symbol || inputs[0]?.address
    })...`
  );

  // 3. Perform Upsert (ใช้ UNNEST เพื่อความเร็วสูงสุดในการ insert หลายแถว)
  // ใช้ RETURNING * เพื่อจะได้ค่าหลังบันทึกทันที (แทนการ read อีกรอบ)
  const query = `
    INSERT INTO prices (chain, address, symbol, price_usd, price_change_h24, market_cap, source, at)
    SELECT * FROM UNNEST(
      $1::text[], $2::text[], $3::text[], $4::numeric[], $5::numeric[], $6::numeric[], $7::text[], $8::timestamptz[]
    )
    ON CONFLICT (chain, address)
    DO UPDATE SET
      price_usd = EXCLUDED.price_usd,
      price_change_h24 = EXCLUDED.price_change_h24,
      market_cap = EXCLUDED.market_cap,
      source = EXCLUDED.source,
      at = EXCLUDED.at,
      symbol = COALESCE(EXCLUDED.symbol, prices.symbol)
    RETURNING *;
  `;

  // เตรียม arrays สำหรับ binding
  const vChain = inputs.map((x) => x.chain);
  const vAddr = inputs.map((x) => x.address);
  const vSym = inputs.map((x) => x.symbol);
  const vPrice = inputs.map((x) => x.price_usd);
  const vChange = inputs.map((x) => x.price_change_h24);
  const vMcap = inputs.map((x) => x.market_cap);
  const vSrc = inputs.map((x) => x.source);
  const vAt = inputs.map((x) => x.at);

  try {
    const res = await pool.query(query, [
      vChain,
      vAddr,
      vSym,
      vPrice,
      vChange,
      vMcap,
      vSrc,
      vAt,
    ]);

    // 4. Compute Diff (เทียบ Before vs After)
    const changed: any[] = [];
    for (const row of res.rows) {
      const k = `${row.chain}|${row.address}`;
      const before = beforeMap.get(k);
      const afterPrice = Number(row.price_usd);
      const afterSource = row.source;

      // ถ้าไม่มีค่าเก่า หรือ ค่าเก่าไม่เท่ากับค่าใหม่ (ใช้ eqApprox)
      if (
        !before ||
        !eqApprox(before.price_usd, afterPrice) ||
        before.source !== afterSource
      ) {
        changed.push({
          chain: row.chain,
          address: row.address,
          symbol: row.symbol,
          before_price: before?.price_usd ?? null,
          after_price: afterPrice,
          before_source: before?.source ?? null,
          after_source: afterSource,
          change_pct: before?.price_usd
            ? ((afterPrice - before.price_usd) / before.price_usd) * 100
            : 100,
        });
      }
    }

    // 5. Log ผลลัพธ์แบบละเอียด
    console.log(
      `[PG] ✅ Upserted ${res.rowCount} rows in ${
        Date.now() - t0
      }ms. Changed: ${changed.length}`
    );

    if (changed.length > 0) {
      console.log(
        "[PG] Sample changes:",
        JSON.stringify(changed.slice(0, 3), null, 2)
      );
    }
  } catch (e: any) {
    console.error("[PG] Upsert failed:", e.message);
  }
}

// --- Cache Helpers (สำหรับ Endpoint /prices) ---
export async function cacheGet<T>(key: string): Promise<T | null> {
  // ... (ส่วนนี้เหมือนเดิม ถ้าไม่ได้ใช้ single get บ่อยๆ ก็ไม่กระทบมาก)
  // แต่เพื่อให้ครบตาม Interface:
  const parts = key.split(":");
  if (parts.length < 3) return null;
  const chain = parts[1];
  const address = parts.slice(2).join(":");

  const res = await pool.query(
    "SELECT * FROM prices WHERE chain = $1 AND address = $2",
    [chain, address]
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    chain: r.chain,
    address: r.address,
    symbol: r.symbol,
    priceUsd: Number(r.price_usd),
    priceChangeH24: Number(r.price_change_h24),
    marketCap: Number(r.market_cap),
    source: r.source,
    at: r.at,
  } as unknown as T;
}

export async function readCacheBatch(
  tokens: { chain: string; contract_address: string }[]
) {
  const map = new Map();
  if (!tokens.length) return map;

  const tuples = tokens
    .map(
      (_, i) => `($${i * 2 + 1}::text, $${i * 2 + 2}::text)` // แก้ไข index ตรงนี้ให้ถูกต้อง
    )
    .join(",");

  // สร้าง values array ให้ถูกต้องตาม index
  const values: string[] = [];
  tokens.forEach((t) => {
    values.push(t.chain.toLowerCase());
    values.push(t.contract_address.toLowerCase());
  });

  const query = `
      SELECT chain, address, price_usd, price_change_h24, market_cap, source, at
      FROM prices
      WHERE (chain, address) IN (${tuples})
    `;

  try {
    const res = await pool.query(query, values);
    for (const r of res.rows) {
      const k = `${r.chain}|${r.address}`; // key lowercase
      map.set(k, {
        chain: r.chain,
        address: r.address,
        symbol: r.symbol,
        price_usd: r.price_usd,
        price_change_h24: r.price_change_h24,
        market_cap: r.market_cap,
        source: r.source,
        at: r.at,
      });
    }
  } catch (e) {
    console.error("[readCacheBatch] error:", e);
  }
  return map;
}

export async function pingSupabase(timeoutMs = 5000) {
  const t0 = Date.now();
  try {
    await pool.query("SELECT 1");
    return { ok: true, ms: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, ms: Date.now() - t0, error: e.message };
  }
}
