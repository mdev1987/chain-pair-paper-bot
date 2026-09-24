import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VersionedTransactionResponse } from "@solana/web3.js";
import { parseFillFromTransaction } from "../src/execution/solana/fills.ts";
import {
  loadLiveOrders,
  markConfirmed,
  markFailed,
  markSubmitted,
  openOrders,
  recordSignal,
  saveLiveOrders,
} from "../src/execution/live-orders.ts";
import {
  applyLiveFill,
  closeLivePosition,
  countOpenLive,
  liveTpQty,
  loadLivePositions,
  openLivePosition,
  realizedShare,
  saveLivePositions,
} from "../src/execution/live-positions.ts";
import { liveState, persistLiveState, restoreLiveState } from "../src/execution/live-state.ts";
import { reconcileLiveState } from "../src/execution/reconcile.ts";
import {
  buildLiveFillConfirmedMessage,
  buildLiveSubmittedMessage,
} from "../src/report.ts";

const dir = mkdtempSync(join(tmpdir(), "paperbot-live-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const TRADER = "Trader1111111111111111111111111111111111111";
const OTHER = "Other11111111111111111111111111111111111111";
const MINT_A = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MINT_B = "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const WSOL = "So11111111111111111111111111111111111111112";

function bal(mint: string, owner: string, amount: string) {
  return {
    accountIndex: 0,
    mint,
    owner,
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    uiTokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: String(Number(amount) / 1e6) },
  };
}

function swapTx() {
  return {
    slot: 999,
    meta: {
      err: null,
      fee: 5000,
      preTokenBalances: [
        bal(MINT_A, TRADER, "1000000"),
        bal(WSOL, TRADER, "500"),
        bal(MINT_A, OTHER, "999"),
      ],
      postTokenBalances: [
        bal(MINT_A, TRADER, "200000"),
        bal(WSOL, TRADER, "500"),
        bal(MINT_B, TRADER, "750000"),
        bal(MINT_A, OTHER, "999"),
      ],
    },
  } as unknown as VersionedTransactionResponse;
}

describe("confirmed-fill extraction (pure)", () => {
  test("nets per-mint deltas, ignores noise and other owners", () => {
    const fill = parseFillFromTransaction(swapTx(), TRADER, "sig1");
    assert.equal(fill.signature, "sig1");
    assert.equal(fill.slot, 999);
    assert.equal(fill.sellMint, MINT_A);
    assert.equal(fill.sellAmountBaseUnits, "800000");
    assert.equal(fill.buyMint, MINT_B);
    assert.equal(fill.buyAmountBaseUnits, "750000");
    assert.equal(fill.feeLamports, "5000");
  });

  test("failed transactions and delta-less transactions throw", () => {
    const failed = { slot: 1, meta: { err: { InstructionError: [0, "Custom"] }, fee: 1, preTokenBalances: [], postTokenBalances: [] } };
    assert.throws(
      () => parseFillFromTransaction(failed as unknown as VersionedTransactionResponse, TRADER, "s"),
      /failed on-chain/,
    );
    const empty = { slot: 1, meta: { err: null, fee: 1, preTokenBalances: [], postTokenBalances: [] } };
    assert.throws(
      () => parseFillFromTransaction(empty as unknown as VersionedTransactionResponse, TRADER, "s"),
      /No usable token deltas/,
    );
    assert.throws(
      () => parseFillFromTransaction({ slot: 1, meta: null } as unknown as VersionedTransactionResponse, TRADER, "s"),
      /no meta/,
    );
  });
});

describe("pending-order journal", () => {
  test("SIGNAL → SUBMITTED → CONFIRMED with illegal transitions refused", () => {
    let orders = recordSignal([], { positionId: "solana:X", chain: "solana", side: "BUY" });
    assert.equal(openOrders(orders).length, 1);
    assert.throws(() => markConfirmed(orders, "solana:X", "BUY"), /Illegal order transition SIGNAL → CONFIRMED/);
    assert.throws(() => markSubmitted(orders, "solana:X", "BUY", ""), /signature/);
    orders = markSubmitted(orders, "solana:X", "BUY", "sigABC");
    assert.equal(orders[0]!.signature, "sigABC");
    orders = markConfirmed(orders, "solana:X", "BUY");
    assert.equal(openOrders(orders).length, 0);
    assert.throws(() => markFailed(orders, "solana:X", "BUY", "late"), /CONFIRMED → FAILED/);
    assert.throws(() => markSubmitted([], "solana:Y", "SELL", "sig"), /No SELL order/);
  });

  test("journal round-trips through disk, corrupt files yield empty", () => {
    const path = join(dir, "orders.json");
    let orders = recordSignal([], { positionId: "solana:X", chain: "solana", side: "BUY" });
    orders = markSubmitted(orders, "solana:X", "BUY", "sigABC");
    saveLiveOrders(orders, path);
    assert.equal(existsSync(path), true);
    assert.equal(loadLiveOrders(path).length, 1);
    assert.equal(loadLiveOrders(path)[0]!.signature, "sigABC");
    writeFileSync(path, "{broken", "utf8");
    assert.deepEqual(loadLiveOrders(path), []);
    assert.deepEqual(loadLiveOrders(join(dir, "missing.json")), []);
  });
});

describe("live position mirror", () => {
  test("TP partials decrement from confirmed fills, oversell refused", () => {
    let positions = openLivePosition([], {
      positionId: "solana:X", chain: "solana", tokenMint: MINT_A, filledBaseUnits: "1000",
      entryCostUsd: 5,
    });
    assert.equal(countOpenLive(positions), 1);
    assert.throws(
      () => openLivePosition(positions, { positionId: "solana:X", chain: "solana", tokenMint: MINT_A, filledBaseUnits: "5", entryCostUsd: 5 }),
      /already open/,
    );
    positions = applyLiveFill(positions, "solana:X", "250"); // TP1
    positions = applyLiveFill(positions, "solana:X", "250"); // TP2
    assert.equal(positions[0]!.remainingBaseUnits, "500");
    assert.equal(positions[0]!.filledBaseUnits, "1500");
    assert.throws(() => applyLiveFill(positions, "solana:X", "501"), /Oversell refused/);
    assert.throws(() => closeLivePosition(positions, "solana:X"), /unaccounted/);
    positions = applyLiveFill(positions, "solana:X", "500");
    positions = closeLivePosition(positions, "solana:X");
    assert.equal(countOpenLive(positions), 0);
    assert.throws(() => applyLiveFill(positions, "solana:X", "1"), /not open/);
    assert.throws(() => applyLiveFill(positions, "nope", "1"), /Unknown live position/);
  });

  test("positions round-trip through disk with validation", () => {
    const path = join(dir, "positions.json");
    const positions = openLivePosition([], {
      positionId: "solana:X", chain: "solana", tokenMint: MINT_A, filledBaseUnits: "1000",
      entryCostUsd: 5,
    });
    saveLivePositions(positions, path);
    assert.equal(loadLivePositions(path)[0]!.remainingBaseUnits, "1000");
    writeFileSync(path, JSON.stringify([{ positionId: "bad", remainingBaseUnits: "-5" }]), "utf8");
    assert.deepEqual(loadLivePositions(path), []);
  });

  test("TP quantities derive from the live original, realized shares pro-rate cost", () => {
    assert.equal(liveTpQty("1000", 25), 250n);
    assert.equal(liveTpQty("1000", 100), 1000n);
    assert.throws(() => liveTpQty("1000", 0), /Invalid sellPct/);
    assert.throws(() => liveTpQty("1000", 101), /Invalid sellPct/);
    assert.throws(() => liveTpQty("0", 25), /positive/);
    assert.throws(() => liveTpQty("abc", 25), /Invalid original/);
    // $10 cost, sell 1/4 for $4 proceeds → 4 - 2.5 = +1.5.
    assert.equal(realizedShare(4, 10, 250n, 1000n), 1.5);
    assert.throws(() => realizedShare(4, 10, 250n, 0n), /positive/);
    assert.throws(() => realizedShare(NaN, 10, 250n, 1000n), /Non-finite/);
  });
});

describe("kill-switch durability", () => {
  test("loss and halt survive a restart, day rollover resets loss only", () => {
    const path = join(dir, "live-state.json");
    liveState.resetForTests();
    liveState.recordRealizedPnl(-30);
    liveState.halt("test halt");
    persistLiveState(path);

    liveState.resetForTests();
    restoreLiveState(path);
    assert.equal(liveState.dailyLossUsd, 30);
    assert.equal(liveState.isHalted(), true);

    // Simulate yesterday's file: loss resets, manual halt stays sticky.
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw.lossDay = "2000-01-01";
    writeFileSync(path, JSON.stringify(raw), "utf8");
    liveState.resetForTests();
    restoreLiveState(path);
    assert.equal(liveState.dailyLossUsd, 0);
    assert.equal(liveState.isHalted(), true);
    liveState.resetForTests();
  });
});

describe("startup reconciliation", () => {
  test("every open order resolves from chain, never assumed", async () => {
    const orders = [
      ...recordSignal([], { positionId: "p1", chain: "solana", side: "BUY" }),
    ];
    const submitted = (id: string, sig: string) =>
      markSubmitted(
        recordSignal([], { positionId: id, chain: "solana", side: "BUY" }),
        id, "BUY", sig,
      );
    const all = [
      ...orders,
      ...submitted("p2", "sig-confirmed"),
      ...submitted("p3", "sig-failed"),
      ...submitted("p4", "sig-missing"),
      ...submitted("p5", "sig-unreadable"),
    ];
    const deps = {
      getTxStatus: async (sig: string) => {
        if (sig === "sig-confirmed" || sig === "sig-unreadable") return "confirmed" as const;
        if (sig === "sig-failed") return "failed" as const;
        if (sig === "sig-boom") throw new Error("rpc down");
        return "missing" as const;
      },
      fetchFill: async (sig: string) => {
        if (sig === "sig-unreadable") throw new Error("pruned");
        return {
          signature: sig, slot: 1, sellMint: "S", sellAmountBaseUnits: "10",
          buyMint: "B", buyAmountBaseUnits: "9", feeLamports: "5000",
        };
      },
      getBalance: async (mint: string) => (mint === MINT_A ? 500n : null),
    };
    const positions = openLivePosition([], {
      positionId: "p9", chain: "solana", tokenMint: MINT_A, filledBaseUnits: "1000",
      entryCostUsd: 5,
    });
    const report = await reconcileLiveState(all, positions, deps);
    assert.equal(report.confirmed.length, 1);
    assert.equal(report.confirmed[0]!.fill.signature, "sig-confirmed");
    assert.deepEqual(report.failed.map((o) => o.positionId).sort(), ["p1", "p3"]);
    assert.deepEqual(report.stillMissing.map((o) => o.positionId), ["p4"]);
    // Confirmed-but-unreadable fill + wallet-vs-recorded mismatch surface.
    assert.equal(report.discrepancies.length, 2);
    assert.ok(report.discrepancies.some((d) => d.includes("sig-unreadable")));
    assert.ok(report.discrepancies.some((d) => d.includes("p9")));
    // Journal reflects every transition (persist it downstream).
    const byId = new Map(report.orders.map((o) => [o.positionId, o.status]));
    assert.equal(byId.get("p1"), "FAILED");
    assert.equal(byId.get("p2"), "CONFIRMED");
    assert.equal(byId.get("p3"), "FAILED");
    assert.equal(byId.get("p4"), "SUBMITTED");
  });
});

describe("live telegram builders", () => {
  test("submitted and fill messages carry signature links", () => {
    const sub = buildLiveSubmittedMessage({
      symbol: "TEST", chain: "solana", side: "BUY", sizeUsd: 5, signature: "sigABC",
    });
    assert.ok(sub.includes("LIVE BUY SUBMITTED"));
    assert.ok(sub.includes("https://solscan.io/tx/sigABC"));
    const fill = buildLiveFillConfirmedMessage({
      symbol: "TEST", chain: "solana", kind: "TP", level: 1, price: 2,
      sellAmount: "100", buyAmount: "90", signature: "sigDEF", realizedPnlUsd: 1.5,
    });
    assert.ok(fill.includes("TP1"));
    assert.ok(fill.includes("https://solscan.io/tx/sigDEF"));
    assert.ok(fill.includes("+$1.50"));
  });
});
