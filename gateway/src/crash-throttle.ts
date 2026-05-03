/**
 * Crash-count throttle.
 *
 * Why this exists:
 * macOS `launchd` with KeepAlive+ThrottleInterval only bounds restart
 * frequency — it does NOT cap total restart count. A persistent crash
 * cause (like today's 409/backlog amplification) can keep restarting
 * every N seconds forever, each time compounding the damage.
 *
 * Fix:
 * On startup, append a timestamp line to $AHI_HOME/state/logs/gateway.crashes.log.
 * If 3+ startups happen within 5 minutes, WRITE A MARKER FILE at
 * $AHI_HOME/state/logs/gateway.CRASHED-REPEATEDLY and exit(2). launchd will still
 * try to restart us, but the marker file is obvious next time the operator
 * looks. (If we wanted hard stop we'd need to re-configure launchd
 * from inside the process, which is fragile — instead we rely on the
 * plist's ThrottleInterval of 60s to limit damage AND leave a loud
 * marker to catch attention.)
 *
 * The 5-minute window is sliding: we only count entries newer than
 * (now - 5 min). The log file is never truncated — it's a thin audit
 * trail you can `tail` to diagnose.
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { homedir } from "os";

const LOG_DIR = resolve(process.env.AHI_HOME || resolve(homedir(), "ahi"), "state/logs");
const CRASH_LOG = resolve(LOG_DIR, "gateway.crashes.log");
const MARKER_FILE = resolve(LOG_DIR, "gateway.CRASHED-REPEATEDLY");
const WINDOW_MS = 5 * 60 * 1000;
const MAX_STARTS = 3;

function ensureDir(): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {}
}

/**
 * Record a startup and return true if the last N startups are within the
 * throttle window (i.e. we've crashed repeatedly). The caller should
 * exit loudly when this returns true.
 */
export function recordStartupAndCheckThrottle(): {
  crashLoop: boolean;
  recentCount: number;
  windowMs: number;
} {
  ensureDir();
  const nowMs = Date.now();
  try {
    appendFileSync(CRASH_LOG, `${new Date(nowMs).toISOString()}\n`);
  } catch (err) {
    console.warn(`[crash-throttle] failed to append crash log:`, (err as Error).message);
  }

  let lines: string[] = [];
  if (existsSync(CRASH_LOG)) {
    try {
      lines = readFileSync(CRASH_LOG, "utf-8").split("\n").filter(Boolean);
    } catch {}
  }

  const recent = lines
    .map((l) => Date.parse(l.trim()))
    .filter((t) => Number.isFinite(t) && nowMs - t <= WINDOW_MS);

  const recentCount = recent.length;
  const crashLoop = recentCount >= MAX_STARTS;

  if (crashLoop) {
    try {
      writeFileSync(
        MARKER_FILE,
        [
          `AHI Gateway crash-loop detected at ${new Date(nowMs).toISOString()}`,
          ``,
          `${recentCount} startups within the last ${WINDOW_MS / 60000} min.`,
          ``,
          `Recent startup timestamps:`,
          ...recent.map((t) => `  ${new Date(t).toISOString()}`),
          ``,
          `This file is a signal — delete it after investigating. Do NOT just restart`,
          `the gateway. Look at $AHI_HOME/state/logs/gateway.err.log and find the root cause.`,
          ``,
          `See $AHI_HOME/mission-control/INCIDENTS.md for the protocol.`,
          ``,
        ].join("\n"),
      );
    } catch (err) {
      console.warn(`[crash-throttle] failed to write marker file:`, (err as Error).message);
    }
  }

  return { crashLoop, recentCount, windowMs: WINDOW_MS };
}
