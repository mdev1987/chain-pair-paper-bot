import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  KNOWN_QUOTE_DECIMALS,
  directV2SkipReason,
  qtyToBaseUnits,
  quoteAdaptersFor,
  quoteNoteIndicatesDrained,
  quotePriceUsd,
  simulateSwap,
  usdToBaseUnits,
} from "../src/execution/simulate.ts";

describe("simulation helpers", () => {
  test("usd/qty convert to base units exactly", () => {
    assert.equal(usdToBaseUnits(10, 6), "10000000");
    assert.equal(usdToBaseUnits(10, 18), "10000000000000000000");
    assert.equal(qtyToBaseUnits(2.5, 9), "2500000000");
    assert.equal(qtyToBaseUnits(0.5, 6), "500000");
    assert.throws(() => usdToBaseUnits(0, 6), /positive/);
    assert.throws(() => qtyToBaseUnits(-1, 6), /positive/);
  });

  test("quote price derives from DexScreener print, stables fall back to $1", () => {
    assert.equal(quotePriceUsd(0.5, 2, "WETH"), 0.25);
    assert.equal(quotePriceUsd(0.5, null, "USDC"), 1);
    assert.equal(quotePriceUsd(0.5, null, "USDT"), 1);
    assert.equal(quotePriceUsd(0.5, null, "WETH"), null);
    assert.equal(quotePriceUsd(0.5, NaN, "SOL"), null);
  });

  test("default quote symbols all have known decimals", () => {
    for (const symbol of ["SOL", "USDC", "USDT", "WETH", "ETH", "BNB", "WBNB"]) {
      assert.ok(
        KNOWN_QUOTE_DECIMALS[symbol.toLowerCase()] !== undefined,
        `missing decimals for ${symbol}`,
      );
    }
  });

  test("adapter set per chain: jupiter on solana, aggregator+direct on EVM", () => {
    assert.deepEqual(quoteAdaptersFor("solana").map((a) => a.name), ["jupiter"]);
    assert.deepEqual(
      quoteAdaptersFor("bsc", "0x0000000000000000000000000000000000000001").map((a) => a.name),
      ["0x", "uniswap"],
    );
    assert.deepEqual(quoteAdaptersFor("bsc").map((a) => a.name), ["0x"]);
    assert.deepEqual(quoteAdaptersFor("robinhood", "0x0000000000000000000000000000000000000001").map((a) => a.name), ["0x", "uniswap"]);
    assert.deepEqual(quoteAdaptersFor("unknown-chain"), []);
  });

  test("V4 pool ids (64-hex) get the direct-V4 adapter, garbage stays aggregator-only", () => {
    const v4 = "0xdb9cc66942610b8d434aff2c8df97a1d42e44dbcbc1b7065d215db1f1bd2f04c";
    assert.deepEqual(
      quoteAdaptersFor("robinhood", v4).map((a) => a.name),
      ["0x", "uniswap-v4"],
    );
    assert.equal(directV2SkipReason(v4), "uniswap: not-v2-pair (len=66)");
    assert.equal(
      directV2SkipReason("0x0000000000000000000000000000000000000001"),
      null,
    );
    assert.equal(directV2SkipReason(undefined), null);
    assert.equal(directV2SkipReason(""), null);
  });

  test("drained-note matcher flags unfillable exits only", () => {
    assert.equal(quoteNoteIndicatesDrained("uniswap-v4: Error: V4 no active liquidity at current tick"), true);
    assert.equal(quoteNoteIndicatesDrained("V4 pool uninitialized (empty slot0)"), true);
    assert.equal(quoteNoteIndicatesDrained("no-quotable-route: Error: No quotable route for 0x777 -> 0x000: 0x: ZEROEX_API_KEY is not configured; uniswap-v4: Error: V4 n"), true);
    assert.equal(quoteNoteIndicatesDrained("no-quotable-route: Error: No quotable route for 0x622 -> 0x000: 0x: ZEROEX_API_KEY is not configured"), false);
    assert.equal(quoteNoteIndicatesDrained("uniswap | eth-call-revert: TRANSFER_FROM_FAILED"), false);
    assert.equal(quoteNoteIndicatesDrained(""), false);
  });

  test("simulateSwap skips unsupported chains without network", async () => {
    const result = await simulateSwap({
      chain: "unknown-chain",
      side: "BUY",
      sellToken: "S",
      buyToken: "B",
      sellAmountBaseUnits: "1000",
      sellDecimals: 18,
      buyDecimals: null,
      taker: "0x0000000000000000000000000000000000000000",
      slippageBps: 100,
    });
    assert.equal(result.attempted, false);
    assert.equal(result.source, "skipped");
  });
});
