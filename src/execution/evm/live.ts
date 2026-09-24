import { maxUint256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ExecutionResult, Quote, QuoteRequest, SwapRequest } from "../types.ts";
import { requireLive } from "../types.ts";
import { EVM_CHAIN_IDS, chainDef, getEvmPublicClient, getEvmWalletClient } from "./viem-client.ts";
import { simulateEvmCall } from "./simulator.ts";
import { assessQuoteRisk } from "../risk.ts";
import { SIM_RISK_POLICY } from "../simulate.ts";
import { checkBuyPreconditions } from "../live-guard.ts";
import { v4StateViewFor } from "./v4.ts";

/**
 * EVM live execution primitives (Robinhood + all EVM chains).
 * Flow per swap: pre-submit recheck → approve (ERC20 only) → submit →
 * receipt → fill parse. Every step throws on failure — callers journal
 * the outcome and never assume a fill.
 *
 * Design notes:
 * - One shared flow for every EVM quote carrying calldata (0x, V2-direct).
 *   V4-direct quotes carry NO calldata yet (the PoolKey is recoverable via
 *   Initialize logs — see recoverV4PoolKey — but UniversalRouter encoding
 *   is not built) and are refused here; route V4 execution through 0x.
 * - Approvals are max-allowance per token per spender: the hot wallet is
 *   throwaway by policy, and per-trade approvals would double the tx count
 *   on a 60-second strategy. Revoke via revoke.cash if a key is retired.
 * - Native legs: sells spend msg.value (exact-in, validated by success
 *   status); buys are measured by native balance delta minus gas.
 */

/** keccak256("Transfer(address,address,uint256)") — canonical ERC20 event. */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ZERO_RE = /^0x0{40}$/i;
const EEEE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function isNativeToken(token: string): boolean {
  return ZERO_RE.test(token) || token.toLowerCase() === EEEE.toLowerCase();
}

/** Trader identity from TRADER_PRIVATE_KEY (throws when missing/malformed). */
export function traderEvmAddress(): `0x${string}` {
  const key = process.env.TRADER_PRIVATE_KEY ?? "";
  if (!key) throw new Error("TRADER_PRIVATE_KEY is not configured");
  return privateKeyToAccount(key as `0x${string}`).address;
}

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Spender for the approval: 0x allowanceTarget when present, else quote.to. */
export function spenderFor(quote: Quote): `0x${string}` {
  const raw = (quote.raw ?? {}) as { allowanceTarget?: unknown };
  const target = typeof raw.allowanceTarget === "string" ? raw.allowanceTarget : quote.to;
  if (!target || !ADDR_RE.test(target)) {
    throw new Error("Quote has no valid spender (to/allowanceTarget)");
  }
  return target as `0x${string}`;
}

/**
 * Ensure the spender can pull the sell token. Returns the approval hash
 * when a transaction was needed, null when allowance already sufficed.
 */
export async function ensureAllowance(
  chain: string,
  token: `0x${string}`,
  spender: `0x${string}`,
  amountNeeded: bigint,
): Promise<string | null> {
  const publicClient = getEvmPublicClient(chain);
  const owner = traderEvmAddress();
  const current = (await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, spender],
  })) as bigint;
  if (current >= amountNeeded) return null;
  const wallet = getEvmWalletClient(chain); // throws unless live enabled
  const hash = await wallet.writeContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, maxUint256],
    account: owner,
    chain: chainDef(chain),
  });
  await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  return hash;
}

const STATE_VIEW_ABI = [
  {
    name: "getLiquidity",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint128" }],
  },
] as const;

/**
 * Pre-submit liquidity re-check — refuse when dry. V4 pools on Robinhood
 * drain mid-trade (observed: familiars, LILY), so V4 quotes re-read
 * active liquidity seconds before submission. 0x quotes are seconds old
 * with on-chain slippage bounds; trusting them here is documented, not
 * skipped silently.
 */
export async function preSubmitRecheck(chain: string, quote: Quote): Promise<void> {
  if (quote.source !== "uniswap-v4") return;
  const poolId = (quote.raw as { poolId?: unknown } | null)?.poolId;
  if (typeof poolId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(poolId)) {
    throw new Error("V4 quote missing poolId for pre-submit recheck");
  }
  const client = getEvmPublicClient(chain);
  const liquidity = (await client.readContract({
    address: v4StateViewFor(chain),
    abi: STATE_VIEW_ABI,
    functionName: "getLiquidity",
    args: [poolId as `0x${string}`],
  })) as bigint;
  if (liquidity <= 0n) {
    throw new Error("V4 pool drained since quote — refusing submit");
  }
}

export interface EvmParsedFill {
  sellAmount: bigint;
  buyAmount: bigint;
}

interface ReceiptLog {
  address?: string;
  topics?: (string | undefined)[];
  data?: string;
}

/**
 * Pure: net Transfer deltas for the trader from a receipt. ERC20 legs
 * must show positive flow on both sides — anything else throws for
 * operator review (fee-on-transfer tokens net correctly by construction).
 */
export function parseEvmFillFromReceipt(
  logs: ReceiptLog[],
  trader: string,
  sellToken: string,
  buyToken: string,
): EvmParsedFill {
  const traderLower = trader.toLowerCase();
  const addrOf = (topic: string | undefined): string => `0x${(topic ?? "").slice(-40)}`.toLowerCase();
  let sold = 0n;
  let bought = 0n;
  for (const log of logs ?? []) {
    if ((log.topics?.[0] ?? "").toLowerCase() !== TRANSFER_TOPIC) continue;
    const token = (log.address ?? "").toLowerCase();
    const from = addrOf(log.topics?.[1]);
    const to = addrOf(log.topics?.[2]);
    let amount: bigint;
    try {
      amount = BigInt(log.data ?? "0x0");
    } catch {
      continue;
    }
    if (token === sellToken.toLowerCase() && from === traderLower) sold += amount;
    if (token === buyToken.toLowerCase() && to === traderLower) bought += amount;
  }
  if (!isNativeToken(sellToken) && sold <= 0n) {
    throw new Error("No sell Transfer for trader in receipt (fill unprovable)");
  }
  if (!isNativeToken(buyToken) && bought <= 0n) {
    throw new Error("No buy Transfer for trader in receipt (fill unprovable)");
  }
  return { sellAmount: sold, buyAmount: bought };
}

export interface EvmLiveFill {
  hash: `0x${string}`;
  sellAmount: string;
  buyAmount: string;
  gasUsed: string;
}

/**
 * Shared live EVM swap: recheck → approve → submit → receipt → parse.
 * Requires quote.to + calldata (0x, V2-direct). Throws on any failure.
 */
export async function executeLiveEvmSwap(
  chain: string,
  quote: Quote,
): Promise<EvmLiveFill> {
  if (!quote.to || !quote.calldata) {
    throw new Error(
      `${quote.source} quote has no executable calldata (V4-direct quotes are diagnostics-only — route V4 execution through 0x)`,
    );
  }
  if (!ADDR_RE.test(quote.to)) throw new Error(`Quote target is not an address: ${quote.to}`);
  await preSubmitRecheck(chain, quote);
  const trader = traderEvmAddress();
  const publicClient = getEvmPublicClient(chain);
  const sellIsNative = isNativeToken(quote.sellToken);
  const buyIsNative = isNativeToken(quote.buyToken);
  const sellAmount = BigInt(quote.sellAmount);
  if (sellAmount <= 0n) throw new Error("Quote sell amount is not positive");
  let preNative: bigint | null = null;
  if (buyIsNative) preNative = await publicClient.getBalance({ address: trader });
  if (!sellIsNative) {
    if (!ADDR_RE.test(quote.sellToken)) throw new Error("Non-native sell token is not a 0x address");
    await ensureAllowance(chain, quote.sellToken as `0x${string}`, spenderFor(quote), sellAmount);
  }
  const wallet = getEvmWalletClient(chain);
  const value = quote.value ? BigInt(quote.value) : 0n;
  const hash = await wallet.sendTransaction({
    to: quote.to as `0x${string}`,
    data: quote.calldata as `0x${string}`,
    value,
    account: trader,
    chain: chainDef(chain),
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: 120_000,
  });
  if (receipt.status !== "success") {
    throw new Error(`Swap reverted on-chain: ${hash} (funds safe, position needs manual review)`);
  }
  const parsed = parseEvmFillFromReceipt(
    (receipt.logs ?? []) as ReceiptLog[],
    trader,
    quote.sellToken,
    quote.buyToken,
  );
  let buyAmount: bigint;
  if (buyIsNative) {
    if (preNative === null) throw new Error("unreachable");
    const postNative = await publicClient.getBalance({ address: trader });
    const gasCost = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
    buyAmount = postNative - preNative + gasCost;
    if (buyAmount < 0n) {
      throw new Error(`Native buy accounting went negative for ${hash} (manual review)`);
    }
  } else {
    buyAmount = parsed.buyAmount;
  }
  const soldAmount = sellIsNative ? sellAmount : parsed.sellAmount;
  if (buyAmount <= 0n) {
    throw new Error(`Swap executed but bought nothing: ${hash} (manual review before proceeding)`);
  }
  return {
    hash,
    sellAmount: soldAmount.toString(),
    buyAmount: buyAmount.toString(),
    gasUsed: receipt.gasUsed.toString(),
  };
}

/** ERC20 balance of the trader (reconcile helper). Null when unreadable. */
export async function traderTokenBalance(
  chain: string,
  token: string,
): Promise<bigint | null> {
  try {
    if (isNativeToken(token)) {
      return await getEvmPublicClient(chain).getBalance({ address: traderEvmAddress() });
    }
    if (!ADDR_RE.test(token)) return null;
    const bal = (await getEvmPublicClient(chain).readContract({
      address: token as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [traderEvmAddress()],
    })) as bigint;
    return bal;
  } catch {
    return null;
  }
}

export interface Quotable {
  quoteBuy: (request: QuoteRequest) => Promise<Quote>;
  quoteSell: (request: QuoteRequest) => Promise<Quote>;
  name: string;
}

function liveQuoteRequest(quote: Quote, taker: string, slippageBps: number): QuoteRequest {
  return {
    chain: quote.chain,
    ...(EVM_CHAIN_IDS[quote.chain] !== undefined
      ? { chainId: EVM_CHAIN_IDS[quote.chain] }
      : {}),
    sellToken: quote.sellToken,
    buyToken: quote.buyToken,
    sellAmountBaseUnits: quote.sellAmount,
    taker,
    slippageBps,
  };
}

/**
 * Shared guarded live BUY for calldata-carrying EVM adapters: re-quote
 * with the trader as taker (aggregator calldata is taker-bound), assess
 * risk, eth_call-simulate from the trader, enforce the safety invariant,
 * then execute. Throws on any refusal — NO TRANSACTION.
 */
export async function liveBuyWithQuoteFlow(
  quoter: Quotable,
  label: string,
  request: SwapRequest & { sizeUsd?: number; positionId?: string },
): Promise<ExecutionResult> {
  requireLive(`${label} buy`);
  const trader = traderEvmAddress();
  const fresh = await quoter.quoteBuy(liveQuoteRequest(request.quote, trader, request.slippageBps));
  const risk = assessQuoteRisk(fresh, SIM_RISK_POLICY);
  let simOk = false;
  if (fresh.to && fresh.calldata && ADDR_RE.test(fresh.to)) {
    const sim = await simulateEvmCall(getEvmPublicClient(fresh.chain), {
      from: trader,
      to: fresh.to as `0x${string}`,
      calldata: fresh.calldata as `0x${string}`,
      ...(fresh.value ? { value: BigInt(fresh.value) } : {}),
    });
    simOk = sim.ok;
  }
  const verdict = checkBuyPreconditions({
    chain: fresh.chain,
    sizeUsd: request.sizeUsd ?? NaN,
    riskPass: risk.pass,
    simOk,
    quoteSource: fresh.source,
    ...(request.positionId !== undefined ? { positionId: request.positionId } : {}),
  });
  if (!verdict.ok) {
    throw new Error(`Live buy refused: ${verdict.failures.join("; ")}`);
  }
  const fill = await executeLiveEvmSwap(fresh.chain, fresh);
  return { ok: true, hash: fill.hash, sellAmount: fill.sellAmount, buyAmount: fill.buyAmount };
}

/**
 * Shared live SELL: re-quote with trader taker, simulate (a reverting
 * exit wastes gas and stays stuck either way — surface it loudly), then
 * execute. Bypasses the entry gate by design; never the live flag.
 */
export async function liveSellWithQuoteFlow(
  quoter: Quotable,
  label: string,
  request: SwapRequest,
): Promise<ExecutionResult> {
  requireLive(`${label} sell`);
  const trader = traderEvmAddress();
  const fresh = await quoter.quoteSell(liveQuoteRequest(request.quote, trader, request.slippageBps));
  if (!fresh.to || !fresh.calldata || !ADDR_RE.test(fresh.to)) {
    throw new Error("Live sell has no executable calldata (manual review)");
  }
  const sim = await simulateEvmCall(getEvmPublicClient(fresh.chain), {
    from: trader,
    to: fresh.to as `0x${string}`,
    calldata: fresh.calldata as `0x${string}`,
    ...(fresh.value ? { value: BigInt(fresh.value) } : {}),
  });
  if (!sim.ok) {
    throw new Error(`Live sell simulation reverts (manual review): ${(sim.reason ?? "").slice(0, 200)}`);
  }
  const fill = await executeLiveEvmSwap(fresh.chain, fresh);
  return { ok: true, hash: fill.hash, sellAmount: fill.sellAmount, buyAmount: fill.buyAmount };
}
