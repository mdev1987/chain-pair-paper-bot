import { config } from "./config.ts";
import { recordFill, type FillRecord } from "./analytics.ts";
import { liveTradingEnabled } from "./execution/types.ts";
import { JupiterExecutor } from "./execution/solana/jupiter.ts";
import { ZeroExExecutor } from "./execution/evm/zeroex.ts";
import { EVM_CHAIN_IDS } from "./execution/evm/viem-client.ts";
import { getEvmTokenDecimals } from "./execution/evm/viem-client.ts";
import { traderEvmAddress } from "./execution/evm/live.ts";
import { traderTokenBalance } from "./execution/evm/live.ts";
import { evmFillFetcher, evmTxStatusFetcher } from "./execution/evm/reconcile.ts";
import { fetchConfirmedFill, traderSplTokenBalance } from "./execution/solana/fills.ts";
import { traderPublicKey } from "./execution/solana/signer.ts";
import { getSolanaConnection } from "./execution/solana/client.ts";
import { getSolanaTokenDecimals } from "./execution/solana/helius.ts";
import {
  KNOWN_QUOTE_DECIMALS,
  quotePriceUsd,
  usdToBaseUnits,
} from "./execution/simulate.ts";
import {
  liveState,
  persistLiveState,
  restoreLiveState,
} from "./execution/live-state.ts";
import {
  loadLiveOrders,
  markConfirmed,
  markFailed,
  markSubmitted,
  recordSignal,
  retrySignal,
  saveLiveOrders,
  type LiveOrder,
} from "./execution/live-orders.ts";
import {
  applyLiveFill,
  closeLivePosition,
  countOpenLive,
  liveTpQty,
  loadLivePositions,
  openLivePosition,
  realizedShare,
  saveLivePositions,
  sellFillStatus,
  type LivePosition,
} from "./execution/live-positions.ts";
import {
  reconcileLiveState,
  type ChainTxStatus,
} from "./execution/reconcile.ts";
import {
  buildLiveFillConfirmedMessage,
  buildLiveSubmittedMessage,
} from "./report.ts";
import type { DexScreenerPair, Position } from "./types.ts";

/**
 * Live-execution wiring (paper-first shadowing). Every function here is
 * best-effort and NEVER throws into the paper engine — paper fills book
 * first, live mirrors them. With LIVE_TRADING_ENABLED unset (current
 * state) every maybe* returns immediately: zero behavior change.
 *
 * Solana only. EVM executors are still stubs, so non-Solana chains
 * always return immediately.
 */

export interface LiveDeps {
  notify: (markdown: string) => Promise<void>;
  log: (message: string) => void;
}

const jupiter = new JupiterExecutor();
const zeroex = new ZeroExExecutor();
let journal: LiveOrder[] = [];
let mirror: LivePosition[] = [];

function isEvmChain(chain: string): boolean {
  return EVM_CHAIN_IDS[chain] !== undefined;
}

/** Live execution covers Solana and every EVM chain (0x for quotes+swaps). */
function liveChain(chain: string): boolean {
  return liveTradingEnabled() && (chain === "solana" || isEvmChain(chain));
}

function takerFor(chain: string): string {
  return chain === "solana" ? traderPublicKey() : traderEvmAddress();
}

function liveQuoteRequest(
  chain: string,
  input: { sellToken: string; buyToken: string; sellAmountBaseUnits: string; slippageBps: number },
) {
  return {
    chain,
    ...(isEvmChain(chain) ? { chainId: EVM_CHAIN_IDS[chain] } : {}),
    sellToken: input.sellToken,
    buyToken: input.buyToken,
    sellAmountBaseUnits: input.sellAmountBaseUnits,
    taker: takerFor(chain),
    slippageBps: input.slippageBps,
  };
}

/** Token decimals: on-chain first, well-known quote map as fallback. */
async function tokenDecimalsFor(chain: string, mint: string): Promise<number | null> {
  try {
    if (chain === "solana") return await getSolanaTokenDecimals(mint);
    if (/^0x0{40}$/i.test(mint)) return 18;
    return await getEvmTokenDecimals(chain, mint as `0x${string}`);
  } catch {
    return null;
  }
}

async function buyDecimalsFor(chain: string, mint: string, symbol: string): Promise<number | null> {
  const onchain = await tokenDecimalsFor(chain, mint);
  if (onchain !== null) return onchain;
  return KNOWN_QUOTE_DECIMALS[symbol.toLowerCase()] ?? null;
}

function saveAll(log: (message: string) => void): void {
  try {
    saveLiveOrders(journal);
  } catch (error) {
    log(`⚠️ live journal persist failed: ${String(error).slice(0, 120)}`);
  }
  try {
    saveLivePositions(mirror);
  } catch (error) {
    log(`⚠️ live mirror persist failed: ${String(error).slice(0, 120)}`);
  }
  try {
    persistLiveState();
  } catch (error) {
    log(`⚠️ live state persist failed: ${String(error).slice(0, 120)}`);
  }
}

function syncCounts(): void {
  liveState.setLiveOpenCount(countOpenLive(mirror));
  // Open cost basis for the stuck-bag halt bound (assumes open bags go to
  // zero). Pro-rata by remaining fill so partial TPs release exposure.
  let exposure = 0;
  for (const p of mirror) {
    if (p.status !== "OPEN") continue;
    try {
      const remaining = BigInt(p.remainingBaseUnits);
      const filled = BigInt(p.filledBaseUnits);
      if (filled > 0n && remaining >= 0n) {
        exposure += p.entryCostUsd * Number(remaining) / Number(filled);
      }
    } catch {
      exposure += p.entryCostUsd;
    }
  }
  liveState.setLiveOpenExposureUsd(exposure);
}

function trackPending(positionId: string, add: boolean): void {
  if (add) liveState.addPending(positionId);
  else liveState.removePending(positionId);
}

function failOrder(
  deps: LiveDeps,
  positionId: string,
  side: "BUY" | "SELL",
  note: string,
  label = "",
): void {
  try {
    journal = markFailed(journal, positionId, side, note, label);
    saveLiveOrders(journal);
  } catch (error) {
    deps.log(`⚠️ live ${side} ${positionId}: journal markFailed failed (${String(error).slice(0, 100)}) — ${note}`);
    return;
  }
  trackPending(positionId, false);
  deps.log(`⚠️ live ${side} ${positionId} FAILED: ${note}`);
}

/** Quote-currency USD price from a DexScreener print (mirrors entry check). */
function quoteUsd(
  priceUsd: number,
  pair: DexScreenerPair,
): { qp: number; qd: number } | null {
  const qp = quotePriceUsd(priceUsd, Number(pair.priceNative ?? "NaN"), pair.quoteToken.symbol);
  const qd = KNOWN_QUOTE_DECIMALS[pair.quoteToken.symbol.toLowerCase()];
  if (qp === null || qd === undefined) return null;
  return { qp, qd };
}

export interface LiveFillInfo {
  id: string;
  chain: string;
  dexId: string;
  symbol: string;
  tokenName: string;
  pairAddress: string;
  poolAddress?: string;
  tokenAddress: string;
  quoteSymbol: string;
}

function liveFillRow(
  position: LiveFillInfo,
  detail: "LIVE_OPEN" | `LIVE_TP${number}` | "LIVE_EXIT",
  price: number,
  qty: number,
  notionalUsd: number,
): FillRecord {
  return {
    time: Date.now(),
    side: detail === "LIVE_OPEN" ? "BUY" : "SELL",
    positionId: position.id,
    chain: position.chain,
    dex: position.dexId,
    symbol: position.symbol,
    tokenName: position.tokenName,
    pair: position.pairAddress,
    pool: position.poolAddress ?? "",
    ca: position.tokenAddress,
    quote: position.quoteSymbol,
    price,
    qty,
    notionalUsd,
    feeUsd: 0, // Jupiter platform fee is embedded in executed amounts.
    slipUsd: 0,
    detail,
    balanceAfterUsd: NaN, // Live wallet is separate from paper cash.
    equityAfterUsd: NaN, // Paper equity is meaningless for live fills.
  };
}

/**
 * Boot: restore kill-switch state, load journals, reconcile every open
 * order from chain status, persist, and report. Never throws.
 */
export async function initLive(
  deps: LiveDeps,
  paperPositions: Map<string, Position>,
): Promise<void> {
  if (!liveTradingEnabled()) return;
  try {
    restoreLiveState();
    journal = loadLiveOrders();
    mirror = loadLivePositions();
    const findOrder = (signature: string): LiveOrder | undefined =>
      journal.find((o) => o.signature === signature);
    const report = await reconcileLiveState(journal, mirror, {
      getTxStatus: async (signature: string): Promise<ChainTxStatus> => {
        const order = findOrder(signature);
        const chain = order?.chain;
        if (!chain) return "missing";
        if (chain === "solana") {
          const connection = getSolanaConnection();
          const [st] = (await connection.getSignatureStatuses([signature])).value;
          if (!st) return "missing";
          if (st.err) return "failed";
          return st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized"
            ? "confirmed"
            : "missing";
        }
        if (isEvmChain(chain)) return evmTxStatusFetcher(chain)(signature);
        return "missing";
      },
      fetchFill: (signature: string) => {
        const order = findOrder(signature);
        const chain = order?.chain;
        if (chain === "solana") return fetchConfirmedFill(signature);
        if (chain !== undefined && isEvmChain(chain)) {
          return evmFillFetcher(chain, (sig) => journal.find((o) => o.signature === sig))(signature);
        }
        return Promise.reject(new Error(`No fill fetcher for chain ${chain ?? "unknown"}`));
      },
      getBalance: (chain: string, mint: string): Promise<bigint | null> => {
        if (chain === "solana") return traderSplTokenBalance(mint);
        if (isEvmChain(chain)) return traderTokenBalance(chain, mint);
        return Promise.resolve(null);
      },
    });
    journal = report.orders;
    // Apply confirmed fills to the mirror (conservative: BUY opens only
    // with a known entry cost, SELL applies, never auto-closes at boot).
    for (const { order, fill } of report.confirmed) {
      try {
        if (order.side === "BUY") {
          const paper = paperPositions.get(order.positionId);
          if (!paper) {
            report.discrepancies.push(`${order.positionId}: confirmed BUY without paper position (manual review)`);
            continue;
          }
          if (!mirror.some((p) => p.positionId === order.positionId)) {
            mirror = openLivePosition(mirror, {
              positionId: order.positionId,
              chain: order.chain,
              tokenMint: fill.buyMint,
              filledBaseUnits: fill.buyAmountBaseUnits,
              entryCostUsd: paper.initialUsdSize,
              // EVM BUY orders journal the quote as meta.sellToken — the
              // sweeper needs it after paper is gone.
              ...(order.meta?.sellToken ? { quoteMint: order.meta.sellToken } : {}),
            });
          }
        } else {
          // Crash window: the fill may already be saved without the
          // CONFIRMED mark — never double-apply, never guess on conflict.
          const existing = mirror.find((p) => p.positionId === order.positionId);
          if (!existing || existing.status !== "OPEN") {
            report.discrepancies.push(`${order.positionId}: confirmed SELL without open live position`);
            continue;
          }
          switch (sellFillStatus(existing, fill.sellAmountBaseUnits)) {
            case "fresh":
              mirror = applyLiveFill(mirror, order.positionId, fill.sellAmountBaseUnits);
              break;
            case "applied":
              break;
            case "conflict":
              report.discrepancies.push(
                `${order.positionId}: SELL fill state conflict (remaining ${existing.remainingBaseUnits}, fill ${fill.sellAmountBaseUnits})`,
              );
              continue;
          }
        }
      } catch (error) {
        report.discrepancies.push(`${order.positionId}: boot-apply failed: ${String(error).slice(0, 120)}`);
      }
    }
    // Catch-up: paper TPs that booked while live was down. tpHit set + live
    // OPEN + no CONFIRMED labeled order means the live leg never ran —
    // re-queue it with recomputed qty instead of losing the fill.
    for (const paper of paperPositions.values()) {
      if (paper.status !== "OPEN") continue;
      const live = mirror.find((p) => p.positionId === paper.id && p.status === "OPEN");
      if (!live) continue;
      const tpLevels = paper.exitProfile?.tp ?? config.tp;
      tpLevels.forEach((level, i) => {
        if (!paper.tpHit[i]) return;
        const label = `TP${i + 1}`;
        const done = journal.some(
          (o) => o.positionId === paper.id && o.side === "SELL" && (o.label ?? "") === label && o.status === "CONFIRMED",
        );
        if (done) return;
        let qty: bigint;
        try {
          qty = liveTpQty(live.originalBaseUnits, level.sellPct);
          const remaining = BigInt(live.remainingBaseUnits);
          if (qty > remaining) qty = remaining;
        } catch {
          return;
        }
        if (qty <= 0n) return;
        if (!live.quoteMint) {
          report.discrepancies.push(`${paper.id}: catch-up ${label} without quote U (manual review)`);
          return;
        }
        const res = enqueueLiveSell(pendingSells, {
          positionId: paper.id,
          chain: paper.chain,
          symbol: paper.symbol,
          tokenName: paper.tokenName,
          dexId: paper.dexId,
          pairAddress: paper.pairAddress,
          poolAddress: paper.poolAddress ?? "",
          tokenMint: paper.tokenAddress,
          quoteMint: live.quoteMint,
          quoteSymbol: paper.quoteSymbol,
          priceNative: "",
          kind: "TP",
          level: (i + 1) as 1 | 2 | 3,
          label,
          sellBaseUnits: qty.toString(),
          paperPrice: paper.currentPrice,
          sizeUsdForReport: 0,
        });
        pendingSells = res.queue;
        if (res.enqueued) {
          trackPending(paper.id, true);
          report.discrepancies.push(`${paper.id}: catch-up ${label} re-queued at boot`);
        }
      });
    }
    saveAll(deps.log);
    syncCounts();
    const lines = [
      `🔄 live reconcile: ${report.confirmed.length} confirmed, ${report.failed.length} failed, ${report.stillMissing.length} still missing`,
      ...report.discrepancies.map((d) => `⚠️ ${d}`),
    ];
    deps.log(lines.join("\n"));
    await deps.notify(lines.join("\n"));
  } catch (error) {
    deps.log(`⚠️ live init failed (paper continues): ${String(error).slice(0, 200)}`);
  }
}

/** Live entry mirror after the paper fill booked. Never throws. */
export async function maybeLiveEnter(
  deps: LiveDeps,
  position: Position,
  pair: DexScreenerPair,
  entryPrice: number,
  sizeUsd: number,
): Promise<void> {
  if (!liveChain(position.chain)) return;
  const id = position.id;
  const evm = isEvmChain(position.chain);
  const quoter = evm ? zeroex : jupiter;
  try {
    const quoteSellToken = pair.quoteToken.address;
    const basis = quoteUsd(entryPrice, pair);
    if (!basis) throw new Error("no live quote basis (unknown quote price/decimals)");
    const sellBase = usdToBaseUnits(sizeUsd / basis.qp, basis.qd);
    journal = recordSignal(journal, {
      positionId: id,
      chain: position.chain,
      side: "BUY",
      // Receipt recovery needs the pair on EVM orders.
      ...(evm
        ? { meta: { sellToken: quoteSellToken, buyToken: position.tokenAddress, sellAmountBaseUnits: sellBase } }
        : {}),
    });
    saveLiveOrders(journal);
    trackPending(id, true);
    const trader = takerFor(position.chain);
    // Live-only slippage budget (config.live), NEVER the paper friction:
    // PAPER_SLIPPAGE_BPS=0 would request zero tolerance and fail the swap.
    const quote = await quoter.quoteBuy(liveQuoteRequest(position.chain, {
      sellToken: quoteSellToken,
      buyToken: position.tokenAddress,
      sellAmountBaseUnits: sellBase,
      slippageBps: config.live.buySlippageBps,
    }));
    const res = await (evm
      ? zeroex.buy({ quote, taker: trader, slippageBps: config.live.buySlippageBps, sizeUsd, positionId: id })
      : jupiter.buy({ quote, taker: trader, slippageBps: config.live.buySlippageBps, sizeUsd, positionId: id }));
    if (!res.hash) throw new Error("live buy returned no signature");
    journal = markSubmitted(journal, id, "BUY", res.hash);
    saveLiveOrders(journal);
    await deps.notify(buildLiveSubmittedMessage({
      symbol: position.symbol, chain: position.chain, side: "BUY", sizeUsd, signature: res.hash,
    }));
    // Confirmed fill, independent of the executor's own parse: Solana
    // re-reads the transaction; EVM amounts already come receipt-parsed
    // out of buy().
    const fill = evm
      ? { buyMint: position.tokenAddress, sellAmountBaseUnits: res.sellAmount, buyAmountBaseUnits: res.buyAmount }
      : await fetchConfirmedFill(res.hash);
    if (fill.buyMint.toLowerCase() !== position.tokenAddress.toLowerCase()) {
      throw new Error(`fill token mismatch: ${fill.buyMint} vs ${position.tokenAddress}`);
    }
    mirror = openLivePosition(mirror, {
      positionId: id,
      chain: position.chain,
      tokenMint: fill.buyMint,
      filledBaseUnits: fill.buyAmountBaseUnits,
      entryCostUsd: sizeUsd,
      quoteMint: pair.quoteToken.address,
    });
    saveLivePositions(mirror);
    journal = markConfirmed(journal, id, "BUY");
    saveLiveOrders(journal);
    trackPending(id, false);
    const dec = await tokenDecimalsFor(position.chain, fill.buyMint);
    const qty = dec === null ? position.quantity : Number(BigInt(fill.buyAmountBaseUnits)) / 10 ** dec;
    const price = dec === null || qty <= 0 ? entryPrice : sizeUsd / qty;
    await recordFill(liveFillRow(position, "LIVE_OPEN", price, qty, sizeUsd));
    await deps.notify(buildLiveFillConfirmedMessage({
      symbol: position.symbol, chain: position.chain, kind: "ENTRY",
      price, sellAmount: fill.sellAmountBaseUnits, buyAmount: fill.buyAmountBaseUnits,
      signature: res.hash,
    }));
    syncCounts();
    persistLiveState();
  } catch (error) {
    failOrder(deps, id, "BUY", String(error).slice(0, 200));
  }
}

interface LiveSellEvent {
  level?: number;
  price: number;
  proceedsUsd: number;
}

// ---------------------------------------------------------------------------
// Live exit manager: paper TP/exit events enqueue intent; a background pump
// (2s loop, 2 concurrent) executes with escalating slippage and retries.
// Nothing here ever runs on the price-tracker tick, so a stuck sell or a
// 120s receipt wait can no longer blind other positions' stops.
// A failed sell retries (x1/x2/x5 slippage) up to LIVE_SELL_MAX_RETRIES,
// then goes manual-review terminal. A 60s sweeper reaps live bags whose
// paper position is gone.
// ---------------------------------------------------------------------------

export interface PendingLiveSell {
  positionId: string;
  chain: string;
  symbol: string;
  tokenName: string;
  dexId: string;
  pairAddress: string;
  poolAddress: string;
  tokenMint: string;
  quoteMint: string;
  quoteSymbol: string;
  priceNative: string;
  kind: "TP" | "EXIT";
  level?: number;
  /** Journal label: TP1..TP3 or EXIT (one lifecycle each). */
  label: string;
  sellBaseUnits: string;
  /** Mark price for USD reporting; NaN when unknown (sweeper orphans). */
  paperPrice: number;
  sizeUsdForReport: number;
  attempts: number;
  nextAttemptAt: number;
}

let pendingSells: PendingLiveSell[] = [];
let lastSweepAt = 0;
let pumping = false;
const SELL_PUMP_CONCURRENCY = 2;
const SELL_SWEEP_MS = 60_000;
// Escalating slippage multipliers per attempt (0-based), capped at 5000bps.
const SELL_SLIPPAGE_STEPS = [1, 2, 5];
const sweepAlerted = new Set<string>();

/** Pure: slippage budget for attempt N. Exported for tests. */
export function nextSellSlippageBps(baseBps: number, attempt: number): number {
  const step = SELL_SLIPPAGE_STEPS[Math.min(Math.max(0, attempt), SELL_SLIPPAGE_STEPS.length - 1)]!;
  return Math.min(5000, baseBps * step);
}

/** Pure: backoff before the next attempt. Exported for tests. */
export function sellRetryDelayMs(attempt: number): number {
  return 5_000 * (attempt + 1);
}

/**
 * Pure queue op: enqueue a live sell intent. Same (positionId, label) twice
 * is one intent. An EXIT supersedes pending TPs for the position (paper
 * already closed — partials are moot). Exported for tests.
 */
export function enqueueLiveSell(
  queue: PendingLiveSell[],
  item: Omit<PendingLiveSell, "attempts" | "nextAttemptAt">,
  now = Date.now(),
): { queue: PendingLiveSell[]; enqueued: boolean } {
  if (queue.some((p) => p.positionId === item.positionId && p.label === item.label)) {
    return { queue, enqueued: false };
  }
  const rest = item.kind === "EXIT"
    ? queue.filter((p) => p.positionId !== item.positionId)
    : queue;
  return { queue: [...rest, { ...item, attempts: 0, nextAttemptAt: now }], enqueued: true };
}

function enqueue(item: Omit<PendingLiveSell, "attempts" | "nextAttemptAt">): boolean {
  const res = enqueueLiveSell(pendingSells, item);
  pendingSells = res.queue;
  return res.enqueued;
}

function dequeue(positionId: string, label: string): void {
  pendingSells = pendingSells.filter((p) => !(p.positionId === positionId && p.label === label));
}

/** Journal intent for a sell attempt: fresh SIGNAL, reopen FAILED, reuse SIGNAL. */
function ensureSellSignal(item: PendingLiveSell, evm: boolean): void {
  const existing = journal.find(
    (o) => o.positionId === item.positionId && o.side === "SELL" && (o.label ?? "") === item.label,
  );
  if (!existing) {
    journal = recordSignal(journal, {
      positionId: item.positionId,
      chain: item.chain,
      side: "SELL",
      label: item.label,
      ...(evm
        ? { meta: { sellToken: item.tokenMint, buyToken: item.quoteMint, sellAmountBaseUnits: item.sellBaseUnits } }
        : {}),
    });
  } else if (existing.status === "FAILED") {
    journal = retrySignal(journal, item.positionId, "SELL", item.label, "retry after terminal fail");
  } else if (existing.status !== "SIGNAL") {
    throw new Error(`live sell ${item.label} ${item.positionId} already ${existing.status}`);
  }
  saveLiveOrders(journal);
}

function liveFillInfo(item: PendingLiveSell): {
  id: string; chain: string; dexId: string; symbol: string; tokenName: string;
  pairAddress: string; poolAddress: string; tokenAddress: string; quoteSymbol: string;
} {
  return {
    id: item.positionId,
    chain: item.chain,
    dexId: item.dexId,
    symbol: item.symbol,
    tokenName: item.tokenName,
    pairAddress: item.pairAddress,
    poolAddress: item.poolAddress,
    tokenAddress: item.tokenMint,
    quoteSymbol: item.quoteSymbol,
  };
}

/** Execute one queued sell (quote → submit → confirm → books). Never throws. */
async function executePendingSell(deps: LiveDeps, item: PendingLiveSell): Promise<void> {
  const evm = isEvmChain(item.chain);
  const quoter = evm ? zeroex : jupiter;
  const live = mirror.find((p) => p.positionId === item.positionId && p.status === "OPEN");
  if (!live) {
    deps.log(`⚠️ live sell ${item.label} ${item.positionId}: no open live position (dropped)`);
    dequeue(item.positionId, item.label);
    trackPending(item.positionId, false);
    return;
  }
  // Re-cap to the live remainder: entry drag and earlier fills move it.
  let qty: bigint;
  try {
    qty = BigInt(item.sellBaseUnits);
    const remaining = BigInt(live.remainingBaseUnits);
    if (qty > remaining) qty = remaining;
  } catch {
    deps.log(`⚠️ live sell ${item.label} ${item.positionId}: unreadable quantity (dropped)`);
    dequeue(item.positionId, item.label);
    trackPending(item.positionId, false);
    return;
  }
  if (qty <= 0n) {
    deps.log(`⚠️ live sell ${item.label} ${item.positionId}: nothing left to sell live (dropped)`);
    dequeue(item.positionId, item.label);
    trackPending(item.positionId, false);
    return;
  }
  const slippageBps = nextSellSlippageBps(config.live.sellSlippageBps, item.attempts);
  const fail = async (note: string, retryable: boolean): Promise<void> => {
    if (retryable && item.attempts < config.live.sellMaxRetries) {
      item.attempts += 1;
      item.nextAttemptAt = Date.now() + sellRetryDelayMs(item.attempts);
      deps.log(`⚠️ live sell ${item.label} ${item.positionId} attempt ${item.attempts} failed (${note}) — retry in ${sellRetryDelayMs(item.attempts) / 1000}s @ ${nextSellSlippageBps(config.live.sellSlippageBps, item.attempts)}bps`);
      return;
    }
    dequeue(item.positionId, item.label);
    failOrder(deps, item.positionId, "SELL", `${item.label}: ${note} (after ${item.attempts} retries)`, item.label);
    await deps.notify(`🔴 LIVE SELL FAILED — ${item.symbol} (${item.label}): ${note}. Bag may still be open — manual review.`);
  };
  try {
    ensureSellSignal(item, evm);
    const trader = takerFor(item.chain);
    const quote = await quoter.quoteSell(liveQuoteRequest(item.chain, {
      sellToken: item.tokenMint,
      buyToken: item.quoteMint,
      sellAmountBaseUnits: qty.toString(),
      slippageBps,
    }));
    const res = evm
      ? await zeroex.sell({ quote, taker: trader, slippageBps })
      : await jupiter.sell({ quote, taker: trader, slippageBps });
    if (!res.hash) throw new Error("live sell returned no signature");
    journal = markSubmitted(journal, item.positionId, "SELL", res.hash, item.label);
    saveLiveOrders(journal);
    await deps.notify(buildLiveSubmittedMessage({
      symbol: item.symbol, chain: item.chain, side: "SELL",
      sizeUsd: item.sizeUsdForReport,
      signature: res.hash,
    }));
    // Confirmed fill, independent of the executor's own parse on Solana;
    // EVM amounts already come receipt-parsed out of sell().
    const fill = evm
      ? { sellAmountBaseUnits: res.sellAmount, buyAmountBaseUnits: res.buyAmount }
      : await fetchConfirmedFill(res.hash);
    mirror = applyLiveFill(mirror, item.positionId, fill.sellAmountBaseUnits);
    saveLivePositions(mirror);
    journal = markConfirmed(journal, item.positionId, "SELL", item.label);
    saveLiveOrders(journal);
    trackPending(item.positionId, false);
    dequeue(item.positionId, item.label);
    // USD proceeds need a mark price; sweeper orphans have none, so their
    // PnL stays unattributed (mirror + journal still record the fill).
    const hasMark = Number.isFinite(item.paperPrice) && item.paperPrice > 0;
    let proceedsUsd = 0;
    if (hasMark) {
      const qp = quotePriceUsd(item.paperPrice, Number(item.priceNative), item.quoteSymbol);
      const buyDec = await buyDecimalsFor(item.chain, item.quoteMint, item.quoteSymbol);
      if (qp !== null && buyDec !== null) {
        proceedsUsd = (Number(BigInt(fill.buyAmountBaseUnits)) / 10 ** buyDec) * qp;
      }
    }
    const realized = hasMark
      ? realizedShare(proceedsUsd, live.entryCostUsd, BigInt(fill.sellAmountBaseUnits), BigInt(live.originalBaseUnits))
      : 0;
    if (hasMark) liveState.recordRealizedPnl(realized);
    if (item.kind === "EXIT") {
      mirror = closeLivePosition(mirror, item.positionId);
      saveLivePositions(mirror);
    }
    syncCounts();
    persistLiveState();
    const rowDetail = item.kind === "TP" ? (`LIVE_TP${item.level ?? 0}` as const) : ("LIVE_EXIT" as const);
    await recordFill(liveFillRow(liveFillInfo(item), rowDetail, hasMark ? item.paperPrice : 0, Number(qty), proceedsUsd));
    await deps.notify(buildLiveFillConfirmedMessage({
      symbol: item.symbol, chain: item.chain,
      kind: item.kind === "TP" ? "TP" : "EXIT",
      ...(item.level !== undefined ? { level: item.level } : {}),
      price: hasMark ? item.paperPrice : null,
      sellAmount: fill.sellAmountBaseUnits,
      buyAmount: fill.buyAmountBaseUnits,
      signature: res.hash,
      realizedPnlUsd: realized,
    }));
    if (liveState.isHalted()) {
      await deps.notify(`🛑 DAILY LOSS LIMIT — live entries halted (net $${liveState.dailyNetPnlUsd.toFixed(2)}, open exposure $${liveState.liveOpenExposureUsd.toFixed(2)})`);
    }
  } catch (error) {
    await fail(String(error).slice(0, 200), true);
  }
}

/**
 * Sweeper: live bags whose paper position is gone still need an exit.
 * Reaps full remainders (quote mint from the mirror, else the EVM journal
 * meta). Positions already terminal-FAILED stay manual-review — the sweeper
 * never fights the operator. Throttled alerts only.
 */
function sweepOrphans(deps: LiveDeps, paperPositions: Map<string, Position>): void {
  for (const live of mirror) {
    if (live.status !== "OPEN") continue;
    if (paperPositions.has(live.positionId)) continue;
    if (pendingSells.some((p) => p.positionId === live.positionId)) continue;
    const terminallyFailed = journal.some(
      (o) => o.positionId === live.positionId && o.side === "SELL" && o.status === "FAILED",
    );
    if (terminallyFailed) continue;
    let quoteMint = live.quoteMint ?? null;
    if (!quoteMint && isEvmChain(live.chain)) {
      const meta = journal.find((o) => o.positionId === live.positionId)?.meta;
      if (meta?.buyToken) quoteMint = meta.buyToken;
    }
    if (!quoteMint) {
      if (!sweepAlerted.has(live.positionId)) {
        sweepAlerted.add(live.positionId);
        deps.log(`⚠️ live orphan ${live.positionId}: quote U unknown, cannot sweep — manual review`);
        void deps.notify(`⚠️ LIVE ORPHAN — ${live.positionId}: paper gone and quote U unknown. Manual review.`);
      }
      continue;
    }
    sweepAlerted.delete(live.positionId);
    const ok = enqueue({
      positionId: live.positionId,
      chain: live.chain,
      symbol: live.positionId,
      tokenName: "",
      dexId: "",
      pairAddress: "",
      poolAddress: "",
      tokenMint: live.tokenMint,
      quoteMint,
      quoteSymbol: "",
      priceNative: "",
      kind: "EXIT",
      label: "EXIT",
      sellBaseUnits: live.remainingBaseUnits,
      paperPrice: NaN,
      sizeUsdForReport: live.entryCostUsd,
    });
    if (ok) {
      trackPending(live.positionId, true);
      deps.log(`🧹 live sweeper: queued orphan EXIT ${live.positionId}`);
    }
  }
}

/**
 * Background pump: execute due sells (2 concurrent) and sweep orphans.
 * No-op unless live trading is enabled. Never throws.
 */
export async function pumpLiveSells(deps: LiveDeps, paperPositions: Map<string, Position>): Promise<void> {
  if (!liveTradingEnabled()) return;
  if (pumping) return;
  pumping = true;
  try {
    const now = Date.now();
    if (now - lastSweepAt >= SELL_SWEEP_MS) {
      lastSweepAt = now;
      sweepOrphans(deps, paperPositions);
    }
    const due = pendingSells.filter((p) => p.nextAttemptAt <= Date.now()).slice(0, SELL_PUMP_CONCURRENCY);
    await Promise.all(due.map((item) => executePendingSell(deps, item)));
  } catch (error) {
    deps.log(`⚠️ live sell pump: ${String(error).slice(0, 150)}`);
  } finally {
    pumping = false;
  }
}

/** Live TP mirror after the paper TP booked. Never throws. */
export async function maybeLiveTp(
  deps: LiveDeps,
  position: Position,
  pair: DexScreenerPair,
  event: { level: 1 | 2 | 3; sellPct: number; price: number; proceedsUsd: number },
): Promise<void> {
  if (!liveChain(position.chain)) return;
  const live = mirror.find((p) => p.positionId === position.id && p.status === "OPEN");
  if (!live) {
    deps.log(`⚠️ live TP${event.level} ${position.id}: no open live position`);
    return;
  }
  let qty: bigint;
  try {
    qty = liveTpQty(live.originalBaseUnits, event.sellPct);
  } catch (error) {
    deps.log(`⚠️ live TP${event.level} ${position.id}: ${String(error).slice(0, 120)}`);
    return;
  }
  const remaining = BigInt(live.remainingBaseUnits);
  const capped = qty > remaining ? remaining : qty;
  if (capped !== qty) {
    deps.log(`⚠️ live TP${event.level} ${position.id}: capped ${qty} → ${capped} (entry drag)`);
  }
  if (capped <= 0n) {
    deps.log(`⚠️ live TP${event.level} ${position.id}: nothing left to sell live`);
    return;
  }
  const label = `TP${event.level}`;
  const ok = enqueue({
    positionId: position.id,
    chain: position.chain,
    symbol: position.symbol,
    tokenName: position.tokenName,
    dexId: position.dexId,
    pairAddress: position.pairAddress,
    poolAddress: position.poolAddress ?? "",
    tokenMint: position.tokenAddress,
    quoteMint: pair.quoteToken.address,
    quoteSymbol: position.quoteSymbol,
    priceNative: pair.priceNative ?? "",
    kind: "TP",
    level: event.level,
    label,
    sellBaseUnits: capped.toString(),
    paperPrice: event.price,
    sizeUsdForReport: event.proceedsUsd,
  });
  if (ok) {
    trackPending(position.id, true);
    deps.log(`⏳ live ${label} ${position.id} queued`);
  }
}

/** Live final-exit mirror after the paper close booked. Never throws. */
export async function maybeLiveExit(
  deps: LiveDeps,
  position: Position,
  pair: DexScreenerPair,
  exitPrice: number,
  event: LiveSellEvent,
): Promise<void> {
  if (!liveChain(position.chain)) return;
  const live = mirror.find((p) => p.positionId === position.id && p.status === "OPEN");
  if (!live) {
    deps.log(`⚠️ live exit ${position.id}: no open live position`);
    return;
  }
  const remaining = BigInt(live.remainingBaseUnits);
  if (remaining <= 0n) {
    deps.log(`⚠️ live exit ${position.id}: live remainder already zero`);
    return;
  }
  const ok = enqueue({
    positionId: position.id,
    chain: position.chain,
    symbol: position.symbol,
    tokenName: position.tokenName,
    dexId: position.dexId,
    pairAddress: position.pairAddress,
    poolAddress: position.poolAddress ?? "",
    tokenMint: position.tokenAddress,
    quoteMint: pair.quoteToken.address,
    quoteSymbol: position.quoteSymbol,
    priceNative: pair.priceNative ?? "",
    kind: "EXIT",
    label: "EXIT",
    sellBaseUnits: remaining.toString(),
    paperPrice: exitPrice,
    sizeUsdForReport: event.proceedsUsd,
  });
  if (ok) {
    trackPending(position.id, true);
    deps.log(`⏳ live EXIT ${position.id} queued`);
  }
}
