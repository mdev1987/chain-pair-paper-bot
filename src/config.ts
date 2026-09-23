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

export const config = {
  mode: env("MODE", "paper"),

  dexPaprika: {
    baseUrl: env("DEXPAPRIKA_BASE_URL", "https://api.dexpaprika.com"),
    apiKey: process.env.DEXPAPRIKA_API_KEY ?? "",
    intervalMs: num("DISCOVERY_INTERVAL_MS", 40_000),
    limit: num("DISCOVERY_LIMIT", 20),
    maxRpm: num("DEXPAPRIKA_MAX_RPM", 14),
    maxAgeSec: num("NEW_POOL_MAX_AGE_SEC", 120),
    minLiquidityUsd: num("MIN_LIQUIDITY_USD", 10_000),
    minVolume24hUsd: num("MIN_VOLUME_24H_USD", 1_000),
    minTxns24h: num("MIN_TXNS_24H", 5),
    chains: csvLower(
      "CHAINS",
      "solana,base,bsc,ethereum,robinhood,arbitrum,avalanche,polygon",
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
    positionSizeUsd: num("POSITION_SIZE_USD", 10),
    maxOpenPositions: num("MAX_OPEN_POSITIONS", 5),
    maxPositionAgeMin: num("MAX_POSITION_AGE_MIN", 60),
    // Pre-entry exitability guard: estimated immediate-sell impact of one
    // position against half the venue liquidity (assumed ~50/50 pool).
    // Skips pools where our own paper exit would move the price — the
    // signature of an unexitable fill. Backstop only: with MIN_LIQUIDITY_USD
    // at 10k and $10 size, worst-case impact is ~0.2% and this never fires.
    maxImpactPct: num("MAX_ENTRY_IMPACT_PCT", 5),
    feeEntryBps: num("PAPER_ENTRY_FEE_BPS", 0),
    feeExitBps: num("PAPER_EXIT_FEE_BPS", 0),
    slippageBps: num("PAPER_SLIPPAGE_BPS", 0),
    // Never open the same chain:pair twice — closed-trade history
    // (restored from state.json) guards re-entry after restarts.
    oneEntryPerPool: bool("ONE_ENTRY_PER_POOL", true),
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

  dynamic: {
    // Protective-stop ratchet: once unrealized gain reaches BREAKEVEN_ARM_PCT
    // (or TP1 fills, as a fallback), the stop moves to breakeven (+ buffer)
    // until the trailing stop takes over. With the defaults the hierarchy is:
    // initial -15% -> breakeven@+20% -> TP1+trail@+30%.
    breakevenAfterTp1: bool("BREAKEVEN_AFTER_TP1", true),
    breakevenBufferPct: num("BREAKEVEN_BUFFER_PCT", 0),
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
    trailDistancePct: num("TRAIL_DISTANCE_PCT", 20),
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

if (config.dexScreener.batchSize < 1 || config.dexScreener.batchSize > 30) {
  throw new Error("DEXSCREENER_PAIR_BATCH_SIZE must be between 1 and 30");
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
