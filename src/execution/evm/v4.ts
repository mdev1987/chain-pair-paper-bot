import type {
  ExecutionResult,
  Quote,
  QuoteRequest,
  SimulationResult,
  SwapExecutor,
} from "../types.ts";
import { requireLive } from "../types.ts";
import { keccak256, parseAbiItem, toHex } from "viem";
import {
  getEvmPublicClient,
  getEvmTokenDecimals,
} from "./viem-client.ts";

/**
 * Uniswap V4 direct quoter for pools the aggregators haven't indexed yet.
 *
 * V4 has no pair contracts: every pool lives in the chain's singleton
 * PoolManager and is identified by a PoolKey hash (bytes32, 64 hex) — that
 * is what DexScreener reports as `pairAddress` with `labels: ["v4"]`.
 * Roughly 97% of recent Robinhood Chain trades in the ledger are V4 pools,
 * so without this adapter those positions get aggregator-only diagnostics.
 *
 * Quoting reads the pool's current slot0 + active liquidity through the
 * chain's StateView lens contract (pure `view` calls, no revert-simulate
 * trickery) and applies exact single-tick constant-price math in BigInt:
 * the quote is exact while the swap stays inside the current tick, which
 * holds for the bot's small diagnostic sizes. Within-tick price movement
 * is NOT modeled — priceImpactPct is the fee drag only.
 *
 * The full PoolKey (fee, tickSpacing, hooks) IS recoverable from the
 * PoolManager Initialize event (topic1 = poolId carries it; see
 * recoverV4PoolKey below), so quotes attach it best-effort when the
 * chain's PoolManager is configured. Executable calldata is still not
 * built — that needs UniversalRouter/V4Router encoding on top of the key —
 * so eth_call simulation stays unavailable and simOk remains null
 * downstream, exactly like Jupiter.
 *
 * Fee math follows v4-core ProtocolFeeLibrary exactly: the direction's
 * 12-bit protocol fee plus the LP fee, minus their cross term, all in pips
 * (1e6 = 100%). StateView/chain mapping below is from the official
 * Uniswap v4 deployments doc, NOT from memory — verify there before
 * touching it.
 */

const Q96 = 2n ** 96n;
const Q192 = 2n ** 192n;
const PIPS_DENOMINATOR = 1_000_000n;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const POOL_ID_RE = /^0x[0-9a-fA-F]{64}$/;
const NATIVE = "0x0000000000000000000000000000000000000000";

const STATE_VIEW_ABI = [
  {
    name: "getSlot0",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
  {
    name: "getLiquidity",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint128" }],
  },
] as const;

/** V4 StateView lens per chain (official deployments doc). */
export const V4_STATE_VIEWS: Record<string, `0x${string}`> = {
  ethereum: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
  base: "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
  bsc: "0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4",
  arbitrum: "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
  avalanche: "0xc3c9e198c735a4b97e3e683f391ccbdd60b69286",
  polygon: "0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a",
  robinhood: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
};

export function v4StateViewFor(chain: string): `0x${string}` {
  try {
    const overrides: unknown = JSON.parse(process.env.UNISWAP_V4_STATEVIEWS ?? "{}");
    const custom = (overrides as Record<string, string>)[chain];
    if (custom) return custom as `0x${string}`;
  } catch {
    // Malformed override JSON falls through to the built-in map.
  }
  const view = V4_STATE_VIEWS[chain];
  if (!view) {
    throw new Error(
      `No V4 StateView configured for "${chain}" (set UNISWAP_V4_STATEVIEWS, e.g. {"${chain}":"0x..."})`,
    );
  }
  return view;
}

/**
 * Exact total swap fee in pips (ProtocolFeeLibrary.calculateSwapFee):
 * protocol fee taken first, LP fee on the remainder.
 */
export function v4SwapFeePips(
  protocolFeePacked: bigint,
  lpFee: bigint,
  zeroForOne: boolean,
): bigint {
  const proto = zeroForOne
    ? protocolFeePacked & 0xfffn
    : (protocolFeePacked >> 12n) & 0xfffn;
  return proto + lpFee - (proto * lpFee) / PIPS_DENOMINATOR;
}

/**
 * Exact single-tick exact-input output in BUY-token base units. Pure BigInt:
 * no floats anywhere. Returns 0n for degenerate inputs.
 */
export function quoteV4AmountOut(
  amountInBaseUnits: bigint,
  sqrtPriceX96: bigint,
  zeroForOne: boolean,
  feePips: bigint,
  sellDecimals: number,
  buyDecimals: number,
): bigint {
  if (amountInBaseUnits <= 0n || sqrtPriceX96 <= 0n) return 0n;
  const keep = PIPS_DENOMINATOR - feePips;
  if (keep <= 0n) return 0n;
  const sellScale = 10n ** BigInt(sellDecimals);
  const buyScale = 10n ** BigInt(buyDecimals);
  if (zeroForOne) {
    // out1 = in0 * P^2, P^2 = sqrtP^2 / 2^192, with decimal rescale + fee.
    return (
      (amountInBaseUnits * sqrtPriceX96 * sqrtPriceX96 * buyScale * keep) /
      (Q192 * sellScale * PIPS_DENOMINATOR)
    );
  }
  // out0 = in1 / P^2, with decimal rescale + fee.
  return (
    (amountInBaseUnits * Q192 * buyScale * keep) /
    (sqrtPriceX96 * sqrtPriceX96 * sellScale * PIPS_DENOMINATOR)
  );
}

export interface V4DirectQuoteParams {
  chain: string;
  poolId: `0x${string}`;
  sellToken: string;
  buyToken: string;
  sellAmountBaseUnits: string;
  sellDecimals: number;
  /** Null = resolved on-chain (native 0x0 counts as 18). */
  buyDecimals: number | null;
  taker: string;
  slippageBps: number;
}

export async function quoteV4Direct(params: V4DirectQuoteParams): Promise<Quote> {
  if (!ADDRESS_RE.test(params.sellToken) || !ADDRESS_RE.test(params.buyToken)) {
    throw new Error("V4 direct quote needs 0x token addresses");
  }
  const client = getEvmPublicClient(params.chain);
  const stateView = v4StateViewFor(params.chain);
  const [slot0, liquidity] = await Promise.all([
    client.readContract({
      address: stateView,
      abi: STATE_VIEW_ABI,
      functionName: "getSlot0",
      args: [params.poolId],
    }),
    client.readContract({
      address: stateView,
      abi: STATE_VIEW_ABI,
      functionName: "getLiquidity",
      args: [params.poolId],
    }),
  ]);
  const [sqrtPriceX96, tick, protocolFee, lpFee] = slot0;
  if (sqrtPriceX96 <= 0n) throw new Error("V4 pool uninitialized (empty slot0)");
  if (liquidity <= 0n) throw new Error("V4 no active liquidity at current tick");

  // V4 orders currencies: currency0 < currency1 (native zero address first).
  const sellLower = params.sellToken.toLowerCase();
  const buyLower = params.buyToken.toLowerCase();
  const zeroForOne = sellLower < buyLower;

  const feePips = v4SwapFeePips(BigInt(protocolFee), BigInt(lpFee), zeroForOne);
  let buyDecimals = params.buyDecimals;
  if (buyDecimals === null) {
    buyDecimals = buyLower === NATIVE
      ? 18
      : await getEvmTokenDecimals(params.chain, params.buyToken as `0x${string}`).catch(
        () => null,
      );
    if (buyDecimals === null) throw new Error("V4 buy-decimals-unknown");
  }
  const buyAmount = quoteV4AmountOut(
    BigInt(params.sellAmountBaseUnits),
    sqrtPriceX96,
    zeroForOne,
    feePips,
    params.sellDecimals,
    buyDecimals,
  );
  if (buyAmount <= 0n) {
    throw new Error("V4 quote is zero (empty tick or dust amount)");
  }
  // Single-tick model: execution deviates from spot by the fee drag only.
  const priceImpactPct = Number(feePips) / 10_000;
  // Best-effort PoolKey enrichment for downstream sell-simulation work.
  // Cached after first recovery; never fails the quote.
  const poolKey = await recoverV4PoolKey(params.chain, params.poolId);
  return {
    source: "uniswap-v4",
    chain: params.chain,
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    sellAmount: BigInt(params.sellAmountBaseUnits).toString(),
    buyAmount: buyAmount.toString(),
    priceImpactPct: Number.isFinite(priceImpactPct) ? priceImpactPct : null,
    buyTaxBps: null,
    sellTaxBps: null,
    estimatedGasUnits: null,
    raw: {
      poolId: params.poolId,
      stateView,
      sqrtPriceX96: sqrtPriceX96.toString(),
      tick,
      liquidity: liquidity.toString(),
      lpFee: lpFee.toString(),
      protocolFee: protocolFee.toString(),
      swapFeePips: feePips.toString(),
      zeroForOne,
      singleTick: true,
      ...(poolKey ? { poolKey } : {}),
    },
  };
}

/**
 * Direct-V4 executor, constructed per candidate pool with the V4 poolId
 * (64 hex) that discovery stores as pairAddress. Quotes only for now:
 * executable calldata needs UniversalRouter/V4Router encoding on top of
 * the recovered PoolKey (see recoverV4PoolKey) — not built yet.
 */
export class UniswapV4DirectExecutor implements SwapExecutor {
  readonly name = "uniswap-v4";
  private readonly poolId: `0x${string}`;

  constructor(poolId: string) {
    if (!POOL_ID_RE.test(poolId)) {
      throw new Error(`Invalid V4 pool id: ${poolId}`);
    }
    this.poolId = poolId as `0x${string}`;
  }

  private quoteExactInput(request: QuoteRequest): Promise<Quote> {
    if (request.sellDecimals === undefined) {
      return Promise.reject(new Error("V4 sell-decimals-unknown"));
    }
    return quoteV4Direct({
      chain: request.chain,
      poolId: this.poolId,
      sellToken: request.sellToken,
      buyToken: request.buyToken,
      sellAmountBaseUnits: request.sellAmountBaseUnits,
      sellDecimals: request.sellDecimals,
      buyDecimals: request.buyDecimals ?? null,
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
    throw new Error("Uniswap V4 adapter has no native simulate yet: quotes carry no calldata (UniversalRouter encoding on the recovered PoolKey is still TODO)");
  }

  async buy(): Promise<ExecutionResult> {
    requireLive("Uniswap V4 buy");
    // Execution must still go through 0x, which abstracts the pool key
    // away — direct calldata is not built yet. Refuse loudly rather than
    // guessing.
    throw new Error("Uniswap V4 has no executable calldata yet: route V4 execution through 0x (ZeroExExecutor)");
  }

  async sell(): Promise<ExecutionResult> {
    requireLive("Uniswap V4 sell");
    throw new Error("Uniswap V4 has no executable calldata yet: route V4 execution through 0x (ZeroExExecutor)");
  }
}

// ---------------------------------------------------------------------------
// PoolKey recovery from the PoolManager Initialize event.
//
// IPoolManager (v4-core): Initialize(PoolId indexed id, Currency indexed
// currency0, Currency indexed currency1, uint24 fee, int24 tickSpacing,
// IHooks hooks, uint160 sqrtPriceX96, int24 tick). Filtering the
// PoolManager's logs by topic0 + topic1=poolId recovers the full key that
// the poolId hash alone cannot reveal — the prerequisite for sell
// simulation and direct (aggregator-free) execution.
// ---------------------------------------------------------------------------

/** Canonical topic0, computed at runtime so no constant can drift. */
export const V4_INITIALIZE_TOPIC0 = keccak256(
  toHex("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"),
);

/** Typed Initialize event for log decoding (topic0 above is its hash). */
const V4_INITIALIZE_EVENT = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
);

export interface V4PoolKey {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
}

/**
 * PoolManager contract per chain. Only deployments confirmed from primary
 * sources are built in (base + arbitrum below); everything else — including
 * Robinhood Chain — comes from UNISWAP_V4_POOL_MANAGERS JSON overrides.
 * Never guess an address: a wrong manager silently yields "no key".
 */
const V4_POOL_MANAGERS: Record<string, `0x${string}`> = {
  base: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
  arbitrum: "0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32",
};

export function v4PoolManagerFor(chain: string): `0x${string}` | null {
  try {
    const overrides: unknown = JSON.parse(process.env.UNISWAP_V4_POOL_MANAGERS ?? "{}");
    const custom = (overrides as Record<string, unknown>)[chain];
    if (typeof custom === "string" && /^0x[0-9a-fA-F]{40}$/.test(custom)) {
      return custom as `0x${string}`;
    }
  } catch {
    // Malformed override JSON falls through to the built-in map.
  }
  return V4_POOL_MANAGERS[chain] ?? null;
}

function topicAddress(topic: string): `0x${string}` | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return `0x${topic.slice(-40)}` as `0x${string}`;
}

/**
 * Pure: decode a PoolKey from one Initialize log. Returns null for any
 * other event or malformed payload — callers scan logs and keep the first
 * hit. Unit-tested with synthetic logs (no network).
 */
export function parseV4InitializeLog(log: {
  topics: Array<string | undefined | null>;
  data: string;
}): V4PoolKey | null {
  const [t0, , t2, t3] = log.topics ?? [];
  if (!t0 || t0.toLowerCase() !== V4_INITIALIZE_TOPIC0) return null;
  const currency0 = t2 ? topicAddress(t2) : null;
  const currency1 = t3 ? topicAddress(t3) : null;
  if (!currency0 || !currency1) return null;
  // Non-indexed data: fee(uint24) | tickSpacing(int24) | hooks(address) |
  // sqrtPriceX96(uint160) | tick(int24) — five 32-byte words.
  const data = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
  if (data.length < 320) return null;
  const fee = Number(BigInt(`0x${data.slice(0, 64)}`));
  let tickSpacing = Number(BigInt(`0x${data.slice(64, 128)}`));
  if (tickSpacing >= 2 ** 23) tickSpacing -= 2 ** 24; // int24 two's complement
  const hooks = `0x${data.slice(128, 192).slice(-40)}` as `0x${string}`;
  if (!Number.isFinite(fee) || fee < 0 || !Number.isFinite(tickSpacing)) return null;
  return { currency0, currency1, fee, tickSpacing, hooks };
}

// Initialize events are immutable, so recovered keys cache forever.
// Bounded: one entry per quoted pool, evicted FIFO past the cap.
const poolKeyCache = new Map<string, V4PoolKey>();
const POOL_KEY_CACHE_CAP = 5_000;

/**
 * Best-effort PoolKey recovery for a poolId. Returns null when the chain
 * has no configured PoolManager, the RPC cannot serve the log range, or no
 * Initialize event exists in the lookback window. Never throws — quoting
 * proceeds without the key exactly as before.
 */
export async function recoverV4PoolKey(
  chain: string,
  poolId: `0x${string}`,
): Promise<V4PoolKey | null> {
  const cacheKey = `${chain}:${poolId.toLowerCase()}`;
  const cached = poolKeyCache.get(cacheKey);
  if (cached) return cached;
  const manager = v4PoolManagerFor(chain);
  if (!manager) return null;
  try {
    const client = getEvmPublicClient(chain);
    const latest = await client.getBlockNumber();
    // Fresh pools initialized recently; bounded for range-limited RPCs.
    const lookback = 200_000n;
    const fromBlock = latest > lookback ? latest - lookback : 0n;
    const logs = await client.getContractEvents({
      address: manager,
      abi: [V4_INITIALIZE_EVENT],
      eventName: "Initialize",
      args: { id: poolId },
      fromBlock,
      toBlock: latest,
    });
    for (const log of logs) {
      const a = (log.args ?? {}) as {
        currency0?: unknown;
        currency1?: unknown;
        fee?: unknown;
        tickSpacing?: unknown;
        hooks?: unknown;
      };
      // Decoded ages are numbers/bigints per ABI; validate shapes, never cast blindly.
      const c0 = typeof a.currency0 === "string" ? a.currency0 : "";
      const c1 = typeof a.currency1 === "string" ? a.currency1 : "";
      const hooks = typeof a.hooks === "string" ? a.hooks : "";
      const fee = typeof a.fee === "number" ? a.fee : Number(a.fee as bigint);
      const spacing = typeof a.tickSpacing === "number" ? a.tickSpacing : Number(a.tickSpacing as bigint);
      if (!/^0x[0-9a-fA-F]{40}$/.test(c0) || !/^0x[0-9a-fA-F]{40}$/.test(c1)) continue;
      if (!/^0x[0-9a-fA-F]{40}$/.test(hooks)) continue;
      if (!Number.isFinite(fee) || fee < 0 || !Number.isFinite(spacing)) continue;
      const key: V4PoolKey = {
        currency0: c0 as `0x${string}`,
        currency1: c1 as `0x${string}`,
        fee,
        tickSpacing: spacing,
        hooks: hooks as `0x${string}`,
      };
      if (poolKeyCache.size >= POOL_KEY_CACHE_CAP) {
        poolKeyCache.delete(poolKeyCache.keys().next().value!);
      }
      poolKeyCache.set(cacheKey, key);
      return key;
    }
    return null;
  } catch {
    return null;
  }
}
