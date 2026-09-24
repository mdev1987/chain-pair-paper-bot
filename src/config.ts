function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid number: ${name}=${raw}`);
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function csv(name: string, fallback: string): string[] {
  return env(name, fallback)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function csvLower(name: string, fallback: string): string[] {
  return csv(name, fallback).map((value) => value.toLowerCase());
}

/**
 * Parse paused entry hours ("20,21,22,23" → set). Exported pure for unit
 * tests. Throws on anything outside integer 0–23 so a typo can never
 * silently pause (or unpause) trading.
 */
export function parseHourSet(
  raw: string | undefined,
): Set<number> {
  const set = new Set<number>();
  if (raw === undefined || raw.trim() === "") return set;
  for (const part of raw.split(",")) {
    const hour = Number(part.trim());
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new Error(`Invalid ENTRY_PAUSED_HOURS_UTC hour: "${part}" (want 0-23)`);
    }
    set.add(hour);
  }
  return set;
}

/** True when entries are paused at this instant (UTC hours). Pure. */
export function isEntryPausedAt(now: Date, pausedHoursUtc: Set<number>): boolean {
  return pausedHoursUtc.has(now.getUTCHours());
}

/**
 * Parse per-chain position-count caps ("solana:3,robinhood:8" → map).
 * Exported pure for unit tests. Empty input disables per-chain caps
 * (global MAX_OPEN_POSITIONS still binds). Throws on malformed entries so
 * a typo can never silently uncap a chain.
 */
export function parseChainCaps(raw: string | undefined): Map<string, number> {
  const map = new Map<string, number>();
  if (raw === undefined || raw.trim() === "") return map;
  for (const part of raw.split(",")) {
    const [chainRaw, countRaw] = part.split(":").map((s) => s.trim());
    const count = Number(countRaw);
    if (!chainRaw || countRaw === undefined || countRaw === "" || !Number.isInteger(count)) {
      throw new Error(`Invalid CHAIN_POSITION_CAPS entry: "${part}" (want "chain:count")`);
    }
    if (count < 1) {
      throw new Error(`CHAIN_POSITION_CAPS entry "${part}": count must be a positive integer`);
    }
    map.set(chainRaw.toLowerCase(), count);
  }
  return map;
}

/**
 * Parse per-chain position-size overrides ("solana:5,bsc:5" → map).
 * Exported pure for unit tests. Chains are matched case-insensitively;
 * empty input means uniform sizing. Throws on malformed entries so a typo
 * can never silently trade the wrong size.
 */
export function parseChainSizes(
  raw: string | undefined,
  maxSizeUsd: number,
): Map<string, number> {
  const map = new Map<string, number>();
  if (raw === undefined || raw.trim() === "") return map;
  for (const part of raw.split(",")) {
    const [chainRaw, sizeRaw] = part.split(":").map((s) => s.trim());
    const sizeUsd = Number(sizeRaw);
    if (!chainRaw || sizeRaw === undefined || sizeRaw === "" || !Number.isFinite(sizeUsd)) {
      throw new Error(`Invalid CHAIN_POSITION_SIZES entry: "${part}" (want "chain:size")`);
    }
    if (sizeUsd <= 0 || sizeUsd > maxSizeUsd) {
      throw new Error(`CHAIN_POSITION_SIZES entry "${part}": size must be within (0, ${maxSizeUsd}]`);
    }
    map.set(chainRaw.toLowerCase(), sizeUsd);
  }
  return map;
}

export const config = {
  mode: env("MODE", "paper"),

  dexPaprika: {
    baseUrl: env("DEXPAPRIKA_BASE_URL", "https://api.dexpaprika.com"),
    apiKey: process.env.DEXPAPRIKA_API_KEY ?? "",
    intervalMs: num("DISCOVERY_INTERVAL_MS", 40_000),
    limit: num("DISCOVERY_LIMIT", 20),
    maxRpm: num("DEXPAPRIKA_MAX_RPM", 14),
    // Evidence-backed new-pool band: younger than 60s usually hasn't
    // finished early price discovery (wait for it); older than 120s missed
    // the momentum window (reject). Liquidity $15k–$100k is the region with
    // the strongest realized expectancy; above $100k behaves differently.
    minAgeSec: num("NEW_POOL_MIN_AGE_SEC", 60),
    maxAgeSec: num("NEW_POOL_MAX_AGE_SEC", 120),
    minLiquidityUsd: num("MIN_LIQUIDITY_USD", 15_000),
    maxLiquidityUsd: num("MAX_LIQUIDITY_USD", 100_000),
    minVolume24hUsd: num("MIN_VOLUME_24H_USD", 1_000),
    minTxns24h: num("MIN_TXNS_24H", 5),
    chains: csvLower(
      "CHAINS",
      "solana,robinhood",
    ),
    quoteSymbols: csvLower(
      "QUOTE_SYMBOLS",
      "SOL,USDC,USDT,WETH,ETH,BNB,WBNB",
    ),
    dexIds: csvLower("DEX_IDS", ""),
  },

  dexScreener: {
    baseUrl: env("DEXSCREENER_BASE_URL", "https://api.dexscreener.com"),
    intervalMs: num("PRICE_POLL_MS", 1_000),
    maxRpm: num("DEXSCREENER_MAX_RPM", 290),
    batchSize: num("DEXSCREENER_PAIR_BATCH_SIZE", 20),
  },

  entry: {
    auto: bool("AUTO_ENTRY", false),
    positionSizeUsd: num("POSITION_SIZE_USD", 10),    maxOpenPositions: num("MAX_OPEN_POSITIONS", 5),
    maxPositionAgeMin: num("MAX_POSITION_AGE_MIN", 60),
    // Pre-entry exitability guard: estimated immediate-sell impact of one
    // position against half the venue liquidity (assumed ~50/50 pool).
    // Skips pools where our own paper exit would move the price — the
    // signature of an unexitable fill. Backstop only: with MIN_LIQUIDITY_USD
    // at 15k and $10 size, worst-case impact is ~0.13% and this never fires.
    maxImpactPct: num("MAX_ENTRY_IMPACT_PCT", 5),
    feeEntryBps: num("PAPER_ENTRY_FEE_BPS", 0),
    feeExitBps: num("PAPER_EXIT_FEE_BPS", 0),
    slippageBps: num("PAPER_SLIPPAGE_BPS", 0),
    // Never open the same chain:pair twice — closed-trade history
    // (restored from state.json) guards re-entry after restarts.
    oneEntryPerPool: bool("ONE_ENTRY_PER_POOL", true),
    // Per-chain size overrides ("solana:5,bsc:5"), for chain-specific risk
    // experiments. Empty = uniform POSITION_SIZE_USD everywhere (frozen
    // baseline). Chains not listed keep the default size.
    chainSizes: new Map<string, number>(),
    // Two-snapshot confirmation: re-quote a qualifying candidate after a
    // short delay and require price/liquidity to be stable-ish before
    // entering. Purpose is narrow — avoid entering something that has
    // already begun failing — not momentum chasing (up moves pass freely).
    confirmEnabled: bool("ENTRY_CONFIRM_ENABLED", true),
    confirmDelayMs: num("ENTRY_CONFIRM_DELAY_MS", 3_000),
    confirmMaxPriceDropPct: num("ENTRY_CONFIRM_MAX_PRICE_DROP_PCT", 5),
    confirmMaxLiqDropPct: num("ENTRY_CONFIRM_MAX_LIQ_DROP_PCT", 30),
    // Dead hours (UTC) with no edge: 20:00–23:59 printed 37–57% win
    // rates vs 64–89% in 03:00–12:00. Entries pause; exits run normally.
    pausedHoursUtc: parseHourSet(process.env.ENTRY_PAUSED_HOURS_UTC ?? "20,21,22,23"),
  },

  portfolio: {
    initialBalanceUsd: num("INITIAL_BALANCE_USD", 10_000),
  },

  recovery: {
    // Reload-safe paper trading: open positions, cash and trade history
    // persist to STATE_FILE and are restored on boot.
    enabled: bool("RECOVERY_ENABLED", true),
    stateFile: env("STATE_FILE", "data/state.json"),
  },

  analytics: {
    // DuckDB trade ledger: every fill + every closed trade is appended to
    // DUCKDB_PATH for later SQL analysis. Best-effort — ledger failures
    // never stop the trading loops.
    enabled: bool("ANALYTICS_ENABLED", true),
    duckdbPath: env("DUCKDB_PATH", "data/paper.duckdb"),
  },

  snapshots: {
    // Per-minute market snapshots of each open position (price, liquidity,
    // txn mix) into position_snapshots. Exists for one purpose: studying
    // pre-collapse deterioration (late gappers). Not an exit signal.
    intervalS: num("SNAPSHOT_INTERVAL_S", 60),
  },

  dynamic: {
    // Protective-stop ratchet: once unrealized gain reaches BREAKEVEN_ARM_PCT
    // (or TP1 fills, as a fallback), the stop moves to breakeven (+ buffer)
    // until the trailing stop takes over. With the defaults the hierarchy is:
    // initial -15% -> breakeven@+20% -> TP1+trail@+30%.
    // The buffer must cover measured round-trip cost (read it off your own
    // Jupiter/0x quotes): a 0% "breakeven" stop exits at a loss after fees.
    breakevenAfterTp1: bool("BREAKEVEN_AFTER_TP1", true),
    breakevenBufferPct: num("BREAKEVEN_BUFFER_PCT", 3),
    breakevenArmPct: num("BREAKEVEN_ARM_PCT", 20),
  },

  earlyStop: {
    // Dead-on-arrival exit for fast collapses: a fresh position (younger
    // than windowSec) that prints below -stopPct is exited immediately
    // instead of riding the full initial stop. Targets the observed failure
    // mode of pools that dump 50-100% within ~30s, where the normal stop
    // cannot execute in time. Must stay tighter than the initial stop.
    enabled: bool("EARLY_STOP_ENABLED", true),
    stopPct: num("EARLY_STOP_PCT", 10),
    windowSec: num("EARLY_STOP_WINDOW_S", 180),
  },

  tp: [
    { gainPct: num("TP1_PCT", 30), sellPct: num("TP1_SELL_PCT", 25) },
    { gainPct: num("TP2_PCT", 60), sellPct: num("TP2_SELL_PCT", 25) },
    { gainPct: num("TP3_PCT", 100), sellPct: num("TP3_SELL_PCT", 25) },
  ] as const,

  stops: {
    initialPct: num("INITIAL_STOP_PCT", 15),
    trailActivationPct: num("TRAIL_ACTIVATION_PCT", 30),
    // Tightened 20 → 15 on ledger evidence: trailing exits averaged
    // ~102pp giveback from peak (MFE ~130% → exit ~+48%).
    trailDistancePct: num("TRAIL_DISTANCE_PCT", 15),
  },

  risk: {
    // Per-chain concurrent position caps ("solana:3,robinhood:8"). Empty =
    // global MAX_OPEN_POSITIONS only. Bounds simultaneous total loss per
    // chain to a fixed share of bankroll.
    chainCaps: parseChainCaps(process.env.CHAIN_POSITION_CAPS ?? ""),
    // Max open positions sharing one chain+symbol (copycat tickers and
    // same-name pools count as one exposure).
    maxSameSymbolOpen: num("MAX_SAME_SYMBOL_OPEN", 1),
    // Breaker: N stop/drain closes on a chain within the window pauses new
    // entries there for pauseMin. Exits always run.
    breakerStops: num("BREAKER_STOPS", 3),
    breakerWindowMin: num("BREAKER_WINDOW_MIN", 30),
    breakerPauseMin: num("BREAKER_PAUSE_MIN", 30),
    // Expectancy gate: the last N closed trades on a chain netting below
    // zero pauses new entries there until the sample recovers.
    expectancyTrades: num("EXPECTANCY_TRADES", 20),
    // Paper daily-loss limit in USD on today's closed PnL. 0 = disabled.
    paperDailyLossLimitUsd: num("PAPER_DAILY_LOSS_LIMIT_USD", 0),
  },

  safety: {
    // Entry safety layer: mint/freeze authority + Token-2022 (Solana),
    // V4 hook check (EVM), repeat-symbol block, executable-quote
    // deviation abort. Strict mode also blocks on unreadable
    // mints/keys (RPC failure then pauses entries — eyes open).
    enabled: bool("TOKEN_SAFETY_ENABLED", true),
    strict: bool("TOKEN_SAFETY_STRICT", false),
    // Block a chain+symbol traded before (copycat tickers share names;
    // ONE_ENTRY_PER_POOL only covers the exact pair).
    blockRepeatSymbols: bool("TOKEN_SAFETY_BLOCK_REPEAT_SYMBOLS", true),
    // Abort the entry when the executable quote deviates this far (%) from
    // the DexScreener mark (stale entry price). Unquotable just logs.
    quoteDeviationPct: num("ENTRY_QUOTE_MAX_DEVIATION_PCT", 3),
  },

  telegram: {
    enabled: bool("TELEGRAM_ENABLED", false),
    token: process.env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: process.env.TELEGRAM_CHAT_ID ?? "",
    startupMessage: bool("TELEGRAM_STARTUP_MESSAGE", true),
    // Verbosity: only BUY + CLOSE are sent by default. Candidate
    // "NEW PAIR" pings and interim TP / trailing / breakeven updates
    // stay in the logs unless explicitly re-enabled.
    announceCandidates: bool("TELEGRAM_ANNOUNCE_CANDIDATES", false),
    announceUpdates: bool("TELEGRAM_TRADE_UPDATES", false),
  },

  live: {
    // Live-only slippage budgets, deliberately decoupled from paper
    // friction: live orders must NEVER inherit PAPER_SLIPPAGE_BPS=0 —
    // zero tolerance fails swaps outright and would strand stop exits.
    // Exits get a wider budget than entries by design.
    buySlippageBps: num("LIVE_BUY_SLIPPAGE_BPS", 100),
    sellSlippageBps: num("LIVE_SELL_SLIPPAGE_BPS", 300),
    // Exit retry budget: a failed live sell retries with escalating
    // slippage (x1, x2, x5) before going manual-review terminal.
    sellMaxRetries: num("LIVE_SELL_MAX_RETRIES", 3),
  },

  // Optional CoinGecko key (CoinGecko API / Onchain). Discovery stays on
  // DexPaprika (see README): this key is reserved for future enrichment
  // (token market context) and is never on the hot discovery path.
  // .env uses COINGECKO_API; accept CG_API_KEY as an alias.
  coingecko: {
    apiKey: process.env.COINGECKO_API ?? process.env.CG_API_KEY ?? "",
  },
};

if (config.mode !== "paper") {
  throw new Error(`Only MODE=paper is supported by this project; received ${config.mode}`);
}

if (config.dexPaprika.limit < 1 || config.dexPaprika.limit > 100) {
  throw new Error("DISCOVERY_LIMIT must be between 1 and 100");
}

if (!Number.isInteger(config.dexPaprika.limit)) {
  throw new Error("DISCOVERY_LIMIT must be an integer");
}

if (!Number.isFinite(config.dexPaprika.intervalMs) || config.dexPaprika.intervalMs <= 0) {
  throw new Error("DISCOVERY_INTERVAL_MS must be positive");
}

if (!Number.isFinite(config.dexScreener.intervalMs) || config.dexScreener.intervalMs <= 0) {
  throw new Error("PRICE_POLL_MS must be positive");
}

if (!Number.isInteger(config.dexScreener.batchSize) || config.dexScreener.batchSize < 1 || config.dexScreener.batchSize > 30) {
  throw new Error("DEXSCREENER_PAIR_BATCH_SIZE must be an integer between 1 and 30");
}

if (!Number.isInteger(config.entry.maxOpenPositions) || config.entry.maxOpenPositions < 1) {
  throw new Error("MAX_OPEN_POSITIONS must be a positive integer");
}

for (const [chain, cap] of config.risk.chainCaps) {
  if (cap > config.entry.maxOpenPositions) {
    throw new Error(`CHAIN_POSITION_CAPS entry "${chain}:${cap}" exceeds MAX_OPEN_POSITIONS=${config.entry.maxOpenPositions}`);
  }
}

if (!Number.isInteger(config.risk.maxSameSymbolOpen) || config.risk.maxSameSymbolOpen < 1) {
  throw new Error("MAX_SAME_SYMBOL_OPEN must be a positive integer");
}

if (
  !Number.isInteger(config.risk.breakerStops) || config.risk.breakerStops < 2 ||
  !Number.isFinite(config.risk.breakerWindowMin) || config.risk.breakerWindowMin <= 0 ||
  !Number.isFinite(config.risk.breakerPauseMin) || config.risk.breakerPauseMin <= 0
) {
  throw new Error("BREAKER_STOPS must be an integer >= 2 and BREAKER_WINDOW_MIN / BREAKER_PAUSE_MIN must be positive");
}

if (!Number.isInteger(config.risk.expectancyTrades) || config.risk.expectancyTrades < 5) {
  throw new Error("EXPECTANCY_TRADES must be an integer >= 5");
}

if (!Number.isFinite(config.risk.paperDailyLossLimitUsd) || config.risk.paperDailyLossLimitUsd < 0) {
  throw new Error("PAPER_DAILY_LOSS_LIMIT_USD must be non-negative (0 disables)");
}

if (!Number.isFinite(config.safety.quoteDeviationPct) || config.safety.quoteDeviationPct <= 0) {
  throw new Error("ENTRY_QUOTE_MAX_DEVIATION_PCT must be positive");
}

if (!Number.isFinite(config.entry.maxPositionAgeMin) || config.entry.maxPositionAgeMin <= 0) {
  throw new Error("MAX_POSITION_AGE_MIN must be positive");
}

if (config.dexPaprika.maxRpm < 1 || config.dexPaprika.maxRpm > 500) {
  throw new Error("DEXPAPRIKA_MAX_RPM must be between 1 and 500");
}

if (config.dexScreener.maxRpm < 1 || config.dexScreener.maxRpm > 300) {
  throw new Error("DEXSCREENER_MAX_RPM must be between 1 and 300");
}

const tpTotal = config.tp.reduce((sum, level) => sum + level.sellPct, 0);
if (tpTotal > 100) throw new Error("TP sell percentages cannot exceed 100% of the original position");
for (const level of config.tp) {
  if (level.gainPct <= 0 || level.sellPct <= 0) {
    throw new Error("TP percentages must be positive");
  }
}

// TP levels are evaluated against the same gain figure, so gains must be
// strictly ascending — otherwise a lower later level would be unreachable
// on the same tick under ordered evaluation, and fill order would surprise.
for (let i = 1; i < config.tp.length; i++) {
  if (config.tp[i]!.gainPct <= config.tp[i - 1]!.gainPct) {
    throw new Error("TP gain percentages must be strictly ascending (TP1_PCT < TP2_PCT < TP3_PCT)");
  }
}

if (config.telegram.enabled && (!config.telegram.token || !config.telegram.chatId)) {
  throw new Error("TELEGRAM_ENABLED=true requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
}

if (config.portfolio.initialBalanceUsd <= 0) {
  throw new Error("INITIAL_BALANCE_USD must be positive");
}

if (config.entry.positionSizeUsd <= 0 || config.entry.positionSizeUsd > config.portfolio.initialBalanceUsd) {
  throw new Error("POSITION_SIZE_USD must be positive and not exceed INITIAL_BALANCE_USD");
}

if (config.dynamic.breakevenBufferPct < 0 || config.dynamic.breakevenBufferPct > 10) {
  throw new Error("BREAKEVEN_BUFFER_PCT must be between 0 and 10");
}

if (config.dynamic.breakevenArmPct <= 0) {
  throw new Error("BREAKEVEN_ARM_PCT must be positive");
}

if (
  config.earlyStop.stopPct <= 0 ||
  config.earlyStop.stopPct >= config.stops.initialPct
) {
  throw new Error("EARLY_STOP_PCT must be positive and tighter than INITIAL_STOP_PCT");
}

if (config.earlyStop.windowSec <= 0) {
  throw new Error("EARLY_STOP_WINDOW_S must be positive");
}

if (config.entry.maxImpactPct <= 0) {
  throw new Error("MAX_ENTRY_IMPACT_PCT must be positive");
}

if (config.entry.confirmDelayMs <= 0) {
  throw new Error("ENTRY_CONFIRM_DELAY_MS must be positive");
}

if (
  !Number.isFinite(config.live.buySlippageBps) ||
  config.live.buySlippageBps <= 0 ||
  config.live.buySlippageBps > 5000
) {
  throw new Error("LIVE_BUY_SLIPPAGE_BPS must be within (0, 5000]");
}

if (
  !Number.isFinite(config.live.sellSlippageBps) ||
  config.live.sellSlippageBps <= 0 ||
  config.live.sellSlippageBps > 5000
) {
  throw new Error("LIVE_SELL_SLIPPAGE_BPS must be within (0, 5000]");
}

if (!Number.isInteger(config.live.sellMaxRetries) || config.live.sellMaxRetries < 0 || config.live.sellMaxRetries > 10) {
  throw new Error("LIVE_SELL_MAX_RETRIES must be an integer within [0, 10]");
}

if (config.entry.confirmMaxPriceDropPct <= 0 || config.entry.confirmMaxLiqDropPct <= 0) {
  throw new Error("ENTRY_CONFIRM_MAX_*_DROP_PCT must be positive");
}

if (
  config.dexPaprika.minAgeSec < 0 ||
  config.dexPaprika.minAgeSec >= config.dexPaprika.maxAgeSec
) {
  throw new Error("NEW_POOL_MIN_AGE_SEC must be non-negative and below NEW_POOL_MAX_AGE_SEC");
}

if (
  config.dexPaprika.minLiquidityUsd <= 0 ||
  config.dexPaprika.minLiquidityUsd >= config.dexPaprika.maxLiquidityUsd
) {
  throw new Error("MIN_LIQUIDITY_USD must be positive and below MAX_LIQUIDITY_USD");
}

if (config.snapshots.intervalS <= 0) {
  throw new Error("SNAPSHOT_INTERVAL_S must be positive");
}

// Parsed last: bounds depend on the already-validated balance above.
config.entry.chainSizes = parseChainSizes(
  process.env.CHAIN_POSITION_SIZES ?? "",
  config.portfolio.initialBalanceUsd,
);

// ---------------------------------------------------------------------------
// Per-chain exit profiles: same engine, different regime per chain.
// Solana banks fast with a short leash (winners peaked +12–64%, losers never
// traded above entry); Robinhood keeps a larger runner with more room
// (winners ran +61–222%). Unlisted chains and empty overrides fall back to
// global config behavior. Tests attach profiles directly, so built-ins never
// leak into the suite.
// ---------------------------------------------------------------------------

import type { ExitProfile } from "./types.ts";

const SOLANA_EXIT_DEFAULT: ExitProfile = {
  tp: [
    { gainPct: 20, sellPct: 50 },
    { gainPct: 50, sellPct: 25 },
  ],
  initialStopPct: 15,
  trailActivationPct: 30,
  trailDistancePct: 15,
  trailConfirmTicks: 3,
  breakevenArmPct: 20,
  breakevenBufferPct: 3,
  breakevenAfterTp1: true,
  earlyStopPct: 10,
  earlyStopWindowSec: 180,
  maxPositionAgeMin: 15,
  drainLiquidityPct: 25,
  deadLiquidityUsd: 25,
};

const ROBINHOOD_EXIT_DEFAULT: ExitProfile = {
  tp: [
    { gainPct: 30, sellPct: 25 },
    { gainPct: 60, sellPct: 25 },
    { gainPct: 100, sellPct: 25 },
  ],
  initialStopPct: 15,
  trailActivationPct: 30,
  trailDistancePct: 20,
  trailConfirmTicks: 3,
  breakevenArmPct: 20,
  breakevenBufferPct: 3,
  breakevenAfterTp1: true,
  earlyStopPct: 10,
  earlyStopWindowSec: 180,
  maxPositionAgeMin: 60,
  drainLiquidityPct: 25,
  deadLiquidityUsd: 25,
};

function isExitProfile(value: unknown): value is ExitProfile {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  if (!Array.isArray(p.tp) || p.tp.length < 1 || p.tp.length > 3) return false;
  let prevGain = -Infinity;
  let sellTotal = 0;
  for (const level of p.tp) {
    if (typeof level !== "object" || level === null) return false;
    const { gainPct, sellPct } = level as Record<string, unknown>;
    if (typeof gainPct !== "number" || !(gainPct > 0)) return false;
    if (typeof sellPct !== "number" || !(sellPct > 0)) return false;
    if (gainPct <= prevGain) return false;
    prevGain = gainPct;
    sellTotal += sellPct;
  }
  if (sellTotal > 100) return false;
  const nums = [
    p.initialStopPct, p.trailActivationPct, p.trailDistancePct,
    p.breakevenArmPct, p.breakevenBufferPct, p.earlyStopPct,
    p.maxPositionAgeMin, p.drainLiquidityPct, p.deadLiquidityUsd,
  ];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n) && (n as number) >= 0)) return false;
  if (!Number.isInteger(p.trailConfirmTicks) || (p.trailConfirmTicks as number) < 1) return false;
  if (typeof p.breakevenAfterTp1 !== "boolean") return false;
  if (!Number.isInteger(p.earlyStopWindowSec) || (p.earlyStopWindowSec as number) <= 0) return false;
  if ((p.earlyStopPct as number) >= (p.initialStopPct as number)) return false;
  return true;
}

/**
 * Parse CHAIN_EXIT_PROFILES JSON overrides ({"solana": {"tp": [...], ...}}).
 * Empty = no overrides. Partial objects merge over the chain default (or
 * globals when the chain has no built-in): specify only what differs.
 * Throws on malformed JSON or invalid profiles so a typo can never
 * silently trade the wrong regime.
 */
export function parseChainExitProfiles(raw: string | undefined): Record<string, ExitProfile> {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid CHAIN_EXIT_PROFILES JSON: ${raw.slice(0, 80)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid CHAIN_EXIT_PROFILES: want {"chain": {...profile}}`);
  }
  const out: Record<string, ExitProfile> = {};
  for (const [chain, profile] of Object.entries(parsed)) {
    const key = chain.toLowerCase();
    const base = key === "solana"
      ? SOLANA_EXIT_DEFAULT
      : key === "robinhood"
        ? ROBINHOOD_EXIT_DEFAULT
        : null;
    const globalFallback: ExitProfile = {
      tp: [...config.tp.map((t) => ({ gainPct: t.gainPct, sellPct: t.sellPct }))],
      initialStopPct: config.stops.initialPct,
      trailActivationPct: config.stops.trailActivationPct,
      trailDistancePct: config.stops.trailDistancePct,
      trailConfirmTicks: 1,
      breakevenArmPct: config.dynamic.breakevenArmPct,
      breakevenBufferPct: config.dynamic.breakevenBufferPct,
      breakevenAfterTp1: config.dynamic.breakevenAfterTp1,
      earlyStopPct: config.earlyStop.stopPct,
      earlyStopWindowSec: config.earlyStop.windowSec,
      maxPositionAgeMin: config.entry.maxPositionAgeMin,
      drainLiquidityPct: 25,
      deadLiquidityUsd: 25,
    };
    if (typeof profile !== "object" || profile === null) {
      throw new Error(`Invalid CHAIN_EXIT_PROFILES profile for "${chain}"`);
    }
    const merged: ExitProfile = { ...(base ?? globalFallback), ...(profile as Partial<ExitProfile>) };
    if (!isExitProfile(merged)) {
      throw new Error(`Invalid CHAIN_EXIT_PROFILES profile for "${chain}"`);
    }
    out[key] = merged;
  }
  return out;
}

const chainExitOverrides = parseChainExitProfiles(process.env.CHAIN_EXIT_PROFILES ?? "");

/**
 * Exit regime for a chain: JSON override merged over the built-in default,
 * or the built-in default itself. Undefined for chains with neither (global
 * config behavior). Resolved once at open and snapshotted on the position.
 */
export function resolveExitProfile(chain: string): ExitProfile | undefined {
  const key = chain.toLowerCase();
  if (chainExitOverrides[key]) return chainExitOverrides[key];
  if (key === "solana") return { ...SOLANA_EXIT_DEFAULT, tp: SOLANA_EXIT_DEFAULT.tp.map((t) => ({ ...t })) };
  if (key === "robinhood") return { ...ROBINHOOD_EXIT_DEFAULT, tp: ROBINHOOD_EXIT_DEFAULT.tp.map((t) => ({ ...t })) };
  return undefined;
}
