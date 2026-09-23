import type {
  ExecutionResult,
  Quote,
  QuoteRequest,
  SimulationResult,
  SwapExecutor,
} from "../types.ts";
import { requireLive } from "../types.ts";

/**
 * Jupiter Swap API V2 adapter (Solana) — Meta-Aggregator path.
 *
 * GET /swap/v2/order returns quote + assembled transaction in one call
 * (all routers compete: Metis, JupiterZ, Dflow, OKX); POST /swap/v2/execute
 * lands it with managed priority fees and confirmation polling.
 * Auth: x-api-key header (JUPITER_API_KEY); keyless works at 0.5 RPS.
 *
 * COST NOTE for the paper model: /order charges a platform fee that depends
 * on pair type — 50 bps for NEW TOKENS (within 24h of token age), which is
 * every pool this bot trades. Our NET_PNL_100BPS_1PCT shadow model absorbs
 * it, but treat per-side live cost on Solana as >= 50 bps fee + slippage.
 */
const JUPITER_V2_BASE = "https://api.jup.ag/swap/v2";

export interface JupiterOrderResponse {
  inAmount?: string;
  outAmount?: string;
  /** Signed percent string (can be negative). */
  priceImpactPct?: string | number;
  router?: string;
  mode?: string;
  feeBps?: number;
  feeMint?: string;
  /** Base64 tx with taker; null without taker; "" when unbuildable. */
  transaction?: string | null;
  requestId?: string;
  errorCode?: number;
  errorMessage?: string;
  error?: string;
}

function apiKeyHeader(): Record<string, string> {
  const key = process.env.JUPITER_API_KEY ?? "";
  return key ? { "x-api-key": key } : {};
}

function numOrNull(value: unknown): number | null {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Pure mapping, fixture-tested against a live V2 response shape. */
export function mapJupiterOrder(
  request: QuoteRequest,
  raw: JupiterOrderResponse,
): Quote {
  if (raw.error) {
    throw new Error(`Jupiter order failed: ${String(raw.error).slice(0, 200)}`);
  }
  if (!raw.inAmount || !raw.outAmount) {
    throw new Error("Jupiter order missing inAmount/outAmount (no route)");
  }
  if (raw.transaction === "") {
    // Quoted but unbuildable — match on router + errorCode, never the message.
    throw new Error(
      `Jupiter order unbuildable [${raw.router ?? "?"}:${raw.errorCode ?? "?"}]: ${(raw.errorMessage ?? "unknown").slice(0, 200)}`,
    );
  }
  return {
    source: "jupiter",
    chain: request.chain,
    sellToken: request.sellToken,
    buyToken: request.buyToken,
    sellAmount: String(raw.inAmount),
    buyAmount: String(raw.outAmount),
    priceImpactPct: numOrNull(raw.priceImpactPct),
    // /order fees are platform fees, NOT token transfer taxes — keep them
    // out of the tax fields and read feeBps/feeMint from raw instead.
    buyTaxBps: null,
    sellTaxBps: null,
    estimatedGasUnits: null,
    raw,
  };
}

export async function fetchJupiterOrder(
  request: QuoteRequest,
): Promise<JupiterOrderResponse> {
  const params = new URLSearchParams({
    inputMint: request.sellToken,
    outputMint: request.buyToken,
    amount: request.sellAmountBaseUnits,
    slippageBps: String(request.slippageBps),
  });
  // Taker omitted = quote-only (no assembled transaction). Used for
  // simulation diagnostics when no trader address is configured.
  if (request.taker) params.set("taker", request.taker);
  const response = await fetch(`${JUPITER_V2_BASE}/order?${params}`, {
    headers: { accept: "application/json", ...apiKeyHeader() },
  });
  if (!response.ok) {
    throw new Error(`Jupiter HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return (await response.json()) as JupiterOrderResponse;
}

/**
 * quote is live (keyless or JUPITER_API_KEY); simulate/buy/sell stay gated.
 * Stage 1 work: sign order.transaction (web3.js/kit) and POST /execute with
 * { signedTransaction, requestId }.
 */
export class JupiterExecutor implements SwapExecutor {
  readonly name = "jupiter";

  async quoteBuy(request: QuoteRequest): Promise<Quote> {
    return mapJupiterOrder(request, await fetchJupiterOrder(request));
  }

  async quoteSell(request: QuoteRequest): Promise<Quote> {
    return mapJupiterOrder(request, await fetchJupiterOrder(request));
  }

  async simulate(): Promise<SimulationResult> {
    throw new Error("Jupiter adapter has no local simulate yet (Stage 1: sign order.transaction, POST /execute)");
  }

  async buy(): Promise<ExecutionResult> {
    requireLive("Jupiter buy");
    throw new Error("unreachable");
  }

  async sell(): Promise<ExecutionResult> {
    requireLive("Jupiter sell");
    throw new Error("unreachable");
  }
}
