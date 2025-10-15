export type Chain = "eth" | "bsc" | "polygon" | "base" | "solana" | string;

export interface SheetTokenRow {
  chain: Chain;                   // เช่น "sol", "eth"
  cmcChain?: string;              // เช่น "solana", "ethereum"
  contract_address: string;       // contract / mint
  symbol?: string;
  decimals?: number | null;
  coingecko_id?: string | null;   // = slug จาก Apps Script: geckoId
  cmc_id?: number | null;         // (มีไว้เฉยๆ หากต้องใช้ทีหลัง)
  cmc_slug?: string | null;       // = slug จาก Apps Script: cmcSlug
  logo?: string | null;           // URL โลโก้เหรียญ
  allocationPct?: number | null;  // สัดส่วน allocation (0-100)
}

export interface PriceResult {
  chain: Chain;
  address: string;
  symbol?: string;
  priceUsd: number | null;
  source: "dexscreener" | "coingecko" | "cmc" | null;
  at: string; // ISO timestamp
}