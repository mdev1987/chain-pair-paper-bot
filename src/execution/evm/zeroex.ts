import type {
  ExecutionResult,
  Quote,
  QuoteRequest,
  SimulationResult,
  SwapExecutor,
} from "../types.ts";
import { requireLive } from "../types.ts";

// 0x Swap API v2 (allowance-holder). v1 was sunset 2025-04-11 — do not
// revert to /swap/v1/* URLs. Docs: docs.0x.org, "getQuote (Allowance Holder)".
const ZEROEX_BASE = "https://api.0x.org/swap/allowance-holder";

interface ZeroExQuoteResponse {
  liquidityAvailable?: boolean;
  sellToken?: string;
  buyToken?: string;
  sellAmount?: string;
  buyAmount?: string;
  minBuyAmount?: string;
  gas?: string | number;
  tokenMetadata?: {
    buyToken?: { buyTaxBps?: string | number; sellTaxBps?: string | number };
    sellToken?: { buyTaxBps?: string | number; sellTaxBps?: string | number };
  };
  transaction?: {
    to?: string;
    data?: string;
    gas?: string | number;
    gasPrice?: string;
    value?: string;
  };
  // v1 leftovers: tolerated, never sent (endpoint is v2-only).
  to?: string;
  data?: string;
  value?: string;
}

function numOrNull(value: unknown): number | null {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Pure mapping, fixture-tested. Throws on missing amounts. */
export function mapZeroExQuote(
  chain: string,
  request: QuoteRequest,
  raw: ZeroExQuoteResponse,
): Quote {
  if (raw.liquidityAvailable === false) {
    throw new Error("0x reports no liquidity available for this pair");
  }
  if (!raw.sellAmount || !raw.buyAmount) {
    throw new Error("0x response missing sellAmount/buyAmount (token may be unindexed)");
  }
  const tx = raw.transaction ?? {};
  return {
    source: "0x",
    chain,
    sellToken: String(raw.sellToken ?? request.sellToken),
    buyToken: String(raw.buyToken ?? request.buyToken),
    sellAmount: String(raw.sellAmount),
    buyAmount: String(raw.buyAmount),
    // 0x v2 quote does not report a dedicated impact figure; downstream
    // risk assessment treats null as unknown (warn, don't block).
    priceImpactPct: null,
    buyTaxBps: numOrNull(raw.tokenMetadata?.buyToken?.buyTaxBps),
    sellTaxBps: numOrNull(raw.tokenMetadata?.sellToken?.sellTaxBps),
    estimatedGasUnits: numOrNull(tx.gas ?? raw.gas),
    ...(tx.to ?? raw.to ? { to: String(tx.to ?? raw.to) } : {}),
    ...(tx.data ?? raw.data ? { calldata: String(tx.data ?? raw.data) } : {}),
    ...(tx.value ?? raw.value ? { value: String(tx.value ?? raw.value) } : {}),
    raw,
  };
}

function apiKey(): string {
  const key = process.env.ZEROEX_API_KEY ?? "";
  if (!key) throw new Error("ZEROEX_API_KEY is not configured");
  return key;
}

async function fetchZeroExQuote(request: QuoteRequest): Promise<ZeroExQuoteResponse> {
  if (request.chainId === undefined) {
    throw new Error("0x quotes require an EVM chainId");
  }
  const params = new URLSearchParams({
    chainId: String(request.chainId),
    sellToken: request.sellToken,
    buyToken: request.buyToken,
    sellAmount: request.sellAmountBaseUnits,
    taker: request.taker,
    slippageBps: String(request.slippageBps),
  });
  const response = await fetch(`${ZEROEX_BASE}/quote?${params}`, {
    headers: {
      accept: "application/json",
      "0x-api-key": apiKey(),
      "0x-version": "v2",
    },
  });
  if (!response.ok) {
    throw new Error(`0x HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return (await response.json()) as ZeroExQuoteResponse;
}

/**
 * 0x Swap API v2 adapter (primary EVM quoter; supports all our EVM chains
 * including Robinhood 4663). UNVERIFIED live: shape follows the public v2
 * docs but no keyed call has been made from this codebase yet — confirm
 * against a real quote once ZEROEX_API_KEY is set.
 */
export class ZeroExExecutor implements SwapExecutor {
  readonly name = "0x";

  async quoteBuy(request: QuoteRequest): Promise<Quote> {
    return mapZeroExQuote(request.chain, request, await fetchZeroExQuote(request));
  }

  async quoteSell(request: QuoteRequest): Promise<Quote> {
    return mapZeroExQuote(request.chain, request, await fetchZeroExQuote(request));
  }

  async simulate(): Promise<SimulationResult> {
    throw new Error("0x adapter has no native simulate: run this quote through the viem eth_call simulator");
  }

  async buy(): Promise<ExecutionResult> {
    requireLive("0x buy");
    throw new Error("unreachable");
  }

  async sell(): Promise<ExecutionResult> {
    requireLive("0x sell");
    throw new Error("unreachable");
  }
}
