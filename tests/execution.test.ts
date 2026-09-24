import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { assessQuoteRisk } from "../src/execution/risk.ts";
import { selectBestQuote } from "../src/execution/evm/router.ts";
import { mapJupiterOrder, jupiterTakerParam } from "../src/execution/solana/jupiter.ts";
import { mapZeroExQuote } from "../src/execution/evm/zeroex.ts";
import {
  quoteV2AmountOut,
  UniswapV2DirectExecutor,
  V2_ROUTERS,
  v2RouterFor,
} from "../src/execution/evm/uniswap.ts";
import {
  quoteV4AmountOut,
  UniswapV4DirectExecutor,
  V4_STATE_VIEWS,
  v4StateViewFor,
  v4SwapFeePips,
} from "../src/execution/evm/v4.ts";
import { routeQuote, type QuoteAdapter } from "../src/execution/evm/router.ts";
import { PaperExecutor } from "../src/execution/paper.ts";
import { buildDrpcUrl, buildInfuraUrl, evmRpcFallbackChains, evmRpcSources, getEvmPublicClient } from "../src/execution/evm/viem-client.ts";
import {
  decimalsFromDasAsset,
  decimalsFromMintData,
} from "../src/execution/solana/helius.ts";
import type { Quote, QuoteRequest, RiskPolicy } from "../src/execution/types.ts";
import { SIM_ZERO_TAKER } from "../src/execution/simulate.ts";

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

  test("0x v2 maps amounts, gas, calldata and taxes", () => {
    const quote = mapZeroExQuote("bsc", { ...REQ, chain: "bsc", chainId: 56 }, {
      liquidityAvailable: true,
      sellToken: "S",
      buyToken: "B",
      sellAmount: "1000",
      buyAmount: "950",
      transaction: { to: "0xrouter", data: "0xabc", gas: "200000", value: "0" },
      tokenMetadata: { buyToken: { buyTaxBps: "100" }, sellToken: { sellTaxBps: 0 } },
    });
    assert.equal(quote.source, "0x");
    assert.equal(quote.buyAmount, "950");
    assert.equal(quote.to, "0xrouter");
    assert.equal(quote.calldata, "0xabc");
    assert.equal(quote.buyTaxBps, 100);
    assert.equal(quote.sellTaxBps, 0);
    assert.equal(quote.priceImpactPct, null);
  });

  test("0x maps native zero address to the Eeee alias", async () => {
    const { nativeAlias } = await import("../src/execution/evm/zeroex.ts");
    assert.equal(
      nativeAlias("0x0000000000000000000000000000000000000000"),
      "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    );
    assert.equal(
      nativeAlias("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"),
      "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    );
  });

  test("0x rejects illiquid pairs and missing amounts (unindexed token)", () => {
    assert.throws(
      () => mapZeroExQuote("bsc", REQ, { liquidityAvailable: false }),
      /no liquidity available/,
    );
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

describe("PaperExecutor", () => {  test("quotes at the mark with decimal scaling", async () => {
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

describe("quote-check regression fixes", () => {
  test("V2 routers are valid checksummed 40-hex addresses", async () => {
    const { isAddress, getAddress } = await import("viem");
    for (const [chain, addr] of Object.entries(V2_ROUTERS)) {
      assert.equal(isAddress(addr), true, `${chain} invalid: ${addr}`);
      assert.equal(getAddress(addr), addr, `${chain} not checksummed: ${addr}`);
      assert.equal(addr.length, 42, `${chain} must be 0x + 40 hex`);
    }
    assert.equal(
      V2_ROUTERS.bsc,
      "0x10ED43C718714eb63d5aA57B78B54704E256024E",
      "PancakeSwap V2 Router02 BSC",
    );
    assert.equal(
      V2_ROUTERS.ethereum,
      "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
      "Uniswap V2 Router02 Ethereum",
    );
    assert.equal(v2RouterFor("robinhood"), V2_ROUTERS.robinhood);
    const prevEnv = process.env.UNISWAP_V2_ROUTERS;
    delete process.env.UNISWAP_V2_ROUTERS;
    try {
      assert.throws(() => v2RouterFor("missing-chain"), /No V2 router configured/);
    } finally {
      if (prevEnv !== undefined) process.env.UNISWAP_V2_ROUTERS = prevEnv;
    }
  });

  test("jupiter omits EVM/zero/empty taker, keeps plausible Solana pubkeys", () => {
    assert.equal(jupiterTakerParam(""), null);
    assert.equal(jupiterTakerParam(SIM_ZERO_TAKER), null);
    assert.equal(jupiterTakerParam("0x1111111111111111111111111111111111111111"), null);
    assert.equal(jupiterTakerParam("short"), null);
    const sol = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    assert.equal(jupiterTakerParam(sol), sol);
  });

  test("routeQuote lists real adapter errors before 0x skips", async () => {
    const prev = process.env.ZEROEX_API_KEY;
    delete process.env.ZEROEX_API_KEY;
    const zeroex: QuoteAdapter = {
      name: "0x",
      quoteBuy: async () => { throw new Error("should not be called"); },
      quoteSell: async () => { throw new Error("should not be called"); },
    };
    const failing: QuoteAdapter = {
      name: "uniswap-v4",
      quoteBuy: async () => { throw new Error("V4 no active liquidity at current tick"); },
      quoteSell: async () => { throw new Error("V4 no active liquidity at current tick"); },
    };
    try {
      await assert.rejects(
        routeQuote([zeroex, failing], { ...REQ, chain: "robinhood", chainId: 4663 }, "sell"),
        (error: unknown) => {
          const message = String(error);
          const v4At = message.indexOf("uniswap-v4:");
          const skAt = message.indexOf("0x: ZEROEX_API_KEY");
          assert.ok(v4At !== -1 && skAt !== -1 && v4At < skAt, message);
          return true;
        },
      );
    } finally {
      if (prev !== undefined) process.env.ZEROEX_API_KEY = prev;
    }
  });

  test("routeQuote skips 0x when ZEROEX_API_KEY is unset", async () => {
    const prev = process.env.ZEROEX_API_KEY;
    delete process.env.ZEROEX_API_KEY;
    let zeroexCalled = false;
    const zeroex: QuoteAdapter = {
      name: "0x",
      quoteBuy: async () => {
        zeroexCalled = true;
        throw new Error("should not be called");
      },
      quoteSell: async () => {
        zeroexCalled = true;
        throw new Error("should not be called");
      },
    };
    const uniswap: QuoteAdapter = {
      name: "uniswap",
      quoteBuy: async () => baseQuote({ source: "uniswap", buyAmount: "900" }),
      quoteSell: async () => baseQuote({ source: "uniswap", buyAmount: "900" }),
    };
    try {
      const quote = await routeQuote(
        [zeroex, uniswap],
        { ...REQ, chain: "bsc", chainId: 56, taker: SIM_ZERO_TAKER },
        "buy",
      );
      assert.equal(quote.source, "uniswap");
      assert.equal(zeroexCalled, false);
    } finally {
      if (prev !== undefined) process.env.ZEROEX_API_KEY = prev;
    }
  });
});

describe("RPC sources", () => {
  test("buildInfuraUrl covers mainnet hosts, null otherwise", () => {
    assert.equal(buildInfuraUrl("bsc", "k"), "https://bsc-mainnet.infura.io/v3/k");
    assert.equal(buildInfuraUrl("ethereum", "k"), "https://mainnet.infura.io/v3/k");
    assert.equal(buildInfuraUrl("base", "k"), "https://base-mainnet.infura.io/v3/k");
    assert.equal(buildInfuraUrl("robinhood", "k"), null);
    assert.equal(buildInfuraUrl("bsc", ""), null);
    assert.equal(buildInfuraUrl("bsc", undefined), null);
  });

  test("decimalsFromDasAsset reads token_info, rejects garbage", () => {
    assert.equal(decimalsFromDasAsset({ token_info: { decimals: 6 } }), 6);
    assert.equal(decimalsFromDasAsset({ token_info: { decimals: 0 } }), 0);
    assert.equal(decimalsFromDasAsset({ token_info: {} }), null);
    assert.equal(decimalsFromDasAsset(null), null);
  });

  test("decimalsFromMintData parses byte 44", () => {
    const bytes = Buffer.alloc(82);
    bytes[44] = 9;
    assert.equal(decimalsFromMintData(bytes.toString("base64")), 9);
    assert.equal(decimalsFromMintData(Buffer.alloc(10).toString("base64")), null);
    assert.equal(decimalsFromMintData("!!!not-base64!!!"), null);
  });

  test("buildDrpcUrl maps only confirmed chains", () => {
    assert.equal(buildDrpcUrl("bsc", "k"), "https://lb.drpc.live/bsc/k");
    assert.equal(buildDrpcUrl("robinhood", "k"), "https://lb.drpc.live/robinhood/k");
    assert.equal(buildDrpcUrl("base", "k"), null);
    assert.equal(buildDrpcUrl("bsc", ""), null);
    assert.equal(buildDrpcUrl("bsc", undefined), null);
  });

  test("evmRpcFallbackChains parses map, ignores garbage", () => {
    const saved = process.env.EVM_RPC_FALLBACKS;
    try {
      delete process.env.EVM_RPC_FALLBACKS;
      assert.deepEqual(evmRpcFallbackChains(), []);
      process.env.EVM_RPC_FALLBACKS = JSON.stringify({ robinhood: "https://x/", bsc: 42, empty: "" });
      assert.deepEqual(evmRpcFallbackChains(), ["robinhood"]);
      process.env.EVM_RPC_FALLBACKS = "{broken";
      assert.deepEqual(evmRpcFallbackChains(), []);
    } finally {
      if (saved === undefined) delete process.env.EVM_RPC_FALLBACKS;
      else process.env.EVM_RPC_FALLBACKS = saved;
    }
  });

  test("failover transport survives a dead primary (live GetBlock drill)", async () => {
    // Needs a real fallback URL in the environment (gitignored .env);
    // skips silently without one so CI stays hermetic.
    let fallbacks: Record<string, string> = {};
    try {
      fallbacks = JSON.parse(process.env.EVM_RPC_FALLBACKS ?? "{}") as Record<string, string>;
    } catch {
      return;
    }
    if (typeof fallbacks.robinhood !== "string" || !fallbacks.robinhood) return;
    const savedOverride = process.env.EVM_RPC_URLS;
    try {
      process.env.EVM_RPC_URLS = JSON.stringify({ robinhood: "https://example.invalid/" });
      const block = await getEvmPublicClient("robinhood").getBlockNumber();
      assert.ok(block > 0n, "failover transport must serve reads past a dead primary");
    } finally {
      if (savedOverride === undefined) delete process.env.EVM_RPC_URLS;
      else process.env.EVM_RPC_URLS = savedOverride;
    }
  });
  test("evmRpcSources reflects precedence and missing chains", () => {
    const savedDrpc = process.env.DRPC_API_KEY;
    const savedInfura = process.env.INFURA_API_KEY;
    const savedOverride = process.env.EVM_RPC_URLS;
    try {
      process.env.DRPC_API_KEY = "k";
      delete process.env.INFURA_API_KEY;
      delete process.env.EVM_RPC_URLS;
      const bare = evmRpcSources();
      assert.equal(bare.robinhood, "drpc");
      assert.equal(bare.bsc, "drpc");
      assert.equal(bare.ethereum, "public");
      process.env.EVM_RPC_URLS = JSON.stringify({ robinhood: "https://rh.example/rpc" });
      assert.equal(evmRpcSources().robinhood, "override");
      delete process.env.DRPC_API_KEY;
      assert.equal(evmRpcSources().robinhood, "override");
      assert.equal(evmRpcSources().bsc, "public");
    } finally {
      if (savedDrpc === undefined) delete process.env.DRPC_API_KEY;
      else process.env.DRPC_API_KEY = savedDrpc;
      if (savedInfura === undefined) delete process.env.INFURA_API_KEY;
      else process.env.INFURA_API_KEY = savedInfura;
      if (savedOverride === undefined) delete process.env.EVM_RPC_URLS;
      else process.env.EVM_RPC_URLS = savedOverride;
    }
  });
});

describe("uniswap V4 direct quoter", () => {
  const Q96 = 2n ** 96n;

  test("swap fee follows ProtocolFeeLibrary exactly", () => {
    assert.equal(v4SwapFeePips(0n, 3000n, true), 3000n);
    assert.equal(v4SwapFeePips(0n, 3000n, false), 3000n);
    // familiars live slot0: packed 4097000 = 0x3e83e8, lp 10000.
    // oneForZero proto = 4097000 >> 12 = 1000 → 1000+10000-10 = 10990.
    assert.equal(v4SwapFeePips(4097000n, 10000n, false), 10990n);
    // zeroForOne proto = 4097000 & 0xfff = 0x3e8 = 1000 → same 10990.
    assert.equal(v4SwapFeePips(4097000n, 10000n, true), 10990n);
  });

  test("single-tick constant-price math matches hand computation", () => {
    // Price 1 (sqrtP = 2^96), 6/6 decimals, fee 3000: out = in * 0.997.
    assert.equal(quoteV4AmountOut(1_000_000n, Q96, true, 3000n, 6, 6), 997000n);
    assert.equal(quoteV4AmountOut(1_000_000n, Q96, false, 3000n, 6, 6), 997000n);
    // Price 4 token1/token0 (sqrtP = 2^97), 18/18, fee 3000, zeroForOne:
    // 1e18 * 4 * 0.997 = 3.988e18.
    assert.equal(
      quoteV4AmountOut(10n ** 18n, 2n ** 97n, true, 3000n, 18, 18),
      3988000000000000000n,
    );
    // OneForZero is the mirror: 3.988e18 token1 → ~0.994009 token0.
    assert.equal(
      quoteV4AmountOut(3988000000000000000n, 2n ** 97n, false, 3000n, 18, 18),
      994009000000000000n,
    );
    // Decimal rescale: 6-decimal in, 18-decimal out at price 1, no fee.
    assert.equal(quoteV4AmountOut(1_000_000n, Q96, true, 0n, 6, 18), 10n ** 18n);
    // Degenerate inputs quote zero.
    assert.equal(quoteV4AmountOut(0n, Q96, true, 3000n, 6, 6), 0n);
    assert.equal(quoteV4AmountOut(1000n, 0n, true, 3000n, 6, 6), 0n);
    assert.equal(quoteV4AmountOut(1000n, Q96, true, 1_000_000n, 6, 6), 0n);
  });

  test("V4 executor validates its pool id", () => {
    assert.throws(() => new UniswapV4DirectExecutor("not-an-id"), /Invalid V4 pool id/);
    assert.throws(
      () => new UniswapV4DirectExecutor("0x0000000000000000000000000000000000000001"),
      /Invalid V4 pool id/,
    );
    const executor = new UniswapV4DirectExecutor(
      "0xdb9cc66942610b8d434aff2c8df97a1d42e44dbcbc1b7065d215db1f1bd2f04c",
    );
    assert.equal(executor.name, "uniswap-v4");
  });

  test("V4 StateViews are valid addresses with robinhood present", async () => {
    const { isAddress } = await import("viem");
    for (const [chain, addr] of Object.entries(V4_STATE_VIEWS)) {
      assert.equal(isAddress(addr), true, `${chain} invalid: ${addr}`);
      assert.equal(addr.length, 42, `${chain} must be 0x + 40 hex`);
    }
    assert.equal(
      V4_STATE_VIEWS.robinhood,
      "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
      "StateView Robinhood (official deployments doc, verified live)",
    );
    assert.equal(v4StateViewFor("robinhood"), V4_STATE_VIEWS.robinhood);
    const prevEnv = process.env.UNISWAP_V4_STATEVIEWS;
    delete process.env.UNISWAP_V4_STATEVIEWS;
    try {
      assert.throws(() => v4StateViewFor("missing-chain"), /No V4 StateView configured/);
    } finally {
      if (prevEnv !== undefined) process.env.UNISWAP_V4_STATEVIEWS = prevEnv;
    }
  });
});
