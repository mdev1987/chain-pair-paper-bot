import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyticsQuery,
  initAnalytics,
  recordFill,
  recordTrade,
} from "../src/analytics.ts";

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
      "SELECT symbol, reason, pnl_usd, tp_levels, entry_liquidity_usd FROM trades",
    );
    assert.equal(trades.length, 1);
    assert.equal(trades[0]!.reason, "TRAIL_EXIT");
    assert.equal(trades[0]!.pnl_usd, -1.5);
    assert.equal(trades[0]!.tp_levels, "1");
    assert.equal(trades[0]!.entry_liquidity_usd, 20_000);

    const wins = await analyticsQuery<{ wins: number | bigint }>(
      "SELECT count(*) FILTER (WHERE pnl_usd > 0) AS wins FROM trades",
    );
    assert.equal(Number(wins[0]!.wins), 0);
  });
});
