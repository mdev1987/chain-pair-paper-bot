import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  enqueueLiveSell,
  nextSellSlippageBps,
  sellRetryDelayMs,
  type PendingLiveSell,
} from "../src/live.ts";
import {
  markConfirmed,
  markFailed,
  markSubmitted,
  recordSignal,
  retrySignal,
} from "../src/execution/live-orders.ts";

function item(overrides: Partial<PendingLiveSell> = {}): Omit<PendingLiveSell, "attempts" | "nextAttemptAt"> {
  return {
    positionId: "p1",
    chain: "solana",
    symbol: "T",
    tokenName: "T",
    dexId: "d",
    pairAddress: "PAIR",
    poolAddress: "",
    tokenMint: "MINT",
    quoteMint: "QUOTE",
    quoteSymbol: "USDC",
    priceNative: "1",
    kind: "TP",
    level: 1,
    label: "TP1",
    sellBaseUnits: "100",
    paperPrice: 1,
    sizeUsdForReport: 10,
    ...overrides,
  };
}

describe("nextSellSlippageBps", () => {
  test("escalates x1/x2/x5 and caps at 5000", () => {
    assert.equal(nextSellSlippageBps(300, 0), 300);
    assert.equal(nextSellSlippageBps(300, 1), 600);
    assert.equal(nextSellSlippageBps(300, 2), 1500);
    assert.equal(nextSellSlippageBps(300, 9), 1500);
    assert.equal(nextSellSlippageBps(3000, 2), 5000);
  });
});

describe("sellRetryDelayMs", () => {
  test("backs off linearly", () => {
    assert.equal(sellRetryDelayMs(0), 5000);
    assert.equal(sellRetryDelayMs(2), 15000);
  });
});

describe("enqueueLiveSell", () => {
  test("same label twice is one intent; EXIT supersedes pending TPs", () => {
    const first = enqueueLiveSell([], item());
    assert.equal(first.enqueued, true);
    const dup = enqueueLiveSell(first.queue, item());
    assert.equal(dup.enqueued, false);
    assert.equal(dup.queue.length, 1);
    const tp2 = enqueueLiveSell(first.queue, item({ label: "TP2", level: 2 }));
    assert.equal(tp2.enqueued, true);
    assert.equal(tp2.queue.length, 2);
    const exit = enqueueLiveSell(tp2.queue, item({ kind: "EXIT", label: "EXIT", level: undefined }));
    assert.equal(exit.enqueued, true);
    assert.deepEqual(exit.queue.map((q) => q.label), ["EXIT"]);
  });
});

describe("labeled journal lifecycles", () => {
  test("TP1 and EXIT live independent SIGNAL→SUBMITTED→CONFIRMED lives", () => {
    let journal = recordSignal([], { positionId: "p1", chain: "solana", side: "SELL", label: "TP1" });
    journal = recordSignal(journal, { positionId: "p1", chain: "solana", side: "SELL", label: "EXIT" });
    journal = markSubmitted(journal, "p1", "SELL", "sig-tp1", "TP1");
    journal = markConfirmed(journal, "p1", "SELL", "TP1");
    // EXIT untouched by TP1's lifecycle.
    const exit = journal.find((o) => (o.label ?? "") === "EXIT")!;
    assert.equal(exit.status, "SIGNAL");
    journal = markSubmitted(journal, "p1", "SELL", "sig-exit", "EXIT");
    journal = markConfirmed(journal, "p1", "SELL", "EXIT");
    assert.equal(journal.filter((o) => o.status === "CONFIRMED").length, 2);
  });

  test("unlabeled orders keep the legacy single lifecycle", () => {
    let journal = recordSignal([], { positionId: "p1", chain: "solana", side: "BUY" });
    journal = markSubmitted(journal, "p1", "BUY", "sig");
    journal = markConfirmed(journal, "p1", "BUY");
    assert.equal(journal[0]!.status, "CONFIRMED");
  });

  test("retrySignal reopens FAILED only", () => {
    let journal = recordSignal([], { positionId: "p1", chain: "solana", side: "SELL", label: "EXIT" });
    journal = markFailed(journal, "p1", "SELL", "boom", "EXIT");
    journal = retrySignal(journal, "p1", "SELL", "EXIT", "retrying");
    const order = journal.find((o) => (o.label ?? "") === "EXIT")!;
    assert.equal(order.status, "SIGNAL");
    assert.equal(order.signature, null);
    assert.throws(() => retrySignal(journal, "p1", "SELL", "EXIT"), /Only FAILED/);
    assert.throws(() => retrySignal([], "nope", "SELL"), /cannot retry/);
  });
});
