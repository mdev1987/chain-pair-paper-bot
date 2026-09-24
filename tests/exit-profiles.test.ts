import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseChainExitProfiles, resolveExitProfile } from "../src/config.ts";
import { openPosition, updatePosition } from "../src/position.ts";
import type { ExitProfile, Position } from "../src/types.ts";

function profile(overrides: Partial<ExitProfile> = {}): ExitProfile {
  return {
    tp: [
      { gainPct: 20, sellPct: 50 },
      { gainPct: 50, sellPct: 25 },
    ],
    initialStopPct: 15,
    trailActivationPct: 30,
    trailDistancePct: 15,
    trailConfirmTicks: 1,
    breakevenArmPct: 20,
    breakevenBufferPct: 3,
    breakevenAfterTp1: true,
    earlyStopPct: 10,
    earlyStopWindowSec: 180,
    maxPositionAgeMin: 15,
    drainLiquidityPct: 25,
    deadLiquidityUsd: 25,
    ...overrides,
  };
}

function open(overrides: Record<string, unknown> = {}): Position {
  return openPosition({
    id: "test:PROFILE",
    chain: "solana",
    pairAddress: "PAIR",
    tokenAddress: "TOKEN",
    symbol: "T",
    tokenName: "T",
    quoteSymbol: "SOL",
    dexId: "d",
    marketPrice: 1,
    usdSize: 100,
    now: 0,
    ...overrides,
  } as Parameters<typeof openPosition>[0]);
}

describe("per-chain exit profiles", () => {
  test("two-level ladder banks 50% at +20% (Solana fast-bank)", () => {
    const p = open({ exitProfile: profile() });
    const events = updatePosition(p, 1.2, 1000);
    const tp = events.find((e) => e.type === "TP");
    assert.ok(tp && tp.type === "TP");
    assert.equal(tp.level, 1);
    assert.equal(tp.sellPct, 50);
    assert.deepEqual(p.tpHit, [true, false, false]);
  });

  test("profile time exit honors its own max age, not the global", () => {
    const p = open({ exitProfile: profile({ maxPositionAgeMin: 15 }) });
    assert.equal(updatePosition(p, 1.0, 14 * 60_000).length, 0);
    const events = updatePosition(p, 1.0, 15 * 60_000 + 1);
    assert.ok(events.some((e) => e.type === "TIME_EXIT"));
  });

  test("drain exit fires when liquidity collapses below the fraction of entry", () => {
    const p = open({ exitProfile: profile(), entryLiquidityUsd: 20_000 });
    const events = updatePosition(p, 1.05, 1000, { liquidityUsd: 4_000 });
    assert.ok(events.some((e) => e.type === "DRAIN_EXIT"));
    assert.equal(p.status, "CLOSED");
    assert.equal(p.closedReason, "DRAIN_EXIT");
  });

  test("drain fraction needs the entry reference; dead floor is absolute", () => {
    const p = open({ exitProfile: profile() });
    // Healthy print, no entry reference: neither drain nor dead floor fires.
    assert.equal(updatePosition(p, 1.05, 1000, { liquidityUsd: 10_000 }).some((e) => e.type === "DRAIN_EXIT"), false);
    // $1 venue liquidity is dead on any reference — remainder worthless.
    const q = open({ exitProfile: profile() });
    assert.equal(updatePosition(q, 1.05, 1000, { liquidityUsd: 1 }).some((e) => e.type === "DRAIN_EXIT"), true);
  });

  test("dead floor books the remainder worthless, keeping banked TPs", () => {
    const p = open({ exitProfile: profile({ deadLiquidityUsd: 25 }), entryLiquidityUsd: 20_000 });
    updatePosition(p, 1.2, 1000, { liquidityUsd: 20_000 }); // TP1 banks 50u
    assert.equal(p.tpHit[0], true);
    const before = p.realizedPnlUsd;
    const events = updatePosition(p, 1.1, 2000, { liquidityUsd: 10 });
    const drain = events.find((e) => e.type === "DRAIN_EXIT");
    assert.ok(drain);
    assert.equal(drain.proceedsUsd, 0);
    assert.equal(drain.soldQty, 0);
    assert.equal(p.quantity, 0);
    assert.equal(p.realizedPnlUsd, before); // banked TPs untouched
  });

  test("wick-proof trail needs consecutive ticks to ratchet", () => {
    const p = open({ exitProfile: profile({ trailConfirmTicks: 3 }) });
    updatePosition(p, 1.3, 1000); // single wick: streak 1, no ratchet
    assert.equal(p.trailingActive, true); // activation keys off gain, not trailHigh
    updatePosition(p, 1.1, 2000); // back below: streak resets
    assert.equal(p.status, "OPEN");
    // Three consecutive exceeds ratchet the trail high to 1.3.
    updatePosition(p, 1.31, 3000);
    updatePosition(p, 1.32, 4000);
    updatePosition(p, 1.33, 5000);
    // Trail stop is now 1.33 * 0.85 = 1.1305; 1.1 would have exited before.
    const events = updatePosition(p, 1.13, 6000);
    assert.ok(events.some((e) => e.type === "TRAIL_EXIT"));
  });

  test("single-tick confirm preserves legacy trail behavior", () => {
    const p = open({ exitProfile: profile({ trailConfirmTicks: 1 }) });
    updatePosition(p, 1.3, 1000);
    const events = updatePosition(p, 1.1, 2000); // 1.1 <= 1.3*0.85=1.105
    assert.ok(events.some((e) => e.type === "TRAIL_EXIT"));
  });
});

describe("resolveExitProfile", () => {
  test("built-ins per chain, undefined elsewhere", () => {
    const sol = resolveExitProfile("solana");
    assert.ok(sol);
    assert.equal(sol.tp.length, 2);
    assert.equal(sol.maxPositionAgeMin, 15);
    const rh = resolveExitProfile("robinhood");
    assert.ok(rh);
    assert.equal(rh.tp.length, 3);
    assert.equal(rh.trailDistancePct, 20);
    assert.equal(resolveExitProfile("base"), undefined);
  });

  test("JSON overrides parse, merge partially, and reject garbage", () => {
    assert.deepEqual(parseChainExitProfiles(""), {});
    assert.deepEqual(parseChainExitProfiles(undefined), {});
    const over = parseChainExitProfiles(JSON.stringify({ solana: { maxPositionAgeMin: 10 } }));
    assert.equal(over.solana!.maxPositionAgeMin, 10);
    assert.equal(over.solana!.tp.length, 2); // built-in ladder kept
    assert.throws(() => parseChainExitProfiles("{broken"), /Invalid CHAIN_EXIT_PROFILES JSON/);
    assert.throws(() => parseChainExitProfiles(JSON.stringify({ solana: { tp: [] } })), /Invalid CHAIN_EXIT_PROFILES profile/);
    assert.throws(
      () => parseChainExitProfiles(JSON.stringify({ solana: { tp: [{ gainPct: 10, sellPct: 200 }] } })),
      /Invalid CHAIN_EXIT_PROFILES profile/,
    );
  });
});
