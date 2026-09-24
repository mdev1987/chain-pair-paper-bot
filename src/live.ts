import { PublicKey } from "@solana/web3.js";
import { config } from "./config.ts";
import { recordFill, type FillRecord } from "./analytics.ts";
import { liveTradingEnabled } from "./execution/types.ts";
import { JupiterExecutor } from "./execution/solana/jupiter.ts";
import { fetchConfirmedFill } from "./execution/solana/fills.ts";
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
  openOrders,
  recordSignal,
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
let journal: LiveOrder[] = [];
let mirror: LivePosition[] = [];

function liveChain(chain: string): boolean {
  return liveTradingEnabled() && chain === "solana";
}

function saveAll(): void {
  try {
    saveLiveOrders(journal);
  } catch (error) {
    console.log(`⚠️ live journal persist failed: ${String(error).slice(0, 120)}`);
  }
  try {
    saveLivePositions(mirror);
  } catch (error) {
    console.log(`⚠️ live mirror persist failed: ${String(error).slice(0, 120)}`);
  }
  try {
    persistLiveState();
  } catch (error) {
    console.log(`⚠️ live state persist failed: ${String(error).slice(0, 120)}`);
  }
}

function syncCounts(): void {
  liveState.setLiveOpenCount(countOpenLive(mirror));
}

function hasOpenOrder(positionId: string): boolean {
  return openOrders(journal).some((o) => o.positionId === positionId);
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
): void {
  try {
    journal = markFailed(journal, positionId, side, note);
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

async function tokenDecimals(mint: string): Promise<number | null> {
  try {
    return await getSolanaTokenDecimals(mint);
  } catch {
    return null;
  }
}

function liveFillRow(
  position: Position,
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
    const connection = getSolanaConnection();
    const trader = traderPublicKey();
    const report = await reconcileLiveState(journal, mirror, {
      getTxStatus: async (signature: string): Promise<ChainTxStatus> => {
        const [st] = (await connection.getSignatureStatuses([signature])).value;
        if (!st) return "missing";
        if (st.err) return "failed";
        return st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized"
          ? "confirmed"
          : "missing";
      },
      fetchFill: (signature: string) => fetchConfirmedFill(signature),
      getBalance: async (mint: string): Promise<bigint | null> => {
        try {
          const accs = await connection.getParsedTokenAccountsByOwner(
            new PublicKey(trader),
            { mint: new PublicKey(mint) },
          );
          let total = 0n;
          for (const a of accs.value) {
            const amt = (a.account.data as unknown as { parsed?: { info?: { tokenAmount?: { amount?: unknown } } } })
              ?.parsed?.info?.tokenAmount?.amount;
            if (typeof amt === "string") {
              try {
                total += BigInt(amt);
              } catch {
                // Skip unparseable rows.
              }
            }
          }
          return total;
        } catch {
          return null;
        }
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
    saveAll();
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
  try {
    journal = recordSignal(journal, { positionId: id, chain: position.chain, side: "BUY" });
    saveLiveOrders(journal);
    trackPending(id, true);
    const trader = traderPublicKey();
    const basis = quoteUsd(entryPrice, pair);
    if (!basis) throw new Error("no live quote basis (unknown quote price/decimals)");
    const sellBase = usdToBaseUnits(sizeUsd / basis.qp, basis.qd);
    const quote = await jupiter.quoteBuy({
      chain: position.chain,
      sellToken: pair.quoteToken.address,
      buyToken: position.tokenAddress,
      sellAmountBaseUnits: sellBase,
      taker: trader,
      slippageBps: config.entry.slippageBps,
    });
    const res = await jupiter.buy({
      quote,
      taker: trader,
      slippageBps: config.entry.slippageBps,
      sizeUsd,
      positionId: id,
    });
    if (!res.hash) throw new Error("live buy returned no signature");
    journal = markSubmitted(journal, id, "BUY", res.hash);
    saveLiveOrders(journal);
    await deps.notify(buildLiveSubmittedMessage({
      symbol: position.symbol, chain: position.chain, side: "BUY", sizeUsd, signature: res.hash,
    }));
    const fill = await fetchConfirmedFill(res.hash);
    if (fill.buyMint.toLowerCase() !== position.tokenAddress.toLowerCase()) {
      throw new Error(`fill token mismatch: ${fill.buyMint} vs ${position.tokenAddress}`);
    }
    mirror = openLivePosition(mirror, {
      positionId: id,
      chain: position.chain,
      tokenMint: fill.buyMint,
      filledBaseUnits: fill.buyAmountBaseUnits,
      entryCostUsd: sizeUsd,
    });
    saveLivePositions(mirror);
    journal = markConfirmed(journal, id, "BUY");
    saveLiveOrders(journal);
    trackPending(id, false);
    const dec = await tokenDecimals(fill.buyMint);
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

async function liveSellFlow(
  deps: LiveDeps,
  position: Position,
  pair: DexScreenerPair,
  sellBaseUnits: bigint,
  detail: "TP" | "EXIT",
  level: number | undefined,
  paperPrice: number,
  sizeUsdForReport: number,
): Promise<void> {
  const id = position.id;
  const live = mirror.find((p) => p.positionId === id && p.status === "OPEN");
  if (!live) {
    deps.log(`⚠️ live sell ${id}: no open live position (paper-only or never filled live)`);
    return;
  }
  try {
    journal = recordSignal(journal, { positionId: id, chain: position.chain, side: "SELL" });
    saveLiveOrders(journal);
    trackPending(id, true);
    const trader = traderPublicKey();
    const quote = await jupiter.quoteSell({
      chain: position.chain,
      sellToken: position.tokenAddress,
      buyToken: pair.quoteToken.address,
      sellAmountBaseUnits: sellBaseUnits.toString(),
      taker: trader,
      slippageBps: config.entry.slippageBps,
    });
    const res = await jupiter.sell({ quote, taker: trader, slippageBps: config.entry.slippageBps });
    if (!res.hash) throw new Error("live sell returned no signature");
    journal = markSubmitted(journal, id, "SELL", res.hash);
    saveLiveOrders(journal);
    await deps.notify(buildLiveSubmittedMessage({
      symbol: position.symbol, chain: position.chain, side: "SELL",
      sizeUsd: sizeUsdForReport,
      signature: res.hash,
    }));
    const fill = await fetchConfirmedFill(res.hash);
    const applied = applyLiveFill(mirror, id, fill.sellAmountBaseUnits);
    mirror = applied;
    saveLivePositions(mirror);
    journal = markConfirmed(journal, id, "SELL");
    saveLiveOrders(journal);
    trackPending(id, false);
    // Actual USD proceeds from the confirmed buy (quote) currency.
    const basis = quoteUsd(paperPrice, pair);
    const buyDec = KNOWN_QUOTE_DECIMALS[position.quoteSymbol.toLowerCase()];
    let proceedsUsd = 0;
    if (basis && buyDec !== undefined) {
      proceedsUsd = (Number(BigInt(fill.buyAmountBaseUnits)) / 10 ** buyDec) * basis.qp;
    }
    const realized = realizedShare(
      proceedsUsd,
      live.entryCostUsd,
      BigInt(fill.sellAmountBaseUnits),
      BigInt(live.originalBaseUnits),
    );
    liveState.recordRealizedPnl(realized);
    if (detail === "EXIT") {
      mirror = closeLivePosition(mirror, id);
      saveLivePositions(mirror);
    }
    syncCounts();
    persistLiveState();
    const rowDetail = detail === "TP" ? (`LIVE_TP${level ?? 0}` as const) : ("LIVE_EXIT" as const);
    await recordFill(liveFillRow(position, rowDetail, paperPrice, Number(sellBaseUnits), proceedsUsd));
    await deps.notify(buildLiveFillConfirmedMessage({
      symbol: position.symbol, chain: position.chain,
      kind: detail === "TP" ? "TP" : "EXIT",
      ...(level !== undefined ? { level } : {}),
      price: paperPrice,
      sellAmount: fill.sellAmountBaseUnits,
      buyAmount: fill.buyAmountBaseUnits,
      signature: res.hash,
      realizedPnlUsd: realized,
    }));
    if (liveState.isHalted()) {
      await deps.notify(`🛑 DAILY LOSS LIMIT — live entries halted (loss $${liveState.dailyLossUsd.toFixed(2)})`);
    }
  } catch (error) {
    failOrder(deps, id, "SELL", String(error).slice(0, 200));
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
  await liveSellFlow(deps, position, pair, capped, "TP", event.level, event.price, event.proceedsUsd);
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
  await liveSellFlow(deps, position, pair, remaining, "EXIT", undefined, exitPrice, event.proceedsUsd);
}
