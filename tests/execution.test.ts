import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { assessQuoteRisk } from "../src/execution/risk.ts";
import { selectBestQuote } from "../src/execution/evm/router.ts";
import { mapJupiterOrder } from "../src/execution/solana/jupiter.ts";
import { mapZeroExQuote } from "../src/execution/evm/zeroex.ts";
import { quoteV2AmountOut, UniswapV2DirectExecutor } from "../src/execution/evm/uniswap.ts";
import { PaperExecutor } from "../src/execution/paper.ts";
import type { Quote, QuoteRequest, RiskPolicy } from "../src/execution/types.ts";

function baseQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    source: "test",
    chain: "bsc",
    sellToken: "SELL",
    buyToken: "BUY",
    sellAmount: "1000",
    buyAmount: "900",
    priceImpactPct: 0.5,
    buyTaxBps: 0,
    sellTaxBps: 0,
    estimatedGasUnits: 150_000,
    raw: {},
    ...overrides,
  };
}

const POLICY: RiskPolicy = {
  maxPriceImpactPct: 5,
  maxBuyTaxBps: 500,
  maxSellTaxBps: 500,
  minBuyAmountBaseUnits: "100",
  maxGasUnits: 500_000,
};

const REQ: QuoteRequest = {
  chain: "solana",
  sellToken: "S",
  buyToken: "B",
  sellAmountBaseUnits: "100000000",
  taker: "T",
  slippageBps: 100,
};

describe("assessQuoteRisk", () => {
  test("clean quote passes without warnings", () => {
    const verdict = assessQuoteRisk(baseQuote(), POLICY);
    assert.equal(verdict.pass, true);
    assert.deepEqual(verdict.reasons, []);
  });

  test("blocks on impact, sell tax, low output and excess gas", () => {
    const verdict = assessQuoteRisk(
      baseQuote({ priceImpactPct: 12.5, sellTaxBps: 900, buyAmount: "50", estimatedGasUnits: 900_000 }),
      POLICY,
    );
    assert.equal(verdict.pass, false);
    assert.ok(verdict.reasons.some((r) => r.includes("price-impact")));
    assert.ok(verdict.reasons.some((r) => r.includes("sell-tax")));
    assert.ok(verdict.reasons.some((r) => r.includes("output")));
    assert.ok(verdict.reasons.some((r) => r.includes("gas")));
  });

  test("unknown impact/tax warns but does not block", () => {
    const verdict = assessQuoteRisk(
      baseQuote({ priceImpactPct: null, buyTaxBps: null, sellTaxBps: null }),
      POLICY,
    );
    assert.equal(verdict.pass, true);
    assert.ok(verdict.warnings.includes("price-impact-unknown"));
    assert.ok(verdict.warnings.includes("transfer-tax-unknown"));
  });
});

describe("selectBestQuote", () => {
  test("picks highest output, skips zero/unparseable", () => {
    const best = selectBestQuote([
      baseQuote({ buyAmount: "100", source: "a" }),
      baseQuote({ buyAmount: "0", source: "zero" }),
      baseQuote({ buyAmount: "not-a-number", source: "bad" }),
      baseQuote({ buyAmount: "250", source: "b" }),
    ]);
    assert.equal(best?.source, "b");
  });

  test("returns null when nothing is quotable", () => {
    assert.equal(selectBestQuote([]), null);
    assert.equal(selectBestQuote([baseQuote({ buyAmount: "0" })]), null);
  });
});

describe("quote mappings", () => {
  test("jupiter maps the live V2 /order response shape", () => {
    const quote = mapJupiterOrder(REQ, {
      inAmount: "100000000",
      outAmount: "11447913",
      priceImpactPct: "-0.00016033809199119948",
      router: "metis",
      mode: "ultra",
      feeBps: 2,
      feeMint: "So11111111111111111111111111111111111111112",
      transaction: null,
      requestId: "01a0cfbb-6d44-76dc-949e-aa961071393a",
    });
    assert.equal(quote.source, "jupiter");
    assert.equal(quote.buyAmount, "11447913");
    assert.ok(Math.abs((quote.priceImpactPct ?? 0) - -0.00016) < 1e-6);
    // Platform fee is not a token tax — tax fields stay null.
    assert.equal(quote.buyTaxBps, null);
  });

  test("jupiter rejects missing amounts and unbuildable orders", () => {
    assert.throws(() => mapJupiterOrder(REQ, {}), /inAmount\/outAmount/);
    assert.throws(
      () => mapJupiterOrder(REQ, {
        inAmount: "100", outAmount: "90", transaction: "",
        router: "metis", errorCode: 1, errorMessage: "Insufficient funds",
      }),
      /unbuildable \[metis:1\]/,
    );
  });

  test("0x maps amounts, gas, calldata and taxes", () => {
    const quote = mapZeroExQuote("bsc", { ...REQ, chain: "bsc", chainId: 56 }, {
      sellToken: "S",
      buyToken: "B",
      sellAmount: "1000",
      buyAmount: "950",
      gas: "200000",
      to: "0xrouter",
      data: "0xabc",
      value: "0",
      tokenMetadata: { buyTaxBps: "100", sellTaxBps: 0 },
    });
    assert.equal(quote.source, "0x");
    assert.equal(quote.buyAmount, "950");
    assert.equal(quote.to, "0xrouter");
    assert.equal(quote.calldata, "0xabc");
    assert.equal(quote.buyTaxBps, 100);
    assert.equal(quote.priceImpactPct, null);
  });

  test("0x rejects missing amounts (unindexed token)", () => {
    assert.throws(() => mapZeroExQuote("bsc", REQ, {}), /unindexed/);
  });

  test("uniswap V2 math matches hand-computed constant-product", () => {
    // amountIn=1000, reserveIn=100_000, reserveOut=50_000, fee 0.3%:
    // (1000*997 * 50000) / (100000*1000 + 1000*997) = 49309...
    assert.equal(quoteV2AmountOut(1000n, 100_000n, 50_000n), 493n);
    assert.equal(quoteV2AmountOut(0n, 100_000n, 50_000n), 0n);
    assert.equal(quoteV2AmountOut(1000n, 0n, 50_000n), 0n);
    assert.equal(quoteV2AmountOut(1000n, 100_000n, 0n), 0n);
  });

  test("uniswap executor validates its pair address", () => {
    assert.throws(
      () => new UniswapV2DirectExecutor("not-an-address"),
      /Invalid V2 pair address/,
    );
    const executor = new UniswapV2DirectExecutor("0x0000000000000000000000000000000000000001");
    assert.equal(executor.name, "uniswap");
  });
});

describe("PaperExecutor", () => {
  test("quotes at the mark with decimal scaling", async () => {
    const paper = new PaperExecutor();
    const quote = await paper.quoteBuy({
      ...REQ,
      sellAmountBaseUnits: "1000000000", // 1000 units, 6 decimals
      markPrice: 2,
      sellDecimals: 6,
      buyDecimals: 6,
    });
    assert.equal(quote.buyAmount, "2000000000");
    const sim = await paper.simulate({ quote, taker: "T", slippageBps: 100 });
    assert.equal(sim.ok, true);
    const fill = await paper.buy({ quote, taker: "T", slippageBps: 100 });
    assert.equal(fill.ok, true);
    assert.equal(fill.buyAmount, "2000000000");
  });

  test("requires a positive mark price", async () => {
    const paper = new PaperExecutor();
    await assert.rejects(paper.quoteBuy(REQ), /markPrice/);
  });
});
