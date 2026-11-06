import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/* ============================================================
   loop-watch.ts — is the gateway itself stalling? (voice-speed step 0, 10/27)

   Calls drop when a third party's socket into this gateway breaks
   (voice-root-cause REPORT §1). One open candidate is the gateway itself: a
   stalled event loop (GC, CPU, swap on a busy 2-core box at 9 AM) misses the
   other side's deadlines and looks exactly like a network break. This
   measures it, always on, for the price of one native histogram:

     · every second, the worst event-loop delay of that second is kept
       (a ring of the last hour);
     · a second whose worst delay is at least LOOP_STALL_LOG_MS (250 ms)
       writes one line: `[loop] <iso> stall max=<ms>ms`;
     · `recentMaxMs(n)` — the worst of the last n seconds — rides every door
       close line, and /health carries a summary.

   Measuring only. Nothing here changes what a call does.
   ============================================================ */

const RING_SECONDS = 3_600;

export interface LoopWatchOptions {
  /** A second this bad or worse is logged (ms). */
  stallMs?: number;
  log?: (line: string) => void;
  now?: () => number;
  /** Test seam: the histogram (its max in ns, then reset). */
  histogram?: Pick<IntervalHistogram, "max" | "reset" | "enable" | "disable">;
}

export function loopStallMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LOOP_STALL_LOG_MS);
  return Number.isFinite(n) && n > 0 ? n : 250;
}

export class LoopWatch {
  private readonly h: Pick<IntervalHistogram, "max" | "reset" | "enable" | "disable">;
  private readonly stallMs: number;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  /** Worst delay per second, newest last (ms). */
  private readonly ring: number[] = [];
  /** When each second in the ring was closed. */
  private readonly at: number[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: LoopWatchOptions = {}) {
    this.h = opts.histogram ?? monitorEventLoopDelay({ resolution: 20 });
    this.stallMs = opts.stallMs ?? loopStallMs();
    this.log = opts.log ?? ((l) => console.log(l));
    this.now = opts.now ?? Date.now;
  }

  start(): this {
    if (this.timer) return this;
    this.h.enable();
    this.timer = setInterval(() => this.tick(), 1_000);
    this.timer.unref?.();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.h.disable();
  }

  /** Close one second: keep its worst delay, log it if it was a stall. Public for tests. */
  tick(): void {
    // The histogram's max is in nanoseconds and includes the sampling resolution.
    const maxMs = Math.round(this.h.max / 1e6);
    this.h.reset();
    const t = this.now();
    this.ring.push(maxMs);
    this.at.push(t);
    if (this.ring.length > RING_SECONDS) {
      this.ring.shift();
      this.at.shift();
    }
    if (maxMs >= this.stallMs) this.log(`[loop] ${new Date(t).toISOString()} stall max=${maxMs}ms`);
  }

  /** The worst delay over the last `seconds` (ms), 0 before any second closed. */
  recentMaxMs(seconds: number): number {
    const since = this.now() - seconds * 1_000;
    // The second still open counts too: a close right after a stall must see it.
    let worst = Math.round(this.h.max / 1e6);
    for (let i = this.ring.length - 1; i >= 0 && this.at[i] >= since; i--) worst = Math.max(worst, this.ring[i]);
    return worst;
  }

  /** Seconds at or over the stall line within the last `seconds`. */
  stallsWithin(seconds: number): number {
    const since = this.now() - seconds * 1_000;
    let n = 0;
    for (let i = this.ring.length - 1; i >= 0 && this.at[i] >= since; i--) if (this.ring[i] >= this.stallMs) n++;
    return n;
  }

  /** For /health. */
  summary(): { maxMs10s: number; maxMs60s: number; maxMs1h: number; stalls1h: number; stallMs: number } {
    return {
      maxMs10s: this.recentMaxMs(10),
      maxMs60s: this.recentMaxMs(60),
      maxMs1h: this.recentMaxMs(RING_SECONDS),
      stalls1h: this.stallsWithin(RING_SECONDS),
      stallMs: this.stallMs,
    };
  }
}

/** The gateway's one watch (started in index.ts). Null until started — door lines then say `loop=?`. */
let shared: LoopWatch | null = null;

export function startLoopWatch(opts?: LoopWatchOptions): LoopWatch {
  shared ??= new LoopWatch(opts).start();
  return shared;
}

export function loopWatch(): LoopWatch | null {
  return shared;
}

/** `loop10s=<ms>` for a door line: the worst loop delay in the 10 s before it. */
export function loopNote(): string {
  return `loop10s=${shared ? `${shared.recentMaxMs(10)}ms` : "?"}`;
}

/**
 * One line per door closed under a call (voice-speed step 0): which door,
 * the close code and reason, how long since the other side last sent
 * anything, what we still had queued to send, and the worst event-loop delay
 * in the ten seconds before. Timestamped: the gateway log has no clock.
 */
export function doorCloseLine(door: "app" | "phone" | "eleven", voiceStreamId: string, code: number, reason: string, lastInAt: number, bufferedBytes: number, now = Date.now()): string {
  const why = reason.replace(/[^\w .:-]+/g, " ").trim().slice(0, 60);
  return (
    `[door] ${new Date(now).toISOString()} ${voiceStreamId} ${door} closed code=${code}${why ? ` reason="${why}"` : ""}` +
    ` last-in=${lastInAt ? `${now - lastInAt}ms` : "never"} queued=${bufferedBytes}B ${loopNote()}`
  );
}
