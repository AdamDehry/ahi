/* ============================================================
   floor.ts — open floor / standby, and the wake name (always-on, slice 1).

   A standing call is in one of two states (ALWAYS-ON-VOICE.md §3 layer 2):

     open floor  he is in a conversation with Michael: he addressed him in
                 the last N seconds, Michael asked a question and is waiting,
                 or a turn is running. Everything heard is addressed; no name
                 needed. Today's call is permanently here.
     standby     nothing for a while, or he said "Michael, go to sleep". Only
                 an utterance carrying the wake name EARLY opens the floor;
                 everything else is an aside: not logged, not recorded, not
                 answered. The listener sends no audio on standby except
                 while its own ear hears speech (web/src/lib/ear.ts).

   The windows: OPEN_AFTER_LINE_MS (≈20 s) after Michael's last line has
   finished PLAYING (not after it was synthesized: voice-streaming-bargein), or
   OPEN_AFTER_QUESTION_MS (≈60 s) when that line asked something; the start
   of a call gets OPEN_AT_START_MS so he can collect his thought. While a turn
   is in flight the floor does not close: a remark into running work is the
   turn gate's business (work-gate.ts), not standby's.

   The wake name is spotted on STT partials, not by a wake-word model: the
   recognizer already streams interims, and the test is "does the name appear
   within the first few words". A proper on-device wake word is slice 4.

   Pure: injectable clock, manual tick for tests. Nothing here touches a
   socket; websocket.ts drives it and mirrors every change to the listener as
   a `voice-floor` event and one `[floor]` log line.
   ============================================================ */

export type FloorState = "open" | "standby";

export type FloorReason =
  | "call-start"
  | "user-turn"
  | "agent-line"
  | "agent-question"
  | "wake-name"
  | "wake-up"
  | "sleep"
  | "idle"
  | "resumed";

export interface FloorChange {
  state: FloorState;
  reason: FloorReason;
  /** When the open floor closes on its own (ms epoch), or null while held open. */
  untilMs: number | null;
}

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Open floor after Michael's last line. */
export const openAfterLineMs = (): number => envInt("CALL_FLOOR_OPEN_MS", 20_000);
/** Open floor after a line of his that asked something — he is expected to answer. */
export const openAfterQuestionMs = (): number => envInt("CALL_FLOOR_OPEN_QUESTION_MS", 60_000);
/** Open floor when the call starts: he tapped the button, he is about to talk. */
export const openAtStartMs = (): number => envInt("CALL_FLOOR_OPEN_START_MS", 60_000);
/** Open floor after the wake name alone ("Michael." … then the request). */
export const openAfterWakeMs = (): number => envInt("CALL_FLOOR_OPEN_WAKE_MS", 20_000);

/** Standby entirely off: the floor is always open (today's behaviour). */
export function floorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CALL_FLOOR ?? "on").toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

/* ── The wake name ──────────────────────────────────────────────────────── */

/** How the recognizer spells the name — ink-2 varies on proper nouns. */
const WAKE_SPELLINGS = ["michael", "micheal", "mikael", "michal", "mikhael", "michae"];
/** The name must appear within this many words to count as a wake. */
export const WAKE_WINDOW_WORDS = 3;

export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Position (0-based word index) of the wake name within the window, or -1. */
export function wakeNameAt(text: string, window = WAKE_WINDOW_WORDS): number {
  const words = normalizeWords(text);
  const n = Math.min(words.length, window);
  for (let i = 0; i < n; i++) if (WAKE_SPELLINGS.includes(words[i])) return i;
  return -1;
}

export function hasWakeName(text: string, window = WAKE_WINDOW_WORDS): boolean {
  return wakeNameAt(text, window) >= 0;
}

/** The utterance is the name and nothing else ("Michael." / "Hey Michael"). */
export function isBareWakeName(text: string): boolean {
  const words = normalizeWords(text).filter((w) => !["hey", "hi", "yo", "ok", "okay", "um", "uh"].includes(w));
  return words.length >= 1 && words.length <= 2 && words.every((w) => WAKE_SPELLINGS.includes(w));
}

/* ── Spoken commands ────────────────────────────────────────────────────── */

export type FloorCommand = "sleep" | "wake" | "quiet";

const SLEEP = /\b(go to sleep|go sleep|sleep now|stand by|standby|go to standby|that'?s all|that is all|we'?re done|im done|i'?m done|later|goodnight|good night|go away)\b/;
const WAKE = /\b(wake up|wakeup|i'?m back|im back|you there|are you there|open up|listen up|come back)\b/;
const QUIET = /\b(go quiet|be quiet|quiet now|mute|mute yourself|stop listening|dont listen|don'?t listen)\b/;

/**
 * "Michael, go to sleep / wake up / go quiet." Only with the name in front
 * (the name is what makes a command a command and not a remark about the
 * room), and only when the rest is the command and little else.
 */
export function floorCommand(text: string): FloorCommand | null {
  const words = normalizeWords(text);
  if (words.length === 0 || words.length > 7) return null;
  const at = wakeNameAt(text);
  if (at < 0) return null;
  const rest = words.slice(at + 1).join(" ");
  if (!rest) return null;
  if (QUIET.test(rest)) return "quiet";
  if (SLEEP.test(rest)) return "sleep";
  if (WAKE.test(rest)) return "wake";
  return null;
}

/* ── The machine ────────────────────────────────────────────────────────── */

/** Michael's line asked something: the floor stays open longer for the answer. */
const ASKS = /\?\s*$|\b(want me to|should i|shall i|would you like|do you want|which one|yes or no|your call|let me know)\b[^.!]*[.?!]?\s*$/i;

export function lineAsks(line: string | null | undefined): boolean {
  if (!line) return false;
  const tail = line.trim().split(/(?<=[.!?])\s+/).filter(Boolean).pop() ?? "";
  return ASKS.test(tail);
}

export interface FloorOptions {
  now?: () => number;
  onChange: (change: FloorChange) => void;
  /** Turns in flight on this call right now — the floor never closes over work. */
  busy?: () => boolean;
  /** Test seam: no real timers; drive `tick()` by hand. */
  manual?: boolean;
  /** Standby off: the floor opens and never closes. */
  enabled?: boolean;
}

export class Floor {
  private state: FloorState = "open";
  private untilMs: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly enabled: boolean;

  constructor(private readonly opts: FloorOptions) {
    this.now = opts.now ?? Date.now;
    this.enabled = opts.enabled ?? floorEnabled();
  }

  get current(): FloorState {
    return this.state;
  }

  get isOpen(): boolean {
    return this.state === "open";
  }

  /** When the open floor is due to close, or null (held, or on standby). */
  get closesAt(): number | null {
    return this.state === "open" ? this.untilMs : null;
  }

  snapshot(): { state: FloorState; untilMs: number | null } {
    return { state: this.state, untilMs: this.closesAt };
  }

  /** The call opened: the floor is his for a while. */
  start(): void {
    this.open("call-start", openAtStartMs());
  }

  /** A resumed socket learns where things stand. */
  resumed(): FloorChange {
    return { state: this.state, reason: "resumed", untilMs: this.closesAt };
  }

  /** He addressed Michael: a turn is dispatched. Open, held while it runs. */
  userTurn(): void {
    this.open("user-turn", null);
  }

  /**
   * Michael finished a line; `line` is what he said last. `playsUntil` (ms
   * epoch): when its audio finishes playing — the window counts from then,
   * because a reply is synthesized seconds before it has been heard.
   */
  agentLine(line: string | null, playsUntil?: number | null): void {
    const asks = lineAsks(line);
    const still = playsUntil ? Math.max(0, playsUntil - this.now()) : 0;
    this.open(asks ? "agent-question" : "agent-line", (asks ? openAfterQuestionMs() : openAfterLineMs()) + still);
  }

  /** The wake name was heard (on a partial or a committed turn). */
  wake(): void {
    this.open("wake-name", openAfterWakeMs());
  }

  /** "Michael, wake up." */
  wakeUp(): void {
    this.open("wake-up", openAfterWakeMs());
  }

  /** "Michael, go to sleep" — standby now, whatever the window said. */
  sleep(): void {
    this.toStandby("sleep");
  }

  /** The clock moved (the real timer, or a test). Closes an expired floor. */
  tick(): void {
    if (this.state !== "open" || this.untilMs === null) return;
    if (this.now() < this.untilMs) return;
    if (this.opts.busy?.()) {
      // Work is running: the floor cannot close over it. Look again shortly.
      this.arm(this.untilMs + 5_000);
      return;
    }
    this.toStandby("idle");
  }

  /** The call ended. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private open(reason: FloorReason, windowMs: number | null): void {
    const was = this.state;
    const until = this.enabled && windowMs !== null ? this.now() + windowMs : null;
    this.state = "open";
    // A new window never SHORTENS an open floor: "agent-line" after a wake
    // keeps whichever closes later.
    if (was === "open" && this.untilMs !== null && until !== null && until < this.untilMs) {
      return;
    }
    this.untilMs = until;
    this.arm(until);
    if (was !== "open") this.opts.onChange({ state: "open", reason, untilMs: until });
  }

  private toStandby(reason: FloorReason): void {
    if (!this.enabled) return;
    const was = this.state;
    this.state = "standby";
    this.untilMs = null;
    this.arm(null);
    if (was !== "standby") this.opts.onChange({ state: "standby", reason, untilMs: null });
  }

  private arm(at: number | null): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (at === null || this.opts.manual) return;
    const delay = Math.max(50, at - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delay);
    this.timer.unref?.();
  }
}

/** One `[floor]` log line per state change, content-free. */
export function formatFloorChange(voiceStreamId: string, c: FloorChange, now: number = Date.now()): string {
  const win = c.untilMs !== null ? ` for ${Math.max(0, Math.round((c.untilMs - now) / 1000))}s` : "";
  return `[floor] ${voiceStreamId} ${c.state} (${c.reason})${win}`;
}
