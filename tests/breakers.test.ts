import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseChainCaps } from "../src/config.ts";
import {
  paperLossLimitBreached,
  recentStopCount,
  rollingExpectancyNegative,
  closedPnlToday,
} from "../src/breakers.ts";
import type { ClosedTrade } from "../src/portfolio.ts";

function trade(overrides: Partial<ClosedTrade> & { closedAt: number }): ClosedTrade {
  return {
    id: "x",
    chain: "solana",
    symbol: "T",
    dexId: "d",
    pnlUsd: 0,
    pnlPct: 0,
    reason: "TIME_EXIT",
    durationMs: 1,
    openedAt: overrides.closedAt - 1,
    ...overrides,
  } as ClosedTrade;
}

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);

describe("parseChainCaps", () => {
  test("empty input disables per-chain caps", () => {
    assert.equal(parseChainCaps("").size, 0);
    assert.equal(parseChainCaps(undefined).size, 0);
  });

  test("parses chain:count pairs case-insensitively", () => {
    const map = parseChainCaps("Solana:3,robinhood:8");
    assert.equal(map.get("solana"), 3);
    assert.equal(map.get("robinhood"), 8);
  });

  test("rejects malformed and non-positive entries", () => {
    assert.throws(() => parseChainCaps("solana"), /want "chain:count"/);
    assert.throws(() => parseChainCaps("solana:2.5"), /want "chain:count"/);
    assert.throws(() => parseChainCaps("solana:abc"), /want "chain:count"/);
    assert.throws(() => parseChainCaps("solana:0"), /positive integer/);
    assert.throws(() => parseChainCaps("solana:-2"), /positive integer/);
  });
});

describe("recentStopCount", () => {
  test("counts only stop/drain reasons inside the window", () => {
    const closed = [
      trade({ closedAt: NOW - 5 * 60_000, reason: "STOP_EXIT" }),
      trade({ closedAt: NOW - 10 * 60_000, reason: "EARLY_STOP" }),
      trade({ closedAt: NOW - 40 * 60_000, reason: "STOP_EXIT" }),
      trade({ closedAt: NOW - 5 * 60_000, reason: "TIME_EXIT", pnlUsd: 5 }),
      trade({ closedAt: NOW - 5 * 60_000, reason: "STOP_EXIT", chain: "robinhood" }),
    ];
    assert.equal(recentStopCount(closed, "solana", NOW, 30), 2);
    assert.equal(recentStopCount(closed, "robinhood", NOW, 30), 1);
    assert.equal(recentStopCount(closed, "solana", NOW, 3), 0);
  });
});

describe("rollingExpectancyNegative", () => {
  test("needs a minimum sample and nets the window", () => {
    const mk = (pnls: number[]) => pnls.map((pnlUsd, i) => trade({ closedAt: NOW - i * 1000, pnlUsd }));
    assert.equal(rollingExpectancyNegative(mk([1, 1]), "solana", 20), false);
    assert.equal(rollingExpectancyNegative(mk([-1, -1, -1, -1, -1]), "solana", 20), true);
    assert.equal(rollingExpectancyNegative(mk([10, -1, -1, -1, -1]), "solana", 20), false);
    // Only the last `lookback` trades count.
    assert.equal(
      rollingExpectancyNegative(mk([-100, 5, 5, 5, 5, 5]), "solana", 5),
      false,
    );
  });
});

describe("paperLossLimitBreached", () => {
  test("non-positive limit disables; UTC day bounds the sum", () => {
    const closed = [trade({ closedAt: NOW - 1000, pnlUsd: -60 })];
    assert.equal(paperLossLimitBreached(closed, 0, NOW), false);
    assert.equal(paperLossLimitBreached(closed, 50, NOW), true);
    assert.equal(paperLossLimitBreached(closed, 100, NOW), false);
    assert.equal(closedPnlToday(closed, NOW), -60);
    // Yesterday's losses don't count.
    const old = [trade({ closedAt: NOW - 26 * 3_600_000, pnlUsd: -1000 })];
    assert.equal(paperLossLimitBreached(old, 50, NOW), false);
  });
});
