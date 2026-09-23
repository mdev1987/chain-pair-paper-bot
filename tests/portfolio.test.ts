import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Portfolio } from "../src/portfolio.ts";
import { openPosition, updatePosition } from "../src/position.ts";

function makePosition(symbol = "TEST", chain = "solana") {
  return openPosition({
    id: `${chain}:${symbol}`,
    chain,
    pairAddress: "PAIR",
    tokenAddress: "TOKEN",
    symbol,
    tokenName: "Test",
    quoteSymbol: "SOL",
    dexId: "raydium",
    marketPrice: 1,
    usdSize: 10,
    now: 0,
  });
}

describe("paper portfolio", () => {
  test("entry reserves cash and TP proceeds flow back", () => {
    const portfolio = new Portfolio(10_000);
    assert.equal(portfolio.cashUsd, 10_000);

    const position = makePosition();
    const before = portfolio.equityUsd([]);
    assert.equal(before, 10_000);
    assert.equal(portfolio.onOpen(position.initialUsdSize), true);
    assert.equal(portfolio.cashUsd, 9_990);

    const events = updatePosition(position, 1.3, 1_000);
    const tp = events.find((e) => e.type === "TP");
    assert.ok(tp && tp.type === "TP");
    portfolio.onProceeds(tp.proceedsUsd);
    assert.ok(Math.abs(portfolio.cashUsd - (9_990 + 3.25)) < 1e-8);
  });

  test("insufficient cash blocks entry", () => {
    const portfolio = new Portfolio(10_000);
    assert.equal(portfolio.canOpen(10_001), false);
    assert.equal(portfolio.onOpen(10_001), false);
    assert.equal(portfolio.cashUsd, 10_000);
  });

  test("closed trades feed win rate and per-chain stats", () => {
    const portfolio = new Portfolio(10_000);

    const winner = makePosition("WIN", "solana");
    portfolio.onOpen(winner.initialUsdSize);
    for (const e of updatePosition(winner, 2.0, 1_000)) {
      if (e.type === "TP" || e.type === "TRAIL_EXIT" || e.type === "STOP_EXIT" || e.type === "BREAKEVEN_EXIT" || e.type === "TIME_EXIT") {
        portfolio.onProceeds(e.proceedsUsd);
      }
    }
    // Force-close the remainder via time exit.
    for (const e of updatePosition(winner, 2.0, 40 * 60_000)) {
      if (e.type === "TP" || e.type === "TRAIL_EXIT" || e.type === "STOP_EXIT" || e.type === "BREAKEVEN_EXIT" || e.type === "TIME_EXIT") {
        portfolio.onProceeds(e.proceedsUsd);
      }
    }
    portfolio.onClose(winner);

    const loser = makePosition("LOSS", "base");
    portfolio.onOpen(loser.initialUsdSize);
    for (const e of updatePosition(loser, 0.8, 1_000)) {
      if (e.type === "TP" || e.type === "TRAIL_EXIT" || e.type === "STOP_EXIT" || e.type === "BREAKEVEN_EXIT" || e.type === "TIME_EXIT") {
        portfolio.onProceeds(e.proceedsUsd);
      }
    }
    portfolio.onClose(loser);

    const snapshot = portfolio.snapshot([]);
    assert.equal(snapshot.totalTrades, 2);
    assert.equal(snapshot.wins, 1);
    assert.equal(snapshot.losses, 1);
    assert.equal(snapshot.winRatePct, 50);

    const chains = portfolio.chainStats();
    assert.equal(chains.length, 2);
    const sol = portfolio.chainStat("solana");
    assert.equal(sol.trades, 1);
    assert.ok(sol.pnlUsd > 0);
  });
});
