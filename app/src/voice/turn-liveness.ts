/* ============================================================
   turn-liveness.ts — "I am still working" for a call's listener.

   A long turn is mostly silent. The agent speaks a line, then runs tools for
   minutes: no text, no audio, nothing on the wire except the mic going up.
   The call screen could not tell that from a dead reply, and its watchdog
   ended the call 45 s into honest work (voice-call-drop, 2026-10-15). Liveness
   now means "the connection and the turn are alive", not "someone is talking":

     - while a turn is in flight the call gets one `voice-working` event every
       HEARTBEAT_MS — content-free: how long the turn has run, how long since
       the listener last heard or saw anything, how many tool calls so far;
     - the client's watchdog counts those as life; a turn whose heartbeat
       stops — the gateway died, or the socket did — still ends honestly;
     - after a generous stretch of silence the turn says ONE calm line, then
       another only after a longer interval, and never more than a few per
       turn. Quiet by default; the screen carries the state between lines.

   One registry for the gateway, keyed by call, so the call-end log line can
   say whether a turn was in flight when the call ended.
   ============================================================ */

export type LivenessSignal = "text" | "audio" | "tool" | "work";

export interface WorkingTurnOptions {
  voiceStreamId: string;
  bot: string;
  /** A control event toward the listener (the call's transport). */
  send: (msg: Record<string, unknown>) => void;
  /**
   * Speak one short line mid-turn. Absent (the degraded path, no live voice)
   * means no spoken check-in: the heartbeat still flows.
   */
  say?: ((text: string) => void) | null;
  now?: () => number;
  /** Test seam: when given, no real interval is armed and `tick()` is driven by hand. */
  manual?: boolean;
}

export interface WorkingTurn {
  /**
   * The listener just got something they can perceive (or a tool call
   * started). `work` carries the work line's text, kept as "the last thing
   * it was doing" for a status answer (work-gate.ts).
   */
  note(kind: LivenessSignal, text?: string): void;
  /** The beat's numbers right now, for a status answer without a model call. */
  describe(): WorkBeat;
  /** The turn is over, however it ended. Idempotent. */
  end(): void;
  /** Advance by hand (tests); the real interval calls this once a second. */
  tick(): void;
  readonly ended: boolean;
}

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** One `voice-working` per this many ms while a turn is in flight. */
export const heartbeatMs = (): number => Math.max(1000, envInt("CALL_WORKING_HEARTBEAT_MS", 10_000));
/** Silence before the first spoken check-in; 0 disables spoken check-ins. */
export const checkinSec = (): number => envInt("CALL_WORKING_CHECKIN_SEC", 120);
/** Silence between later check-ins in the same turn. */
export const checkinRepeatSec = (): number => Math.max(30, envInt("CALL_WORKING_CHECKIN_REPEAT_SEC", 180));
/** Never more than this many spoken check-ins in one turn. */
export const MAX_CHECKINS_PER_TURN = 3;

/**
 * The lines, in order. Short, calm, no promise about when it will be done —
 * a check-in that says "almost there" and is not is worse than silence.
 */
export const CHECKIN_LINES = ["Still on it.", "Still working on it.", "Still here, still working."] as const;

/** What a status answer is built from: the turn's age, its tool calls, its last work line. */
export interface WorkBeat {
  sinceMs: number;
  tools: number;
  lastWork: string | null;
}

const inFlight = new Map<string, Set<WorkingTurn>>();

/** How many turns are in flight on this call right now. */
export function turnsInFlight(voiceStreamId: string): number {
  return inFlight.get(voiceStreamId)?.size ?? 0;
}

/** The beat of the oldest turn in flight on this call, or null when idle. */
export function describeWork(voiceStreamId: string): WorkBeat | null {
  const set = inFlight.get(voiceStreamId);
  if (!set || set.size === 0) return null;
  const first = set.values().next().value as WorkingTurn | undefined;
  return first ? first.describe() : null;
}

/**
 * A turn has started generating. Returns the handle the turn feeds and ends.
 */
export function beginWorkingTurn(opts: WorkingTurnOptions): WorkingTurn {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  let lastPerceivedAt = startedAt;
  let lastBeatAt = startedAt;
  let tools = 0;
  let lastWork: string | null = null;
  let checkins = 0;
  let lastCheckinAt = 0;
  let ended = false;
  let timer: NodeJS.Timeout | null = null;

  const beat = (at: number): void => {
    lastBeatAt = at;
    opts.send({
      type: "voice-working",
      voiceStreamId: opts.voiceStreamId,
      bot: opts.bot,
      sinceMs: at - startedAt,
      quietMs: at - lastPerceivedAt,
      tools,
    });
  };

  const handle: WorkingTurn = {
    get ended() {
      return ended;
    },
    note(kind, text) {
      if (ended) return;
      if (kind === "tool") tools++;
      else if (kind === "work") {
        const t = text?.trim();
        if (t) lastWork = t.slice(0, 200);
        lastPerceivedAt = now();
      } else lastPerceivedAt = now();
    },
    describe() {
      return { sinceMs: now() - startedAt, tools, lastWork };
    },
    tick() {
      if (ended) return;
      const at = now();
      if (at - lastBeatAt >= heartbeatMs()) beat(at);
      const first = checkinSec();
      if (!opts.say || first <= 0 || checkins >= MAX_CHECKINS_PER_TURN) return;
      const quietSec = (at - lastPerceivedAt) / 1000;
      const due = checkins === 0 ? quietSec >= first : quietSec >= checkinRepeatSec() && (at - lastCheckinAt) / 1000 >= checkinRepeatSec();
      if (!due) return;
      const line = CHECKIN_LINES[Math.min(checkins, CHECKIN_LINES.length - 1)];
      checkins++;
      lastCheckinAt = at;
      // The line is itself something the listener perceives.
      lastPerceivedAt = at;
      console.log(`[voice-working] ${opts.voiceStreamId} check-in ${checkins} after ${Math.round(quietSec)}s quiet (turn ${Math.round((at - startedAt) / 1000)}s, ${tools} tool call(s))`);
      try {
        opts.say(line);
      } catch (err) {
        console.warn(`[voice-working] ${opts.voiceStreamId} check-in failed: ${(err as Error).message}`);
      }
    },
    end() {
      if (ended) return;
      ended = true;
      if (timer) clearInterval(timer);
      timer = null;
      const set = inFlight.get(opts.voiceStreamId);
      set?.delete(handle);
      if (set && set.size === 0) inFlight.delete(opts.voiceStreamId);
    },
  };

  let set = inFlight.get(opts.voiceStreamId);
  if (!set) {
    set = new Set();
    inFlight.set(opts.voiceStreamId, set);
  }
  set.add(handle);

  // The first beat goes out at once: the screen learns the turn is alive
  // before it has had time to wonder.
  beat(startedAt);
  if (!opts.manual) {
    timer = setInterval(() => handle.tick(), 1000);
    timer.unref?.();
  }
  return handle;
}
