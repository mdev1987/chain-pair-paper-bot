import type {
  ExecutionResult,
  Quote,
  QuoteRequest,
  SimulationResult,
  SwapExecutor,
} from "../types.ts";
import { requireLive } from "../types.ts";

const ZEROEX_BASE = "https://api.0x.org/swap/v1";

interface ZeroExQuoteResponse {
  sellToken?: string;
  buyToken?: string;
  sellAmount?: string;
  buyAmount?: string;
  gas?: string | number;
  to?: string;
  data?: string;
  value?: string;
  tokenMetadata?: {
    buyTaxBps?: string | number;
    sellTaxBps?: string | number;
  };
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
  if (!raw.sellAmount || !raw.buyAmount) {
    throw new Error("0x response missing sellAmount/buyAmount (token may be unindexed)");
  }
  return {
    source: "0x",
    chain,
    sellToken: String(raw.sellToken ?? request.sellToken),
    buyToken: String(raw.buyToken ?? request.buyToken),
    sellAmount: String(raw.sellAmount),
    buyAmount: String(raw.buyAmount),
    // 0x v1 quote does not report a dedicated impact figure; downstream
    // risk assessment treats null as unknown (warn, don't block).
    priceImpactPct: null,
    buyTaxBps: numOrNull(raw.tokenMetadata?.buyTaxBps),
    sellTaxBps: numOrNull(raw.tokenMetadata?.sellTaxBps),
    estimatedGasUnits: numOrNull(raw.gas),
    ...(raw.to ? { to: String(raw.to) } : {}),
    ...(raw.data ? { calldata: String(raw.data) } : {}),
    ...(raw.value ? { value: String(raw.value) } : {}),
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
    headers: { accept: "application/json", "0x-api-key": apiKey() },
  });
  if (!response.ok) {
    throw new Error(`0x HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return (await response.json()) as ZeroExQuoteResponse;
}

/**
 * 0x Swap API adapter (primary EVM quoter). UNVERIFIED live: endpoint shape
 * follows the public 0x v1 docs but no keyed call has been made from this
 * codebase yet — confirm against a real quote before Stage 1.
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
