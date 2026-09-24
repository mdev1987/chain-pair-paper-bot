import type {
  ExecutionResult,
  Quote,
  QuoteRequest,
  SimulationResult,
  SwapExecutor,
  SwapRequest,
} from "../types.ts";
import { requireLive } from "../types.ts";
import { VersionedTransaction, type Keypair } from "@solana/web3.js";
import { loadTraderKeypair, traderPublicKey } from "./signer.ts";
import { checkBuyPreconditions, maxSizeFor } from "../live-guard.ts";
import { assessQuoteRisk } from "../risk.ts";
import { SIM_RISK_POLICY } from "../simulate.ts";

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

/**
 * Taker query param for /order: omitted for quote-only diagnostics.
 * The EVM zero address is not a valid Solana pubkey — sending it 400s
 * with "Invalid taker". Returns null when the param must be left off.
 */
export function jupiterTakerParam(taker: string): string | null {
  if (!taker) return null;
  if (/^0x0{40}$/i.test(taker)) return null;
  if (taker.startsWith("0x")) return null; // any other EVM address
  if (taker.length < 32 || taker.length > 44) return null;
  return taker;
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
  const taker = jupiterTakerParam(request.taker);
  if (taker) params.set("taker", taker);
  const response = await fetch(`${JUPITER_V2_BASE}/order?${params}`, {
    headers: { accept: "application/json", ...apiKeyHeader() },
  });
  if (!response.ok) {
    throw new Error(`Jupiter HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return (await response.json()) as JupiterOrderResponse;
}

export interface JupiterExecuteResponse {
  status?: string;
  signature?: string;
  slot?: string;
  error?: string;
  code?: number;
  /** Actual wallet deltas — the basis for fill extraction (Phase 1.2). */
  totalInputAmount?: string;
  totalOutputAmount?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
}

/**
 * Deserialize a /order transaction and sign it with the trader keypair.
 * Offline-capable (no network). Throws on missing/malformed input.
 */
export function signJupiterOrder(
  transactionB64: string,
  signer: Keypair = loadTraderKeypair(),
): string {
  if (!transactionB64) throw new Error("Jupiter order has no transaction to sign");
  let bytes: Buffer;
  try {
    bytes = Buffer.from(transactionB64, "base64");
  } catch {
    throw new Error("Jupiter transaction is not valid base64");
  }
  if (bytes.length === 0) throw new Error("Jupiter transaction is empty");
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(bytes);
  } catch (error) {
    throw new Error(`Jupiter transaction malformed: ${String(error).slice(0, 120)}`);
  }
  tx.sign([signer]);
  return Buffer.from(tx.serialize()).toString("base64");
}

/**
 * POST /execute: Jupiter lands the signed tx (managed priority fees,
 * confirmation polling, retries) and returns the signature plus actual
 * wallet deltas. Throws when status is not Success.
 */
export async function executeJupiterOrder(
  signedTransaction: string,
  requestId: string,
): Promise<JupiterExecuteResponse> {
  if (!requestId) throw new Error("Jupiter execute needs the /order requestId");
  const response = await fetch(`${JUPITER_V2_BASE}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json", ...apiKeyHeader() },
    body: JSON.stringify({ signedTransaction, requestId }),
  });
  if (!response.ok) {
    throw new Error(`Jupiter execute HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const result = (await response.json()) as JupiterExecuteResponse;
  if (result.status !== "Success" || !result.signature) {
    throw new Error(
      `Jupiter execute ${result.status ?? "Failed"} [${result.code ?? "?"}]: ${(result.error ?? "unknown").slice(0, 300)}`,
    );
  }
  return result;
}

export interface JupiterLiveFill {
  signature: string;
  sellAmount: string;
  buyAmount: string;
}

/**
 * Full live flow: /order (trader as taker) → sign → /execute → verified
 * amounts from the execution result (preferred) or the order quote.
 * Throws on any failure — callers must not assume a fill.
 */
export async function executeJupiterSwap(request: QuoteRequest): Promise<JupiterLiveFill> {
  const order = await fetchJupiterOrder({ ...request, taker: traderPublicKey() });
  if (!order.transaction) {
    throw new Error("Jupiter order built no transaction (unindexed or unbuildable route)");
  }
  if (!order.requestId) throw new Error("Jupiter order missing requestId");
  const signed = signJupiterOrder(order.transaction);
  const result = await executeJupiterOrder(signed, order.requestId);
  return {
    signature: result.signature as string,
    sellAmount: result.totalInputAmount ?? String(order.inAmount ?? request.sellAmountBaseUnits),
    buyAmount: result.totalOutputAmount ?? String(order.outAmount ?? "0"),
  };
}

/**
 * quote is live (keyless or JUPITER_API_KEY). buy/sell execute for real
 * behind requireLive + the buy safety invariant (live-guard.ts).
 * Exits bypass the entry gate but never the live flag.
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

  async buy(
    request: SwapRequest & { sizeUsd?: number; positionId?: string },
  ): Promise<ExecutionResult> {
    requireLive("Jupiter buy");
    // Safety invariant: every condition must pass, else NO TRANSACTION.
    // Fail-closed on size: live callers must state the USD size.
    const risk = assessQuoteRisk(request.quote, SIM_RISK_POLICY);
    const sizeUsd = request.sizeUsd ?? NaN;
    const verdict = checkBuyPreconditions({
      chain: request.quote.chain,
      sizeUsd,
      riskPass: risk.pass,
      simOk: null, // Solana/Jupiter: no local simulate; /execute confirms instead.
      quoteSource: request.quote.source,
      ...(request.positionId !== undefined ? { positionId: request.positionId } : {}),
    });
    if (!verdict.ok) {
      throw new Error(`Live buy refused: ${verdict.failures.join("; ")}`);
    }
    const fill = await executeJupiterSwap({
      chain: request.quote.chain,
      sellToken: request.quote.sellToken,
      buyToken: request.quote.buyToken,
      sellAmountBaseUnits: request.quote.sellAmount,
      taker: request.taker,
      slippageBps: request.slippageBps,
    });
    return { ok: true, hash: fill.signature, sellAmount: fill.sellAmount, buyAmount: fill.buyAmount };
  }

  async sell(request: SwapRequest): Promise<ExecutionResult> {
    // Exits bypass the entry gate (positions must always be exitable) but
    // never the live flag.
    requireLive("Jupiter sell");
    const fill = await executeJupiterSwap({
      chain: request.quote.chain,
      sellToken: request.quote.sellToken,
      buyToken: request.quote.buyToken,
      sellAmountBaseUnits: request.quote.sellAmount,
      taker: request.taker,
      slippageBps: request.slippageBps,
    });
    return { ok: true, hash: fill.signature, sellAmount: fill.sellAmount, buyAmount: fill.buyAmount };
  }
}
