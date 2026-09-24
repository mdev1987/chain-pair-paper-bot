import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { openPosition, totalPnlPct, totalPnlUsd, updatePosition } from "../src/position.ts";
import { Portfolio } from "../src/portfolio.ts";
import {
  buildBuyMessage,
  buildCloseMessage,
  buildTpMessage,
  chainTxUrl,
} from "../src/report.ts";

function makeClosedPosition() {
  const position = openPosition({
    id: "solana:PAIR",
    chain: "solana",
    pairAddress: "PAIRADDR123456789",
    tokenAddress: "TOKENADDR123456789",
    symbol: "TEST",
    tokenName: "Test Token",
    quoteSymbol: "SOL",
    dexId: "raydium",
    pairUrl: "https://dexscreener.com/solana/pair",
    marketPrice: 1,
    usdSize: 10,
    balanceBeforeUsd: 10_000,
    poolAddress: "POOLADDR123456789",
    entryLiquidityUsd: 20_000,
    entryAgeSec: 60,
    now: 0,
  });
  updatePosition(position, 1.3, 1_000);
  updatePosition(position, 0.8, 2_000); // trailing exit after TP1+trail @1.3
  position.exitLiquidityUsd = 18_500;
  return position;
}

describe("telegram reporting", () => {
  test("buy message carries token, chain, DEX, pair, entry, size and balance", () => {
    const position = openPosition({
      id: "base:PAIR",
      chain: "base",
      pairAddress: "PAIRADDR123456789",
      tokenAddress: "TOKEN",
      symbol: "BUY",
      tokenName: "Buy Token",
      quoteSymbol: "USDC",
      dexId: "uniswap",
      marketPrice: 2,
      usdSize: 10,
      balanceBeforeUsd: 10_000,
      poolAddress: "POOLADDR123456789",
      entryLiquidityUsd: 15_000,
      entryAgeSec: 45,
      now: 0,
    });
    const text = buildBuyMessage({
      position,
      stopPrice: 1.7,
      tpGains: [30, 60, 100],
      trailActivationPct: 30,
      trailDistancePct: 20,
      maxHoldMin: 40,
      balanceBeforeUsd: 10_000,
      cashAfterUsd: 9_990,
      openCount: 1,
      maxOpen: 5,
    });
    for (const needle of ["BUY", "base", "uniswap", "PAIRADDR123456789", "Pool:", "POOLADDR123456789", "CA:", "TOKEN", "Entry", "$10.00", "Liquidity", "Age at entry", "Balance before", "Cash after"]) {
      assert.ok(text.includes(needle), `buy message missing ${needle}`);
    }
  });

  test("TP message carries gain, proceeds and remaining", () => {
    const position = openPosition({
      id: "solana:PAIR",
      chain: "solana",
      pairAddress: "PAIR",
      tokenAddress: "TOKEN",
      symbol: "TEST",
      tokenName: "Test",
      quoteSymbol: "SOL",
      dexId: "raydium",
      marketPrice: 1,
      usdSize: 10,
      now: 0,
    });
    const events = updatePosition(position, 1.3, 1_000);
    const tp = events.find((e) => e.type === "TP");
    assert.ok(tp && tp.type === "TP");
    const text = buildTpMessage({
      position,
      level: tp.level,
      gainPct: tp.gainPct,
      sellPct: tp.sellPct,
      price: tp.price,
      soldQty: tp.soldQty,
      proceedsUsd: tp.proceedsUsd,
      equityUsd: 10_002,
    });
    for (const needle of ["TP1", "30", "Sold", "Realized", "Remaining", "Equity"]) {
      assert.ok(text.includes(needle), `TP message missing ${needle}`);
    }
  });

  test("close message carries PnL, balances, duration, reason, DEX, pair and stats", () => {
    const portfolio = new Portfolio(10_000);
    const position = makeClosedPosition();
    assert.equal(position.status, "CLOSED");
    position.balanceAfterUsd = 10_000 + totalPnlUsd(position);
    portfolio.onClose(position);
    const snapshot = portfolio.snapshot([]);
    const text = buildCloseMessage({
      position,
      snapshot,
      chainStat: portfolio.chainStat("solana"),
      tokenTrades: 1,
      tokenPnlUsd: totalPnlUsd(position),
    });
    const pnl = `${totalPnlPct(position) >= 0 ? "+" : ""}${totalPnlPct(position).toFixed(2)}%`;
    void pnl;
    for (const needle of [
      "TEST", "solana", "raydium", "PAIRADDR123456789", "TOKENADDR123456789", "Pool:", "POOLADDR123456789", "Entry", "Exit",
      "PnL", "Net model", "Balance", "Duration", "Portfolio", "Win", "Liquidity", "Age at entry",
    ]) {
      assert.ok(text.includes(needle), `close message missing ${needle}`);
    }
    assert.ok(text.includes("TRAILING"), "close message missing exit-reason label");
  });

  test("chainTxUrl maps each chain to its explorer", () => {
    assert.equal(chainTxUrl("solana", "sig"), "https://solscan.io/tx/sig");
    assert.equal(chainTxUrl("robinhood", "sig"), "https://robinhoodchain.blockscout.com/tx/sig");
    assert.equal(chainTxUrl("bsc", "sig"), "https://bscscan.com/tx/sig");
    assert.equal(chainTxUrl("ethereum", "sig"), "https://etherscan.io/tx/sig");
    assert.equal(chainTxUrl("weirdchain", "sig"), "https://solscan.io/tx/sig");
  });
});
