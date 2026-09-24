import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  V4_INITIALIZE_TOPIC0,
  parseV4InitializeLog,
  v4PoolManagerFor,
} from "../src/execution/evm/v4.ts";

function word(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

function paddedAddr(addr: string): string {
  return `0x${addr.slice(2).padStart(64, "0")}`;
}

describe("parseV4InitializeLog", () => {
  test("decodes a synthetic Initialize log into a PoolKey", () => {
    const currency0 = "0x0000000000000000000000000000000000000000";
    const currency1 = "0x1111111111111111111111111111111111111111";
    const poolId = `0x${"ab".repeat(32)}`;
    const log = {
      topics: [
        V4_INITIALIZE_TOPIC0,
        poolId,
        paddedAddr(currency0),
        paddedAddr(currency1),
      ],
      data: `0x${word(3000n)}${word(60n)}${word(0x1234n)}${word(2n ** 96n)}${word(100n)}`,
    };
    const key = parseV4InitializeLog(log);
    assert.ok(key);
    assert.equal(key.currency0.toLowerCase(), currency0);
    assert.equal(key.currency1.toLowerCase(), currency1);
    assert.equal(key.fee, 3000);
    assert.equal(key.tickSpacing, 60);
    assert.equal(key.hooks.toLowerCase(), `0x${"0".repeat(36)}1234`);
  });

  test("rejects non-Initialize events and malformed payloads", () => {
    assert.equal(
      parseV4InitializeLog({ topics: [`0x${"00".repeat(32)}`], data: "0x" }),
      null,
    );
    assert.equal(
      parseV4InitializeLog({ topics: [V4_INITIALIZE_TOPIC0], data: "0x1234" }),
      null,
    );
  });
});

describe("v4PoolManagerFor", () => {
  test("returns null for chains without a configured manager (no network)", () => {
    assert.equal(v4PoolManagerFor("robinhood"), null);
    assert.equal(v4PoolManagerFor("no-such-chain"), null);
  });

  test("honors UNISWAP_V4_POOL_MANAGERS overrides", () => {
    const prev = process.env.UNISWAP_V4_POOL_MANAGERS;
    process.env.UNISWAP_V4_POOL_MANAGERS = JSON.stringify({
      robinhood: "0x2222222222222222222222222222222222222222",
    });
    try {
      assert.equal(
        v4PoolManagerFor("robinhood"),
        "0x2222222222222222222222222222222222222222",
      );
    } finally {
      if (prev === undefined) delete process.env.UNISWAP_V4_POOL_MANAGERS;
      else process.env.UNISWAP_V4_POOL_MANAGERS = prev;
    }
  });
});
