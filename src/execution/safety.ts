import { PublicKey } from "@solana/web3.js";
import { getSolanaConnection } from "./solana/client.ts";
import type { V4PoolKey } from "./evm/v4.ts";
import { recoverV4PoolKey } from "./evm/v4.ts";

/**
 * Entry safety layer (pure checks + best-effort on-chain reads).
 * Blocks what is provably unsafe, allows what is unknown in lenient mode
 * (strict mode blocks unknowns too). Every check logs its reason so the
 * ledger — not just the log — explains skipped entries.
 */

export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkfUHNNGEaP3DQL5ENZZj5JJ9";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface SolanaMintSafety {
  /** Null = unreadable (RPC failure, bad address, wrong size). */
  mintAuthorityNull: boolean | null;
  freezeAuthorityNull: boolean | null;
  isToken2022: boolean | null;
}

/**
 * Pure: parse an 82-byte SPL Mint layout. COption authorities sit at
 * [0..36) and [46..82): u32le tag (0 = None) + 32-byte pubkey.
 */
export function parseSolanaMintAuthorities(data: Uint8Array): SolanaMintSafety | null {
  if (data.length < 82) return null;
  const readAuthority = (offset: number): boolean | null => {
    const tag = data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24);
    if (tag === 0) return true;
    if (tag === 1) return false;
    return null;
  };
  const mintAuthorityNull = readAuthority(0);
  const freezeAuthorityNull = readAuthority(46);
  if (mintAuthorityNull === null || freezeAuthorityNull === null) return null;
  return { mintAuthorityNull, freezeAuthorityNull, isToken2022: null };
}

// Mint reads are immutable per address — cache forever, bounded.
const mintCache = new Map<string, SolanaMintSafety>();
const MINT_CACHE_CAP = 2_000;

/**
 * Best-effort Solana mint safety read. Never throws: failures resolve to
 * all-null (unknown) and the caller decides lenient vs strict.
 */
export async function getSolanaMintSafety(mint: string): Promise<SolanaMintSafety> {
  const unknown: SolanaMintSafety = { mintAuthorityNull: null, freezeAuthorityNull: null, isToken2022: null };
  const cached = mintCache.get(mint);
  if (cached) return cached;
  try {
    const info = await getSolanaConnection().getAccountInfo(new PublicKey(mint));
    if (!info || info.data.length < 82) return unknown;
    const parsed = parseSolanaMintAuthorities(info.data);
    if (!parsed) return unknown;
    const result: SolanaMintSafety = {
      ...parsed,
      isToken2022: info.owner.toBase58() === TOKEN_2022_PROGRAM,
    };
    if (mintCache.size >= MINT_CACHE_CAP) {
      mintCache.delete(mintCache.keys().next().value!);
    }
    mintCache.set(mint, result);
    return result;
  } catch {
    return unknown;
  }
}

export interface SafetyVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Pure: Solana mint gate. Creator-held mint/freeze authority enables hard
 * rugs; Token-2022 enables transfer-fee extensions. Unknowns pass in
 * lenient mode (RPC failure shouldn't stillbirth every entry) and block in
 * strict mode.
 */
export function assessSolanaMint(
  safety: SolanaMintSafety,
  strict: boolean,
): SafetyVerdict {
  if (safety.mintAuthorityNull === false) {
    return { ok: false, reason: "mint-authority-set (creator can mint)" };
  }
  if (safety.freezeAuthorityNull === false) {
    return { ok: false, reason: "freeze-authority-set (creator can freeze)" };
  }
  if (safety.isToken2022 === true) {
    return { ok: false, reason: "token-2022 (transfer-fee extensions possible)" };
  }
  if (strict && (safety.mintAuthorityNull === null || safety.freezeAuthorityNull === null || safety.isToken2022 === null)) {
    return { ok: false, reason: "mint-unreadable (strict mode)" };
  }
  return { ok: true };
}

/**
 * Pure: V4 hooks gate. A nonzero hook address can tax, gate, or brick the
 * exit — only explicitly clean (zero) pools pass. An unrecovered key passes
 * in lenient mode (manager unconfigured) and blocks in strict mode.
 */
export function assessV4Hooks(poolKey: V4PoolKey | null, strict: boolean): SafetyVerdict {
  if (!poolKey) {
    return strict
      ? { ok: false, reason: "v4-poolkey-unknown (strict mode)" }
      : { ok: true };
  }
  if (poolKey.hooks.toLowerCase() !== ZERO_ADDRESS) {
    return { ok: false, reason: `v4-hooks-set (${poolKey.hooks})` };
  }
  return { ok: true };
}

/**
 * Pure: quote-deviation gate. Compares the executable quote against the
 * DexScreener mark: a deviation past the threshold means the entry price is
 * stale (or the venue moved) — abort instead of buying the top.
 * Returns null when either side is uncomputable (caller allows + logs).
 */
export function quoteDeviationPct(
  markBuyPerSell: number,
  quotedBuyBase: string,
  quotedSellBase: string,
  buyDecimals: number,
  sellDecimals: number,
): number | null {
  if (!Number.isFinite(markBuyPerSell) || markBuyPerSell <= 0) return null;
  let buyBase: bigint;
  let sellBase: bigint;
  try {
    buyBase = BigInt(quotedBuyBase);
    sellBase = BigInt(quotedSellBase);
  } catch {
    return null;
  }
  if (buyBase <= 0n || sellBase <= 0n) return null;
  if (!Number.isInteger(buyDecimals) || !Number.isInteger(sellDecimals) || buyDecimals < 0 || sellDecimals < 0) {
    return null;
  }
  const quoted = Number(buyBase) / Number(sellBase) * 10 ** (sellDecimals - buyDecimals);
  if (!Number.isFinite(quoted) || quoted <= 0) return null;
  return (Math.abs(quoted - markBuyPerSell) / markBuyPerSell) * 100;
}

/** Result of the pre-entry live quote probe (best-effort, never throws). */
export interface EntryQuoteProbe {
  /** True when a deviation check ran (quote + decimals resolved). */
  checked: boolean;
  deviationPct: number | null;
  /** True when an EVM exit simulation ran and reverted. */
  sellSimReverted: boolean;
  note: string;
}

export { recoverV4PoolKey };
