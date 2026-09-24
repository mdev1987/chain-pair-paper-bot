import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Single-instance guard: two bot processes sharing data/state.json and
 * data/paper.duckdb silently corrupt each other (state.json last-writer-wins
 * cash jumps, DuckDB lock contention drops ledger rows, duplicate Telegram
 * sends). The lock lives next to the state file so custom STATE_FILE paths
 * get their own guard automatically.
 *
 * Stale locks (SIGKILL, crash) are stolen when the recorded pid is dead;
 * a live pid refuses startup with a clear error.
 */
export function claimInstanceLockForStateFile(stateFile: string): void {
  const lockPath = join(dirname(stateFile), "bot.lock");
  mkdirSync(dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    let livePid: number | null = null;
    try {
      const raw = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
      if (typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 0 && pidAlive(raw.pid)) {
        livePid = raw.pid;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Another bot instance")) throw error;
      // Unparseable lock: treat as stale and steal it below.
    }
    if (livePid !== null) {
      throw new Error(`Another bot instance is running (pid ${livePid}, lock ${lockPath}) — refusing to start`);
    }
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf8");
  // Released on clean shutdown paths (SIGTERM/SIGINT handlers call
  // process.exit, which fires 'exit'). SIGKILL leaves a stale lock that
  // the next boot steals via the dead-pid check above.
  process.once("exit", () => {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // Best-effort: a stale file is stolen, never fatal.
    }
  });
}
