import { config } from "./config.ts";
import { fetchNewestPools } from "./dexpaprika.ts";
import {
  assessConfirmation,
  getPair,
  getPairsByChain,
  parsePrice,
  pairLiquidityUsd,
} from "./dexscreener.ts";
import {
  effectiveStopPrice,
  totalPnlPct,
  totalPnlUsd,
  openPosition,
  updatePosition,
} from "./position.ts";
import { Portfolio } from "./portfolio.ts";
import { loadState, saveState } from "./store.ts";
import {
  analyticsStatus,
  closeAnalytics,
  initAnalytics,
  recordFill,
  recordQuoteCheck,
  recordSnapshot,
  recordTrade,
  tradeRecordFromPosition,
} from "./analytics.ts";
import {
  buildBuyMessage,
  buildCloseMessage,
  buildStartupMessage,
  buildStopMovedMessage,
  buildTpMessage,
  buildTrailActivatedMessage,
  chainIcon,
} from "./report.ts";
import type { Candidate, DexScreenerPair, Position } from "./types.ts";
import { telegram, testTelegram } from "./telegram.ts";
import {
  KNOWN_QUOTE_DECIMALS,
  qtyToBaseUnits,
  quotePriceUsd,
  resolveTokenDecimals,
  SIM_ZERO_TAKER,
  simulateSwap,
} from "./execution/simulate.ts";
import { EVM_CHAIN_IDS } from "./execution/evm/viem-client.ts";

const seenPools = new Map<string, number>();
const candidates = new Map<string, Candidate>();
const positions = new Map<string, Position>();
const portfolio = new Portfolio(config.portfolio.initialBalanceUsd);

// Cumulative fee/slippage already attributed to the ledger, per position.
// Lets partial fills record incremental (delta) costs instead of totals.
const ledgerCosts = new Map<string, { fee: number; slip: number }>();

// Last per-minute market snapshot per open position (late-gap research).
// Entries die with the position, so the map stays bounded by open count.
const lastSnapshotAt = new Map<string, number>();

// --- Positions recovery: state.json is the source of truth for open
// positions, cash and closed-trade history across restarts. Saves are
// immediate on opens/fills/closes and throttled (15s) on idle ticks so
// trailing-high progress is never more than a few seconds stale.
let lastPersistAt = 0;
const PERSIST_THROTTLE_MS = 15_000;

function persist(force: boolean): void {
  if (!config.recovery.enabled) return;
  const now = Date.now();
  if (!force && now - lastPersistAt < PERSIST_THROTTLE_MS) return;
  lastPersistAt = now;
  try {
    saveState(config.recovery.stateFile, {
      version: 1,
      savedAt: now,
      cashUsd: portfolio.cashUsd,
      closedTrades: [...portfolio.closedTrades],
      openPositions: [...positions.values()].filter((p) => p.status === "OPEN"),
    });
  } catch (error) {
    log(`⚠️ persist failed: ${String(error)}`);
  }
}

function restore(): void {
  if (!config.recovery.enabled) return;
  const state = loadState(config.recovery.stateFile);
  if (state.openPositions.length === 0 && state.closedTrades.length === 0 && !Number.isFinite(state.cashUsd)) {
    log("♻️ recovery: no prior state, starting fresh");
    return;
  }
  portfolio.restore(state.cashUsd, state.closedTrades);
  let restored = 0;
  for (const position of state.openPositions) {
    if (positions.has(position.id)) continue;
    if (positions.size >= config.entry.maxOpenPositions) {
      log(`⚠️ recovery: position cap reached, skipping ${position.id}`);
      continue;
    }
    // Backfill fields added after this state file was written: pre-upgrade
    // positions lack path tracking and shadow-cost accrual, so seed neutral
    // values instead of dropping the position.
    position.lowestPrice ??= position.currentPrice;
    position.lowestAt ??= position.openedAt;
    position.highestAt ??= position.updatedAt;
    position.shadowFeeUsd ??= 0;
    position.shadowSlipUsd ??= 0;
    positions.set(position.id, position);
    // Restore the fee/slippage baseline so post-restart fills record
    // incremental (delta) costs instead of re-counting lifetime totals.
    ledgerCosts.set(position.id, {
      fee: position.totalExitFeeUsd,
      slip: position.totalSlippageUsd,
    });
    restored += 1;
  }
  const age = state.savedAt > 0 ? ` (saved ${Math.round((Date.now() - state.savedAt) / 1000)}s ago)` : "";
  log(
    `♻️ recovery: restored ${restored} open positions, ` +
    `cash $${portfolio.cashUsd.toFixed(2)}, ` +
    `${portfolio.closedTrades.length} closed trades${age}`,
  );
}

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

/**
 * Best-effort Telegram delivery. Reporting must never determine whether a
 * trade is considered open/closed — a failed send only logs.
 */
async function notify(markdown: string): Promise<void> {
  try {
    await telegram(markdown);
  } catch (error) {
    log(`⚠️ telegram send failed: ${String(error)}`);
  }
}

function short(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function ageSeconds(createdAtMs: number): number {
  return Math.max(0, (Date.now() - createdAtMs) / 1000);
}

function isAllowedQuote(pair: DexScreenerPair): boolean {
  if (config.dexPaprika.quoteSymbols.length === 0) return true;
  const quote = pair.quoteToken.symbol.trim().toLowerCase();
  return config.dexPaprika.quoteSymbols.includes(quote);
}

function isAllowedDex(pair: DexScreenerPair): boolean {
  if (config.dexPaprika.dexIds.length === 0) return true;
  return config.dexPaprika.dexIds.includes(pair.dexId.toLowerCase());
}

function chooseCandidateToken(pair: DexScreenerPair): {
  address: string;
  symbol: string;
  name: string;
} {
  return {
    address: pair.baseToken.address,
    symbol: pair.baseToken.symbol,
    name: pair.baseToken.name,
  };
}

async function announceCandidate(candidate: Candidate, price: number): Promise<void> {
  const liquidity = pairLiquidityUsd(candidate.pair);
  const age = ageSeconds(candidate.poolCreatedAt);
  const markdown = [
    `### 🆕 NEW PAIR — ${candidate.tokenSymbol || "UNKNOWN"}`,
    `${chainIcon(candidate.chain)} Chain: ${candidate.chain}  |  🏷️ DEX: ${candidate.dexId}`,
    `🪙 ${candidate.tokenName || candidate.tokenSymbol} (${candidate.tokenSymbol}/${candidate.quoteSymbol})`,
    `🔗 Pair: \`${candidate.pairAddress}\``,
    `💧 Liquidity: $${liquidity.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
    `💲 Price: $${price.toPrecision(8)}`,
    `⏱️ Age: ${Math.round(age)}s`,
    candidate.pair.url ? `[DexScreener](${candidate.pair.url})` : "",
  ].filter(Boolean).join("\n");

  await notify(markdown);
}

async function announceBuy(position: Position): Promise<void> {
  await notify(buildBuyMessage({
    position,
    stopPrice: effectiveStopPrice(position),
    tpGains: config.tp.map((t) => t.gainPct),
    trailActivationPct: config.stops.trailActivationPct,
    trailDistancePct: config.stops.trailDistancePct,
    maxHoldMin: config.entry.maxPositionAgeMin,
    balanceBeforeUsd: position.balanceBeforeUsd ?? portfolio.equityUsd(positions.values()),
    cashAfterUsd: portfolio.cashUsd,
    openCount: positions.size,
    maxOpen: config.entry.maxOpenPositions,
  }));
}

/**
 * Parallel real-quote diagnostics (simulation stage). Runs AFTER the paper
 * bookkeeping is complete and NEVER gates trading — every failure is caught,
 * logged, and ledgered as a skip. Feeds the fill-vs-mark dataset that
 * decides whether the strategy transfers to live execution.
 */
function simTaker(): string {
  return process.env.SIM_TAKER_ADDRESS ?? SIM_ZERO_TAKER;
}

function chainIdFor(chain: string): number | undefined {
  return EVM_CHAIN_IDS[chain];
}

async function recordEntryQuoteCheck(
  position: Position,
  activePair: DexScreenerPair,
  entryPrice: number,
  sizeUsd: number,
): Promise<void> {
  const base = {
    time: Date.now(),
    positionId: position.id,
    chain: position.chain,
    side: "BUY" as const,
    paperPriceUsd: entryPrice,
  };
  try {
    const quoteSymbol = activePair.quoteToken.symbol;
    const qp = quotePriceUsd(entryPrice, Number(activePair.priceNative ?? "NaN"), quoteSymbol);
    const qd = KNOWN_QUOTE_DECIMALS[quoteSymbol.toLowerCase()];
    if (qp === null || qd === undefined) {
      await recordQuoteCheck({
        ...base, source: "skipped", quotedSellAmount: "", quotedBuyAmount: "",
        sellDecimals: null, buyDecimals: null, riskPass: null, simOk: null,
        note: qp === null ? "quote-price-unknown" : `decimals-unknown:${quoteSymbol}`,
      });
      return;
    }
    const chainId = chainIdFor(position.chain);
    const result = await simulateSwap({
      chain: position.chain,
      ...(chainId !== undefined ? { chainId } : {}),
      side: "BUY",
      sellToken: activePair.quoteToken.address,
      buyToken: position.tokenAddress,
      sellAmountBaseUnits: qtyToBaseUnits(sizeUsd / qp, qd),
      sellDecimals: qd,
      buyDecimals: null,
      pairAddress: activePair.pairAddress,
      taker: simTaker(),
      slippageBps: 100,
    });
    await recordQuoteCheck({
      ...base, source: result.source,
      quotedSellAmount: result.quotedSellAmount, quotedBuyAmount: result.quotedBuyAmount,
      sellDecimals: qd, buyDecimals: null,
      riskPass: result.riskPass, simOk: result.simOk, note: result.note,
    });
  } catch (error) {
    log(`⚠️ entry quote-check ${position.id}: ${String(error).slice(0, 150)}`);
  }
}

async function recordExitQuoteCheck(
  position: Position,
  pair: DexScreenerPair,
  soldQty: number,
  exitPrice: number,
): Promise<void> {
  const base = {
    time: Date.now(),
    positionId: position.id,
    chain: position.chain,
    side: "SELL" as const,
    paperPriceUsd: exitPrice,
  };
  try {
    const tokenDec = await resolveTokenDecimals(position.chain, position.tokenAddress);
    const qd = KNOWN_QUOTE_DECIMALS[position.quoteSymbol.toLowerCase()];
    if (tokenDec === null) {
      await recordQuoteCheck({
        ...base, source: "skipped", quotedSellAmount: "", quotedBuyAmount: "",
        sellDecimals: null, buyDecimals: qd ?? null, riskPass: null, simOk: null,
        note: "token-decimals-unavailable",
      });
      return;
    }
    const chainId = chainIdFor(position.chain);
    const result = await simulateSwap({
      chain: position.chain,
      ...(chainId !== undefined ? { chainId } : {}),
      side: "SELL",
      sellToken: position.tokenAddress,
      buyToken: pair.quoteToken.address,
      sellAmountBaseUnits: qtyToBaseUnits(soldQty, tokenDec),
      sellDecimals: tokenDec,
      buyDecimals: qd ?? null,
      pairAddress: position.pairAddress,
      taker: simTaker(),
      slippageBps: 100,
    });
    await recordQuoteCheck({
      ...base, source: result.source,
      quotedSellAmount: result.quotedSellAmount, quotedBuyAmount: result.quotedBuyAmount,
      sellDecimals: tokenDec, buyDecimals: qd ?? null,
      riskPass: result.riskPass, simOk: result.simOk, note: result.note,
    });
  } catch (error) {
    log(`⚠️ exit quote-check ${position.id}: ${String(error).slice(0, 150)}`);
  }
}

async function processPool(chain: string, pool: Awaited<ReturnType<typeof fetchNewestPools>>[number], pair: DexScreenerPair): Promise<void> {
  const key = `${chain}:${pool.poolAddress}`;
  if (seenPools.has(key)) return;

  const price = parsePrice(pair);
  if (price === null) return;
  if (!isAllowedQuote(pair) || !isAllowedDex(pair)) return;
  // Fresh-quote liquidity band: DexPaprika rows can be stale, so re-apply
  // the $15k–$100k band against the DexScreener print before entering.
  const liquidity = pairLiquidityUsd(pair);
  if (
    liquidity < config.dexPaprika.minLiquidityUsd ||
    liquidity > config.dexPaprika.maxLiquidityUsd
  ) return;

  const token = chooseCandidateToken(pair);
  const candidate: Candidate = {
    key,
    chain,
    poolAddress: pool.poolAddress,
    pairAddress: pair.pairAddress,
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    tokenName: token.name,
    quoteSymbol: pair.quoteToken.symbol,
    dexId: pair.dexId,
    pair,
    discoveredAt: Date.now(),
    poolCreatedAt: pool.createdAtMs,
  };

  candidates.set(key, candidate);
  // Mark only after DexScreener resolution and candidate acceptance.
  // This lets transient DS failures and newly-active pools be retried.
  seenPools.set(key, Date.now());

  log(
    `🆕 ${chain} ${candidate.tokenSymbol} ${short(candidate.poolAddress)} ` +
    `price=$${price.toPrecision(8)} liq=$${liquidity.toFixed(0)}`,
  );
  if (config.telegram.announceCandidates) {
    await announceCandidate(candidate, price);
  }

  if (!config.entry.auto) return;
  if (positions.size >= config.entry.maxOpenPositions) return;

  // Per-chain sizing (uniform POSITION_SIZE_USD unless CHAIN_POSITION_SIZES
  // overrides this chain). Resolved once so the impact guard, reserve, fill
  // record and position all agree on the same notional.
  const sizeUsd = config.entry.chainSizes.get(chain) ?? config.entry.positionSizeUsd;

  // Pre-entry exitability guard: skip pools where our own paper exit would
  // move the price (estimated against half the venue liquidity). Logs and
  // retries are handled by the caller — this only gates new entries.
  const impactPct = (sizeUsd / Math.max(1, liquidity / 2)) * 100;
  if (impactPct > config.entry.maxImpactPct) {
    log(`⏭️ skip entry ${chain}:${pair.pairAddress}: est. impact ${impactPct.toFixed(2)}% > ${config.entry.maxImpactPct}%`);
    return;
  }

  // Two-snapshot confirmation: re-quote after a short delay and enter on the
  // second print. Rejects pools already sliding or draining; rising/flat
  // prints pass freely (no momentum requirement).
  let activePair = pair;
  let entryPrice = price;
  let entryLiquidity = liquidity;
  if (config.entry.confirmEnabled) {
    await new Promise((resolve) => setTimeout(resolve, config.entry.confirmDelayMs));
    let fresh: DexScreenerPair | null = null;
    try {
      fresh = await getPair(chain, pair.pairAddress);
    } catch (error) {
      log(`⏭️ skip entry ${chain}:${pair.pairAddress}: re-quote failed (${String(error)})`);
      return;
    }
    if (!fresh) {
      log(`⏭️ skip entry ${chain}:${pair.pairAddress}: vanished on re-quote`);
      return;
    }
    const freshPrice = parsePrice(fresh);
    const verdict = assessConfirmation(
      { price, liquidityUsd: liquidity },
      { price: freshPrice ?? NaN, liquidityUsd: pairLiquidityUsd(fresh) },
      config.entry.confirmMaxPriceDropPct,
      config.entry.confirmMaxLiqDropPct,
    );
    if (!verdict.ok || freshPrice === null) {
      log(`⏭️ skip entry ${chain}:${pair.pairAddress}: confirm failed (${verdict.reason ?? "no-price"})`);
      return;
    }
    activePair = fresh;
    entryPrice = freshPrice;
    entryLiquidity = pairLiquidityUsd(fresh);
  }

  const positionId = `${chain}:${activePair.pairAddress}`;
  if (positions.has(positionId)) return;
  if (config.entry.oneEntryPerPool && portfolio.closedTrades.some((t) => t.id === positionId)) {
    log(`⏭️ skip re-entry ${positionId}: already traded (ONE_ENTRY_PER_POOL)`);
    return;
  }

  const balanceBefore = portfolio.equityUsd(positions.values());
  if (!portfolio.canOpen(sizeUsd)) {
    log(`⚠️ skip entry ${positionId}: insufficient cash $${portfolio.cashUsd.toFixed(2)}`);
    return;
  }

  const entryToken = chooseCandidateToken(activePair);
  const position = openPosition({
    id: positionId,
    chain,
    pairAddress: activePair.pairAddress,
    tokenAddress: entryToken.address,
    symbol: entryToken.symbol,
    tokenName: entryToken.name,
    quoteSymbol: activePair.quoteToken.symbol,
    dexId: activePair.dexId,
    pairUrl: activePair.url,
    marketPrice: entryPrice,
    usdSize: sizeUsd,
    balanceBeforeUsd: balanceBefore,
    poolAddress: pool.poolAddress,
    entryLiquidityUsd: entryLiquidity,
    entryAgeSec: ageSeconds(pool.createdAtMs),
  });
  portfolio.onOpen(sizeUsd);

  positions.set(positionId, position);
  // Fee/slippage baseline for incremental per-fill attribution. The fee
  // baseline must be the cumulative EXIT fee (zero at open): TP/exit dumps
  // compute `totalExitFeeUsd - prev.fee`, so seeding it with the entry fee
  // would under-count the first fill whenever PAPER_*_FEE_BPS > 0.
  // totalSlippageUsd already includes entry slippage, which is exactly the
  // baseline later deltas must exclude.
  ledgerCosts.set(positionId, { fee: position.totalExitFeeUsd, slip: position.totalSlippageUsd });
  persist(true);
  await recordFill({
    time: Date.now(),
    side: "BUY",
    positionId,
    chain,
    dex: position.dexId,
    symbol: position.symbol,
    tokenName: position.tokenName,
    pair: position.pairAddress,
    pool: position.poolAddress ?? "",
    ca: position.tokenAddress,
    quote: position.quoteSymbol,
    price: position.entryPrice,
    qty: position.quantity,
    notionalUsd: sizeUsd,
    feeUsd: position.totalEntryFeeUsd,
    slipUsd: position.totalSlippageUsd,
    detail: "OPEN",
    balanceAfterUsd: portfolio.cashUsd,
  });
  // Parallel real-quote diagnostic (simulation only — paper already booked).
  await recordEntryQuoteCheck(position, activePair, entryPrice, sizeUsd);
  await announceBuy(position);
}

async function discover(): Promise<void> {
  const started = Date.now();
  for (const chain of config.dexPaprika.chains) {
    try {
      const pools = await fetchNewestPools(chain);
      const unseen = pools.filter((pool) => !seenPools.has(`${chain}:${pool.poolAddress}`));
      if (unseen.length === 0) continue;
      // One batched DexScreener call per chain (internally chunked by
      // DEXSCREENER_PAIR_BATCH_SIZE) instead of one request per pool.
      // Worst case ≈ 1–2 requests/chain/cycle, leaving the RPM budget
      // for active-position price tracking.
      let pairs: DexScreenerPair[];
      try {
        pairs = await getPairsByChain(chain, unseen.map((pool) => pool.poolAddress));
      } catch (error) {
        log(`⚠️ DexScreener batch resolve ${chain} (${unseen.length} pools): ${String(error)}`);
        continue; // seenPools untouched → retried next cycle
      }
      const pairMap = new Map(pairs.map((pair) => [pair.pairAddress.toLowerCase(), pair]));
      for (const pool of unseen) {
        const pair = pairMap.get(pool.poolAddress.toLowerCase())
          ?? (pairs.length === 1 && unseen.length === 1 ? pairs[0] : undefined);
        if (!pair) continue; // not indexed yet → retried next cycle
        await processPool(chain, pool, pair);
      }
    } catch (error) {
      log(`⚠️ discovery ${chain}: ${String(error)}`);
    }
  }

  pruneSeenPools();
  pruneCandidates();
  log(`🔎 discovery cycle complete in ${Date.now() - started}ms; seen=${seenPools.size} candidates=${candidates.size}`);
}

function pruneSeenPools(): void {
  const cutoff = Date.now() - 6 * 60 * 60_000;
  for (const [key, timestamp] of seenPools) {
    if (timestamp < cutoff) seenPools.delete(key);
  }
  if (seenPools.size > 20_000) {
    const entries = [...seenPools.entries()].sort((a, b) => a[1] - b[1]);
    for (const [key] of entries.slice(0, Math.floor(entries.length / 2))) {
      seenPools.delete(key);
    }
  }
}

function pruneCandidates(): void {
  const cutoff = Date.now() - 6 * 60 * 60_000;
  for (const [key, candidate] of candidates) {
    if (candidate.discoveredAt < cutoff) candidates.delete(key);
  }
  if (candidates.size > 20_000) {
    const entries = [...candidates.entries()].sort((a, b) => a[1].discoveredAt - b[1].discoveredAt);
    for (const [key] of entries.slice(0, Math.floor(entries.length / 2))) {
      candidates.delete(key);
    }
  }
}

async function trackPositions(): Promise<void> {
  if (positions.size === 0) return;

  const grouped = new Map<string, string[]>();
  for (const position of positions.values()) {
    const list = grouped.get(position.chain) ?? [];
    list.push(position.pairAddress);
    grouped.set(position.chain, list);
  }

  for (const [chain, pairAddresses] of grouped) {
    try {
      const pairs = await getPairsByChain(chain, pairAddresses);
      // DexScreener may return checksummed/lowercased addresses that differ
      // in case from what was requested (EVM hex). Match case-insensitively
      // like discovery does, so a price update is never missed on casing.
      const pairMap = new Map(pairs.map((pair) => [pair.pairAddress.toLowerCase(), pair]));

      for (const position of [...positions.values()].filter((p) => p.chain === chain)) {
        if (position.status !== "OPEN") continue;

        const pair = pairMap.get(position.pairAddress.toLowerCase());
        if (!pair) continue;
        const price = parsePrice(pair);
        if (price === null) continue;

        const events = updatePosition(position, price);
        for (const event of events) {
          log(
            `⚡ ${position.symbol} ${event.type} price=$${price.toPrecision(8)} ` +
            `pnl=${totalPnlPct(position).toFixed(2)}%`,
          );
          switch (event.type) {
            case "TP": {
              portfolio.onProceeds(event.proceedsUsd);
              persist(true);
              const prev = ledgerCosts.get(position.id) ?? { fee: 0, slip: 0 };
              const feeDelta = position.totalExitFeeUsd - prev.fee;
              const slipDelta = position.totalSlippageUsd - prev.slip;
              ledgerCosts.set(position.id, { fee: position.totalExitFeeUsd, slip: position.totalSlippageUsd });
              await recordFill({
                time: Date.now(),
                side: "SELL",
                positionId: position.id,
                chain: position.chain,
                dex: position.dexId,
                symbol: position.symbol,
                tokenName: position.tokenName,
                pair: position.pairAddress,
                pool: position.poolAddress ?? "",
                ca: position.tokenAddress,
                quote: position.quoteSymbol,
                price: event.price,
                qty: event.soldQty,
                notionalUsd: event.proceedsUsd,
                feeUsd: feeDelta,
                slipUsd: slipDelta,
                detail: `TP${event.level}`,
                balanceAfterUsd: portfolio.cashUsd,
              });
              if (config.telegram.announceUpdates) {
                await notify(buildTpMessage({
                  position,
                  level: event.level,
                  gainPct: event.gainPct,
                  sellPct: event.sellPct,
                  price: event.price,
                  soldQty: event.soldQty,
                  proceedsUsd: event.proceedsUsd,
                  equityUsd: portfolio.equityUsd(positions.values()),
                }));
              }
              break;
            }
            case "STOP_MOVED":
              if (config.telegram.announceUpdates) {
                await notify(buildStopMovedMessage(position, event.stopPrice));
              }
              break;
            case "TRAIL_ACTIVATED":
              if (config.telegram.announceUpdates) {
                await notify(buildTrailActivatedMessage(position, event.trailStop));
              }
              break;
            case "TRAIL_EXIT":
            case "STOP_EXIT":
            case "EARLY_EXIT":
            case "BREAKEVEN_EXIT":
            case "TIME_EXIT": {
              // State mutation first: proceeds, close record, removal and
              // persist all happen before any fallible reporting, so a
              // Telegram/analytics failure can never strand the position
              // or leave state.json disagreeing with the portfolio.
              portfolio.onProceeds(event.proceedsUsd);
              position.exitLiquidityUsd = pairLiquidityUsd(pair);
              portfolio.onClose(position);
              positions.delete(position.id);
              const prev = ledgerCosts.get(position.id) ?? { fee: position.totalEntryFeeUsd, slip: 0 };
              ledgerCosts.delete(position.id);
              lastSnapshotAt.delete(position.id);
              position.balanceAfterUsd = portfolio.equityUsd(positions.values());
              persist(true);
              // Analytics is internally best-effort; reporting via notify.
              await recordFill({
                time: Date.now(),
                side: "SELL",
                positionId: position.id,
                chain: position.chain,
                dex: position.dexId,
                symbol: position.symbol,
                tokenName: position.tokenName,
                pair: position.pairAddress,
                pool: position.poolAddress ?? "",
                ca: position.tokenAddress,
                quote: position.quoteSymbol,
                price: event.price,
                qty: event.soldQty,
                notionalUsd: event.proceedsUsd,
                feeUsd: position.totalExitFeeUsd - prev.fee,
                slipUsd: position.totalSlippageUsd - prev.slip,
                detail: event.type,
                balanceAfterUsd: position.balanceAfterUsd,
              });
              await recordTrade(tradeRecordFromPosition(position, {
                pnlUsd: totalPnlUsd(position),
                pnlPct: totalPnlPct(position),
                balanceBeforeUsd: position.balanceBeforeUsd ?? position.balanceAfterUsd,
                balanceAfterUsd: position.balanceAfterUsd,
              }));
              // Parallel real-quote diagnostic for the actual exit fill.
              await recordExitQuoteCheck(position, pair, event.soldQty, event.price);
              const snapshot = portfolio.snapshot(positions.values());
              const chainStat = portfolio.chainStat(position.chain);
              const tokenStat = portfolio.tokenPnlUsd(position.chain, position.symbol);
              await notify(buildCloseMessage({
                position,
                snapshot,
                chainStat,
                tokenTrades: tokenStat.trades,
                tokenPnlUsd: tokenStat.pnlUsd,
              }));
              break;
            }
          }
        }

        // Per-minute market snapshot for the late-gap study (research only,
        // never an exit signal). Skipped for positions that just closed —
        // their close record already carries the final print.
        if (position.status === "OPEN") {
          const tickNow = Date.now();
          if (tickNow - (lastSnapshotAt.get(position.id) ?? 0) >= config.snapshots.intervalS * 1000) {
            lastSnapshotAt.set(position.id, tickNow);
            await recordSnapshot({
              time: tickNow,
              positionId: position.id,
              chain: position.chain,
              symbol: position.symbol,
              price,
              liquidityUsd: pairLiquidityUsd(pair),
              txnsJson: JSON.stringify(pair.txns ?? null),
            });
          }
        }

        // Safety net: position closed without a matching exit event
        // should never happen, but never leak a dead position.
        if ((position.status as string) === "CLOSED" && positions.has(position.id)) {
          if (position.balanceAfterUsd === undefined) {
            position.balanceAfterUsd = portfolio.equityUsd(
              [...positions.values()].filter((p) => p.id !== position.id),
            );
            portfolio.onClose(position);
          }
          positions.delete(position.id);
          lastSnapshotAt.delete(position.id);
          persist(true);
        }
      }
    } catch (error) {
      log(`⚠️ price ${chain}: ${String(error)}`);
    }
  }

  // Throttled save: keeps trailing-high / price progress fresh on disk
  // even when no fill or exit events fired this cycle.
  persist(false);
}

async function runLoop(label: string, intervalMs: number, task: () => Promise<void>): Promise<never> {
  while (true) {
    try {
      await task();
    } catch (error) {
      log(`⚠️ ${label}: ${String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function main(): Promise<void> {
  console.log("============================================");
  console.log(" Multi-Chain New Pair Paper Trading Bot");
  console.log("============================================");
  console.log(`Mode                : ${config.mode}`);
  console.log(`Chains              : ${config.dexPaprika.chains.join(", ")}`);
  console.log(`Entry band          : age ${config.dexPaprika.minAgeSec}-${config.dexPaprika.maxAgeSec}s, ` +
    `liq $${config.dexPaprika.minLiquidityUsd.toLocaleString()}-$${config.dexPaprika.maxLiquidityUsd.toLocaleString()}, ` +
    `confirm ${config.entry.confirmEnabled ? `on (${config.entry.confirmDelayMs}ms)` : "off"}`);
  console.log(`Discovery interval  : ${config.dexPaprika.intervalMs}ms`);
  console.log(`Price interval      : ${config.dexScreener.intervalMs}ms`);
  console.log(`DexScreener RPM cap : ${config.dexScreener.maxRpm}`);
  console.log(`Auto entry          : ${config.entry.auto}`);
  console.log(`Position size       : $${config.entry.positionSizeUsd}` +
    (config.entry.chainSizes.size > 0
      ? ` (overrides: ${[...config.entry.chainSizes.entries()].map(([c, s]) => `${c}=$${s}`).join(", ")})`
      : ""));
  console.log(`Initial balance     : $${config.portfolio.initialBalanceUsd}`);
  console.log(`Max positions       : ${config.entry.maxOpenPositions}`);
  console.log(`Telegram            : ${config.telegram.enabled}`);
  console.log(`CoinGecko key       : ${config.coingecko.apiKey ? "present (enrichment only)" : "absent"}`);
  console.log(`Recovery            : ${config.recovery.enabled ? config.recovery.stateFile : "disabled"}`);

  const analyticsReady = await initAnalytics();
  console.log(`Analytics           : ${analyticsStatus()}`);
  if (config.analytics.enabled && !analyticsReady) {
    log(`⚠️ analytics ledger unavailable (${analyticsStatus()}) — trading continues without it`);
  }

  restore();

  if (config.telegram.enabled) {
    await testTelegram();
    log("✅ Telegram connection OK");
    if (config.telegram.startupMessage) {
      await telegram(buildStartupMessage({
        mode: config.mode,
        chains: config.dexPaprika.chains,
        discoveryMs: config.dexPaprika.intervalMs,
        priceMs: config.dexScreener.intervalMs,
        autoEntry: config.entry.auto,
        positionSizeUsd: config.entry.positionSizeUsd,
        initialBalanceUsd: config.portfolio.initialBalanceUsd,
        maxPositions: config.entry.maxOpenPositions,
        coingeckoWired: config.coingecko.apiKey.length > 0,
        analytics: analyticsStatus(),
      }));
    }
  }

  await Promise.all([
    runLoop("discovery", config.dexPaprika.intervalMs, discover),
    runLoop("price-tracker", config.dexScreener.intervalMs, trackPositions),
  ]);
}

function installShutdownFlush(): void {
  let shuttingDown = false;
  const flushAndExit = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`🛑 ${signal} received — flushing analytics ledger`);
    try {
      await Promise.race([
        closeAnalytics(),
        new Promise((resolve) => setTimeout(resolve, 4_000)),
      ]);
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGTERM", () => void flushAndExit("SIGTERM"));
  process.once("SIGINT", () => void flushAndExit("SIGINT"));
}

installShutdownFlush();

await main();
