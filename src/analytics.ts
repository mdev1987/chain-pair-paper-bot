import { config } from "./config.ts";
import { SHADOW_COST_MODEL } from "./position.ts";
import type { Position } from "./types.ts";

type DuckDBConnection = import("@duckdb/node-api").DuckDBConnection;

export interface QuoteCheckRecord {
  time: number;
  positionId: string;
  chain: string;
  side: "BUY" | "SELL";
  /** Adapter name, or "skipped" when no quote was attempted. */
  source: string;
  paperPriceUsd: number;
  quotedSellAmount: string;
  quotedBuyAmount: string;
  sellDecimals: number | null;
  buyDecimals: number | null;
  riskPass: boolean | null;
  simOk: boolean | null;
  note: string;
}

export interface PositionSnapshotTick {
  time: number;
  positionId: string;
  chain: string;
  symbol: string;
  price: number;
  liquidityUsd: number | null;
  /** Raw DexScreener txn/volume mix, JSON-encoded (shape varies by venue). */
  txnsJson: string;
}

export interface FillRecord {
  time: number;
  side: "BUY" | "SELL";
  positionId: string;
  chain: string;
  dex: string;
  symbol: string;
  tokenName: string;
  pair: string;
  pool: string;
  ca: string;
  quote: string;
  price: number;
  qty: number;
  notionalUsd: number;
  feeUsd: number;
  slipUsd: number;
  detail: string;
  balanceAfterUsd: number;
}

export interface TradeRecord {
  positionId: string;
  chain: string;
  dex: string;
  symbol: string;
  tokenName: string;
  pair: string;
  pool: string;
  ca: string;
  quote: string;
  openedAt: number;
  closedAt: number;
  durationS: number;
  entryPrice: number;
  exitPrice: number;
  highPrice: number;
  sizeUsd: number;
  pnlUsd: number;
  pnlPct: number;
  reason: string;
  tpLevels: string;
  feesUsd: number;
  slipUsd: number;
  balanceBeforeUsd: number;
  balanceAfterUsd: number;
  entryLiquidityUsd: number | null;
  exitLiquidityUsd: number | null;
  entryAgeS: number | null;
  /** Gross PnL minus the shadow cost model — research only, never cash. */
  netPnlUsd: number;
  /** Cost-model convention label (e.g. NET_PNL_100BPS_1PCT), explicit per row. */
  costModel: string;
  /** Max favorable excursion, % vs entry. */
  mfePct: number;
  /** Max adverse excursion, % vs entry (<= 0). */
  maePct: number;
  /** Exit mark, % vs entry. */
  exitPct: number;
  /** Giveback in percentage points: mfePct - exitPct. */
  givebackPp: number;
  /** Seconds from open to the high-water mark. */
  timeToMfeS: number;
  /** Seconds from open to the low-water mark. */
  timeToMaeS: number;
  /** Stop level that triggered the exit, % vs entry (fill itself for TIME_EXIT). */
  exitTriggerPct: number;
  /**
   * True when execution printed materially worse than the trigger, i.e. the
   * price gapped through the stop between polls. Tolerance below.
   */
  gapThroughStop: boolean;
  /** Shadow modeled fee component (research only, never cash). */
  modeledFeeUsd: number;
  /** Shadow modeled slippage component (research only, never cash). */
  modeledSlipUsd: number;
}

const FILLS_DDL = `CREATE TABLE IF NOT EXISTS fills (
  time BIGINT, side VARCHAR, position_id VARCHAR, chain VARCHAR, dex VARCHAR,
  symbol VARCHAR, token_name VARCHAR, pair VARCHAR, pool VARCHAR, ca VARCHAR,
  quote VARCHAR, price DOUBLE, qty DOUBLE, notional_usd DOUBLE, fee_usd DOUBLE,
  slip_usd DOUBLE, detail VARCHAR, balance_after_usd DOUBLE
)`;

// Per-minute market snapshots of open positions. Exists for one research
// question only: did liquidity/txn-mix deteriorate before late collapses?
// Not an exit signal. A standalone table (no migration needed).
const SNAPSHOTS_DDL = `CREATE TABLE IF NOT EXISTS position_snapshots (
  time BIGINT, position_id VARCHAR, chain VARCHAR, symbol VARCHAR,
  price DOUBLE, liquidity_usd DOUBLE, txns_json VARCHAR
)`;

// Parallel real-quote diagnostics for every paper fill (simulation stage).
// The paper engine never reads this table — it exists to measure how far
// live-executable quotes and eth_call simulations deviate from paper marks.
const QUOTE_CHECKS_DDL = `CREATE TABLE IF NOT EXISTS quote_checks (
  time BIGINT, position_id VARCHAR, chain VARCHAR, side VARCHAR,
  source VARCHAR, paper_price_usd DOUBLE,
  quoted_sell_amount VARCHAR, quoted_buy_amount VARCHAR,
  sell_decimals INTEGER, buy_decimals INTEGER,
  risk_pass BOOLEAN, sim_ok BOOLEAN, note VARCHAR
)`;

const TRADES_DDL = `CREATE TABLE IF NOT EXISTS trades (
  position_id VARCHAR, chain VARCHAR, dex VARCHAR, symbol VARCHAR,
  token_name VARCHAR, pair VARCHAR, pool VARCHAR, ca VARCHAR, quote VARCHAR,
  opened_at BIGINT, closed_at BIGINT, duration_s BIGINT, entry_price DOUBLE,
  exit_price DOUBLE, high_price DOUBLE, size_usd DOUBLE, pnl_usd DOUBLE,
  pnl_pct DOUBLE, reason VARCHAR, tp_levels VARCHAR, fees_usd DOUBLE,
  slip_usd DOUBLE, balance_before_usd DOUBLE, balance_after_usd DOUBLE,
  entry_liquidity_usd DOUBLE, exit_liquidity_usd DOUBLE, entry_age_s BIGINT,
  net_pnl_usd DOUBLE, cost_model VARCHAR, mfe_pct DOUBLE, mae_pct DOUBLE,
  exit_pct DOUBLE, giveback_pp DOUBLE, time_to_mfe_s BIGINT,
  time_to_mae_s BIGINT, exit_trigger_pct DOUBLE, gap_through_stop BOOLEAN,
  modeled_fee_usd DOUBLE, modeled_slip_usd DOUBLE
)`;

// Columns added after the initial schema. Applied idempotently on every
// open so pre-existing ledgers gain them (appended at the end) without a
// manual migration step. recordTrade uses an explicit column list, so the
// differing column order between fresh and migrated DBs is harmless.
const TRADES_MIGRATION_COLUMNS = [
  "net_pnl_usd DOUBLE",
  "cost_model VARCHAR",
  "mfe_pct DOUBLE",
  "mae_pct DOUBLE",
  "exit_pct DOUBLE",
  "giveback_pp DOUBLE",
  "time_to_mfe_s BIGINT",
  "time_to_mae_s BIGINT",
  "exit_trigger_pct DOUBLE",
  "gap_through_stop BOOLEAN",
  "modeled_fee_usd DOUBLE",
  "modeled_slip_usd DOUBLE",
];

/**
 * Trigger-vs-fill tolerance in percentage points. Ticks after the trigger
 * print routinely land a fraction below the stop; only a materially worse
 * fill counts as gapping through it.
 */
export const GAP_TOLERANCE_PP = 1.0;

let conn: DuckDBConnection | null = null;
let connPath = "";
let initPromise: Promise<boolean> | null = null;
let failure = "";
// Explicit init state wins over global config: initAnalytics(path, false)
// must make every record call a true no-op (no surprise file creation),
// and record calls never fall back to config defaults on their own.
let armed: { enabled: boolean; path: string } | null = null;

/** Human-readable ledger status for logs / startup banner. */
export function analyticsStatus(): string {
  if (!config.analytics.enabled) return "disabled";
  if (conn) return `ready (${connPath})`;
  if (failure) return `FAILED: ${failure}`;
  return "not initialized";
}

async function openConnection(dbPath: string): Promise<DuckDBConnection> {
  // Dynamic import isolates native-binding load failures: analytics must
  // never prevent the trading loops from running.
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  await connection.run(FILLS_DDL);
  await connection.run(TRADES_DDL);
  await connection.run(SNAPSHOTS_DDL);
  await connection.run(QUOTE_CHECKS_DDL);
  for (const column of TRADES_MIGRATION_COLUMNS) {
    const name = column.split(" ")[0]!;
    await connection.run(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS ${name} ${column.slice(name.length + 1)}`);
  }
  return connection;
}

function startOpen(path: string): Promise<boolean> {
  connPath = path;
  initPromise = openConnection(path)
    .then((c) => {
      conn = c;
      failure = "";
      return true;
    })
    .catch((error: unknown) => {
      conn = null;
      failure = String(error);
      initPromise = null;
      return false;
    });
  return initPromise;
}

/** Idempotent init. Returns true when the ledger is writable. */
export function initAnalytics(
  dbPath: string = config.analytics.duckdbPath,
  enabled: boolean = config.analytics.enabled,
): Promise<boolean> {
  armed = { enabled, path: dbPath };
  if (!enabled) return Promise.resolve(false);
  if (conn && connPath === dbPath) return Promise.resolve(true);
  if (!initPromise || connPath !== dbPath) {
    // Path switch: best-effort close of the previous connection first.
    if (conn) {
      try {
        conn.closeSync();
      } catch {
        // Already closed.
      }
      conn = null;
    }
    return startOpen(dbPath);
  }
  return initPromise;
}

async function ensure(): Promise<DuckDBConnection | null> {
  if (!armed?.enabled) return null;
  if (conn && connPath === armed.path) return conn;
  if (!initPromise || connPath !== armed.path) startOpen(armed.path);
  const ok = await (initPromise as Promise<boolean>);
  return ok && connPath === armed.path ? conn : null;
}

/** Append one execution (entry fill, TP partial, final exit). Best-effort. */
export async function recordFill(fill: FillRecord): Promise<void> {
  const c = await ensure();
  if (!c) return;
  try {
    await c.run(
      `INSERT INTO fills VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        fill.time, fill.side, fill.positionId, fill.chain, fill.dex,
        fill.symbol, fill.tokenName, fill.pair, fill.pool, fill.ca,
        fill.quote, fill.price, fill.qty, fill.notionalUsd, fill.feeUsd,
        fill.slipUsd, fill.detail, fill.balanceAfterUsd,
      ],
    );
  } catch (error) {
    failure = String(error);
    conn = null;
    initPromise = null;
  }
}

/** Append a periodic market snapshot of an open position. Best-effort. */
export async function recordSnapshot(tick: PositionSnapshotTick): Promise<void> {
  const c = await ensure();
  if (!c) return;
  try {
    await c.run(
      `INSERT INTO position_snapshots VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        tick.time, tick.positionId, tick.chain, tick.symbol,
        tick.price, tick.liquidityUsd, tick.txnsJson,
      ],
    );
  } catch (error) {
    failure = String(error);
    conn = null;
    initPromise = null;
  }
}

/** Append a parallel real-quote diagnostic for a paper fill. Best-effort. */
export async function recordQuoteCheck(check: QuoteCheckRecord): Promise<void> {
  const c = await ensure();
  if (!c) return;
  try {
    await c.run(
      `INSERT INTO quote_checks VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        check.time, check.positionId, check.chain, check.side, check.source,
        check.paperPriceUsd, check.quotedSellAmount, check.quotedBuyAmount,
        check.sellDecimals, check.buyDecimals, check.riskPass, check.simOk,
        check.note,
      ],
    );
  } catch (error) {
    failure = String(error);
    conn = null;
    initPromise = null;
  }
}

/** Append the one-row summary of a fully closed position. Best-effort. */
export async function recordTrade(trade: TradeRecord): Promise<void> {
  const c = await ensure();
  if (!c) return;
  try {
    // Explicit column list: migrated ledgers append new columns at the end,
    // so positional INSERTs would misalign there.
    await c.run(
      `INSERT INTO trades (position_id, chain, dex, symbol, token_name, pair,
        pool, ca, quote, opened_at, closed_at, duration_s, entry_price,
        exit_price, high_price, size_usd, pnl_usd, pnl_pct, reason, tp_levels,
        fees_usd, slip_usd, balance_before_usd, balance_after_usd,
        entry_liquidity_usd, exit_liquidity_usd, entry_age_s,
        net_pnl_usd, cost_model, mfe_pct, mae_pct, exit_pct, giveback_pp,
        time_to_mfe_s, time_to_mae_s, exit_trigger_pct, gap_through_stop,
        modeled_fee_usd, modeled_slip_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39)`,
      [
        trade.positionId, trade.chain, trade.dex, trade.symbol,
        trade.tokenName, trade.pair, trade.pool, trade.ca, trade.quote,
        trade.openedAt, trade.closedAt, trade.durationS, trade.entryPrice,
        trade.exitPrice, trade.highPrice, trade.sizeUsd, trade.pnlUsd,
        trade.pnlPct, trade.reason, trade.tpLevels, trade.feesUsd,
        trade.slipUsd, trade.balanceBeforeUsd, trade.balanceAfterUsd,
        trade.entryLiquidityUsd, trade.exitLiquidityUsd, trade.entryAgeS,
        trade.netPnlUsd, trade.costModel, trade.mfePct, trade.maePct,
        trade.exitPct, trade.givebackPp, trade.timeToMfeS, trade.timeToMaeS,
        trade.exitTriggerPct, trade.gapThroughStop,
        trade.modeledFeeUsd, trade.modeledSlipUsd,
      ],
    );
  } catch (error) {
    failure = String(error);
    conn = null;
    initPromise = null;
  }
}

/** Ad-hoc SQL for later analysis (tests, one-off scripts). */
export async function analyticsQuery<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const c = await ensure();
  if (!c) return [];
  const reader = await c.runAndReadAll(sql);
  return reader.getRowObjects() as T[];
}

/** Flush + close. Called on SIGTERM/SIGINT so no committed row is lost. */
export async function closeAnalytics(): Promise<void> {
  if (!conn) return;
  try {
    await conn.run("CHECKPOINT");
  } catch {
    // Best-effort: WAL replay on next open covers us.
  }
  try {
    conn.closeSync();
  } catch {
    // Already closed.
  }
  conn = null;
  initPromise = null;
}

export function tradeRecordFromPosition(
  position: Position,
  args: {
    pnlUsd: number;
    pnlPct: number;
    balanceBeforeUsd: number;
    balanceAfterUsd: number;
  },
): TradeRecord {
  const tpLevels = position.tpHit
    .map((hit, i) => (hit ? `${i + 1}` : null))
    .filter((v): v is string => v !== null)
    .join(",");
  // Full path metrics vs entry (entryPrice is always > 0 by construction).
  const mfePct = (position.highestPrice / position.entryPrice - 1) * 100;
  const maePct = (position.lowestPrice / position.entryPrice - 1) * 100;
  const exitPct = (position.currentPrice / position.entryPrice - 1) * 100;
  // Trigger-vs-fill separation: a materially worse fill means the price
  // gapped through the stop between polls. Falls back to the fill itself
  // (no gap) when the trigger was never captured.
  const triggerPrice = position.exitTriggerPrice ?? position.currentPrice;
  const exitTriggerPct = (triggerPrice / position.entryPrice - 1) * 100;
  return {
    positionId: position.id,
    chain: position.chain,
    dex: position.dexId,
    symbol: position.symbol,
    tokenName: position.tokenName,
    pair: position.pairAddress,
    pool: position.poolAddress ?? "",
    ca: position.tokenAddress,
    quote: position.quoteSymbol,
    openedAt: position.openedAt,
    closedAt: position.closedAt ?? Date.now(),
    durationS: Math.max(0, Math.round(((position.closedAt ?? Date.now()) - position.openedAt) / 1000)),
    entryPrice: position.entryPrice,
    exitPrice: position.currentPrice,
    highPrice: position.highestPrice,
    sizeUsd: position.initialUsdSize,
    pnlUsd: args.pnlUsd,
    pnlPct: args.pnlPct,
    reason: position.closedReason ?? "unknown",
    tpLevels,
    feesUsd: position.totalEntryFeeUsd + position.totalExitFeeUsd,
    slipUsd: position.totalSlippageUsd,
    balanceBeforeUsd: args.balanceBeforeUsd,
    balanceAfterUsd: args.balanceAfterUsd,
    entryLiquidityUsd: position.entryLiquidityUsd ?? null,
    exitLiquidityUsd: position.exitLiquidityUsd ?? null,
    entryAgeS: position.entryAgeSec !== undefined ? Math.round(position.entryAgeSec) : null,
    // Shadow net: gross minus modeled costs. Reporting only — cash is untouched.
    netPnlUsd: args.pnlUsd - (position.shadowFeeUsd + position.shadowSlipUsd),
    costModel: SHADOW_COST_MODEL,
    mfePct,
    maePct,
    exitPct,
    givebackPp: mfePct - exitPct,
    timeToMfeS: Math.max(0, Math.round((position.highestAt - position.openedAt) / 1000)),
    timeToMaeS: Math.max(0, Math.round((position.lowestAt - position.openedAt) / 1000)),
    exitTriggerPct,
    gapThroughStop: exitTriggerPct - exitPct > GAP_TOLERANCE_PP,
    modeledFeeUsd: position.shadowFeeUsd,
    modeledSlipUsd: position.shadowSlipUsd,
  };
}
