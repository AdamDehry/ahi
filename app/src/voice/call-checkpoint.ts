/**
 * Live-call checkpoints — what is left of a call when the gateway dies under it.
 *
 * The call card is written at teardown, from memory. A gateway SIGKILLed
 * mid-call (the OOM killer) runs no teardown, so without a checkpoint the
 * whole call — possibly hours of turns — leaves no card at all, and the app's
 * resume after the restart is refused ("no such call").
 *
 * Each live call now keeps one small file under the state dir
 * (`<state>/live-calls/<id>.json`), written atomically (tmp + rename), at most
 * every THROTTLE_MS when the call changes and every ALIVE_MS regardless, so
 * `aliveAt` bounds the call's real end to within that. A normal teardown
 * deletes it. On boot, whatever is still there is a call the last process
 * never ended (websocket.ts `restoreLiveCalls`): the app may resume it, and if
 * it does not, it becomes the call's card through the owning message store.
 *
 * Holds only what a card holds (the transcript is already bounded by
 * websocket.ts), mode 0600: it is a private conversation at rest.
 */

import { mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, gatewayStateRoot } from "../multi-user-paths.js";

export interface CallCheckpoint {
  v: 1;
  voiceStreamId: string;
  bot: string;
  userId: string;
  channel: "app" | "phone";
  direction?: "inbound" | "outbound";
  startedAt: number;
  /** The last moment a gateway process knew this call was up. */
  aliveAt: number;
  turns: number;
  muted: boolean;
  resumed: number;
  gapMs: number;
  transcript: { role: "user" | "agent"; text: string }[];
  pid: number;
}

export type CallSnapshot = Omit<CallCheckpoint, "v" | "aliveAt" | "pid">;

const THROTTLE_MS = 2_000;
const ALIVE_MS = 30_000;
/** Call ids come from the client: only plain names become file names. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export function liveCallsDir(): string {
  return join(gatewayStateRoot(), "live-calls");
}

interface Entry {
  snap: () => CallSnapshot;
  lastWriteAt: number;
  timer: NodeJS.Timeout | null;
}

export class CallCheckpoints {
  private readonly live = new Map<string, Entry>();
  private aliveTimer: NodeJS.Timeout | null = null;
  private exitHooked = false;
  private warnedAt = 0;

  constructor(
    private readonly dir: () => string = liveCallsDir,
    private readonly throttleMs = THROTTLE_MS,
    private readonly aliveMs = ALIVE_MS,
  ) {}

  /** The call changed: write it now, or once the throttle allows. */
  touch(id: string, snap: () => CallSnapshot): void {
    if (!SAFE_ID.test(id)) return;
    let e = this.live.get(id);
    if (!e) {
      e = { snap, lastWriteAt: 0, timer: null };
      this.live.set(id, e);
      this.start();
    }
    e.snap = snap;
    if (e.timer) return;
    const wait = e.lastWriteAt + this.throttleMs - Date.now();
    if (wait <= 0) {
      this.write(id, e);
      return;
    }
    e.timer = setTimeout(() => {
      e!.timer = null;
      if (this.live.get(id) === e) this.write(id, e!);
    }, wait);
    e.timer.unref?.();
  }

  /** The call ended through a normal teardown: its file goes. */
  clear(id: string): void {
    const e = this.live.get(id);
    if (e?.timer) clearTimeout(e.timer);
    this.live.delete(id);
    if (this.live.size === 0 && this.aliveTimer) {
      clearInterval(this.aliveTimer);
      this.aliveTimer = null;
    }
    this.remove(id);
  }

  remove(id: string): void {
    if (!SAFE_ID.test(id)) return;
    try {
      unlinkSync(join(this.dir(), `${id}.json`));
    } catch {
      // Never written, or already gone.
    }
  }

  /** Every call this process still holds, written now (the exit path). */
  flushAll(): void {
    for (const [id, e] of this.live) {
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
      this.write(id, e);
    }
  }

  /** What a previous process left: every readable checkpoint, oldest call first. */
  list(): CallCheckpoint[] {
    let names: string[];
    try {
      names = readdirSync(this.dir()).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out: CallCheckpoint[] = [];
    for (const n of names) {
      try {
        const cp = parseCheckpoint(JSON.parse(readFileSync(join(this.dir(), n), "utf8")));
        if (cp && `${cp.voiceStreamId}.json` === n) out.push(cp);
        else console.warn(`[call-checkpoint] ignoring unreadable checkpoint ${n}`);
      } catch {
        console.warn(`[call-checkpoint] ignoring unreadable checkpoint ${n}`);
      }
    }
    return out.sort((a, b) => a.startedAt - b.startedAt);
  }

  private start(): void {
    if (!this.aliveTimer) {
      this.aliveTimer = setInterval(() => this.flushAll(), this.aliveMs);
      this.aliveTimer.unref?.();
    }
    if (!this.exitHooked) {
      this.exitHooked = true;
      // A planned restart (SIGTERM → exit) leaves every call current to the second.
      process.on("exit", () => this.flushAll());
    }
  }

  private write(id: string, e: Entry): void {
    e.lastWriteAt = Date.now();
    try {
      const dir = this.dir();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const cp: CallCheckpoint = { v: 1, ...e.snap(), aliveAt: e.lastWriteAt, pid: process.pid };
      atomicWriteFile(join(dir, `${id}.json`), JSON.stringify(cp), 0o600);
    } catch (err) {
      // A failed checkpoint must never touch the call itself; say so, at most once a minute.
      if (Date.now() - this.warnedAt > 60_000) {
        this.warnedAt = Date.now();
        console.warn(`[call-checkpoint] ${id} write failed: ${(err as Error).message}`);
      }
    }
  }
}

function parseCheckpoint(raw: unknown): CallCheckpoint | null {
  const r = raw as Partial<CallCheckpoint> | null;
  if (!r || r.v !== 1) return null;
  if (typeof r.voiceStreamId !== "string" || !SAFE_ID.test(r.voiceStreamId)) return null;
  if (typeof r.bot !== "string" || typeof r.userId !== "string") return null;
  if (r.channel !== "app" && r.channel !== "phone") return null;
  for (const k of ["startedAt", "aliveAt", "turns", "resumed", "gapMs", "pid"] as const) {
    if (typeof r[k] !== "number" || !Number.isFinite(r[k])) return null;
  }
  if (!Array.isArray(r.transcript)) return null;
  const transcript = r.transcript
    .filter((l) => l && (l.role === "user" || l.role === "agent") && typeof l.text === "string")
    .map((l) => ({ role: l.role, text: l.text }));
  return {
    v: 1,
    voiceStreamId: r.voiceStreamId,
    bot: r.bot,
    userId: r.userId,
    channel: r.channel,
    ...(r.direction === "inbound" || r.direction === "outbound" ? { direction: r.direction } : {}),
    startedAt: r.startedAt!,
    aliveAt: r.aliveAt!,
    turns: r.turns!,
    muted: r.muted === true,
    resumed: r.resumed!,
    gapMs: r.gapMs!,
    transcript,
    pid: r.pid!,
  };
}
