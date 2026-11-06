/**
 * The gateway's own life record — so its next death is never silent again.
 *
 * When the machine runs out of memory, the kernel's OOM killer can send the
 * gateway SIGKILL, even in the middle of a call. SIGKILL cannot be caught, so
 * nothing in-process can log it: the log just stops, and the next boot only
 * says "stale pid reaped". The reason sits in the systemd user journal
 * ("A process of this unit has been killed by the OOM killer").
 *
 * Three things here, none of which can stop the box running out of memory:
 *  1. A heartbeat file beside the singleton lock (pid, last alive, gateway and
 *     box memory, live calls), rewritten every 30 s, marked clean on a normal
 *     exit. The next boot reads it: an unclean record means the last gateway
 *     died where no handler could see it, and the boot says so, with the
 *     memory picture from its last 30 seconds, and the systemd lines for the
 *     death (allow-listed manager lines only, never the unit's own output).
 *  2. A low-memory warning line while it lives, so the next OOM has a trail.
 *  3. The OOM shield: every process under the user manager starts at
 *     oom_score_adj 200, so the gateway was in a coin toss with every build
 *     and test on the box and lost it by being the biggest. It lowers itself
 *     to the lowest value the kernel lets it (100 here), and puts its own
 *     children (agent turns, fast-voice lanes) back at the box default — a
 *     runaway turn is still a candidate; the process every call lives in is
 *     not, unless it is itself the hog by a wide margin.
 */

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { getHeapStatistics } from "node:v8";
import { atomicWriteFile } from "./multi-user-paths.js";
import { singletonLockPath } from "./singleton.js";

export interface LifeRecord {
  pid: number;
  bootAt: number;
  aliveAt: number;
  rssMb: number;
  heapUsedMb: number;
  heapLimitMb: number;
  boxAvailableMb: number | null;
  swapFreeMb: number | null;
  liveCalls: number;
  /** Set only by a normal exit; absent means the process died where nothing could log it. */
  cleanExit?: { at: number; code: number; why: string };
}

const HEARTBEAT_MS = 30_000;
const LOW_MEMORY_WARN_EVERY_MS = 5 * 60_000;

export function lifeRecordPath(): string {
  return join(dirname(singletonLockPath()), "gateway.life.json");
}

/** The box's memory from /proc/meminfo, in MB; nulls off Linux. */
export function boxMemory(meminfo?: string): { availableMb: number | null; swapFreeMb: number | null; swapTotalMb: number | null } {
  let text = meminfo;
  if (text === undefined) {
    try {
      text = readFileSync("/proc/meminfo", "utf8");
    } catch {
      return { availableMb: null, swapFreeMb: null, swapTotalMb: null };
    }
  }
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text!);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  };
  return { availableMb: kb("MemAvailable"), swapFreeMb: kb("SwapFree"), swapTotalMb: kb("SwapTotal") };
}

function snapshot(bootAt: number, liveCalls: number): LifeRecord {
  const mem = process.memoryUsage();
  const box = boxMemory();
  return {
    pid: process.pid,
    bootAt,
    aliveAt: Date.now(),
    rssMb: Math.round(mem.rss / 1048576),
    heapUsedMb: Math.round(mem.heapUsed / 1048576),
    heapLimitMb: Math.round(getHeapStatistics().heap_size_limit / 1048576),
    boxAvailableMb: box.availableMb,
    swapFreeMb: box.swapFreeMb,
    liveCalls,
  };
}

function writeRecord(path: string, rec: LifeRecord): void {
  atomicWriteFile(path, JSON.stringify(rec) + "\n");
}

export function readLifeRecord(path = lifeRecordPath()): LifeRecord | null {
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as LifeRecord;
    return typeof r.pid === "number" && typeof r.aliveAt === "number" ? r : null;
  } catch {
    return null;
  }
}

/** The boot line about the process before this one, or null when there is nothing to say. */
export function describePreviousLife(prev: LifeRecord | null, now = Date.now(), pid = process.pid): string | null {
  if (!prev || prev.pid === pid) return null;
  if (prev.cleanExit) {
    return `[lifecycle] previous gateway pid=${prev.pid} exited cleanly (${prev.cleanExit.why}, code ${prev.cleanExit.code}) at ${new Date(prev.cleanExit.at).toISOString()}`;
  }
  const mb = (v: number | null) => (v === null ? "?" : `${v} MB`);
  return (
    `[lifecycle] previous gateway pid=${prev.pid} DIED WITHOUT A CLEAN EXIT (SIGKILL, OOM killer or power — nothing in-process could log it). ` +
    `Last alive ${new Date(prev.aliveAt).toISOString()} (${Math.round((now - prev.aliveAt) / 1000)}s before this boot, up ${Math.round((prev.aliveAt - prev.bootAt) / 60000)} min): ` +
    `gateway rss ${prev.rssMb} MB, heap ${prev.heapUsedMb}/${prev.heapLimitMb} MB · box available ${mb(prev.boxAvailableMb)}, swap free ${mb(prev.swapFreeMb)} · ${prev.liveCalls} live call(s)`
  );
}

/** systemd manager lines worth repeating about a death. Never the unit's own output. */
const SYSTEMD_DEATH_LINE = /(killed by the OOM killer|Main process exited|Failed with result|memory peak|Scheduled restart job|Out of memory|oom-kill)/i;

export function systemdDeathLines(journal: string, max = 8): string[] {
  return journal
    .split("\n")
    .filter((l) => SYSTEMD_DEATH_LINE.test(l))
    .slice(-max)
    .map((l) => l.trim().slice(0, 300));
}

/** The systemd unit this process runs in, from /proc/self/cgroup; null outside one. */
export function systemdUnit(cgroup?: string): { unit: string; user: boolean } | null {
  let text = cgroup;
  if (text === undefined) {
    try {
      text = readFileSync("/proc/self/cgroup", "utf8");
    } catch {
      return null;
    }
  }
  const m = /^[^\n]*\/([\w@.-]+\.service)\s*$/m.exec(text);
  if (!m) return null;
  return { unit: m[1], user: /\/user@\d+\.service\//.test(text) };
}

type Journal = (args: string[]) => Promise<string>;
const runJournal: Journal = (args) =>
  new Promise((resolve) => {
    execFile("journalctl", args, { timeout: 5000, maxBuffer: 512 * 1024 }, (_err, stdout) => resolve(String(stdout ?? "")));
  });

/** Ask systemd how the previous process ended, and log only its lifecycle lines. */
export async function explainFromSystemd(sinceMs: number, journal: Journal = runJournal, unit = systemdUnit()): Promise<string[]> {
  if (!unit) return [];
  const since = `@${Math.floor((sinceMs - 60_000) / 1000)}`;
  const out = await journal([...(unit.user ? ["--user"] : []), "-u", unit.unit, "--since", since, "--no-pager", "-o", "short-iso"]);
  const lines = systemdDeathLines(out);
  if (lines.length === 0) {
    console.log(`[lifecycle] systemd journal has no death record for ${unit.unit} since ${new Date(sinceMs - 60_000).toISOString()}`);
  }
  for (const l of lines) console.error(`[lifecycle] systemd: ${l}`);
  return lines;
}

// ── OOM shield ──────────────────────────────────────────────────────────────

let childOomAdj: number | null = null;

function readAdj(pid: number | "self"): number | null {
  try {
    return Number(readFileSync(`/proc/${pid}/oom_score_adj`, "utf8").trim());
  } catch {
    return null;
  }
}

/**
 * Lower this process's oom_score_adj as far as the kernel allows (an
 * unprivileged process can go down to the floor its parent was given, no
 * lower). Children then inherit the lowered value, so each spawn site hands
 * its child back to the box default with `unshieldChild`. GATEWAY_OOM_SHIELD=off skips it.
 */
export function shieldFromOom(env: NodeJS.ProcessEnv = process.env): { from: number; to: number } | null {
  if (process.platform !== "linux" || /^(off|0|false|no)$/i.test(env.GATEWAY_OOM_SHIELD ?? "")) return null;
  const from = readAdj("self");
  if (from === null || from <= 0) return null;
  for (let v = 0; v < from; v += 50) {
    try {
      writeFileSync("/proc/self/oom_score_adj", String(v));
      childOomAdj = from;
      return { from, to: v };
    } catch {
      // Below the floor: try the next step up.
    }
  }
  return null;
}

/** Put a spawned child back at the box default (raising is always allowed). No-op unless the shield is on. */
export function unshieldChild(pid: number | undefined): void {
  if (childOomAdj === null || !pid) return;
  try {
    writeFileSync(`/proc/${pid}/oom_score_adj`, String(childOomAdj));
  } catch {
    // The child already exited, or this is not Linux: nothing to put back.
  }
}

// ── Install ─────────────────────────────────────────────────────────────────

/**
 * Called once, right after the singleton lock: reads what the last process
 * left, starts this one's heartbeat, and marks a normal exit clean.
 */
export function installLifecycle(opts: { liveCalls: () => number; lowMemoryMb?: number }): void {
  const path = lifeRecordPath();
  const bootAt = Date.now();
  const prev = readLifeRecord(path);
  const line = describePreviousLife(prev, bootAt);
  if (line) {
    if (prev?.cleanExit) console.log(line);
    else {
      console.error(line);
      void explainFromSystemd(prev!.aliveAt).catch(() => {});
    }
  }

  const shield = shieldFromOom();
  if (shield) console.log(`[lifecycle] OOM shield: gateway oom_score_adj ${shield.from} → ${shield.to}; its child processes stay at ${shield.from}`);

  const lowMb = opts.lowMemoryMb ?? Number(process.env.GATEWAY_LOW_MEMORY_MB ?? 400);
  let lastWarnAt = 0;
  const beat = (): void => {
    try {
      const rec = snapshot(bootAt, opts.liveCalls());
      writeRecord(path, rec);
      if (rec.boxAvailableMb !== null && rec.boxAvailableMb < lowMb && rec.aliveAt - lastWarnAt >= LOW_MEMORY_WARN_EVERY_MS) {
        lastWarnAt = rec.aliveAt;
        console.warn(
          `[lifecycle] LOW MEMORY: box available ${rec.boxAvailableMb} MB, swap free ${rec.swapFreeMb ?? "?"} MB, gateway rss ${rec.rssMb} MB — the OOM killer is next`,
        );
      }
    } catch (err) {
      console.warn("[lifecycle] heartbeat write failed:", (err as Error).message);
    }
  };
  beat();
  setInterval(beat, HEARTBEAT_MS).unref();

  let lastSignal: string | null = null;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.prependListener(sig, () => {
      lastSignal = sig;
    });
  }
  process.on("exit", (code) => {
    const why = lastSignal ? `signal ${lastSignal}` : code === 0 ? "normal exit" : "process.exit";
    // writeSync: on "exit" nothing asynchronous runs again.
    try {
      writeSync(2, `[lifecycle] gateway pid=${process.pid} exiting: ${why}, code ${code}\n`);
    } catch {}
    try {
      writeRecord(path, { ...snapshot(bootAt, opts.liveCalls()), cleanExit: { at: Date.now(), code, why } });
    } catch {}
  });
}
