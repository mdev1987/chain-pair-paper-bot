import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { assessConfirmation } from "../src/dexscreener.ts";

describe("assessConfirmation", () => {
  test("flat and rising re-quotes pass freely", () => {
    assert.equal(
      assessConfirmation({ price: 1, liquidityUsd: 20_000 }, { price: 1, liquidityUsd: 20_000 }, 5, 30).ok,
      true,
    );
    assert.equal(
      assessConfirmation({ price: 1, liquidityUsd: 20_000 }, { price: 1.5, liquidityUsd: 40_000 }, 5, 30).ok,
      true,
    );
  });

  test("small dips within tolerance pass", () => {
    const verdict = assessConfirmation(
      { price: 1, liquidityUsd: 20_000 },
      { price: 0.96, liquidityUsd: 19_000 },
      5, 30,
    );
    assert.equal(verdict.ok, true);
  });

  test("material price slide rejects", () => {
    const verdict = assessConfirmation(
      { price: 1, liquidityUsd: 20_000 },
      { price: 0.9, liquidityUsd: 20_000 },
      5, 30,
    );
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? "", /price-declining/);
  });

  test("liquidity collapse rejects even when price holds", () => {
    const verdict = assessConfirmation(
      { price: 1, liquidityUsd: 20_000 },
      { price: 1, liquidityUsd: 10_000 },
      5, 30,
    );
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? "", /liquidity-collapsing/);
  });

  test("missing re-quote price rejects", () => {
    assert.equal(
      assessConfirmation({ price: 1, liquidityUsd: 20_000 }, { price: NaN, liquidityUsd: 20_000 }, 5, 30).ok,
      false,
    );
  });
});
