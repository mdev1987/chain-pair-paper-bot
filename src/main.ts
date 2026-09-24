import { config, isEntryPausedAt } from "./config.ts";
import { resolveExitProfile } from "./config.ts";
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
  analyticsQuery,
  analyticsStatus,
  closeAnalytics,
  initAnalytics,
  markTradeDrained,
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
  quoteNoteIndicatesDrained,
  quotePriceUsd,
  resolveTokenDecimals,
  SIM_ZERO_TAKER,
  simulateSwap,
} from "./execution/simulate.ts";
import { EVM_CHAIN_IDS, evmRpcFallbackChains, evmRpcSources } from "./execution/evm/viem-client.ts";
import { initLive, maybeLiveEnter, maybeLiveExit, maybeLiveTp, pumpLiveSells } from "./live.ts";
import { maybeLiveTestTrade } from "./live-test.ts";
import { claimInstanceLockForStateFile } from "./instance-lock.ts";
import {
  assessSolanaMint,
  assessV4Hooks,
  getSolanaMintSafety,
  quoteDeviationPct,
  recoverV4PoolKey,
} from "./execution/safety.ts";
import {
  paperLossLimitBreached,
  recentStopCount,
  rollingExpectancyNegative,
} from "./breakers.ts";

const seenPools = new Map<string, number>();
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
    position.trailHigh ??= position.highestPrice;
    position.highStreak ??= 0;
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
  // One line per restored position: without it a restart silently drops the
  // BUY announcements (no re-send on restore) and the closes later arrive
  // for positions Telegram never showed — this log is the audit trail.
  for (const position of positions.values()) {
    log(`♻️ restored ${position.id} ${position.symbol} entry=$${position.entryPrice.toPrecision(8)} qty=${position.quantity.toPrecision(6)}`);
  }
}

/**
 * Boot reconciliation: the DuckDB ledger is best-effort and fails silently,
 * so compare its trade count against state.json at startup and say so when
 * they disagree (analytics will undercount until the gap is understood).
 */
async function reconcileLedgerWithState(): Promise<void> {
  if (!config.analytics.enabled) return;
  if (!analyticsStatus().startsWith("ready")) return;
  try {
    const rows = await analyticsQuery<{ n: bigint | number }>("SELECT COUNT(*) AS n FROM trades");
    const ledgerTrades = Number(rows[0]?.n ?? 0);
    const stateTrades = portfolio.closedTrades.length;
    if (ledgerTrades !== stateTrades) {
      log(`⚠️ ledger gap: state.json holds ${stateTrades} closed trades but DuckDB has ${ledgerTrades} — some closes never reached the ledger; per-trade analytics will undercount`);
    } else {
      log(`📊 ledger reconcile OK: ${ledgerTrades} trades`);
    }
  } catch (error) {
    log(`⚠️ ledger reconcile failed: ${String(error)}`);
  }
}

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

let lastPausedHourLogMs = 0;

/** Hour-gate notice at most once per hour — discovery runs every 40s. */
function logPausedHourThrottled(): void {
  const now = Date.now();
  if (now - lastPausedHourLogMs < 3_600_000) return;
  lastPausedHourLogMs = now;
  log(`⏸️ entries paused (dead UTC hour ${new Date().getUTCHours()}:00) — exits continue`);
}

// --- Portfolio entry gates: per-chain breaker pauses, expectancy gate and
// paper daily-loss limit. Exits always run; only NEW entries pause.
const chainPauseUntilMs = new Map<string, number>();
const chainGateLogAt = new Map<string, number>();

function openCountForChain(chain: string): number {
  let n = 0;
  for (const p of positions.values()) {
    if (p.status === "OPEN" && p.chain === chain) n += 1;
  }
  return n;
}

function gateLogThrottled(key: string, message: string): void {
  const now = Date.now();
  if (now - (chainGateLogAt.get(key) ?? 0) < 15 * 60_000) return;
  chainGateLogAt.set(key, now);
  log(message);
}

/** False when this chain must not open new entries right now. */
function chainEntriesAllowed(chain: string): boolean {
  const now = Date.now();
  if (now < (chainPauseUntilMs.get(chain) ?? 0)) return false; // logged once at trip
  const stops = recentStopCount(portfolio.closedTrades, chain, now, config.risk.breakerWindowMin);
  if (stops >= config.risk.breakerStops) {
    chainPauseUntilMs.set(chain, now + config.risk.breakerPauseMin * 60_000);
    log(`🛑 breaker: ${chain} entries paused ${config.risk.breakerPauseMin}m after ${stops} stops/drains in ${config.risk.breakerWindowMin}m`);
    return false;
  }
  if (rollingExpectancyNegative(portfolio.closedTrades, chain, config.risk.expectancyTrades)) {
    gateLogThrottled(`exp:${chain}`, `⏸️ ${chain} entries gated: last ${config.risk.expectancyTrades} closed net negative`);
    return false;
  }
  return true;
}

function paperEntriesAllowed(): boolean {
  if (!paperLossLimitBreached(portfolio.closedTrades, config.risk.paperDailyLossLimitUsd, Date.now())) {
    return true;
  }
  gateLogThrottled("paperloss", `⏸️ entries gated: paper daily loss limit $${config.risk.paperDailyLossLimitUsd} hit (exits continue)`);
  return false;
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

function simTakerFor(chain: string): string {
  // Solana: omit the EVM zero address entirely (Jupiter rejects it);
  // quote-only diagnostics work without a taker. EVM keeps the zero
  // address as eth_call sender until a real SIM_TAKER_ADDRESS exists.
  if (chain === "solana") {
    const configured = process.env.SIM_TAKER_ADDRESS ?? "";
    if (configured && !/^0x0{40}$/i.test(configured) && !configured.startsWith("0x")) {
      return configured;
    }
    return "";
  }
  return simTaker();
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
      taker: simTakerFor(position.chain),
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
): Promise<{ source: string; note: string } | null> {
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
      const note = "token-decimals-unavailable";
      await recordQuoteCheck({
        ...base, source: "skipped", quotedSellAmount: "", quotedBuyAmount: "",
        sellDecimals: null, buyDecimals: qd ?? null, riskPass: null, simOk: null,
        note,
      });
      return { source: "skipped", note };
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
      taker: simTakerFor(position.chain),
      slippageBps: 100,
    });
    await recordQuoteCheck({
      ...base, source: result.source,
      quotedSellAmount: result.quotedSellAmount, quotedBuyAmount: result.quotedBuyAmount,
      sellDecimals: tokenDec, buyDecimals: qd ?? null,
      riskPass: result.riskPass, simOk: result.simOk, note: result.note,
    });
    return { source: result.source, note: result.note };
  } catch (error) {
    log(`⚠️ exit quote-check ${position.id}: ${String(error).slice(0, 150)}`);
    return null;
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

  // Mark only after DexScreener resolution and candidate acceptance.
  // This lets transient DS failures and newly-active pools be retried.
  // Post-acceptance skips below (impact guard, confirm fail, cap, cash)
  // are TERMINAL for this pool id within the 6h seen-window: the 60–120s
  // age band moves on, so a pool skipped now is stale by the time
  // conditions change.
  seenPools.set(key, Date.now());

  log(
    `🆕 ${chain} ${candidate.tokenSymbol} ${short(candidate.poolAddress)} ` +
    `price=$${price.toPrecision(8)} liq=$${liquidity.toFixed(0)}`,
  );
  if (config.telegram.announceCandidates) {
    await announceCandidate(candidate, price);
  }

  if (!config.entry.auto) return;
  if (isEntryPausedAt(new Date(), config.entry.pausedHoursUtc)) {
    logPausedHourThrottled();
    return;
  }
  // Portfolio gates before any per-pool work: breaker pauses, expectancy
  // gate and the paper daily-loss limit. All entry-only; exits continue.
  if (!chainEntriesAllowed(chain)) return;
  if (!paperEntriesAllowed()) return;
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

  // Entry safety layer: hard-rug-capable mints (creator-held authority,
  // Token-2022) never reach the confirm queue. Unreadable mints pass in
  // lenient mode so an RPC outage doesn't stillbirth every entry.
  if (config.safety.enabled && chain === "solana") {
    const verdict = assessSolanaMint(await getSolanaMintSafety(token.address), config.safety.strict);
    if (!verdict.ok) {
      log(`⏭️ skip entry ${chain}:${pair.pairAddress}: token safety (${verdict.reason})`);
      return;
    }
  }

  // Copycat-ticker block: ONE_ENTRY_PER_POOL covers the exact pair, but a
  // recycled name on a new pair is the documented scam pattern — treat the
  // chain+symbol as one exposure, open or closed.
  if (config.safety.enabled && config.safety.blockRepeatSymbols) {
    const sym = token.symbol.toLowerCase();
    const seenSymbol =
      [...positions.values()].some((p) => p.chain === chain && p.symbol.toLowerCase() === sym) ||
      portfolio.closedTrades.some((t) => t.chain === chain && t.symbol.toLowerCase() === sym);
    if (seenSymbol) {
      log(`⏭️ skip entry ${chain}:${pair.pairAddress}: repeat symbol ${token.symbol} on ${chain}`);
      return;
    }
  }

  // Two-snapshot confirmation is DEFERRED, never inline: the re-quote
  // happens in fireDueConfirms on a 1s loop so the ENTRY_CONFIRM_DELAY_MS
  // wait never stalls pool discovery for other chains/pools.
  if (config.entry.confirmEnabled) {
    queueConfirm({
      chain,
      poolAddress: pool.poolAddress,
      pairAddress: pair.pairAddress,
      firstPrice: price,
      firstLiquidity: liquidity,
      sizeUsd,
      poolCreatedAt: pool.createdAtMs,
    });
    return;
  }

  await openEntry({
    chain,
    poolAddress: pool.poolAddress,
    poolCreatedAtMs: pool.createdAtMs,
    activePair: pair,
    entryPrice: price,
    entryLiquidity: liquidity,
    sizeUsd,
  });
}

interface PendingConfirm {
  chain: string;
  poolAddress: string;
  pairAddress: string;
  firstPrice: number;
  firstLiquidity: number;
  sizeUsd: number;
  poolCreatedAt: number;
  queuedAt: number;
  fireAt: number;
}

// Deferred entry confirmations waiting out ENTRY_CONFIRM_DELAY_MS.
// Bounded by 2x max open positions; queued entries die with a process
// restart (pools re-qualify through discovery on boot).
const pendingConfirms = new Map<string, PendingConfirm>();

function queueConfirm(args: Omit<PendingConfirm, "queuedAt" | "fireAt">): void {
  const positionId = `${args.chain}:${args.pairAddress}`;
  if (positions.has(positionId) || pendingConfirms.has(positionId)) return;
  if (pendingConfirms.size >= Math.max(1, config.entry.maxOpenPositions) * 2) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, p] of pendingConfirms) {
      if (p.queuedAt < oldestAt) {
        oldestAt = p.queuedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) pendingConfirms.delete(oldestKey);
  }
  const now = Date.now();
  pendingConfirms.set(positionId, {
    ...args,
    queuedAt: now,
    fireAt: now + config.entry.confirmDelayMs,
  });
  log(`⏳ ${positionId}: queued for confirm in ${config.entry.confirmDelayMs}ms`);
}

/**
 * Fire due confirmations: re-quote each queued candidate once and enter on
 * the second print. Rejects pools already sliding or draining; rising/flat
 * prints pass freely (no momentum requirement). Cap, pause-gate, cash and
 * re-entry guards are re-checked here because slots fill during the delay.
 */
async function fireDueConfirms(): Promise<void> {
  if (pendingConfirms.size === 0) return;
  const now = Date.now();
  const due = [...pendingConfirms.entries()].filter(([, p]) => p.fireAt <= now);
  for (const [positionId, pending] of due) {
    pendingConfirms.delete(positionId);
    if (now - pending.queuedAt > 60_000) {
      log(`⏭️ drop stale confirm ${positionId}: queued ${Math.round((now - pending.queuedAt) / 1000)}s ago`);
      continue;
    }
    if (isEntryPausedAt(new Date(), config.entry.pausedHoursUtc)) {
      logPausedHourThrottled();
      continue;
    }
    let fresh: DexScreenerPair | null = null;
    try {
      fresh = await getPair(pending.chain, pending.pairAddress);
    } catch (error) {
      log(`⏭️ skip entry ${pending.chain}:${pending.pairAddress}: re-quote failed (${String(error)})`);
      continue;
    }
    if (!fresh) {
      log(`⏭️ skip entry ${pending.chain}:${pending.pairAddress}: vanished on re-quote`);
      continue;
    }
    const freshPrice = parsePrice(fresh);
    const verdict = assessConfirmation(
      { price: pending.firstPrice, liquidityUsd: pending.firstLiquidity },
      { price: freshPrice ?? NaN, liquidityUsd: pairLiquidityUsd(fresh) },
      config.entry.confirmMaxPriceDropPct,
      config.entry.confirmMaxLiqDropPct,
    );
    if (!verdict.ok || freshPrice === null) {
      log(`⏭️ skip entry ${pending.chain}:${pending.pairAddress}: confirm failed (${verdict.reason ?? "no-price"})`);
      continue;
    }
    // V4 hook gate (EVM 64-hex poolIds): a nonzero hook can tax, gate or
    // brick the exit. Unrecovered keys pass lenient (manager unconfigured).
    if (config.safety.enabled && /^0x[0-9a-fA-F]{64}$/.test(pending.pairAddress)) {
      const hookVerdict = assessV4Hooks(
        await recoverV4PoolKey(pending.chain, pending.pairAddress as `0x${string}`),
        config.safety.strict,
      );
      if (!hookVerdict.ok) {
        log(`⏭️ skip entry ${pending.chain}:${pending.pairAddress}: token safety (${hookVerdict.reason})`);
        continue;
      }
    }
    // Executable-quote probe: abort on a stale mark (deviation) or a
    // reverting EVM exit simulation (honeypot exit). Unquotable just logs.
    if (config.safety.enabled) {
      const probe = await probeEntryQuote(pending.chain, fresh, freshPrice, pending.sizeUsd);
      if (probe.deviationPct !== null && probe.deviationPct > config.safety.quoteDeviationPct) {
        log(`⏭️ skip entry ${pending.chain}:${pending.pairAddress}: executable quote deviated ${probe.deviationPct.toFixed(1)}% > ${config.safety.quoteDeviationPct}%`);
        continue;
      }
      if (probe.sellSimReverted) {
        log(`⏭️ skip entry ${pending.chain}:${pending.pairAddress}: exit simulation reverts (unexitable)`);
        continue;
      }
    }
    await openEntry({
      chain: pending.chain,
      poolAddress: pending.poolAddress,
      poolCreatedAtMs: pending.poolCreatedAt,
      activePair: fresh,
      entryPrice: freshPrice,
      entryLiquidity: pairLiquidityUsd(fresh),
      sizeUsd: pending.sizeUsd,
    });
  }
}

/**
 * Pre-entry executable-quote probe (best-effort, never throws). Compares a
 * real BUY quote against the DexScreener mark and runs a dust SELL
 * simulation on EVM. Unquotable or unreadable → unchecked (allow + log);
 * only a measured deviation or an explicit revert blocks the entry.
 */
async function probeEntryQuote(
  chain: string,
  pair: DexScreenerPair,
  markPriceUsd: number,
  sizeUsd: number,
): Promise<{ deviationPct: number | null; sellSimReverted: boolean }> {
  const unchecked = { deviationPct: null, sellSimReverted: false };
  try {
    const priceNative = Number(pair.priceNative ?? "NaN");
    const qp = quotePriceUsd(markPriceUsd, priceNative, pair.quoteToken.symbol);
    const qd = KNOWN_QUOTE_DECIMALS[pair.quoteToken.symbol.toLowerCase()];
    if (qp === null || qd === undefined || !Number.isFinite(priceNative) || priceNative <= 0) {
      return unchecked;
    }
    const chainId = EVM_CHAIN_IDS[chain];
    const base = {
      chain,
      ...(chainId !== undefined ? { chainId } : {}),
      pairAddress: pair.pairAddress,
      taker: simTakerFor(chain),
      slippageBps: 100,
    };
    const buy = await simulateSwap({
      ...base,
      side: "BUY",
      sellToken: pair.quoteToken.address,
      buyToken: pair.baseToken.address,
      sellAmountBaseUnits: qtyToBaseUnits(sizeUsd / qp, qd),
      sellDecimals: qd,
      buyDecimals: null,
    });
    let deviationPct: number | null = null;
    const tokenDec = await resolveTokenDecimals(chain, pair.baseToken.address);
    if (buy.attempted && tokenDec !== null) {
      deviationPct = quoteDeviationPct(1 / priceNative, buy.quotedBuyAmount, buy.quotedSellAmount, tokenDec, qd);
    }
    // Dust exit simulation: a reverting $1 sell means the entry is a trap.
    // No-calldata routes (V4-direct) report simOk null → not a revert.
    let sellSimReverted = false;
    if (chainId !== undefined && tokenDec !== null) {
      const dust = await simulateSwap({
        ...base,
        side: "SELL",
        sellToken: pair.baseToken.address,
        buyToken: pair.quoteToken.address,
        sellAmountBaseUnits: qtyToBaseUnits(1 / markPriceUsd, tokenDec),
        sellDecimals: tokenDec,
        buyDecimals: qd,
      });
      sellSimReverted = dust.attempted && dust.simOk === false;
    }
    return { deviationPct, sellSimReverted };
  } catch {
    return unchecked;
  }
}

/**
 * Open a paper position after all gates pass. Shared by the immediate
 * (confirm-disabled) path and the deferred confirm worker.
 */
async function openEntry(args: {
  chain: string;
  poolAddress: string;
  poolCreatedAtMs: number;
  activePair: DexScreenerPair;
  entryPrice: number;
  entryLiquidity: number;
  sizeUsd: number;
}): Promise<void> {
  const { chain, poolAddress, activePair, entryPrice, entryLiquidity, sizeUsd } = args;
  const positionId = `${chain}:${activePair.pairAddress}`;
  if (positions.has(positionId)) return;
  if (config.entry.oneEntryPerPool && portfolio.closedTrades.some((t) => t.id === positionId)) {
    log(`⏭️ skip re-entry ${positionId}: already traded (ONE_ENTRY_PER_POOL)`);
    return;
  }
  // Age is gated at discovery, but the confirm delay + re-quote means the
  // FILL can land past NEW_POOL_MAX_AGE_SEC (observed up to ~124s against
  // a 120s cap). Enforce the band at fill so the sample stays in-regime.
  const ageSec = ageSeconds(args.poolCreatedAtMs);
  if (ageSec > config.dexPaprika.maxAgeSec) {
    log(`⏭️ skip entry ${positionId}: age ${ageSec.toFixed(0)}s exceeds NEW_POOL_MAX_AGE_SEC=${config.dexPaprika.maxAgeSec}s at fill`);
    return;
  }
  if (positions.size >= config.entry.maxOpenPositions) {
    log(`⏭️ skip entry ${positionId}: position cap reached (${positions.size}/${config.entry.maxOpenPositions})`);
    return;
  }
  const entryToken = chooseCandidateToken(activePair);
  // Per-chain cap bounds simultaneous total loss on one chain.
  const chainCap = config.risk.chainCaps.get(chain);
  if (chainCap !== undefined && openCountForChain(chain) >= chainCap) {
    log(`⏭️ skip entry ${positionId}: chain cap reached (${openCountForChain(chain)}/${chainCap} on ${chain})`);
    return;
  }
  // Same-symbol cluster cap: copycat tickers and same-name pools on
  // different pairs count as one exposure.
  let sameSymbol = 0;
  for (const p of positions.values()) {
    if (p.status === "OPEN" && p.chain === chain && p.symbol === entryToken.symbol) {
      sameSymbol += 1;
    }
  }
  if (sameSymbol >= config.risk.maxSameSymbolOpen) {
    log(`⏭️ skip entry ${positionId}: symbol cluster cap reached (${sameSymbol} open ${entryToken.symbol} on ${chain})`);
    return;
  }

  const balanceBefore = portfolio.equityUsd(positions.values());
  // Single atomic reserve: onOpen returns false when cash is insufficient.
  if (!portfolio.onOpen(sizeUsd)) {
    log(`⚠️ skip entry ${positionId}: insufficient cash $${portfolio.cashUsd.toFixed(2)}`);
    return;
  }

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
    poolAddress,
    entryLiquidityUsd: entryLiquidity,
    entryAgeSec: ageSeconds(args.poolCreatedAtMs),
    // Per-chain exit regime snapshot (undefined = global config behavior).
    exitProfile: resolveExitProfile(chain),
  });

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
    equityAfterUsd: portfolio.equityUsd(positions.values()),
  });
  // Parallel real-quote diagnostic (simulation only — paper already booked).
  await recordEntryQuoteCheck(position, activePair, entryPrice, sizeUsd);
  await announceBuy(position);
  // Live mirror (no-op unless live Solana entries are enabled).
  await maybeLiveEnter({ notify, log }, position, activePair, entryPrice, sizeUsd);
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
  checkLedgerHealthThrottled();
  log(`🔎 discovery cycle complete in ${Date.now() - started}ms; seen=${seenPools.size} pendingConfirm=${pendingConfirms.size}`);
}

let lastLedgerWarnMs = 0;

/**
 * Ledger writes are best-effort and fail silently by design, so surface an
 * unhealthy ledger here (hourly at most) instead of discovering gaps in the
 * DuckDB file weeks later during analysis.
 */
function checkLedgerHealthThrottled(): void {
  if (!config.analytics.enabled) return;
  const status = analyticsStatus();
  if (status.startsWith("ready") || status === "disabled") return;
  const now = Date.now();
  if (now - lastLedgerWarnMs < 3_600_000) return;
  lastLedgerWarnMs = now;
  log(`⚠️ analytics ledger unhealthy (${status}) — trading continues, ledger gaps possible`);
}

function pruneSeenPools(): void {
  // Amortized cleanup: linear scan every cycle, full sort only past the cap.
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

      // Positions on this chain update concurrently (cap 5): each task stays
      // sequential per position (state → persist → reporting order kept),
      // but a slow quote-check or Telegram send on one position no longer
      // stalls the rest of the tick past the 1s poll budget.
      const tasks = [...positions.values()]
        .filter((p) => p.chain === chain)
        .map((position) => () => trackOnePosition(position, pairMap.get(position.pairAddress.toLowerCase())));
      await runWithLimit(tasks, PRICE_TRACK_CONCURRENCY);
    } catch (error) {
      log(`⚠️ price ${chain}: ${String(error)}`);
    }
  }

  // Throttled save: keeps trailing-high / price progress fresh on disk
  // even when no fill or exit events fired this cycle.
  persist(false);
}

/** Max concurrent per-position updates within one price tick. */
const PRICE_TRACK_CONCURRENCY = 5;

/** Run async tasks with at most `limit` in flight. Completion order varies. */
async function runWithLimit(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), Math.max(1, tasks.length)) },
    async () => {
      while (next < tasks.length) {
        const task = tasks[next++]!;
        await task();
      }
    },
  );
  await Promise.all(workers);
}

/**
 * Update one position from its latest DexScreener print: TP fills, stop
 * transitions and exits (state → persist → reporting, in that order), then
 * the research snapshot and the closed-without-event safety net.
 */
async function trackOnePosition(position: Position, pair: DexScreenerPair | undefined): Promise<void> {
  if (position.status !== "OPEN") return;
  if (!pair) return;
  const price = parsePrice(pair);
  if (price === null) return;

        const events = updatePosition(position, price, Date.now(), {
          liquidityUsd: pairLiquidityUsd(pair),
        });
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
                equityAfterUsd: portfolio.equityUsd(positions.values()),
              });
              // Parallel real-quote diagnostic for the partial exit fill,
              // same as full exits below. Best-effort: never gates trading.
              await recordExitQuoteCheck(position, pair, event.soldQty, event.price);
              // Live TP mirror (no-op unless live Solana is enabled).
              await maybeLiveTp({ notify, log }, position, pair, {
                level: event.level,
                sellPct: event.sellPct,
                price: event.price,
                proceedsUsd: event.proceedsUsd,
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
            case "DRAIN_EXIT":
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
                balanceAfterUsd: portfolio.cashUsd,
                equityAfterUsd: position.balanceAfterUsd,
              });
              await recordTrade(tradeRecordFromPosition(position, {
                pnlUsd: totalPnlUsd(position),
                pnlPct: totalPnlPct(position),
                balanceBeforeUsd: position.balanceBeforeUsd ?? position.balanceAfterUsd,
                balanceAfterUsd: position.balanceAfterUsd,
              }));
              // Parallel real-quote diagnostic for the actual exit fill.
              const exitCheck = await recordExitQuoteCheck(position, pair, event.soldQty, event.price);
              // A drained pool means the paper fill may overstate an exit
              // that was unfillable on-chain — flag it for expectancy math.
              if (exitCheck && quoteNoteIndicatesDrained(exitCheck.note)) {
                await markTradeDrained(position.id);
              }
              // Live exit mirror (no-op unless live Solana is enabled).
              await maybeLiveExit({ notify, log }, position, pair, event.price, {
                price: event.price,
                proceedsUsd: event.proceedsUsd,
              });
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
  // Single-instance guard first: a second process sharing state.json and
  // paper.duckdb silently corrupts both (cash jumps, ledger lock losses).
  claimInstanceLockForStateFile(config.recovery.stateFile);
  console.log("============================================");
  console.log(" Multi-Chain New Pair Paper Trading Bot");
  console.log("============================================");
  console.log(`Mode                : ${config.mode}`);
  console.log(`Chains              : ${config.dexPaprika.chains.join(", ")}`);
  console.log(`Entry band          : age ${config.dexPaprika.minAgeSec}-${config.dexPaprika.maxAgeSec}s, ` +
    `liq $${config.dexPaprika.minLiquidityUsd.toLocaleString()}-$${config.dexPaprika.maxLiquidityUsd.toLocaleString()}, ` +
    `confirm ${config.entry.confirmEnabled ? `on (${config.entry.confirmDelayMs}ms)` : "off"}` +
    (config.entry.pausedHoursUtc.size > 0 ? `, paused ${[...config.entry.pausedHoursUtc].sort((a, b) => a - b).join(",")}h UTC` : ""));
  console.log(`Stops               : initial ${config.stops.initialPct}% / trail +${config.stops.trailActivationPct}% x ${config.stops.trailDistancePct}%`);
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
  // Quote-layer visibility: without a 0x key every EVM quote-check runs
  // aggregator-free (direct V2/V4 only). Without a Jupiter key, Solana
  // still quotes (Ultra is keyless) — the key only raises rate limits.
  console.log(`0x key              : ${process.env.ZEROEX_API_KEY ? "present (EVM aggregator quotes on)" : "absent (direct-V2/V4 quotes only)"}`);
  const rpcSources = evmRpcSources();
  console.log(`EVM RPCs            : ${Object.entries(rpcSources).map(([c, s]) => `${c}=${s}`).join(", ")}`);
  const fragileRpcs = Object.entries(rpcSources).filter(([, s]) => s === "none" || s === "public");
  if (fragileRpcs.length > 0) {
    log(`⚠️ EVM chains on fallback/missing RPCs (${fragileRpcs.map(([c, s]) => `${c}=${s}`).join(", ")}) — set EVM_RPC_URLS before any live trading`);
  }
  const fbChains = evmRpcFallbackChains();
  if (fbChains.length > 0) {
    console.log(`EVM RPC failover    : ${fbChains.join(", ")} (secondary transport behind primary)`);
  }
  console.log(`Jupiter key         : ${process.env.JUPITER_API_KEY ? "present" : "absent (Ultra quotes still work, lower rate limit)"}`);
  console.log(`Live trading        : ${process.env.LIVE_TRADING_ENABLED === "true" ? "ENABLED — real funds at risk" : "off (paper only)"}`);
  console.log(`Recovery            : ${config.recovery.enabled ? config.recovery.stateFile : "disabled"}`);

  const analyticsReady = await initAnalytics();
  console.log(`Analytics           : ${analyticsStatus()}`);
  if (config.analytics.enabled && !analyticsReady) {
    log(`⚠️ analytics ledger unavailable (${analyticsStatus()}) — trading continues without it`);
  }

  restore();
  await reconcileLedgerWithState();

  // Live reconciliation (no-op unless LIVE_TRADING_ENABLED=true): restores
  // the kill switch, reloads journals, and resolves every open live order
  // from on-chain status before trading resumes.
  await initLive({ notify, log }, positions);

  // One-shot $5 round-trip self-test (no-op unless LIVE_TEST_TRADE=true).
  await maybeLiveTestTrade({ notify, log });

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
    // Deferred entry-confirm worker: fires queued re-quotes ~ENTRY_CONFIRM_DELAY_MS
    // after queueing. Runs every second so confirms don't wait for the 40s
    // discovery cadence and blow the 60–120s entry age band.
    runLoop("confirm", 1_000, fireDueConfirms),
    // Live exit manager: background execution with retry + sweeper, off the
    // price-tracker tick. No-op unless LIVE_TRADING_ENABLED=true.
    runLoop("live-sells", 2_000, () => pumpLiveSells({ notify, log }, positions)),
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
