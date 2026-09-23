import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseChainSizes } from "../src/config.ts";

describe("parseChainSizes", () => {
  test("empty input means uniform sizing", () => {
    assert.equal(parseChainSizes("", 10_000).size, 0);
    assert.equal(parseChainSizes(undefined, 10_000).size, 0);
    assert.equal(parseChainSizes("   ", 10_000).size, 0);
  });

  test("parses chain:size pairs case-insensitively", () => {
    const map = parseChainSizes("Solana:5,bsc:7.5", 10_000);
    assert.equal(map.get("solana"), 5);
    assert.equal(map.get("bsc"), 7.5);
  });

  test("rejects malformed entries and oversized values", () => {
    assert.throws(() => parseChainSizes("solana", 10_000), /want "chain:size"/);
    assert.throws(() => parseChainSizes("solana:abc", 10_000), /want "chain:size"/);
    assert.throws(() => parseChainSizes("solana:0", 10_000), /within \(0/);
    assert.throws(() => parseChainSizes("solana:-5", 10_000), /within \(0/);
    assert.throws(() => parseChainSizes("solana:20000", 10_000), /within \(0/);
  });
});
