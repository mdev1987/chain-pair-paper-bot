export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url?: string;
  pairAddress: string;
  labels?: string[];
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: Record<string, { buys?: number; sells?: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: unknown;
  boosts?: { active?: number };
}

export interface Candidate {
  key: string;
  chain: string;
  poolAddress: string;
  pairAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  quoteSymbol: string;
  dexId: string;
  pair: DexScreenerPair;
  discoveredAt: number;
  poolCreatedAt: number;
}

export type PositionStatus = "OPEN" | "CLOSED";

export interface Position {
  id: string;
  chain: string;
  pairAddress: string;
  tokenAddress: string;
  symbol: string;
  tokenName: string;
  quoteSymbol: string;
  dexId: string;
  pairUrl?: string;

  entryPrice: number;
  currentPrice: number;
  highestPrice: number;
  quantity: number;
  originalQuantity: number;
  initialUsdSize: number;

  realizedPnlUsd: number;
  totalEntryFeeUsd: number;
  totalExitFeeUsd: number;
  totalSlippageUsd: number;

  openedAt: number;
  updatedAt: number;
  closedAt?: number;
  closedReason?: string;

  trailingActive: boolean;
  breakevenArmed: boolean;
  status: PositionStatus;
  tpHit: [boolean, boolean, boolean];
  /** Portfolio equity just before entry (set by caller for reporting). */
  balanceBeforeUsd?: number;
  /** Portfolio equity just after full close (set by caller for reporting). */
  balanceAfterUsd?: number;
  /** DexPaprika pool id from discovery (may differ from DexScreener pairAddress). */
  poolAddress?: string;
  /** Venue liquidity USD observed at entry — kept for later analysis. */
  entryLiquidityUsd?: number;
  /** Pool age in seconds at discovery — kept for later analysis. */
  entryAgeSec?: number;
  /** Venue liquidity USD observed at close — set by the tracker. */
  exitLiquidityUsd?: number;
}

export interface PriceSnapshot {
  pair: DexScreenerPair;
  priceUsd: number;
  observedAt: number;
}
