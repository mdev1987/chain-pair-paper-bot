import { Keypair } from "@solana/web3.js";

const B58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Minimal base58 decode (avoids a bs58 dependency for one call site). */
function base58Decode(s: string): Uint8Array {
  let num = 0n;
  for (const ch of s) {
    const i = B58_ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("invalid base58 character");
    num = num * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  let leading = 0;
  for (const ch of s) {
    if (ch !== "1") break;
    leading++;
  }
  const out = new Uint8Array(leading + bytes.length);
  out.set(bytes, leading);
  return out;
}

/**
 * Load the isolated Solana hot-wallet keypair from SOLANA_TRADER_SECRET_KEY
 * (base58, 64 bytes). Throws when missing or malformed. NEVER log the
 * secret — only the derived pubkey is safe to display.
 *
 * Key-hygiene note: any key that has appeared in chat history, logs, or a
 * committed file is dev-only. Generate fresh pilot wallets before funding.
 */
export function loadTraderKeypair(): Keypair {
  const raw = (process.env.SOLANA_TRADER_SECRET_KEY ?? "").trim();
  if (!raw) throw new Error("SOLANA_TRADER_SECRET_KEY is not configured");
  let bytes: Uint8Array;
  try {
    bytes = base58Decode(raw);
  } catch {
    throw new Error("SOLANA_TRADER_SECRET_KEY is not valid base58");
  }
  if (bytes.length !== 64) {
    throw new Error(
      `SOLANA_TRADER_SECRET_KEY must decode to 64 bytes (got ${bytes.length})`,
    );
  }
  return Keypair.fromSecretKey(bytes);
}

/** Display-safe trader identity (pubkey only). */
export function traderPublicKey(): string {
  return loadTraderKeypair().publicKey.toBase58();
}
