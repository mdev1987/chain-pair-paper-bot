import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  assessSolanaMint,
  assessV4Hooks,
  parseSolanaMintAuthorities,
  quoteDeviationPct,
} from "../src/execution/safety.ts";

function mintBuffer(opts: { mintTag: number; freezeTag: number }): Uint8Array {
  const buf = new Uint8Array(82);
  const view = new DataView(buf.buffer);
  view.setUint32(0, opts.mintTag, true);
  view.setUint32(46, opts.freezeTag, true);
  return buf;
}

describe("parseSolanaMintAuthorities", () => {
  test("null authorities parse as safe", () => {
    const parsed = parseSolanaMintAuthorities(mintBuffer({ mintTag: 0, freezeTag: 0 }));
    assert.ok(parsed);
    assert.equal(parsed.mintAuthorityNull, true);
    assert.equal(parsed.freezeAuthorityNull, true);
  });

  test("set authorities parse as present", () => {
    const parsed = parseSolanaMintAuthorities(mintBuffer({ mintTag: 1, freezeTag: 1 }));
    assert.ok(parsed);
    assert.equal(parsed.mintAuthorityNull, false);
    assert.equal(parsed.freezeAuthorityNull, false);
  });

  test("short buffers and bad tags are unknown", () => {
    assert.equal(parseSolanaMintAuthorities(new Uint8Array(10)), null);
    assert.equal(parseSolanaMintAuthorities(mintBuffer({ mintTag: 7, freezeTag: 0 })), null);
  });
});

describe("assessSolanaMint", () => {
  const clean = { mintAuthorityNull: true, freezeAuthorityNull: true, isToken2022: false };
  test("clean mint passes in both modes", () => {
    assert.equal(assessSolanaMint(clean, false).ok, true);
    assert.equal(assessSolanaMint(clean, true).ok, true);
  });

  test("set authorities and Token-2022 block", () => {
    assert.match(assessSolanaMint({ ...clean, mintAuthorityNull: false }, false).reason ?? "", /mint-authority/);
    assert.match(assessSolanaMint({ ...clean, freezeAuthorityNull: false }, false).reason ?? "", /freeze-authority/);
    assert.match(assessSolanaMint({ ...clean, isToken2022: true }, false).reason ?? "", /token-2022/);
  });

  test("unknowns pass lenient, block strict", () => {
    const unknown = { mintAuthorityNull: null, freezeAuthorityNull: null, isToken2022: null };
    assert.equal(assessSolanaMint(unknown, false).ok, true);
    assert.equal(assessSolanaMint(unknown, true).ok, false);
  });
});

describe("assessV4Hooks", () => {
  test("zero hooks pass; set hooks block", () => {
    assert.equal(assessV4Hooks({ currency0: "0x0", currency1: "0x1", fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" } as never, false).ok, true);
    const verdict = assessV4Hooks({ currency0: "0x0", currency1: "0x1", fee: 3000, tickSpacing: 60, hooks: "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEadBeeF" } as never, false);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? "", /hooks/);
  });

  test("unknown key passes lenient, blocks strict", () => {
    assert.equal(assessV4Hooks(null, false).ok, true);
    assert.equal(assessV4Hooks(null, true).ok, false);
  });
});

describe("quoteDeviationPct", () => {
  test("exact quote deviates ~0%", () => {
    // Mark: 100 tokens per 1 quote unit; quote sells 1e6 (6dp = 1.0 unit)
    // for 1e10 (8dp = 100.0 tokens).
    const dev = quoteDeviationPct(100, "10000000000", "1000000", 8, 6);
    assert.ok(dev !== null && Math.abs(dev) < 1e-9);
  });

  test("5% worse quote reads ~5%", () => {
    const dev = quoteDeviationPct(100, "9500000000", "1000000", 8, 6);
    assert.ok(dev !== null && Math.abs(dev - 5) < 1e-9);
  });

  test("garbage inputs return null", () => {
    assert.equal(quoteDeviationPct(NaN, "1", "1", 6, 6), null);
    assert.equal(quoteDeviationPct(100, "abc", "1", 6, 6), null);
    assert.equal(quoteDeviationPct(100, "0", "1", 6, 6), null);
  });
});
