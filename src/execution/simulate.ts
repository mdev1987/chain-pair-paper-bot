import type { Quote, QuoteRequest, RiskPolicy } from "./types.ts";
import { assessQuoteRisk } from "./risk.ts";
import { routeQuote, type QuoteAdapter } from "./evm/router.ts";
import { ZeroExExecutor } from "./evm/zeroex.ts";
import { UniswapV2DirectExecutor } from "./evm/uniswap.ts";
import { JupiterExecutor } from "./solana/jupiter.ts";
import { EVM_CHAIN_IDS, getEvmPublicClient, getEvmTokenDecimals } from "./evm/viem-client.ts";
import { simulateEvmCall } from "./evm/simulator.ts";

/**
 * Simulation orchestrator: parallel real-quote diagnostics for paper fills.
 * NEVER gates trading — every failure path returns a skipped result with a
 * reason instead of throwing, and main.ts only logs + ledgers the outcome.
 */

/** Well-known quote-currency decimals (entries always spend these). */
export const KNOWN_QUOTE_DECIMALS: Record<string, number> = {
  usdc: 6,
  usdt: 6,
  sol: 9,
  wsol: 9,
  weth: 18,
  eth: 18,
  bnb: 18,
  wbnb: 18,
  avax: 18,
  waxav: 18,
  matic: 18,
  wmatic: 18,
  pol: 18,
};

/** Zero address: eth_call simulation sender when no trader is configured. */
export const SIM_ZERO_TAKER = "0x0000000000000000000000000000000000000000";

/** Lenient observation policy: we record deviations, we don't gate entries. */
export const SIM_RISK_POLICY: RiskPolicy = {
  maxPriceImpactPct: 25,
  maxBuyTaxBps: 1000,
  maxSellTaxBps: 1000,
};

/** Exact USD → base units without float error above cents precision. */
export function usdToBaseUnits(usd: number, decimals: number): string {
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("USD amount must be positive");
  return ((BigInt(Math.round(usd * 1_000_000)) * 10n ** BigInt(decimals)) / 1_000_000n).toString();
}

/** Exact natural-qty → base units without float error above 1e-6 units. */
export function qtyToBaseUnits(qty: number, decimals: number): string {
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("Quantity must be positive");
  return ((BigInt(Math.round(qty * 1_000_000)) * 10n ** BigInt(decimals)) / 1_000_000n).toString();
}

/** Quote price of the quote currency in USD from a DexScreener print. */
export function quotePriceUsd(priceUsd: number, priceNative: number | null, quoteSymbol: string): number | null {
  if (Number.isFinite(priceNative) && (priceNative as number) > 0) {
    return priceUsd / (priceNative as number);
  }
  // Stablecoins trade at $1 by definition; anything else is unknowable here.
  return ["usdc", "usdt"].includes(quoteSymbol.toLowerCase()) ? 1 : null;
}

/** Adapter set per chain. Pure construction — no network until quoting. */
export function quoteAdaptersFor(chain: string, pairAddress?: string): QuoteAdapter[] {
  if (chain === "solana") return [new JupiterExecutor()];
  if (EVM_CHAIN_IDS[chain] === undefined) return [];
  const adapters: QuoteAdapter[] = [new ZeroExExecutor()];
  if (pairAddress) {
    try {
      adapters.push(new UniswapV2DirectExecutor(pairAddress));
    } catch {
      // Invalid pair address: aggregator-only routing.
    }
  }
  return adapters;
}

export interface SimCheckInput {
  chain: string;
  chainId?: number;
  side: "BUY" | "SELL";
  sellToken: string;
  buyToken: string;
  sellAmountBaseUnits: string;
  sellDecimals: number;
  buyDecimals: number | null;
  pairAddress?: string;
  taker: string;
  slippageBps: number;
}

export interface SimCheckResult {
  attempted: boolean;
  source: string;
  quotedSellAmount: string;
  quotedBuyAmount: string;
  riskPass: boolean | null;
  riskReasons: string[];
  simOk: boolean | null;
  note: string;
}

function skipped(note: string): SimCheckResult {
  return {
    attempted: false,
    source: "skipped",
    quotedSellAmount: "",
    quotedBuyAmount: "",
    riskPass: null,
    riskReasons: [],
    simOk: null,
    note,
  };
}

export async function simulateSwap(input: SimCheckInput): Promise<SimCheckResult> {
  const adapters = quoteAdaptersFor(input.chain, input.pairAddress);
  if (adapters.length === 0) return skipped(`unsupported-chain ${input.chain}`);

  const request: QuoteRequest = {
    chain: input.chain,
    ...(input.chainId !== undefined ? { chainId: input.chainId } : {}),
    sellToken: input.sellToken,
    buyToken: input.buyToken,
    sellAmountBaseUnits: input.sellAmountBaseUnits,
    taker: input.taker,
    slippageBps: input.slippageBps,
    sellDecimals: input.sellDecimals,
    ...(input.buyDecimals !== null ? { buyDecimals: input.buyDecimals } : {}),
  };

  let quote: Quote;
  try {
    quote = await routeQuote(adapters, request, input.side === "BUY" ? "buy" : "sell");
  } catch (error) {
    return skipped(`no-quotable-route: ${String(error).slice(0, 200)}`);
  }

  const risk = assessQuoteRisk(quote, SIM_RISK_POLICY);

  // eth_call simulation needs executable calldata (EVM aggregator/direct
  // quotes). Jupiter has no local simulate path yet.
  let simOk: boolean | null = null;
  let simNote = "no-local-simulate";
  if (quote.to && quote.calldata && input.chain !== "solana") {
    try {
      const client = getEvmPublicClient(input.chain);
      const sim = await simulateEvmCall(client, {
        from: input.taker as `0x${string}`,
        to: quote.to as `0x${string}`,
        calldata: quote.calldata as `0x${string}`,
        ...(quote.value ? { value: BigInt(quote.value) } : {}),
      });
      simOk = sim.ok;
      simNote = sim.ok ? "eth-call-ok" : `eth-call-revert: ${(sim.reason ?? "").slice(0, 150)}`;
    } catch (error) {
      simNote = `sim-error: ${String(error).slice(0, 150)}`;
    }
  }

  return {
    attempted: true,
    source: quote.source,
    quotedSellAmount: quote.sellAmount,
    quotedBuyAmount: quote.buyAmount,
    riskPass: risk.pass,
    riskReasons: [...risk.reasons, ...risk.warnings.map((w) => `warn:${w}`)],
    simOk,
    note: [quote.source, simNote, ...risk.reasons].filter(Boolean).join(" | "),
  };
}

/** Resolve position-token decimals for exit simulation (EVM on-chain read). */
export async function resolveTokenDecimals(chain: string, token: string): Promise<number | null> {
  if (chain === "solana" || EVM_CHAIN_IDS[chain] === undefined) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) return null;
  try {
    return await getEvmTokenDecimals(chain, token as `0x${string}`);
  } catch {
    return null;
  }
}
