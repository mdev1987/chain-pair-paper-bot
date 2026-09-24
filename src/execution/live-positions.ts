import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Phase 1.4 — live position mirror. Paper tracks virtual quantities; live
 * remaining quantity derives ONLY from confirmed on-chain fills:
 *
 *   openLivePosition   ← confirmed BUY fill (entry)
 *   applyLiveFill SELL ← each confirmed TP partial (decrements remainder)
 *   closeLivePosition  ← confirmed final exit
 *
 * Remaining quantity is NEVER computed from paper TP percentages. Oversells
 * (more than the confirmed remainder) throw instead of going negative.
 * Amounts are base-unit bigint strings — no floats anywhere.
 */

export interface LivePosition {
  positionId: string;
  chain: string;
  /** Token mint held (base units below). */
  tokenMint: string;
  remainingBaseUnits: string;
  filledBaseUnits: string;
  status: "OPEN" | "CLOSED";
  openedAt: number;
  updatedAt: number;
}

function isLivePosition(value: unknown): value is LivePosition {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  const isBigStr = (v: unknown) => {
    if (typeof v !== "string") return false;
    try {
      return BigInt(v) >= 0n;
    } catch {
      return false;
    }
  };
  return (
    typeof p.positionId === "string" &&
    p.positionId.length > 0 &&
    typeof p.chain === "string" &&
    typeof p.tokenMint === "string" &&
    isBigStr(p.remainingBaseUnits) &&
    isBigStr(p.filledBaseUnits) &&
    (p.status === "OPEN" || p.status === "CLOSED") &&
    typeof p.openedAt === "number" &&
    typeof p.updatedAt === "number"
  );
}

export function defaultLivePositionsPath(): string {
  return process.env.LIVE_POSITIONS_FILE ?? "data/live-positions.json";
}

export function loadLivePositions(path: string = defaultLivePositionsPath()): LivePosition[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed as { positions?: unknown }).positions;
    if (!Array.isArray(list)) return [];
    return list.filter(isLivePosition);
  } catch {
    return [];
  }
}

export function saveLivePositions(
  positions: LivePosition[],
  path: string = defaultLivePositionsPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), positions }), "utf8");
  renameSync(tmp, path);
}

export function openLivePosition(
  positions: LivePosition[],
  input: { positionId: string; chain: string; tokenMint: string; filledBaseUnits: string },
): LivePosition[] {
  if (positions.some((p) => p.positionId === input.positionId && p.status === "OPEN")) {
    throw new Error(`Live position already open: ${input.positionId}`);
  }
  let filled: bigint;
  try {
    filled = BigInt(input.filledBaseUnits);
  } catch {
    throw new Error(`Invalid fill amount: ${input.filledBaseUnits}`);
  }
  if (filled <= 0n) throw new Error("Entry fill must be positive");
  const now = Date.now();
  return [
    ...positions.filter((p) => p.positionId !== input.positionId),
    {
      positionId: input.positionId,
      chain: input.chain,
      tokenMint: input.tokenMint,
      remainingBaseUnits: filled.toString(),
      filledBaseUnits: filled.toString(),
      status: "OPEN",
      openedAt: now,
      updatedAt: now,
    },
  ];
}

/**
 * Apply a CONFIRMED SELL fill: decrements the remainder, accumulates the
 * filled total. Throws on unknown/closed positions and on oversell.
 */
export function applyLiveFill(
  positions: LivePosition[],
  positionId: string,
  soldBaseUnits: string,
): LivePosition[] {
  let sold: bigint;
  try {
    sold = BigInt(soldBaseUnits);
  } catch {
    throw new Error(`Invalid fill amount: ${soldBaseUnits}`);
  }
  if (sold <= 0n) throw new Error("Sell fill must be positive");
  const idx = positions.findIndex((p) => p.positionId === positionId);
  if (idx === -1) throw new Error(`Unknown live position: ${positionId}`);
  const current = positions[idx]!;
  if (current.status !== "OPEN") throw new Error(`Live position not open: ${positionId}`);
  const remaining = BigInt(current.remainingBaseUnits);
  if (sold > remaining) {
    throw new Error(
      `Oversell refused for ${positionId}: ${sold} > remaining ${remaining}`,
    );
  }
  const next = [...positions];
  next[idx] = {
    ...current,
    remainingBaseUnits: (remaining - sold).toString(),
    filledBaseUnits: (BigInt(current.filledBaseUnits) + sold).toString(),
    updatedAt: Date.now(),
  };
  return next;
}

export function closeLivePosition(
  positions: LivePosition[],
  positionId: string,
): LivePosition[] {
  const idx = positions.findIndex((p) => p.positionId === positionId);
  if (idx === -1) throw new Error(`Unknown live position: ${positionId}`);
  const current = positions[idx]!;
  if (current.status !== "OPEN") throw new Error(`Live position not open: ${positionId}`);
  if (BigInt(current.remainingBaseUnits) !== 0n) {
    throw new Error(
      `Close refused for ${positionId}: ${current.remainingBaseUnits} base units unaccounted`,
    );
  }
  const next = [...positions];
  next[idx] = { ...current, status: "CLOSED", updatedAt: Date.now() };
  return next;
}

/** Live open count for the buy gate (wired to live-state in a later step). */
export function countOpenLive(positions: LivePosition[]): number {
  return positions.filter((p) => p.status === "OPEN").length;
}
