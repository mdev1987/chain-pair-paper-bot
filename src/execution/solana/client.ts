import { Connection } from "@solana/web3.js";

/**
 * Read-only Solana RPC connection (Helius-backed). Used for fill
 * extraction and startup reconciliation — never for spending (Jupiter
 * /execute lands transactions; this connection only reads).
 */
export function getSolanaConnection(): Connection {
  const endpoint = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  return new Connection(endpoint, "confirmed");
}
