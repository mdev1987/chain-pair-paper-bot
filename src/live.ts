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
    const quote = await quoter.quoteBuy(liveQuoteRequest(position.chain, {
      sellToken: quoteSellToken,
      buyToken: position.tokenAddress,
      sellAmountBaseUnits: sellBase,
      slippageBps: config.entry.slippageBps,
    }));
    const res = await (evm
      ? zeroex.buy({ quote, taker: trader, slippageBps: config.entry.slippageBps, sizeUsd, positionId: id })
      : jupiter.buy({ quote, taker: trader, slippageBps: config.entry.slippageBps, sizeUsd, positionId: id }));
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
  const evm = isEvmChain(position.chain);
  const quoter = evm ? zeroex : jupiter;
  const live = mirror.find((p) => p.positionId === id && p.status === "OPEN");
  if (!live) {
    deps.log(`⚠️ live sell ${id}: no open live position (paper-only or never filled live)`);
    return;
  }
  try {
    journal = recordSignal(journal, {
      positionId: id,
      chain: position.chain,
      side: "SELL",
      ...(evm
        ? { meta: { sellToken: position.tokenAddress, buyToken: pair.quoteToken.address, sellAmountBaseUnits: sellBaseUnits.toString() } }
        : {}),
    });
    saveLiveOrders(journal);
    trackPending(id, true);
    const trader = takerFor(position.chain);
    const quote = await quoter.quoteSell(liveQuoteRequest(position.chain, {
      sellToken: position.tokenAddress,
      buyToken: pair.quoteToken.address,
      sellAmountBaseUnits: sellBaseUnits.toString(),
      slippageBps: config.entry.slippageBps,
    }));
    const res = evm
      ? await zeroex.sell({ quote, taker: trader, slippageBps: config.entry.slippageBps })
      : await jupiter.sell({ quote, taker: trader, slippageBps: config.entry.slippageBps });
    if (!res.hash) throw new Error("live sell returned no signature");
    journal = markSubmitted(journal, id, "SELL", res.hash);
    saveLiveOrders(journal);
    await deps.notify(buildLiveSubmittedMessage({
      symbol: position.symbol, chain: position.chain, side: "SELL",
      sizeUsd: sizeUsdForReport,
      signature: res.hash,
    }));
    // Confirmed fill, independent of the executor's own parse on Solana;
    // EVM amounts already come receipt-parsed out of sell().
    const fill = evm
      ? { sellAmountBaseUnits: res.sellAmount, buyAmountBaseUnits: res.buyAmount }
      : await fetchConfirmedFill(res.hash);
    const applied = applyLiveFill(mirror, id, fill.sellAmountBaseUnits);
    mirror = applied;
    saveLivePositions(mirror);
    journal = markConfirmed(journal, id, "SELL");
    saveLiveOrders(journal);
    trackPending(id, false);
    // Actual USD proceeds from the confirmed buy (quote) currency.
    const basis = quoteUsd(paperPrice, pair);
    const buyDec = await buyDecimalsFor(position.chain, pair.quoteToken.address, position.quoteSymbol);
    let proceedsUsd = 0;
    if (basis && buyDec !== null) {
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
