import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyticsQuery,
  initAnalytics,
  markTradeDrained,
  recordFill,
  recordSnapshot,
  recordTrade,
  tradeRecordFromPosition,
} from "../src/analytics.ts";
import {
  openPosition,
  totalPnlPct,
  totalPnlUsd,
  updatePosition,
} from "../src/position.ts";

const dir = mkdtempSync(join(tmpdir(), "paperbot-duckdb-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("duckdb trade ledger", () => {
  // Single sequential flow: shared module singleton must never see
  // interleaved inits from sibling tests.
  test("disabled ledger is a no-op; enabled ledger round-trips full addresses", async () => {
    const offPath = join(dir, "off.duckdb");
    assert.equal(await initAnalytics(offPath, false), false);
    await recordFill({
      time: 1, side: "BUY", positionId: "x", chain: "solana", dex: "raydium",
      symbol: "T", tokenName: "T", pair: "P", pool: "", ca: "C", quote: "SOL",
      price: 1, qty: 1, notionalUsd: 1, feeUsd: 0, slipUsd: 0,
      detail: "OPEN", balanceAfterUsd: 1,
    });
    assert.equal(existsSync(offPath), false, "disabled ledger must not create a file");

    const dbPath = join(dir, "paper.duckdb");
    assert.equal(await initAnalytics(dbPath, true), true);

    await recordFill({
      time: 1_000, side: "BUY", positionId: "solana:PAIR", chain: "solana",
      dex: "raydium", symbol: "TEST", tokenName: "Test Token",
      pair: "PAIRADDR123456789", pool: "POOLADDR123456789",
      ca: "TOKENADDR123456789", quote: "SOL", price: 1, qty: 10,
      notionalUsd: 10, feeUsd: 0, slipUsd: 0, detail: "OPEN",
      balanceAfterUsd: 9_990,
    });
    await recordFill({
      time: 2_000, side: "SELL", positionId: "solana:PAIR", chain: "solana",
      dex: "raydium", symbol: "TEST", tokenName: "Test Token",
      pair: "PAIRADDR123456789", pool: "POOLADDR123456789",
      ca: "TOKENADDR123456789", quote: "SOL", price: 1.3, qty: 2.5,
      notionalUsd: 3.25, feeUsd: 0, slipUsd: 0, detail: "TP1",
      balanceAfterUsd: 9_993.25,
    });
    await recordTrade({
      positionId: "solana:PAIR", chain: "solana", dex: "raydium",
      symbol: "TEST", tokenName: "Test Token", pair: "PAIRADDR123456789",
      pool: "POOLADDR123456789", ca: "TOKENADDR123456789", quote: "SOL",
      openedAt: 1_000, closedAt: 3_000, durationS: 2, entryPrice: 1,
      exitPrice: 0.8, highPrice: 1.3, sizeUsd: 10, pnlUsd: -1.5, pnlPct: -15,
      reason: "TRAIL_EXIT", tpLevels: "1", feesUsd: 0, slipUsd: 0,
      balanceBeforeUsd: 10_000, balanceAfterUsd: 9_998.5,
      entryLiquidityUsd: 20_000, exitLiquidityUsd: 18_500, entryAgeS: 60,
      netPnlUsd: -1.7, costModel: "NET_PNL_100BPS_1PCT",
      mfePct: 30, maePct: -20, exitPct: -20, givebackPp: 50, timeToMfeS: 1,
      timeToMaeS: 2, exitTriggerPct: -15, gapThroughStop: true,
      modeledFeeUsd: 0.1, modeledSlipUsd: 0.1, drainedExit: false,
    });

    const fills = await analyticsQuery<Record<string, unknown>>(
      "SELECT side, detail, qty, notional_usd, pair, pool, ca FROM fills ORDER BY time",
    );
    assert.equal(fills.length, 2);
    assert.equal(fills[0]!.side, "BUY");
    assert.equal(fills[0]!.detail, "OPEN");
    assert.equal(fills[1]!.detail, "TP1");
    // Full addresses — no ellipsis truncation in the ledger.
    assert.equal(fills[0]!.pair, "PAIRADDR123456789");
    assert.equal(fills[0]!.pool, "POOLADDR123456789");
    assert.equal(fills[0]!.ca, "TOKENADDR123456789");

    const trades = await analyticsQuery<Record<string, unknown>>(
      "SELECT symbol, reason, pnl_usd, tp_levels, entry_liquidity_usd, net_pnl_usd, cost_model, mfe_pct, mae_pct, exit_pct, giveback_pp, time_to_mfe_s, time_to_mae_s, exit_trigger_pct, gap_through_stop, modeled_fee_usd, modeled_slip_usd, drained_exit FROM trades",
    );
    assert.equal(trades.length, 1);
    assert.equal(trades[0]!.reason, "TRAIL_EXIT");
    assert.equal(trades[0]!.pnl_usd, -1.5);
    assert.equal(trades[0]!.tp_levels, "1");
    assert.equal(trades[0]!.entry_liquidity_usd, 20_000);
    // Shadow + path columns persist alongside gross PnL.
    assert.equal(trades[0]!.net_pnl_usd, -1.7);
    assert.equal(trades[0]!.cost_model, "NET_PNL_100BPS_1PCT");
    assert.equal(trades[0]!.mfe_pct, 30);
    assert.equal(trades[0]!.mae_pct, -20);
    assert.equal(trades[0]!.exit_pct, -20);
    assert.equal(trades[0]!.giveback_pp, 50);
    assert.equal(Number(trades[0]!.time_to_mfe_s), 1);
    assert.equal(Number(trades[0]!.time_to_mae_s), 2);
    assert.equal(trades[0]!.exit_trigger_pct, -15);
    assert.equal(trades[0]!.gap_through_stop, true);
    assert.equal(trades[0]!.modeled_fee_usd, 0.1);
    assert.equal(trades[0]!.modeled_slip_usd, 0.1);
    assert.equal(trades[0]!.drained_exit, false);

    await markTradeDrained("solana:PAIR");
    const flagged = await analyticsQuery<Record<string, unknown>>(
      "SELECT drained_exit FROM trades WHERE position_id = 'solana:PAIR'",
    );
    assert.equal(flagged[0]!.drained_exit, true);

    const wins = await analyticsQuery<{ wins: number | bigint }>(
      "SELECT count(*) FILTER (WHERE pnl_usd > 0) AS wins FROM trades",
    );
    assert.equal(Number(wins[0]!.wins), 0);
  });

  test("position snapshots round-trip for the late-gap study", async () => {
    await recordSnapshot({
      time: 5_000, positionId: "solana:PAIR", chain: "solana", symbol: "TEST",
      price: 1.2, liquidityUsd: 19_000, txnsJson: '{"h1":{"buys":10,"sells":4}}',
    });
    const ticks = await analyticsQuery<Record<string, unknown>>(
      "SELECT position_id, price, liquidity_usd, txns_json FROM position_snapshots",
    );
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0]!.position_id, "solana:PAIR");
    assert.equal(ticks[0]!.price, 1.2);
    assert.equal(ticks[0]!.liquidity_usd, 19_000);
    assert.equal(ticks[0]!.txns_json, '{"h1":{"buys":10,"sells":4}}');
  });
});

describe("trade path record", () => {
  test("tradeRecordFromPosition derives shadow net and MFE/MAE/giveback", () => {
    const position = openPosition({
      id: "solana:PATH",
      chain: "solana",
      pairAddress: "PAIR",
      tokenAddress: "TOKEN",
      symbol: "PATH",
      tokenName: "Path",
      quoteSymbol: "SOL",
      dexId: "raydium",
      marketPrice: 1,
      usdSize: 100,
      now: 0,
    });
    updatePosition(position, 1.3, 1_000); // TP1 + trailing activates
    updatePosition(position, 0.9, 2_000); // trails out at the low
    assert.equal(position.status, "CLOSED");

    const record = tradeRecordFromPosition(position, {
      pnlUsd: totalPnlUsd(position),
      pnlPct: totalPnlPct(position),
      balanceBeforeUsd: 10_000,
      balanceAfterUsd: 10_000,
    });

    // Path: high 1.3 (+30%), low/exit 0.9 (-10%).
    assert.ok(Math.abs(record.mfePct - 30) < 1e-9);
    assert.ok(Math.abs(record.maePct - -10) < 1e-9);
    assert.ok(Math.abs(record.exitPct - -10) < 1e-9);
    assert.ok(Math.abs(record.givebackPp - 40) < 1e-9);
    assert.equal(record.timeToMfeS, 1);
    assert.equal(record.timeToMaeS, 2);

    // Shadow (100 bps + 1% per side): entry $100 → $2.00; TP1 25u @1.3 →
    // $0.65; exit 75u @0.9 → $1.35. Gross is flat (7.5 - 7.5), net is -$4.
    assert.equal(record.costModel, "NET_PNL_100BPS_1PCT");
    assert.ok(Math.abs(totalPnlUsd(position) - 0) < 1e-9);
    assert.ok(Math.abs(record.netPnlUsd - -4) < 1e-9);
    // Trail trigger was 1.04 (+4%) but the fill printed at 0.9 (-10%):
    // a gap-through-stop with the modeled cost split stored separately.
    assert.ok(Math.abs(record.exitTriggerPct - 4) < 1e-9);
    assert.equal(record.gapThroughStop, true);
    assert.ok(Math.abs(record.modeledFeeUsd - 2) < 1e-9);
    assert.ok(Math.abs(record.modeledSlipUsd - 2) < 1e-9);
  });

  test("breakeven trigger with catastrophic fill flags the gap (CATO profile)", () => {
    const position = openPosition({
      id: "solana:GAP",
      chain: "solana",
      pairAddress: "PAIR",
      tokenAddress: "TOKEN",
      symbol: "GAP",
      tokenName: "Gap",
      quoteSymbol: "SOL",
      dexId: "raydium",
      marketPrice: 1,
      usdSize: 100,
      now: 0,
    });
    updatePosition(position, 1.25, 60_000); // arms breakeven (+25%, no TP/trail)
    assert.equal(position.breakevenArmed, true);
    updatePosition(position, 0.05, 120_000); // gap far through the stop
    assert.equal(position.closedReason, "BREAKEVEN_STOP");

    const record = tradeRecordFromPosition(position, {
      pnlUsd: totalPnlUsd(position),
      pnlPct: totalPnlPct(position),
      balanceBeforeUsd: 10_000,
      balanceAfterUsd: 10_000,
    });
    // Trigger was breakeven (0%) but the fill was -95%: unmistakable gap.
    assert.ok(Math.abs(record.exitTriggerPct - 0) < 1e-9);
    assert.ok(Math.abs(record.exitPct - -95) < 1e-9);
    assert.equal(record.gapThroughStop, true);
  });

  test("clean stop fill does not flag a gap", () => {
    const position = openPosition({
      id: "solana:CLEAN",
      chain: "solana",
      pairAddress: "PAIR",
      tokenAddress: "TOKEN",
      symbol: "CLEAN",
      tokenName: "Clean",
      quoteSymbol: "SOL",
      dexId: "raydium",
      marketPrice: 1,
      usdSize: 100,
      now: 0, // opened long ago: update below lands past the early window
    });
    updatePosition(position, 0.849, 200_000); // just through the -15% stop
    assert.equal(position.closedReason, "STOP_EXIT");

    const record = tradeRecordFromPosition(position, {
      pnlUsd: totalPnlUsd(position),
      pnlPct: totalPnlPct(position),
      balanceBeforeUsd: 10_000,
      balanceAfterUsd: 10_000,
    });
    assert.ok(Math.abs(record.exitTriggerPct - -15) < 1e-9);
    assert.equal(record.gapThroughStop, false);
  });
});
