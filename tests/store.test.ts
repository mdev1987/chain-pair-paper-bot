import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPosition } from "../src/position.ts";
import { defaultState, loadState, saveState } from "../src/store.ts";

const dir = mkdtempSync(join(tmpdir(), "paperbot-state-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function makePosition(symbol = "TEST") {
  return openPosition({
    id: `solana:${symbol}`,
    chain: "solana",
    pairAddress: "PAIRADDR123456789",
    tokenAddress: "TOKENADDR123456789",
    symbol,
    tokenName: "Test Token",
    quoteSymbol: "SOL",
    dexId: "raydium",
    marketPrice: 1,
    usdSize: 10,
    balanceBeforeUsd: 10_000,
    poolAddress: "POOLADDR123456789",
    entryLiquidityUsd: 20_000,
    entryAgeSec: 60,
    now: 0,
  });
}

describe("state persistence", () => {
  test("round-trip preserves positions, cash and history", () => {
    const path = join(dir, "state.json");
    const position = makePosition();
    saveState(path, {
      version: 1,
      savedAt: 0,
      cashUsd: 9_990,
      closedTrades: [{
        id: "solana:OLD",
        chain: "solana",
        symbol: "OLD",
        dexId: "raydium",
        pnlUsd: 2.5,
        pnlPct: 25,
        reason: "TRAIL_EXIT",
        durationMs: 60_000,
        openedAt: 0,
        closedAt: 60_000,
      }],
      openPositions: [position],
    });

    const loaded = loadState(path);
    assert.equal(loaded.cashUsd, 9_990);
    assert.equal(loaded.closedTrades.length, 1);
    assert.equal(loaded.closedTrades[0]!.symbol, "OLD");
    assert.equal(loaded.openPositions.length, 1);
    const restored = loaded.openPositions[0]!;
    assert.equal(restored.id, "solana:TEST");
    assert.equal(restored.status, "OPEN");
    assert.equal(restored.quantity, position.quantity);
    assert.equal(restored.tokenAddress, "TOKENADDR123456789");
    assert.equal(restored.poolAddress, "POOLADDR123456789");
    assert.equal(restored.balanceBeforeUsd, 10_000);
  });

  test("missing file yields empty state", () => {
    const loaded = loadState(join(dir, "does-not-exist.json"));
    assert.deepEqual(loaded, { ...defaultState(), cashUsd: loaded.cashUsd });
    assert.equal(loaded.openPositions.length, 0);
    assert.equal(loaded.closedTrades.length, 0);
    assert.ok(!Number.isFinite(loaded.cashUsd));
  });

  test("corrupt file yields empty state instead of throwing", () => {
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{not json", "utf8");
    const loaded = loadState(path);
    assert.equal(loaded.openPositions.length, 0);
    assert.equal(loaded.closedTrades.length, 0);
  });

  test("invalid entries are dropped, valid ones kept", () => {
    const path = join(dir, "mixed.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      cashUsd: 5_000,
      closedTrades: [{ id: "bad" }, {
        id: "base:OK",
        chain: "base",
        symbol: "OK",
        dexId: "uniswap",
        pnlUsd: -1,
        pnlPct: -10,
        reason: "STOP_EXIT",
        durationMs: 1_000,
        openedAt: 0,
        closedAt: 1_000,
      }],
      openPositions: [
        { id: "", status: "OPEN" },
        { ...makePosition("GOOD"), status: "CLOSED" },
        makePosition("GOOD"),
      ],
    }), "utf8");
    const loaded = loadState(path);
    assert.equal(loaded.cashUsd, 5_000);
    assert.equal(loaded.closedTrades.length, 1);
    assert.equal(loaded.openPositions.length, 1);
    assert.equal(loaded.openPositions[0]!.symbol, "GOOD");
  });
});
