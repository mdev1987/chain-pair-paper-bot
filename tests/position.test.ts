import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import {
  openPosition,
  remainingPct,
  totalPnlPct,
  updatePosition,
} from "../src/position.ts";

function makePosition() {
  return openPosition({
    id: "solana:test",
    chain: "solana",
    pairAddress: "PAIR",
    tokenAddress: "TOKEN",
    symbol: "TEST",
    tokenName: "Test",
    quoteSymbol: "SOL",
    dexId: "raydium",
    marketPrice: 1,
    usdSize: 100,
    now: 0,
  });
}

describe("paper position engine", () => {
  test("TP1 sells the configured fraction of the original position", () => {
    const position = makePosition();
    const events = updatePosition(position, 1.3, 1_000);

    assert.equal(events.some((event) => event.type === "TP" && event.level === 1), true);
    assert.ok(Math.abs(remainingPct(position) - 75) < 1e-8);
    assert.ok(Math.abs(totalPnlPct(position) - 30) < 1e-8);
  });

  test("trailing activates after the configured threshold and exits on retrace", () => {
    const position = makePosition();
    updatePosition(position, 1.4, 1_000);
    assert.equal(position.trailingActive, true);

    const events = updatePosition(position, 1.1, 2_000);
    assert.equal(events.some((event) => event.type === "TRAIL_EXIT"), true);
    assert.equal(position.status, "CLOSED");
  });

  test("initial stop closes before trailing activation", () => {
    const position = makePosition();
    const stop = 1 - config.stops.initialPct / 100;
    const events = updatePosition(position, stop - 0.001, 1_000);

    assert.equal(events.some((event) => event.type === "STOP_EXIT"), true);
    assert.equal(position.status, "CLOSED");
  });
});

describe("dynamic stop: breakeven after TP1", () => {
  test("STOP_MOVED arms breakeven once TP1 fills", () => {
    const position = makePosition();
    const events = updatePosition(position, 1.3, 1_000);

    assert.equal(position.breakevenArmed, true);
    assert.equal(events.some((event) => event.type === "STOP_MOVED"), true);
  });

  test("breakeven stop exits when trailing is not active", () => {
    const position = makePosition();
    // Simulate the post-TP1 / pre-trail window (TP1 < trail activation).
    position.breakevenArmed = true;
    const events = updatePosition(position, 0.99, 1_000);

    assert.equal(events.some((event) => event.type === "BREAKEVEN_EXIT"), true);
    assert.equal(position.status, "CLOSED");
    assert.equal(position.closedReason, "BREAKEVEN_STOP");
  });

  test("TP events carry sold quantity and cash proceeds", () => {
    const position = makePosition(); // $100 @ $1 -> 100 units, zero friction by default
    const events = updatePosition(position, 1.3, 1_000);
    const tp = events.find((event) => event.type === "TP");
    assert.ok(tp && tp.type === "TP");
    assert.ok(Math.abs(tp.soldQty - 25) < 1e-8);
    assert.ok(Math.abs(tp.proceedsUsd - 32.5) < 1e-8);
  });
});

describe("ledger fee baseline", () => {
  test("first TP attributes only the exit fee, never minus the entry fee", () => {
    const savedEntryBps = config.entry.feeEntryBps;
    const savedExitBps = config.entry.feeExitBps;
    config.entry.feeEntryBps = 10;
    config.entry.feeExitBps = 10;
    try {
      const position = makePosition(); // $100 @ $1, $0.10 entry fee
      // Invariant the main.ts ledgerCosts baseline relies on.
      assert.equal(position.totalExitFeeUsd, 0);
      assert.ok(position.totalEntryFeeUsd > 0);

      // Baseline main.ts must seed for this position.
      const prevFee = position.totalExitFeeUsd;
      const events = updatePosition(position, 1.3, 1_000);
      const tp = events.find((event) => event.type === "TP");
      assert.ok(tp && tp.type === "TP");

      const feeDelta = position.totalExitFeeUsd - prevFee;
      const expectedExitFee = tp.soldQty * 1.3 * (10 / 10_000);
      assert.ok(Math.abs(feeDelta - expectedExitFee) < 1e-9);
      // The buggy baseline (entry fee) would under-count by $0.10.
      assert.ok(feeDelta > expectedExitFee - position.totalEntryFeeUsd);
    } finally {
      config.entry.feeEntryBps = savedEntryBps;
      config.entry.feeExitBps = savedExitBps;
    }
  });
});

describe("paper position edge cases", () => {
  test("all three partial TPs sell exactly 75% of the original quantity", () => {
    const position = makePosition();
    updatePosition(position, 1.3, 1_000);
    updatePosition(position, 1.6, 2_000);
    const events = updatePosition(position, 2.0, 3_000);

    const tpLevels = events.filter((event) => event.type === "TP").map((event) => event.level);
    assert.deepEqual(tpLevels, [3]);
    assert.ok(Math.abs(remainingPct(position) - 25) < 1e-8);
  });

  test("time exit records the update timestamp", () => {
    const position = makePosition();
    const now = 40 * 60_000;
    const events = updatePosition(position, 1, now);

    assert.equal(events.some((event) => event.type === "TIME_EXIT"), true);
    assert.equal(position.closedAt, now);
  });
});
