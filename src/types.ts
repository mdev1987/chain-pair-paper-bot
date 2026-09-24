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

/**
 * Per-chain exit regime attached at open. Absent = global config behavior
 * (and every unit test). Lets Solana bank fast with a short leash while
 * Robinhood keeps a larger runner — same engine, different regime.
 */
export interface ExitProfile {
  /** 1–3 TP levels, gains strictly ascending, sells % of ORIGINAL qty. */
  tp: ReadonlyArray<{ gainPct: number; sellPct: number }>;
  initialStopPct: number;
  trailActivationPct: number;
  trailDistancePct: number;
  /** Consecutive ticks above the trail high required to ratchet (wick-proofing). 1 = every print. */
  trailConfirmTicks: number;
  breakevenArmPct: number;
  breakevenBufferPct: number;
  breakevenAfterTp1: boolean;
  earlyStopPct: number;
  earlyStopWindowSec: number;
  maxPositionAgeMin: number;
  /** Hard drain exit when venue liquidity falls below this % of entry. */
  drainLiquidityPct: number;
  /** Remainder is worthless below this venue liquidity USD (unexitable). */
  deadLiquidityUsd: number;
}

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
  /** Lowest quoted price seen since open — for MAE/giveback research. */
  lowestPrice: number;
  /** When highestPrice was last set (ms epoch) — for time-to-MFE. */
  highestAt: number;
  /** When lowestPrice was last set (ms epoch) — for time-to-MAE. */
  lowestAt: number;
  quantity: number;
  originalQuantity: number;
  initialUsdSize: number;

  realizedPnlUsd: number;
  totalEntryFeeUsd: number;
  totalExitFeeUsd: number;
  totalSlippageUsd: number;
  /**
   * Shadow cost-model accrual (NET_PNL_100BPS_1PCT): modeled fee/slippage
   * for research reporting only. Never touches simulated cash — see
   * SHADOW_* in position.ts.
   */
  shadowFeeUsd: number;
  shadowSlipUsd: number;

  openedAt: number;
  updatedAt: number;
  closedAt?: number;
  closedReason?: string;
  /**
   * Stop level (price) that triggered the exit, captured at close time.
   * Lets the ledger separate trigger from fill to detect gap-through-stop.
   * TIME_EXIT sets it to the exit price itself (no stop involved).
   */
  exitTriggerPrice?: number;

  trailingActive: boolean;
  breakevenArmed: boolean;
  /**
   * Confirmed trail high (wick-proof: see trailConfirmTicks). Optional for
   * state-file compatibility — pre-trail positions backfill from
   * highestPrice on first update.
   */
  trailHigh?: number;
  /** Consecutive ticks printing above trailHigh (ratchet progress). */
  highStreak?: number;
  status: PositionStatus;
  tpHit: [boolean, boolean, boolean];
  /**
   * Exit regime snapshot at open. Optional for state-file compatibility:
   * pre-profile positions fall back to global config.
   */
  exitProfile?: ExitProfile;
  /** Portfolio equity just before entry (set by caller for reporting). */
  balanceBeforeUsd?: number;
  /**
   * Portfolio EQUITY (cash + open-position market value) just after full
   * close — not cash. Named balanceAfterUsd for state-file compatibility;
   * compare against balanceBeforeUsd (also equity) or the ledger's
   * cash/equity columns, never against cash alone. Other open positions
   * move between entry and close, so after-minus-before is portfolio drift,
   * not this trade's PnL (see totalPnlUsd for the trade itself).
   */
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
