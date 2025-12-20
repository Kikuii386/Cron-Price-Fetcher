// src/types.ts



export interface SheetTokenRow {
  chain: Chain;                   
  cmcChain?: string;              
  contract_address: string;       
  symbol?: string;
  decimals?: number | null;
  coingecko_id?: string | null;   
  cmc_id?: number | null;         
  cmc_slug?: string | null;       
  logo?: string | null;           
  allocationPct?: number | null;  
}

export type Chain = string;

export interface PriceResult {
  chain: Chain;
  address: string;
  symbol?: string;
  priceUsd: number | null;
  priceChangeH24: number | null; 
  marketCap: number | null;
  source: "dexscreener" | "coingecko" | "cmc" | null;
  at: string; // ISO timestamp
}