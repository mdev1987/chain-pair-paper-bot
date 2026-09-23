/**
 * Minimal Solana RPC client (Helius-backed) for simulation support.
 * Only job today: resolve SPL token decimals so Solana exits can be sized
 * for quotes. Uses Helius DAS getAsset first, falls back to parsing the
 * mint account (decimals live at byte offset 44) on any vanilla RPC.
 */

function rpcUrl(): string {
  return process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) {
    throw new Error(`Solana RPC HTTP ${response.status}`);
  }
  const body = (await response.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`Solana RPC error: ${body.error.message ?? "unknown"}`);
  if (body.result === undefined) throw new Error("Solana RPC returned no result");
  return body.result;
}

interface DasAsset {
  token_info?: { decimals?: number };
}

/** Pure: decimals from a Helius DAS getAsset payload. */
export function decimalsFromDasAsset(asset: DasAsset | null): number | null {
  const decimals = asset?.token_info?.decimals;
  return typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 ? decimals : null;
}

/** Pure: decimals from a base64 mint account (byte offset 44). */
export function decimalsFromMintData(base64: string): number | null {
  try {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length < 45) return null;
    const decimals = bytes[44]!;
    return decimals <= 18 ? decimals : null;
  } catch {
    return null;
  }
}

/** SPL token decimals via Helius DAS, falling back to mint-account parsing. */
export async function getSolanaTokenDecimals(mint: string): Promise<number | null> {
  try {
    const asset = await rpcCall<DasAsset | null>("getAsset", [mint]);
    const fromDas = decimalsFromDasAsset(asset);
    if (fromDas !== null) return fromDas;
  } catch {
    // Fall through to the binary parse below.
  }
  try {
    const info = await rpcCall<{ value?: { data?: [string, string] } | null }>(
      "getAccountInfo",
      [mint, { encoding: "base64" }],
    );
    const data = info.value?.data;
    if (Array.isArray(data) && typeof data[0] === "string") {
      return decimalsFromMintData(data[0]);
    }
  } catch {
    return null;
  }
  return null;
}
