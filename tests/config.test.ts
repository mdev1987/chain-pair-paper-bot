import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isEntryPausedAt, parseChainSizes, parseHourSet } from "../src/config.ts";

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

describe("parseHourSet", () => {
  test("empty input means no paused hours", () => {
    assert.equal(parseHourSet("").size, 0);
    assert.equal(parseHourSet(undefined).size, 0);
  });

  test("parses UTC hours with dedupe", () => {
    const set = parseHourSet("20,21,22,23,20");
    assert.deepEqual([...set].sort((a, b) => a - b), [20, 21, 22, 23]);
  });

  test("rejects non-integer and out-of-range hours", () => {
    assert.throws(() => parseHourSet("24"), /0-23/);
    assert.throws(() => parseHourSet("-1"), /0-23/);
    assert.throws(() => parseHourSet("20.5"), /0-23/);
    assert.throws(() => parseHourSet("abc"), /0-23/);
  });

  test("isEntryPausedAt matches UTC hours", () => {
    const paused = parseHourSet("20,21,22,23");
    assert.equal(isEntryPausedAt(new Date("2026-09-24T21:30:00Z"), paused), true);
    assert.equal(isEntryPausedAt(new Date("2026-09-24T12:00:00Z"), paused), false);
    assert.equal(isEntryPausedAt(new Date("2026-09-24T12:00:00Z"), new Set()), false);
  });
});
