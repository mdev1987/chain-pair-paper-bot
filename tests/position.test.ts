import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import {
  openPosition,
  remainingPct,
  SHADOW_FEE_BPS,
  SHADOW_SLIPPAGE_BPS,
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
    // Outside the early-stop window so the initial leg is the one firing.
    const events = updatePosition(position, stop - 0.001, 200_000);

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
    const now = config.entry.maxPositionAgeMin * 60_000;
    const events = updatePosition(position, 1, now);

    assert.equal(events.some((event) => event.type === "TIME_EXIT"), true);
    assert.equal(position.closedAt, now);
  });

  test("tracks lowest price and high/low timestamps", () => {
    const position = makePosition();
    updatePosition(position, 0.95, 1_000); // -5%: above the early stop, stays open
    assert.equal(position.status, "OPEN");
    assert.equal(position.lowestPrice, 0.95);
    assert.equal(position.lowestAt, 1_000);

    updatePosition(position, 1.2, 2_000);
    assert.equal(position.highestPrice, 1.2);
    assert.equal(position.highestAt, 2_000);
    // The low is sticky — later prices above it must not move it.
    assert.equal(position.lowestPrice, 0.95);
    assert.equal(position.lowestAt, 1_000);
  });
});

describe("shadow cost model", () => {
  test("entry accrues modeled fee + slippage on the full notional", () => {
    const position = makePosition(); // $100 @ $1
    assert.ok(Math.abs(position.shadowFeeUsd - 100 * (SHADOW_FEE_BPS / 10_000)) < 1e-9);
    assert.ok(Math.abs(position.shadowSlipUsd - 100 * (SHADOW_SLIPPAGE_BPS / 10_000)) < 1e-9);
  });

  test("fills accrue shadow costs without touching realized PnL", () => {
    const position = makePosition(); // $100 @ $1 -> 100 units, zero real friction
    updatePosition(position, 1.3, 1_000); // TP1 sells 25 units
    // Shadow: entry $2.00 + TP1 25u @1.3 ($0.325 fee + $0.325 slip).
    assert.ok(Math.abs(position.shadowFeeUsd - 1.325) < 1e-9);
    assert.ok(Math.abs(position.shadowSlipUsd - 1.325) < 1e-9);
    // Realized PnL reflects only real fills — the shadow never leaks into cash.
    assert.ok(Math.abs(position.realizedPnlUsd - 7.5) < 1e-9);
  });
});

describe("breakeven arming", () => {
  test("arms at BREAKEVEN_ARM_PCT gain, before any TP fills", () => {
    const position = makePosition();
    const events = updatePosition(position, 1.2, 1_000); // +20%, below TP1

    assert.equal(position.breakevenArmed, true);
    assert.equal(events.some((event) => event.type === "STOP_MOVED"), true);
    assert.equal(events.some((event) => event.type === "TP"), false);
  });
});

describe("early stop", () => {
  test("exits a fresh position printing below the early stop", () => {
    const position = makePosition();
    const events = updatePosition(position, 0.89, 60_000); // -11% at 60s

    assert.equal(events.some((event) => event.type === "EARLY_EXIT"), true);
    assert.equal(position.status, "CLOSED");
    assert.equal(position.closedReason, "EARLY_STOP");
  });

  test("does not fire outside its window — the initial stop still applies", () => {
    const position = makePosition();
    const quiet = updatePosition(position, 0.89, 200_000); // -11% at 200s
    assert.equal(quiet.length, 0);
    assert.equal(position.status, "OPEN");

    const stopped = updatePosition(position, 0.84, 200_000); // -16% at 200s
    assert.equal(stopped.some((event) => event.type === "STOP_EXIT"), true);
    assert.equal(position.status, "CLOSED");
  });

  test("never preempts an armed breakeven stop", () => {
    const position = makePosition();
    position.breakevenArmed = true;
    const events = updatePosition(position, 0.89, 60_000); // below entry, in window

    assert.equal(events.some((event) => event.type === "BREAKEVEN_EXIT"), true);
    assert.equal(events.some((event) => event.type === "EARLY_EXIT"), false);
  });
});
