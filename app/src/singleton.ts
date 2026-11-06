/**
 * OS-level singleton enforcement via PID lockfile.
 *
 * Why this exists:
 * We already have a per-process global concurrency semaphore (see
 * `concurrency.ts`) that caps in-flight Claude invocations. That semaphore
 * works ONLY within a single Node process. If launchd, a manual start, or
 * a stale restart leaves two gateway processes running simultaneously,
 * each process has its own cap, neither knows about the other, and the
 * effective concurrency doubles — exactly the burst scenario the owner saw.
 *
 * Fix:
 * Before ANY polling or Claude init, atomically create `~/ai/logs/gateway.pid`
 * with `O_EXCL` (`fs.openSync(path, 'wx')`). If it already exists:
 *   - Read the PID inside.
 *   - `process.kill(pid, 0)` — signal 0 only checks existence; throws
 *     ESRCH if the PID is dead, throws EPERM if alive but not ours,
 *     succeeds if alive and ours.
 *   - If alive: log loudly, drop a marker at
 *     ~/ai/logs/gateway.SINGLETON-REJECTED, and exit(1). launchd can
 *     restart us — the existing instance will still own the lock.
 *   - If dead (stale): delete the file and retry the exclusive create
 *     exactly once. If the retry fails (another process beat us in the
 *     race), exit(1). Launchd retry will resolve it cleanly.
 *
 * On clean exit (SIGTERM, SIGINT, normal exit), we remove the lockfile.
 * Crashes skip cleanup; the next boot will detect the stale PID and reap
 * it.
 *
 * Escape hatch — AHI_GATEWAY_LOCK_PATH:
 * The one case where a second gateway is legitimate is an isolated build
 * running side by side with production for a live test. That instance sets
 * AHI_GATEWAY_LOCK_PATH to its own lockfile so it never contends for
 * production's, and (because it is a different lock) it must also move its
 * state roots — see the ISOLATED INSTANCE block in .env.example. Unset,
 * everything below is the same ~/ai/logs/gateway.pid it has always been.
 */
import { AI_ROOT } from "./ai-root.js";

import { openSync, writeSync, closeSync, readFileSync, unlinkSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { homedir } from "os";

const DEFAULT_PID_FILE = resolve(AI_ROOT, "logs", "gateway.pid");

/**
 * Absolute path of the singleton lockfile. Exported because crash-throttle.ts
 * keys its crash log off the same directory — the two are one artifact class
 * (per-process supervision state) and must travel together.
 */
export function singletonLockPath(): string {
  const override = process.env.AHI_GATEWAY_LOCK_PATH;
  return override ? resolve(override) : DEFAULT_PID_FILE;
}

const PID_FILE = singletonLockPath();
const LOG_DIR = dirname(PID_FILE);
// The rejection marker sits next to the lock it belongs to, named after it:
// "<lock minus .pid>.SINGLETON-REJECTED". At the default lock that is exactly
// the historical ~/ai/logs/gateway.SINGLETON-REJECTED; with a moved lock each
// instance gets its own marker instead of two instances overwriting one file.
const REJECTED_MARKER = `${PID_FILE.replace(/\.pid$/, "")}.SINGLETON-REJECTED`;
// Marker prose keeps the historical "~/ai/logs/gateway.pid" wording whenever
// the lock is where it has always been, so an ordinary rejection marker reads
// byte-for-byte as it did before this knob existed.
const PID_FILE_LABEL = PID_FILE === DEFAULT_PID_FILE ? "~/ai/logs/gateway.pid" : PID_FILE;

function ensureDir(): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {}
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 is a no-op existence check. Returns normally if alive
    // (either ours or owned by another user). Throws ESRCH if no such
    // process. Throws EPERM if the process exists but we can't signal
    // it (still means alive for our purposes).
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false; // ESRCH or anything else — treat as dead
  }
}

function tryAtomicCreate(): number | null {
  // 'wx' = O_WRONLY | O_CREAT | O_EXCL — fails if file exists.
  try {
    const fd = openSync(PID_FILE, "wx");
    return fd;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return null;
    throw err;
  }
}

function writePidAndClose(fd: number, pid: number): void {
  writeSync(fd, `${pid}\n`);
  closeSync(fd);
}

function writeRejectedMarker(existingPid: number, ourPid: number): void {
  try {
    writeFileSync(
      REJECTED_MARKER,
      [
        `AHI Gateway singleton rejection at ${new Date().toISOString()}`,
        ``,
        `Attempted to start (our pid=${ourPid}) but another gateway is already`,
        `running with pid=${existingPid}. Aborted to avoid double-polling and`,
        `bypassing the per-process concurrency cap.`,
        ``,
        `This file is a signal — delete it after investigating. If you want to`,
        `force a fresh start, kill pid ${existingPid} first, then remove`,
        `${PID_FILE_LABEL}.`,
        ``,
      ].join("\n"),
    );
  } catch (err) {
    console.warn(`[singleton] failed to write rejected marker:`, (err as Error).message);
  }
}

/**
 * Acquire the singleton lock or exit the process.
 * MUST be called before any polling, Claude init, or side-effectful
 * startup work.
 */
export function acquireSingletonLockOrExit(): void {
  ensureDir();
  const ourPid = process.pid;

  // First attempt: exclusive create.
  let fd = tryAtomicCreate();

  if (fd === null) {
    // Lockfile exists — figure out if owner is alive.
    let existingPid = NaN;
    try {
      const raw = readFileSync(PID_FILE, "utf-8").trim();
      existingPid = parseInt(raw, 10);
    } catch (err) {
      console.warn(`[singleton] could not read existing pid file:`, (err as Error).message);
    }

    if (isPidAlive(existingPid)) {
      console.error(
        `[singleton] ANOTHER GATEWAY RUNNING (pid=${existingPid}, ours=${ourPid}), exiting`,
      );
      writeRejectedMarker(existingPid, ourPid);
      process.exit(1);
    }

    console.warn(`[singleton] stale pid=${existingPid} reaped, claiming lock`);
    try {
      unlinkSync(PID_FILE);
    } catch (err) {
      console.error(`[singleton] failed to remove stale pid file:`, (err as Error).message);
      process.exit(1);
    }

    // Retry exactly once. If we lose the race, bail; launchd will retry.
    fd = tryAtomicCreate();
    if (fd === null) {
      console.error(`[singleton] lost race for lockfile after reaping stale pid, exiting`);
      process.exit(1);
    }
  }

  writePidAndClose(fd, ourPid);
  console.log(`[singleton] acquired lock pid=${ourPid} path=${PID_FILE}`);

  // Best-effort cleanup on clean shutdown. Crashes won't reach these —
  // next boot will reap the stale PID.
  const release = () => {
    try {
      // Only remove if we still own it (guards against a race where
      // another instance already reaped us).
      if (existsSync(PID_FILE)) {
        const raw = readFileSync(PID_FILE, "utf-8").trim();
        if (parseInt(raw, 10) === ourPid) {
          unlinkSync(PID_FILE);
        }
      }
    } catch {}
  };

  process.on("exit", release);
  process.on("SIGTERM", () => {
    release();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    release();
    process.exit(0);
  });
}
