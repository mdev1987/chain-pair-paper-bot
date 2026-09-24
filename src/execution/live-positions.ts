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
  /**
   * Entry fill size (base units) — the base for TP fractions. TP sell
   * quantities derive from THIS, never from paper percentages applied to
   * paper quantities (entry drag makes them differ).
   */
  originalBaseUnits: string;
  /** USD spent on entry (for realized-PnL cost shares). */
  entryCostUsd: number;
  /**
   * Quote-currency mint for exits (sweeper needs it after paper is gone).
   * Absent on mirrors opened before this field existed.
   */
  quoteMint?: string;
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
  const isCost = typeof p.entryCostUsd === "number" && Number.isFinite(p.entryCostUsd) && p.entryCostUsd > 0;
  return (
    typeof p.positionId === "string" &&
    p.positionId.length > 0 &&
    typeof p.chain === "string" &&
    typeof p.tokenMint === "string" &&
    (p.quoteMint === undefined || typeof p.quoteMint === "string") &&
    isBigStr(p.remainingBaseUnits) &&
    isBigStr(p.filledBaseUnits) &&
    isBigStr(p.originalBaseUnits) &&
    isCost &&
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
  input: { positionId: string; chain: string; tokenMint: string; filledBaseUnits: string; entryCostUsd: number; quoteMint?: string },
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
  if (!Number.isFinite(input.entryCostUsd) || input.entryCostUsd <= 0) {
    throw new Error("Entry cost must be positive");
  }
  const now = Date.now();
  return [
    ...positions.filter((p) => p.positionId !== input.positionId),
    {
      positionId: input.positionId,
      chain: input.chain,
      tokenMint: input.tokenMint,
      remainingBaseUnits: filled.toString(),
      filledBaseUnits: filled.toString(),
      originalBaseUnits: filled.toString(),
      entryCostUsd: input.entryCostUsd,
      ...(input.quoteMint !== undefined ? { quoteMint: input.quoteMint } : {}),
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

/**
 * Crash-restart idempotency for SELL fills: was this exact fill already
 * applied to the mirror?
 * - "fresh": remainder untouched (equals original) → safe to apply.
 * - "applied": remainder already reduced by exactly this fill → skip.
 * - "conflict": neither — partial state needing operator review, never guess.
 */
export function sellFillStatus(
  position: LivePosition,
  fillSellBaseUnits: string,
): "fresh" | "applied" | "conflict" {
  let sold: bigint;
  try {
    sold = BigInt(fillSellBaseUnits);
  } catch {
    throw new Error(`Invalid fill amount: ${fillSellBaseUnits}`);
  }
  if (sold <= 0n) throw new Error("Fill amount must be positive");
  const remaining = BigInt(position.remainingBaseUnits);
  const original = BigInt(position.originalBaseUnits);
  if (remaining === original) return "fresh";
  if (remaining === original - sold) return "applied";
  return "conflict";
}

/**
 * Live TP sell quantity: the strategy fraction applied to the LIVE
 * original fill — never paper percentages on paper quantities (entry
 * drag makes them differ). Pure BigInt; throws on degenerate input.
 */
export function liveTpQty(originalBaseUnits: string, sellPct: number): bigint {
  let orig: bigint;
  try {
    orig = BigInt(originalBaseUnits);
  } catch {
    throw new Error(`Invalid original amount: ${originalBaseUnits}`);
  }
  if (orig <= 0n) throw new Error("Original must be positive");
  if (!(sellPct > 0) || sellPct > 100) throw new Error(`Invalid sellPct: ${sellPct}`);
  const qty = (orig * BigInt(Math.round(sellPct * 100))) / 10_000n;
  if (qty <= 0n) throw new Error("TP quantity rounds to zero");
  return qty;
}

/**
 * Realized PnL share for a partial: proceeds minus the proportional
 * entry-cost share. Approximate (ignores sub-cent network fees).
 */
export function realizedShare(
  proceedsUsd: number,
  entryCostUsd: number,
  soldBase: bigint,
  originalBase: bigint,
): number {
  if (originalBase <= 0n) throw new Error("Original must be positive");
  if (!Number.isFinite(proceedsUsd) || !Number.isFinite(entryCostUsd)) {
    throw new Error("Non-finite USD input");
  }
  return proceedsUsd - (entryCostUsd * Number(soldBase)) / Number(originalBase);
}
