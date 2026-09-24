import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  KNOWN_QUOTE_DECIMALS,
  qtyToBaseUnits,
  quoteAdaptersFor,
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
