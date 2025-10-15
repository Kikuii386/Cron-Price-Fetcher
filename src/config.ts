import * as dotenv from "dotenv";

// โหลด .env.local ก่อน ถ้าไม่มี จะ fallback ไป .env อัตโนมัติ
dotenv.config({ path: ".env.local" });
dotenv.config(); // โหลดซ้ำจาก .env ถ้ามีตัวแปรที่ยังไม่มีค่า

export const CFG = {
  source: {
    appsScriptUrl: process.env.APPS_SCRIPT_URL!,
  },
  api: {
    coingeckoKey: process.env.COINGECKO_API_KEY || "",
    cmcKey: process.env.CMC_API_KEY || "",
    timeoutMs: 8000,
  },
  cache: {
    redisUrl: process.env.REDIS_URL || "",
    redisToken: process.env.REDIS_TOKEN || "",
    ttlSeconds: Number(process.env.REDIS_TTL || 120),
  },
  cron: {
    schedule: process.env.CRON_SCHEDULE || "*/5 * * * *", // default ทุก 5 นาที
  },
};