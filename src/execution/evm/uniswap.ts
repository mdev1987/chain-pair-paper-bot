import { encodeFunctionData } from "viem";
import type {
  ExecutionResult,
  Quote,
  QuoteRequest,
  SimulationResult,
  SwapExecutor,
} from "../types.ts";
import { requireLive } from "../types.ts";
import { getEvmPublicClient } from "./viem-client.ts";
import { liveBuyWithQuoteFlow, liveSellWithQuoteFlow } from "./live.ts";

/**
 * Uniswap V2-style direct quoter (chain-specific fallback for pools the
 * aggregators haven't indexed yet).
 *
 * Design follows the Uniswap SDK guidance ("use an SDK when you want
 * client-side computation and want to construct calldata yourself"): we
 * already know the exact pair contract from DexPaprika discovery, so we
 * read token0/token1/getReserves on-chain and apply constant-product math
 * locally instead of depending on an aggregator's index. No Uniswap package
 * dependency — viem plus two minimal ABIs covers the single-pool
 * exact-input case; reach for @uniswap/sdk-core + v2/v3/v4 SDKs if we ever
 * need multi-hop routing or concentrated-liquidity (v3/v4) Quoter flows
 * (which quote via revert-and-simulate, not plain reads).
 */

const V2_PAIR_ABI = [
  {
    name: "token0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "token1",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "getReserves",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "_reserve0", type: "uint112" },
      { name: "_reserve1", type: "uint112" },
      { name: "_blockTimestampLast", type: "uint32" },
    ],
  },
] as const;

const V2_ROUTER_ABI = [
  {
    name: "swapExactTokensForTokens",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

/** Canonical V2 Router02 deployments. Missing chains fall through (env override below). */
export const V2_ROUTERS: Record<string, `0x${string}`> = {
  ethereum: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
  bsc: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  base: "0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb",
  arbitrum: "0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb",
  robinhood: "0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb",
};

export function v2RouterFor(chain: string): `0x${string}` {
  try {
    const overrides: unknown = JSON.parse(process.env.UNISWAP_V2_ROUTERS ?? "{}");
    const custom = (overrides as Record<string, string>)[chain];
    if (custom) return custom as `0x${string}`;
  } catch {
    // Malformed override JSON falls through to the built-in map.
  }
  const router = V2_ROUTERS[chain];
  if (!router) {
    throw new Error(
      `No V2 router configured for "${chain}" (set UNISWAP_V2_ROUTERS, e.g. {"${chain}":"0x..."})`,
    );
  }
  return router;
}

/**
 * Pure Uniswap V2 exact-input math. feeNum/feeDen default to the standard
 * 0.3% (997/1000); pass the venue's own fee for V2-forks that differ.
 */
export function quoteV2AmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeNum = 997n,
  feeDen = 1000n,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * feeNum;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * feeDen + amountInWithFee;
  return numerator / denominator;
}

export interface V2DirectQuoteParams {
  chain: string;
  pairAddress: `0x${string}`;
  sellToken: string;
  buyToken: string;
  sellAmountBaseUnits: string;
  taker: string;
  slippageBps: number;
}

export async function quoteV2Direct(params: V2DirectQuoteParams): Promise<Quote> {
  const client = getEvmPublicClient(params.chain);
  const pair = params.pairAddress;
  const [token0, token1, reserves] = await Promise.all([
    client.readContract({ address: pair, abi: V2_PAIR_ABI, functionName: "token0" }),
    client.readContract({ address: pair, abi: V2_PAIR_ABI, functionName: "token1" }),
    client.readContract({ address: pair, abi: V2_PAIR_ABI, functionName: "getReserves" }),
  ]);
  const sellLower = params.sellToken.toLowerCase();
  const reserveIn = token0.toLowerCase() === sellLower ? reserves[0] : reserves[1];
  const reserveOut = token0.toLowerCase() === sellLower ? reserves[1] : reserves[0];
  if (token0.toLowerCase() !== sellLower && token1.toLowerCase() !== sellLower) {
    throw new Error("Sell token is not in this pair");
  }
  const sellAmount = BigInt(params.sellAmountBaseUnits);
  const buyAmount = quoteV2AmountOut(sellAmount, reserveIn, reserveOut);
  if (buyAmount <= 0n) {
    throw new Error("V2 quote is zero (empty reserves or dust amount)");
  }
  const amountOutMin = (buyAmount * BigInt(10_000 - params.slippageBps)) / 10_000n;
  const router = v2RouterFor(params.chain);
  const calldata = encodeFunctionData({
    abi: V2_ROUTER_ABI,
    functionName: "swapExactTokensForTokens",
    args: [
      sellAmount,
      amountOutMin,
      [params.sellToken as `0x${string}`, params.buyToken as `0x${string}`],
      params.taker as `0x${string}`,
      BigInt(Math.floor(Date.now() / 1000) + 300),
    ],
  });
  // Price impact of this exact input against the reserves, in percent.
  const midReserveRatio = Number(reserveOut) / Number(reserveIn);
  const execRatio = Number(buyAmount) / Number(sellAmount);
  const priceImpactPct = midReserveRatio > 0 ? ((midReserveRatio - execRatio) / midReserveRatio) * 100 : null;
  return {
    source: "uniswap",
    chain: params.chain,
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    sellAmount: sellAmount.toString(),
    buyAmount: buyAmount.toString(),
    priceImpactPct: Number.isFinite(priceImpactPct) ? priceImpactPct : null,
    buyTaxBps: null,
    sellTaxBps: null,
    estimatedGasUnits: null,
    to: router,
    calldata,
    raw: {
      pair: params.pairAddress,
      reserveIn: reserveIn.toString(),
      reserveOut: reserveOut.toString(),
      amountOutMin: amountOutMin.toString(),
    },
  };
}

/**
 * Direct-V2 executor, constructed per candidate pool: the router builds one
 * with the DexPaprika-discovered pair address at entry time, so no factory
 * lookup or aggregator index is ever needed.
 */
export class UniswapV2DirectExecutor implements SwapExecutor {
  readonly name = "uniswap";
  private readonly pairAddress: `0x${string}`;

  constructor(pairAddress: string) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(pairAddress)) {
      throw new Error(`Invalid V2 pair address: ${pairAddress}`);
    }
    this.pairAddress = pairAddress as `0x${string}`;
  }

  private quoteExactInput(request: QuoteRequest): Promise<Quote> {
    return quoteV2Direct({
      chain: request.chain,
      pairAddress: this.pairAddress,
      sellToken: request.sellToken,
      buyToken: request.buyToken,
      sellAmountBaseUnits: request.sellAmountBaseUnits,
      taker: request.taker,
      slippageBps: request.slippageBps,
    });
  }

  async quoteBuy(request: QuoteRequest): Promise<Quote> {
    return this.quoteExactInput(request);
  }

  async quoteSell(request: QuoteRequest): Promise<Quote> {
    return this.quoteExactInput(request);
  }

  async simulate(): Promise<SimulationResult> {
    throw new Error("Uniswap direct adapter has no native simulate: run this quote through the viem eth_call simulator");
  }

  async buy(
    request: Parameters<SwapExecutor["buy"]>[0] & { sizeUsd?: number; positionId?: string },
  ): Promise<ExecutionResult> {
    return liveBuyWithQuoteFlow(this, "Uniswap V2", request);
  }

  async sell(
    request: Parameters<SwapExecutor["sell"]>[0],
  ): Promise<ExecutionResult> {
    return liveSellWithQuoteFlow(this, "Uniswap V2", request);
  }
}

/** Backwards-compatible alias: the direct quoter is the Uniswap adapter. */
export const UniswapExecutor = UniswapV2DirectExecutor;
