/**
 * Execution layer contracts (simulation stage).
 *
 * The paper engine in src/main.ts does NOT use these yet — it keeps filling
 * virtually at observed DexScreener prices. This module is the foundation for
 * Stage 1 (probe trading): one SwapExecutor interface with a Jupiter
 * implementation for Solana and 0x/Uniswap/PancakeSwap implementations for
 * EVM, plus a PaperExecutor that emulates swaps for tests and dry runs.
 *
 * Staging rule: quote/simulate paths may hit live APIs (read-only);
 * buy/sell on network adapters throw unless LIVE_TRADING_ENABLED=true AND
 * a trader key is configured. There is no silent path to spending money.
 */

export type ExecutionChain = string; // "solana" | "bsc" | "base" | ...

export interface QuoteRequest {
  chain: ExecutionChain;
  /** EVM chain id (1, 56, 8453, 4663, …). Omitted on Solana. */
  chainId?: number;
  /** Token contract/mint being spent. */
  sellToken: string;
  /** Token contract/mint being received. */
  buyToken: string;
  /** Exact-input amount, base units, decimal string. */
  sellAmountBaseUnits: string;
  /** Trader wallet address (taker). */
  taker: string;
  slippageBps: number;
  sellDecimals?: number;
  buyDecimals?: number;
  /**
   * Observed mark price (buyToken per sellToken, natural units). Used ONLY
   * by the PaperExecutor and tests — live adapters ignore it and return
   * routed prices.
   */
  markPrice?: number;
}

export interface Quote {
  /** Adapter that produced it: "0x" | "uniswap" | "pancakeswap" | "jupiter" | "paper". */
  source: string;
  chain: ExecutionChain;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  /** Percent, or null when the venue doesn't report it. */
  priceImpactPct: number | null;
  /** Basis points, or null when unreported. */
  buyTaxBps: number | null;
  /** Basis points, or null when unreported. */
  sellTaxBps: number | null;
  estimatedGasUnits: number | null;
  /** Executable transaction payload (aggregators). Absent on paper quotes. */
  to?: string;
  calldata?: string;
  value?: string;
  /** Original venue response, for debugging. */
  raw: unknown;
}

export interface SwapRequest {
  quote: Quote;
  taker: string;
  slippageBps: number;
}

export interface SimulationResult {
  ok: boolean;
  reason?: string;
  gasUsed?: bigint | null;
  returnData?: string | null;
}

export interface ExecutionResult {
  ok: boolean;
  /** On-chain transaction hash (live fills only). */
  hash?: string;
  sellAmount: string;
  buyAmount: string;
  reason?: string;
}

export interface RiskPolicy {
  maxPriceImpactPct: number;
  maxBuyTaxBps: number;
  maxSellTaxBps: number;
  /** Minimum acceptable output, base units. Null disables. */
  minBuyAmountBaseUnits?: string | null;
  maxGasUnits?: number | null;
}

export interface RiskAssessment {
  pass: boolean;
  /** Blocking violations. */
  reasons: string[];
  /** Non-blocking observations (e.g. venue didn't report impact). */
  warnings: string[];
}

export interface SwapExecutor {
  readonly name: string;
  /** Spend quote currency, receive token (exact input). */
  quoteBuy(request: QuoteRequest): Promise<Quote>;
  /** Spend token, receive quote currency (exact input). */
  quoteSell(request: QuoteRequest): Promise<Quote>;
  simulate(request: SwapRequest): Promise<SimulationResult>;
  buy(request: SwapRequest): Promise<ExecutionResult>;
  sell(request: SwapRequest): Promise<ExecutionResult>;
}

/** Live-spend gate: network buy/sell throw unless explicitly enabled. */
export function liveTradingEnabled(): boolean {
  return (process.env.LIVE_TRADING_ENABLED ?? "").toLowerCase() === "true";
}

export function requireLive(action: string): void {
  if (!liveTradingEnabled()) {
    throw new Error(
      `${action} refused: live execution is not enabled (set LIVE_TRADING_ENABLED=true with a configured trader key)`,
    );
  }
}
