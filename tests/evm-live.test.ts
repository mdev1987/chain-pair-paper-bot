import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  TRANSFER_TOPIC,
  isNativeToken,
  parseEvmFillFromReceipt,
  spenderFor,
  traderEvmAddress,
} from "../src/execution/evm/live.ts";
import { evmFillFromReceipt } from "../src/execution/evm/reconcile.ts";
import { UniswapV4DirectExecutor } from "../src/execution/evm/v4.ts";
import { ZeroExExecutor } from "../src/execution/evm/zeroex.ts";
import type { Quote } from "../src/execution/types.ts";

// Trader identity under test comes from the environment (pinned to a
// throwaway key by .env.test) — never hardcode a live wallet here.
const TRADER = traderEvmAddress();
const TOKEN_A = "0x1111111111111111111111111111111111111111";
const TOKEN_B = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";

function pad(addr: string): string {
  return `0x${"0".repeat(24)}${addr.slice(2).toLowerCase()}`;
}

function transferLog(token: string, from: string, to: string, amount: bigint) {
  return {
    address: token,
    topics: [TRANSFER_TOPIC, pad(from), pad(to)],
    data: `0x${amount.toString(16)}`,
  };
}

function baseQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    source: "0x",
    chain: "robinhood",
    sellToken: TOKEN_A,
    buyToken: TOKEN_B,
    sellAmount: "1000",
    buyAmount: "900",
    priceImpactPct: null,
    buyTaxBps: null,
    sellTaxBps: null,
    estimatedGasUnits: null,
    raw: {},
    ...overrides,
  };
}

describe("evm live primitives (pure)", () => {
  test("native detection covers zero and Eeee alias", () => {
    assert.equal(isNativeToken("0x0000000000000000000000000000000000000000"), true);
    assert.equal(isNativeToken("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"), true);
    assert.equal(isNativeToken("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"), true);
    assert.equal(isNativeToken(TOKEN_A), false);
  });

  test("spender prefers 0x allowanceTarget, falls back to quote.to", () => {
    assert.equal(
      spenderFor(baseQuote({ to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", raw: { allowanceTarget: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } })),
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    assert.equal(
      spenderFor(baseQuote({ to: TOKEN_A, raw: {} })),
      TOKEN_A,
    );
    assert.throws(() => spenderFor(baseQuote({ raw: {} })), /no valid spender/);
  });

  test("receipt parse nets Transfers, ignores noise, demands both legs", () => {
    const logs = [
      transferLog(TOKEN_A, TRADER, OTHER, 600n),
      transferLog(TOKEN_A, TRADER, OTHER, 400n), // split across two logs
      transferLog(TOKEN_B, OTHER, TRADER, 900n),
      transferLog(TOKEN_B, OTHER, OTHER, 5n), // someone else's money
      transferLog(TOKEN_A, OTHER, TRADER, 7n), // unrelated inbound
      { address: TOKEN_A, topics: ["0xdeadbeef"], data: "0x1" }, // non-Transfer
    ];
    const fill = parseEvmFillFromReceipt(logs, TRADER, TOKEN_A, TOKEN_B);
    assert.equal(fill.sellAmount, 1000n); // split logs summed; unrelated inbound ignored
    assert.equal(fill.buyAmount, 900n);
  });

  test("receipt parse throws when a leg is unprovable", () => {
    const onlyBuy = [transferLog(TOKEN_B, OTHER, TRADER, 9n)];
    assert.throws(
      () => parseEvmFillFromReceipt(onlyBuy, TRADER, TOKEN_A, TOKEN_B),
      /No sell Transfer/,
    );
    const onlySell = [transferLog(TOKEN_A, TRADER, OTHER, 9n)];
    assert.throws(
      () => parseEvmFillFromReceipt(onlySell, TRADER, TOKEN_A, TOKEN_B),
      /No buy Transfer/,
    );
    // Native legs skip their side (measured off-chain instead).
    const nativeSell = [transferLog(TOKEN_B, OTHER, TRADER, 9n)];
    assert.equal(
      parseEvmFillFromReceipt(nativeSell, TRADER, "0x0000000000000000000000000000000000000000", TOKEN_B).buyAmount,
      9n,
    );
  });

  test("evmFillFromReceipt maps receipt to ConfirmedFill with gas cost", () => {
    const receipt = {
      blockNumber: 12345n,
      gasUsed: 200_000n,
      effectiveGasPrice: 1_000_000_000n,
      logs: [transferLog(TOKEN_A, TRADER, OTHER, 1000n), transferLog(TOKEN_B, OTHER, TRADER, 900n)],
    };
    const fill = evmFillFromReceipt("0xsig", receipt as never, TOKEN_A, TOKEN_B);
    assert.equal(fill.signature, "0xsig");
    assert.equal(fill.slot, 12345);
    assert.equal(fill.sellMint, TOKEN_A);
    assert.equal(fill.sellAmountBaseUnits, "1000");
    assert.equal(fill.buyMint, TOKEN_B);
    assert.equal(fill.buyAmountBaseUnits, "900");
    assert.equal(fill.feeLamports, String(200_000n * 1_000_000_000n));
  });
});

describe("evm live gates (no network when disabled)", () => {
  test("V4 buy/sell refuse with direction to 0x", async () => {
    const v4 = new UniswapV4DirectExecutor(
      "0xdb9cc66942610b8d434aff2c8df97a1d42e44dbcbc1b7065d215db1f1bd2f04c",
    );
    // LIVE_TRADING_ENABLED unset in test env → live flag refuses first.
    await assert.rejects(v4.buy(), /live execution is not enabled/i);
    await assert.rejects(v4.sell(), /live execution is not enabled/i);
  });

  test("0x buy checks the live flag before touching network", async () => {
    const zeroex = new ZeroExExecutor();
    await assert.rejects(
      zeroex.buy({ quote: baseQuote(), taker: TRADER, slippageBps: 100 } as never),
      /live execution is not enabled/i,
    );
  });
});
