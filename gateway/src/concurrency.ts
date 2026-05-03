/**
 * Per-bot concurrency cap for `claude -p` invocations.
 *
 * Why this exists:
 * On 2026-04-24 around 15:11 EDT, a crash-restart loop in the gateway
 * amplified a Telegram backlog into 20+ parallel `claude -p` subprocesses
 * — every pending update for every bot fired its invokeAgent in parallel
 * the moment the gateway came back up. That burned through the operator's entire
 * 5-hour Anthropic usage limit and locked him out for three hours.
 *
 * Fix:
 * Per-bot token-bucket with a HARD ceiling of MAX_CONCURRENT (default 2).
 * When the bucket is full, the message is REJECTED (not queued) and a
 * warning is logged. Rejecting instead of queueing is intentional: the
 * backlog-drain policy (see backlog-drain.ts) already bounds cold-start
 * blast radius; a soft queue here just trades one form of pileup for
 * another during a hot incident. If a bot is already saturated, drop new
 * messages on the floor — the user will resend.
 *
 * Contract:
 *   await withBotSlot("michael", async () => { ... })  // runs if cap ok
 *   → throws ConcurrencyCapError if cap hit (caller decides how to tell user)
 */

export class ConcurrencyCapError extends Error {
  constructor(
    public botName: string,
    public current: number,
    public cap: number,
  ) {
    super(
      `[concurrency] ${botName} at cap ${current}/${cap} — refusing new invocation`,
    );
    this.name = "ConcurrencyCapError";
  }
}

const DEFAULT_CAP = 2;

const inFlight = new Map<string, number>();

function cap(botName: string): number {
  const envKey = `MAX_CONCURRENT_${botName.toUpperCase()}`;
  const override = process.env[envKey];
  if (override) {
    const n = parseInt(override, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const globalOverride = process.env.MAX_CONCURRENT_PER_BOT;
  if (globalOverride) {
    const n = parseInt(globalOverride, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_CAP;
}

export function currentInFlight(botName: string): number {
  return inFlight.get(botName) ?? 0;
}

export function snapshotInFlight(): Record<string, number> {
  return Object.fromEntries(inFlight.entries());
}

/**
 * Run `fn` with a concurrency slot reserved for `botName`. Throws
 * ConcurrencyCapError immediately if the cap is already saturated — does
 * NOT wait. Callers should translate the error into a user-facing message.
 */
export async function withBotSlot<T>(
  botName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const c = cap(botName);
  const now = inFlight.get(botName) ?? 0;
  if (now >= c) {
    console.warn(
      `[concurrency] CAP HIT bot=${botName} in-flight=${now}/${c} — rejecting`,
    );
    throw new ConcurrencyCapError(botName, now, c);
  }
  inFlight.set(botName, now + 1);
  try {
    return await fn();
  } finally {
    const after = inFlight.get(botName) ?? 0;
    inFlight.set(botName, Math.max(0, after - 1));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL spawn semaphore (protection #2b — 2026-04-24 second incident)
//
// Why this exists:
// The per-bot cap above gates at the *invokeAgent callsite* level. That is
// correct for normal dispatch but fails open in two real scenarios:
//   1. Multiple gateway processes stacked (launchd crash-loop racing another
//      still-alive instance). Each process has its own in-memory counter, so
//      N instances = N × (5 bots × 2 cap) = up to 10N concurrent claudes.
//   2. A new callsite that forgets to wrap with withBotSlot — nothing in the
//      type system stops `spawn("claude", ...)` from being called directly.
//
// The fix is a HARD global semaphore RIGHT AT THE SPAWN POINT. Every single
// `claude -p` subprocess — no matter which callsite or which bot — must
// acquire a global slot before child_process.spawn is called. If no slot is
// available within a short wait, the request is rejected.
//
// This semaphore is process-scoped (not cross-process) — we can't coordinate
// across stacked launchd processes without IPC or a file lock, and doing
// either from a hot-path spawn is a separate incident waiting to happen.
// ThrottleInterval=60s in the plist is the cross-process backstop.
// ─────────────────────────────────────────────────────────────────────────────

const GLOBAL_CAP = (() => {
  const override = process.env.MAX_CONCURRENT_CLAUDE;
  if (override) {
    const n = parseInt(override, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 3;
})();

const GLOBAL_QUEUE_MAX = (() => {
  const override = process.env.MAX_CLAUDE_QUEUE;
  if (override) {
    const n = parseInt(override, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 20;
})();

// Max time a caller will wait in the queue before giving up. Kept short so
// Telegram handlers don't stack up indefinitely — if the system is saturated
// for >30s, new requests should be rejected so the user sees a clear signal.
const GLOBAL_QUEUE_WAIT_MS = 30_000;

let globalInFlight = 0;
let globalSpawnCounter = 0; // monotonic; for CLAUDE_SPAWN log correlation
const waitQueue: Array<{ resolve: () => void; reject: (e: Error) => void; enqueuedAt: number; bot: string; spawnId: number }> = [];

export class GlobalCapExceededError extends Error {
  constructor(public bot: string, public inFlight: number, public queued: number) {
    super(`[claude-spawn] GLOBAL CAP EXCEEDED bot=${bot} in-flight=${inFlight}/${GLOBAL_CAP} queue=${queued}/${GLOBAL_QUEUE_MAX} — rejecting`);
    this.name = "GlobalCapExceededError";
  }
}

export function globalSpawnSnapshot(): { inFlight: number; cap: number; queued: number; queueMax: number } {
  return { inFlight: globalInFlight, cap: GLOBAL_CAP, queued: waitQueue.length, queueMax: GLOBAL_QUEUE_MAX };
}

function tryDrainQueue(): void {
  while (waitQueue.length > 0 && globalInFlight < GLOBAL_CAP) {
    const next = waitQueue.shift()!;
    globalInFlight++;
    const waited = Date.now() - next.enqueuedAt;
    console.log(`[claude-spawn] DEQUEUE spawn#${next.spawnId} bot=${next.bot} waited=${waited}ms in-flight=${globalInFlight}/${GLOBAL_CAP}`);
    next.resolve();
  }
}

/**
 * Acquire a global spawn slot. Resolves immediately if capacity, otherwise
 * queues up to GLOBAL_QUEUE_MAX. If queue is full or wait exceeds
 * GLOBAL_QUEUE_WAIT_MS, rejects with GlobalCapExceededError.
 *
 * Returns a `release` function the caller MUST invoke in a finally block —
 * forgetting to release leaks a slot forever.
 */
export async function acquireGlobalSpawnSlot(botName: string): Promise<{ release: () => void; spawnId: number }> {
  const spawnId = ++globalSpawnCounter;

  if (globalInFlight < GLOBAL_CAP) {
    globalInFlight++;
    console.log(`[claude-spawn] ACQUIRE spawn#${spawnId} bot=${botName} in-flight=${globalInFlight}/${GLOBAL_CAP} queue=${waitQueue.length}`);
    return { release: makeRelease(spawnId, botName), spawnId };
  }

  if (waitQueue.length >= GLOBAL_QUEUE_MAX) {
    console.warn(`[claude-spawn] QUEUE OVERFLOW spawn#${spawnId} bot=${botName} in-flight=${globalInFlight}/${GLOBAL_CAP} queue=${waitQueue.length}/${GLOBAL_QUEUE_MAX} — REJECTING`);
    throw new GlobalCapExceededError(botName, globalInFlight, waitQueue.length);
  }

  console.warn(`[claude-spawn] QUEUE spawn#${spawnId} bot=${botName} in-flight=${globalInFlight}/${GLOBAL_CAP} queue-pos=${waitQueue.length + 1}/${GLOBAL_QUEUE_MAX}`);

  await new Promise<void>((resolve, reject) => {
    const entry = { resolve, reject, enqueuedAt: Date.now(), bot: botName, spawnId };
    waitQueue.push(entry);

    const timer = setTimeout(() => {
      const idx = waitQueue.indexOf(entry);
      if (idx !== -1) {
        waitQueue.splice(idx, 1);
        console.warn(`[claude-spawn] QUEUE TIMEOUT spawn#${spawnId} bot=${botName} waited=${GLOBAL_QUEUE_WAIT_MS}ms — rejecting`);
        reject(new GlobalCapExceededError(botName, globalInFlight, waitQueue.length));
      }
    }, GLOBAL_QUEUE_WAIT_MS);

    // Patch resolve/reject to clear the timer
    const origResolve = entry.resolve;
    entry.resolve = () => { clearTimeout(timer); origResolve(); };
    const origReject = entry.reject;
    entry.reject = (e) => { clearTimeout(timer); origReject(e); };
  });

  return { release: makeRelease(spawnId, botName), spawnId };
}

function makeRelease(spawnId: number, botName: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    globalInFlight = Math.max(0, globalInFlight - 1);
    console.log(`[claude-spawn] RELEASE spawn#${spawnId} bot=${botName} in-flight=${globalInFlight}/${GLOBAL_CAP} queue=${waitQueue.length}`);
    tryDrainQueue();
  };
}
