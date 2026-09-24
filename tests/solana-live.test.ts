import { describe, test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { loadTraderKeypair } from "../src/execution/solana/signer.ts";
import { signJupiterOrder } from "../src/execution/solana/jupiter.ts";
import { checkBuyPreconditions } from "../src/execution/live-guard.ts";
import { liveState, dailyLossLimitUsd } from "../src/execution/live-state.ts";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out || "1";
}

function randomSecret(): { b58: string; kp: Keypair } {
  const kp = Keypair.generate();
  return { b58: b58encode(kp.secretKey), kp };
}

describe("solana trader signer", () => {
  test("loads a 64-byte secret and derives its pubkey", () => {
    const prev = process.env.SOLANA_TRADER_SECRET_KEY;
    const gen = randomSecret();
    process.env.SOLANA_TRADER_SECRET_KEY = gen.b58;
    try {
      assert.equal(loadTraderKeypair().publicKey.toBase58(), gen.kp.publicKey.toBase58());
    } finally {
      if (prev === undefined) delete process.env.SOLANA_TRADER_SECRET_KEY;
      else process.env.SOLANA_TRADER_SECRET_KEY = prev;
    }
  });

  test("refuses missing, non-base58, and wrong-length secrets", () => {
    const prev = process.env.SOLANA_TRADER_SECRET_KEY;
    try {
      delete process.env.SOLANA_TRADER_SECRET_KEY;
      assert.throws(() => loadTraderKeypair(), /not configured/);
      process.env.SOLANA_TRADER_SECRET_KEY = "!!!not-base58!!!";
      assert.throws(() => loadTraderKeypair(), /base58/);
      process.env.SOLANA_TRADER_SECRET_KEY = b58encode(new Uint8Array(32));
      assert.throws(() => loadTraderKeypair(), /64 bytes/);
    } finally {
      if (prev === undefined) delete process.env.SOLANA_TRADER_SECRET_KEY;
      else process.env.SOLANA_TRADER_SECRET_KEY = prev;
    }
  });
});

describe("jupiter order signing (offline)", () => {
  test("sign produces a verifiable signature on the same message", () => {
    const payer = Keypair.generate();
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: new PublicKey("11111111111111111111111111111111"),
          lamports: 1,
        }),
      ],
    }).compileToV0Message();
    const unsignedB64 = Buffer.from(
      new VersionedTransaction(message).serialize(),
    ).toString("base64");

    const signedB64 = signJupiterOrder(unsignedB64, payer);
    assert.notEqual(signedB64, unsignedB64);
    const signed = VersionedTransaction.deserialize(Buffer.from(signedB64, "base64"));
    // web3.js v1 exposes no verifySignatures: assert the signature slot
    // went from all-zero to populated and the message is untouched
    // (JupiterZ market-maker slots must survive our signing).
    assert.equal(signed.signatures.length, 1);
    assert.ok(
      signed.signatures[0]!.some((b) => b !== 0),
      "signature must be populated after signing",
    );
    assert.deepEqual(
      Buffer.from(signed.message.serialize()),
      Buffer.from(message.serialize()),
      "signing must not alter the message (JupiterZ MM sig slots preserved)",
    );
  });

  test("sign refuses empty and malformed transactions", () => {
    const payer = Keypair.generate();
    assert.throws(() => signJupiterOrder("", payer), /no transaction/);
    assert.throws(() => signJupiterOrder("aGVsbG8=", payer), /deserialize|malformed|empty/i);
  });
});

describe("live buy safety invariant", () => {
  const OLD_LIVE = process.env.LIVE_TRADING_ENABLED;
  const OLD_LIMIT = process.env.DAILY_LOSS_LIMIT_USD;

  beforeEach(() => {
    liveState.resetForTests();
    process.env.LIVE_TRADING_ENABLED = "true";
    delete process.env.DAILY_LOSS_LIMIT_USD;
  });
  afterEach(() => {
    liveState.resetForTests();
    if (OLD_LIVE === undefined) delete process.env.LIVE_TRADING_ENABLED;
    else process.env.LIVE_TRADING_ENABLED = OLD_LIVE;
    if (OLD_LIMIT === undefined) delete process.env.DAILY_LOSS_LIMIT_USD;
    else process.env.DAILY_LOSS_LIMIT_USD = OLD_LIMIT;
  });

  const BASE = {
    chain: "solana",
    sizeUsd: 5,
    riskPass: true as const,
    simOk: null as null,
    quoteSource: "jupiter",
  };

  test("all-clear passes on solana/jupiter", () => {
    const verdict = checkBuyPreconditions({ ...BASE });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.failures));
  });

  test("every condition fails closed, one at a time", () => {
    process.env.LIVE_TRADING_ENABLED = "false";
    assert.match(checkBuyPreconditions({ ...BASE }).failures.join(";"), /LIVE_TRADING_ENABLED/);
    process.env.LIVE_TRADING_ENABLED = "true";

    liveState.halt("test");
    assert.match(checkBuyPreconditions({ ...BASE }).failures.join(";"), /halted/);
    liveState.resetForTests();

    liveState.recordRealizedPnl(-30); // default limit 25
    assert.match(checkBuyPreconditions({ ...BASE }).failures.join(";"), /halted/);
    liveState.resetForTests();

    liveState.setLiveOpenCount(20);
    assert.match(checkBuyPreconditions({ ...BASE }).failures.join(";"), /too many/);
    liveState.resetForTests();

    for (const bad of [NaN, 0, -1, 10_000]) {
      assert.match(
        checkBuyPreconditions({ ...BASE, sizeUsd: bad }).failures.join(";"),
        /size/,
        `size ${bad} must refuse`,
      );
    }

    assert.match(
      checkBuyPreconditions({ ...BASE, riskPass: false }).failures.join(";"),
      /risk/,
    );
    assert.match(
      checkBuyPreconditions({ ...BASE, riskPass: null }).failures.join(";"),
      /risk/,
    );

    // EVM without eth_call sim refuses; with sim passes.
    assert.match(
      checkBuyPreconditions({ ...BASE, chain: "bsc", quoteSource: "uniswap", simOk: null }).failures.join(";"),
      /simulation/,
    );
    assert.equal(
      checkBuyPreconditions({ ...BASE, chain: "bsc", quoteSource: "uniswap", simOk: true, sizeUsd: 10 }).ok,
      true,
    );

    // Solana non-Jupiter quotes still need a real simulation verdict.
    assert.match(
      checkBuyPreconditions({ ...BASE, quoteSource: "paper" }).failures.join(";"),
      /simulation/,
    );

    liveState.addPending("solana:X");
    assert.match(
      checkBuyPreconditions({ ...BASE, positionId: "solana:X" }).failures.join(";"),
      /pending/,
    );
  });

  test("daily loss limit parses, rejects garbage", () => {
    assert.equal(dailyLossLimitUsd(), 25);
    process.env.DAILY_LOSS_LIMIT_USD = "50";
    assert.equal(dailyLossLimitUsd(), 50);
    process.env.DAILY_LOSS_LIMIT_USD = "nope";
    assert.throws(() => dailyLossLimitUsd(), /Invalid DAILY_LOSS_LIMIT_USD/);
  });
});
