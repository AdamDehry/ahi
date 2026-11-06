import { estimateImageTokens, parseScreenFrame, type ScreenFrame } from "./screen-frame.js";

/* ============================================================
   screen-watch.ts — Michael watches while the owner points (10/30).

   Before this, a call turn carried ONE frame: the latest the app had sent,
   often seconds stale by the time he finished talking. Whatever he pointed
   at while saying "this one here" was gone. Now the call keeps a short
   rolling window of frames and a timeline of his words, and a turn gets a
   small ordered set of the frames that were on screen while he spoke, each
   aligned to the words he said over it — the Codex / ChatGPT screen-share
   shape. Two modes:

   ALWAYS-ON (default). Every turn while sharing: frames from just before his
   first word to his last, near-duplicates dropped, capped (CALL_SCREEN_MAX_
   FRAMES, default 5). A still screen is one frame, exactly as before.

   RECORD. "Watch this" / "start recording" (or the REC button) starts a
   recording; the app shows a red dot and a timer; Michael says nothing
   while it runs. "Stop recording" (or the button) ends it, and ONE turn
   reviews the whole clip — up to CALL_SCREEN_RECORD_FRAMES frames (default
   16), aligned to everything he said — and acts on it.

   Word times. The recognizer gives no word timestamps; its live partials
   arrive as he talks, so each new word is stamped when it first appears in
   a partial, less a fixed recognizer lag (CALL_SCREEN_WORD_LAG_MS, 350).
   With no partials (a degraded recognizer) the final words are spread
   evenly over the utterance.

   PRIVACY is unchanged from screen-frame.ts: frames live in memory only, on
   the call, and go with it; nothing here writes anywhere. A recording is
   dropped the moment the call ends or sharing stops without a review.
   ============================================================ */

export interface WatchFrame extends ScreenFrame {
  seq: number;
  /** Fraction (0..1) of the screen that changed since the previous frame the app sent. Null from an older app. */
  change: number | null;
  /** Where it changed, normalized [x0, y0, x1, y1], or null. */
  region: [number, number, number, number] | null;
  /** Why the app sent it: first | tick | change | big | heartbeat. */
  why: string;
  /** Coarse grayscale signature (hex, one digit per cell) for de-duplication. */
  sig: string | null;
}

export interface TimedWord {
  word: string;
  /** ms epoch he said it (estimated). */
  at: number;
}

export type ShareSurface = "monitor" | "window" | "browser" | "unknown";

export interface WatchPick {
  frames: WatchFrame[];
  /** The text the model reads with the frames: what he said, by frame. */
  note: string;
  /** Estimated input tokens for the frames. */
  tokens: number;
  /** Estimated dollars for those tokens at the main model's input price. */
  usd: number;
  /** Frames that were in the window before de-duplication and the cap. */
  considered: number;
  /** Seconds the window covered. */
  spanSec: number;
}

export interface WatchOptions {
  /** How long frames are kept outside a recording. */
  keepMs?: number;
  /** Bytes held outside a recording. */
  maxBytes?: number;
  /** Longest recording (0 = none, the default); past it the recording stops and is reviewed. */
  recordMaxMs?: number;
  /** Bytes held for one recording; past it the least-changed middle frames are thinned. */
  recordMaxBytes?: number;
  wordLagMs?: number;
}

/* ── Knobs ─────────────────────────────────────────────────────────────── */

const num = (v: string | undefined, dflt: number, lo: number, hi: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** CALL_SCREEN_WATCH=off: the old one-frame behavior (rollback). */
export function screenWatchOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CALL_SCREEN_WATCH ?? "").toLowerCase() !== "off";
}
/** CALL_SCREEN_RECORD=off: no record mode (voice phrases pass through as ordinary words; no button). */
export function screenRecordOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return screenWatchOn(env) && (env.CALL_SCREEN_RECORD ?? "").toLowerCase() !== "off";
}
export function maxTurnFrames(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(num(env.CALL_SCREEN_MAX_FRAMES, 5, 1, 12));
}
export function maxRecordFrames(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(num(env.CALL_SCREEN_RECORD_FRAMES, 16, 2, 40));
}
/**
 * Longest recording, or 0 = no limit (the default): a recording runs until
 * HE stops it. The old 300 s default stopped it by itself, waited for his sentence, then fired the review —
 * so mid-walkthrough the recording "stopped when his words were sent" and Michael cut in. Memory is
 * already bounded without a clock (recordMaxBytes thins the middle frames). Set the env to opt back in.
 */
export function recordMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = env.CALL_SCREEN_RECORD_MAX_SEC;
  if (v === undefined || v.trim() === "" || Number(v) === 0) return 0;
  return Math.round(num(v, 0, 10, 4 * 3600) * 1000);
}
/** A stop that lands mid-sentence waits for him to finish talking; this is only the backstop for a recognizer that never says he stopped. */
export function stopWaitMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(num(env.CALL_SCREEN_STOP_WAIT_MAX_MS, 60_000, 1_000, 300_000));
}
/** The main model's input price, dollars per million tokens (Opus 5.5 list: $4). */
export function usdPerMTok(env: NodeJS.ProcessEnv = process.env): number {
  return num(env.CALL_SCREEN_USD_PER_MTOK, 4, 0, 1000);
}
export function wordLagMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(num(env.CALL_SCREEN_WORD_LAG_MS, 350, 0, 3000));
}

/* ── Parsing what the app sends ────────────────────────────────────────── */

const SIG_RE = /^[0-9a-f]{16,256}$/;

/**
 * Validate an app-sent frame and its watch metadata. The frame itself goes
 * through parseScreenFrame (same caps); the extras are optional, so an older
 * app's frames still work. `ageMs` (grab → send) moves the capture time back.
 */
export function parseWatchFrame(msg: Record<string, unknown>, seq: number, now = Date.now()): WatchFrame | null {
  const base = parseScreenFrame(msg, now);
  if (!base) return null;
  const age = Number(msg.ageMs);
  const capturedAt = Number.isFinite(age) ? now - Math.min(3000, Math.max(0, age)) : now;
  const ch = Number(msg.change);
  const change = msg.change !== undefined && Number.isFinite(ch) ? Math.min(1, Math.max(0, ch)) : null;
  let region: WatchFrame["region"] = null;
  if (Array.isArray(msg.region) && msg.region.length === 4 && msg.region.every((v) => typeof v === "number" && Number.isFinite(v))) {
    const [a, b, c, d] = (msg.region as number[]).map((v) => Math.min(1, Math.max(0, v)));
    if (c > a && d > b) region = [a, b, c, d];
  }
  const why = typeof msg.why === "string" && /^[a-z]{1,12}$/.test(msg.why) ? msg.why : "change";
  const sig = typeof msg.sig === "string" && SIG_RE.test(msg.sig) ? msg.sig : null;
  return { ...base, capturedAt, seq, change, region, why, sig };
}

export function parseSurface(v: unknown): ShareSurface {
  return v === "monitor" || v === "window" || v === "browser" ? v : "unknown";
}

/* ── Record-mode phrases ───────────────────────────────────────────────── */

const LEAD = String.raw`^(?:\s*(?:hey|ok|okay|so|alright|all right|right|now|and)[,.!]?\s+)*(?:(?:michael|mike)[,.!]?\s+)?(?:(?:can you|could you|please|i want you to|i'd like you to)\s+)?`;
const START = String.raw`(?:start (?:recording|watching)|(?:watch|record) (?:this|my screen|what i(?:'m| am)? (?:do|doing))|begin recording)`;
const STOP = String.raw`(?:(?:stop|end|finish) (?:the )?(?:recording|watching)|(?:i'?m |we'?re )?done recording|that'?s the (?:end of the )?recording)`;
const CANCEL = String.raw`(?:cancel|scrap|discard|forget) (?:the |that )?recording`;

const START_AT_HEAD = new RegExp(LEAD + START + String.raw`\b[,.!?]?`, "i");
const START_AT_TAIL = new RegExp(String.raw`(?:^|[,.!?]\s*|\s(?:so|and|now|okay|ok)\s+)` + START + String.raw`[.!?]*\s*$`, "i");
const STOP_ANY = new RegExp(String.raw`\b` + STOP + String.raw`\b[,.!?]?`, "gi");
const CANCEL_ANY = new RegExp(String.raw`\b` + CANCEL + String.raw`\b`, "gi");
/**
 * A command is its own clause: between the last clause break and the phrase
 * there may be only these (Codex r1/r2). "Don't ever stop recording", "I usually
 * stop recording after this" and "the stop recording button" are mentions.
 */
const COMMAND_LEAD = /^(?:\s*(?:ok|okay|alright|all right|right|so|and|now|then|actually|good|great|cool|thanks|thank you|michael|mike|please|you can|go ahead and|let'?s|lets|just)\b[,.!]?)*\s*$/i;
const NOT_A_COMMAND_AFTER = /^\s*(?:button|icon|link|option|thing|feature|mode)\b/i;

/** Walking back over clauses of only address/filler words, is the first real clause a bare negation? */
function negatedAcrossClauses(text: string): boolean {
  const clauses = text.split(/[,.!?;:]/);
  for (let i = clauses.length - 1; i >= 0; i--) {
    const c = clauses[i];
    if (/^\s*$/.test(c)) continue;
    if (/^\s*(?:don'?t|do not|never)\s*$/i.test(c)) return true;
    if (COMMAND_LEAD.test(c)) continue;
    return false;
  }
  return false;
}

/** The last match of `re` in `text` that reads as a command, or null. */
function lastCommand(re: RegExp, text: string): RegExpExecArray | null {
  let last: RegExpExecArray | null = null;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(0, m.index);
    const cut = Math.max(before.lastIndexOf(","), before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf(";"), before.lastIndexOf(":")) + 1;
    const clause = before.slice(cut);
    const after = text.slice(m.index + m[0].length);
    if (!COMMAND_LEAD.test(clause) || NOT_A_COMMAND_AFTER.test(after)) continue;
    // "Don't, cancel the recording", "Don't, Michael, cancel the recording": a bare negation in an
    // earlier clause still negates it when only address or filler words come between (Codex r3/r4).
    // ("No, stop recording" and "Wait, stop recording" are commands; only don't / do not / never negate.)
    if (negatedAcrossClauses(before.slice(0, cut))) continue;
    last = m;
  }
  return last;
}

/**
 * Does this utterance start a recording? Only as its own clause — at the head
 * ("Michael, watch this. So I click…") or as the closing clause ("…let me show
 * you, watch this.") — so "I need to watch this movie" does not.
 * Returns what came before and after the phrase (both are part of the clip).
 */
export function matchRecordStart(text: string): { before: string; after: string } | null {
  const t = text.trim();
  const head = START_AT_HEAD.exec(t);
  if (head) {
    const after = t.slice(head[0].length).trim();
    // "watch this movie" at the head: the phrase must end its clause.
    if (after && !/[,.!?]$/.test(head[0]) && !/^(?:so|and|okay|ok|now|i|here|look|this|first)\b/i.test(after)) return null;
    return { before: "", after };
  }
  const tail = START_AT_TAIL.exec(t);
  if (tail) return { before: t.slice(0, tail.index).replace(/[\s,]+$/, "").trim(), after: "" };
  return null;
}

/**
 * Inside a recording: does this utterance stop it? The LAST stop phrase wins;
 * what came before it belongs to the clip, what came after is his ask.
 */
export function matchRecordStop(text: string): { before: string; after: string } | null {
  const last = lastCommand(STOP_ANY, text);
  if (!last) return null;
  const before = text.slice(0, last.index).replace(/[\s,]*(?:ok|okay|alright|so|and|michael|now)?[\s,]*$/i, "").trim();
  const after = text.slice(last.index + last[0].length).replace(/^[\s,.!?]*(?:and|so|then|now)?[\s,]+/i, "").trim();
  return { before, after };
}

export function matchRecordCancel(text: string): boolean {
  return lastCommand(CANCEL_ANY, text) !== null;
}

/* ── The word timeline ─────────────────────────────────────────────────── */

const tokens = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);

/** Spread `n` words evenly over [from, to]. */
function spread(words: string[], from: number, to: number): TimedWord[] {
  const span = Math.max(0, to - from);
  return words.map((word, i) => ({ word, at: Math.round(from + (words.length > 1 ? (span * i) / (words.length - 1) : 0)) }));
}

/* ── Picking frames ────────────────────────────────────────────────────── */

/** Mean absolute per-cell difference between two signatures, in signature levels (0..15). */
export function sigDistance(a: string, b: string): number {
  if (a.length !== b.length || !a.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(parseInt(a[i], 16) - parseInt(b[i], 16));
  return sum / a.length;
}

const DEICTIC = /^(?:this|that|these|those|here|there|look|see|click|clicking|clicked|pointing|point|mouse|cursor)$/i;

/**
 * Near-identical to the one kept before it: the same picture (signature within
 * a level) AND the app saw nothing change (a heartbeat). The app sends any
 * other frame only because something changed — a pointer moving onto a row is
 * a few cells of a 48x27 grid, far below what the coarse signature sees — so
 * every such frame is kept (Codex r1: a change threshold dropped pointer moves).
 */
function isDuplicate(f: WatchFrame, kept: WatchFrame): boolean {
  if (!f.sig || !kept.sig) return false;
  if (sigDistance(f.sig, kept.sig) > 0.6) return false;
  return f.why === "heartbeat" || f.change === 0;
}

/**
 * Choose at most `cap` frames from `list` (oldest first; the first is what was
 * on screen when he began). Keeps the first and last, then the frames on
 * screen as he said a pointing word ("this", "here", "click"…), then large
 * changes, spread over the window.
 */
export function chooseFrames(list: WatchFrame[], cap: number, words: TimedWord[]): WatchFrame[] {
  const deduped: WatchFrame[] = [];
  for (const f of list) {
    const prev = deduped[deduped.length - 1];
    if (prev && isDuplicate(f, prev)) continue;
    deduped.push(f);
  }
  if (deduped.length <= cap) return deduped;
  if (cap <= 1) return [deduped[deduped.length - 1]];

  const onScreenAt = (t: number): number => {
    let idx = 0;
    for (let i = 0; i < deduped.length; i++) if (deduped[i].capturedAt <= t) idx = i;
    return idx;
  };
  const score = new Array<number>(deduped.length).fill(0);
  for (const w of words) if (DEICTIC.test(w.word.replace(/[^\p{L}']/gu, ""))) score[onScreenAt(w.at)] += 2;
  deduped.forEach((f, i) => {
    if ((f.change ?? 0) >= 0.08) score[i] += 1;
    if (f.why === "big") score[i] += 0.5;
  });

  const chosen = new Set<number>([0, deduped.length - 1]);
  const t0 = deduped[0].capturedAt;
  const span = Math.max(1, deduped[deduped.length - 1].capturedAt - t0);
  while (chosen.size < cap) {
    let best = -1;
    let bestVal = -Infinity;
    for (let i = 0; i < deduped.length; i++) {
      if (chosen.has(i)) continue;
      let gap = Infinity;
      for (const j of chosen) gap = Math.min(gap, Math.abs(deduped[i].capturedAt - deduped[j].capturedAt));
      const val = score[i] + (2 * gap) / span;
      if (val > bestVal) {
        bestVal = val;
        best = i;
      }
    }
    if (best < 0) break;
    chosen.add(best);
  }
  return [...chosen].sort((a, b) => a - b).map((i) => deduped[i]);
}

/* ── The note the model reads ──────────────────────────────────────────── */

const pct = (v: number): number => Math.round(v * 100);

function describeRegion(r: WatchFrame["region"]): string {
  if (!r) return "";
  return `changed area x ${pct(r[0])}–${pct(r[2])}%, y ${pct(r[1])}–${pct(r[3])}%`;
}

function pointerLine(surface: ShareSurface, his: string): string {
  if (surface === "monitor" || surface === "window")
    return `${his[0].toUpperCase()}${his.slice(1)} mouse pointer is drawn in the frames.`;
  if (surface === "browser")
    return `A shared browser tab never shows ${his} mouse pointer, so where each frame changed is given instead (a hover, a click, typing or scrolling shows up there).`;
  return `${his[0].toUpperCase()}${his.slice(1)} mouse pointer shows only if the browser draws it; where each frame changed is given too.`;
}

/**
 * The per-frame label (rides right after its image) and the one note listing
 * what he said over each frame. Text only — no pixels.
 */
export function buildNote(
  frames: WatchFrame[],
  words: TimedWord[],
  opts: { userName?: string; surface: ShareSurface; kind: "turn" | "recording"; considered: number; from: number; durationSec?: number },
): { labels: string[]; note: string } {
  const user = opts.userName ?? "the owner";
  const his = user === "the owner" ? "his" : "their";
  const he = user === "the owner" ? "he" : "they";
  const n = frames.length;
  const rel = (t: number): string => {
    const s = (t - opts.from) / 1000;
    return s <= 0 ? "at the start" : `+${s.toFixed(1)}s`;
  };
  const labels = frames.map((f, i) => {
    const bits = [`frame ${i + 1} of ${n}`, rel(f.capturedAt)];
    const where = describeRegion(f.region);
    if (i > 0 && where) bits.push(where);
    return `${user}'s screen, ${bits.join(", ")}`;
  });

  // His words, grouped by the frame on screen as he said each one.
  const groups: string[][] = frames.map(() => []);
  for (const w of words) {
    let idx = 0;
    for (let i = 0; i < n; i++) if (frames[i].capturedAt <= w.at) idx = i;
    groups[idx].push(w.word);
  }
  const lines: string[] = [];
  groups.forEach((g, i) => {
    if (g.length) lines.push(`frame ${i + 1}: "${g.join(" ")}"`);
  });

  const head =
    opts.kind === "recording"
      ? `[${user} recorded ${his} screen for you (${Math.round(opts.durationSec ?? 0)}s) and asked you to watch quietly; it has just stopped. ` +
        `The ${n} frame${n === 1 ? "" : "s"} above ${n === 1 ? "is" : "are"} the recording, oldest first` +
        (opts.considered > n ? ` (picked from ${opts.considered}: the moments ${he} pointed at, big changes, and spread over the clip)` : "") +
        ". Review the whole recording against what " + he + " said, then answer or act on it."
      : `[${user} is sharing ${his} screen on this call. The ${n} frames above are what it showed while ${he} spoke, oldest first` +
        (opts.considered > n ? ` (picked from ${opts.considered})` : "") +
        ".";
  const body = lines.length ? ` What ${he} said, by the frame on screen at the time:\n${lines.join("\n")}\n` : " ";
  return {
    labels,
    note: `${head} ${pointerLine(opts.surface, his)}${body}You can only look, not click.]`,
  };
}

/* ── The per-call watcher ──────────────────────────────────────────────── */

interface Recording {
  startedAt: number;
  how: "voice" | "button";
}

export class ScreenWatch {
  private frames: WatchFrame[] = [];
  private bytes = 0;
  private seq = 0;
  /** Finalized words not yet taken by a turn. */
  private timeline: TimedWord[] = [];
  /** The open utterance: its words so far and when each first appeared. */
  private utt: { words: string[]; times: number[]; startedAt: number } | null = null;
  /** The last turn's window and words, for a turn that merges into it. */
  private prev: { from: number; words: TimedWord[] } | null = null;
  private rec: Recording | null = null;
  surface: ShareSurface = "unknown";
  readonly since = Date.now();
  received = 0;

  private readonly keepMs: number;
  private readonly maxBytes: number;
  private readonly recordMaxBytes: number;
  readonly recordMaxMs: number;
  private readonly lagMs: number;

  constructor(opts: WatchOptions = {}) {
    this.keepMs = opts.keepMs ?? 90_000;
    this.maxBytes = opts.maxBytes ?? 40_000_000;
    this.recordMaxMs = opts.recordMaxMs ?? recordMaxMs();
    this.recordMaxBytes = opts.recordMaxBytes ?? 96_000_000;
    this.lagMs = opts.wordLagMs ?? wordLagMs();
  }

  /* frames */

  /** Parse and keep one app frame. Returns it, or null if off-shape. */
  addFrame(msg: Record<string, unknown>, now = Date.now()): WatchFrame | null {
    const f = parseWatchFrame(msg, ++this.seq, now);
    if (!f) return null;
    this.received++;
    // Out-of-order arrival (a slow encode) keeps the list sorted.
    let i = this.frames.length;
    while (i > 0 && this.frames[i - 1].capturedAt > f.capturedAt) i--;
    this.frames.splice(i, 0, f);
    this.bytes += f.data.length;
    this.prune(now);
    return f;
  }

  latest(): WatchFrame | null {
    return this.frames[this.frames.length - 1] ?? null;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  get heldBytes(): number {
    return this.bytes;
  }

  private drop(i: number): void {
    this.bytes -= this.frames[i].data.length;
    this.frames.splice(i, 1);
  }

  private prune(now: number): void {
    if (this.rec) {
      // Everything since the frame on screen at the start is the clip.
      const start = this.rec.startedAt;
      let base = 0;
      for (let i = 0; i < this.frames.length; i++) if (this.frames[i].capturedAt <= start) base = i;
      while (base > 0) {
        this.drop(0);
        base--;
      }
      // Over budget: thin the least-changed frames from the middle; the first and last stay.
      while (this.bytes > this.recordMaxBytes && this.frames.length > 2) {
        let worst = 1;
        for (let i = 2; i < this.frames.length - 1; i++) if ((this.frames[i].change ?? 1) < (this.frames[worst].change ?? 1)) worst = i;
        this.drop(worst);
      }
      return;
    }
    // Outside a recording: the last keepMs, and always at least the latest frame.
    while (this.frames.length > 1 && (now - this.frames[0].capturedAt > this.keepMs || this.bytes > this.maxBytes)) this.drop(0);
  }

  /* words */

  speechStart(now = Date.now()): void {
    if (!this.utt) this.utt = { words: [], times: [], startedAt: now };
  }

  /** A cumulative partial for the open utterance. New words are stamped now, less the recognizer lag. */
  partial(text: string, now = Date.now()): void {
    const words = tokens(text);
    if (!this.utt) this.utt = { words: [], times: [], startedAt: now };
    const u = this.utt;
    const at = now - this.lagMs;
    const times = words.map((_, i) => (i < u.times.length ? u.times[i] : Math.max(at, u.times[u.times.length - 1] ?? at)));
    u.words = words;
    u.times = times;
  }

  /** The utterance closed with this final text. Its words join the timeline. */
  final(text: string, now = Date.now(), audioSec?: number): void {
    const words = tokens(text);
    const u = this.utt;
    this.utt = null;
    if (!words.length) return;
    let timed: TimedWord[];
    if (u && u.times.length) {
      // Map the final words onto the partial's times by position, proportionally.
      const m = u.times.length;
      timed = words.map((word, i) => ({ word, at: u.times[Math.min(m - 1, Math.round(words.length > 1 ? (i * (m - 1)) / (words.length - 1) : 0))] }));
    } else {
      const from = u?.startedAt ?? now - Math.max(500, (audioSec ?? words.length * 0.35) * 1000);
      timed = spread(words, from, Math.max(from, now - this.lagMs));
    }
    this.timeline.push(...timed);
    // Bounded: a long stretch of talk no turn took (muted floor, a long recording) keeps its newest words.
    if (this.timeline.length > 4000) this.timeline.splice(0, this.timeline.length - 4000);
  }

  /**
   * The utterance still open (partials, no final yet) joins the timeline as it
   * stands. A recording stopped mid-sentence keeps what was heard of it.
   * Returns whether there was one.
   */
  closeOpen(now = Date.now()): boolean {
    const u = this.utt;
    if (!u || !u.words.length) return false;
    this.final(u.words.join(" "), now);
    return true;
  }

  /** Words heard since the last take (finalized only), for logs and tests. */
  get pendingWords(): TimedWord[] {
    return [...this.timeline];
  }

  /* always-on: one turn */

  /**
   * The frames for a turn ending now: from just before his first word (or
   * `fallbackFrom`) to now, plus the frame on screen when he began. `merge`:
   * this turn continues the last one (turn-taking merged them), so its window
   * and words start where that one's did. Null when there is no frame at all.
   */
  takeTurn(opts: { now?: number; fallbackFrom?: number | null; merge?: boolean; cap?: number; userName?: string }): WatchPick | null {
    const now = opts.now ?? Date.now();
    let words = this.timeline;
    this.timeline = [];
    let from = words[0]?.at ?? opts.fallbackFrom ?? now - 8000;
    if (opts.merge && this.prev) {
      words = [...this.prev.words, ...words];
      from = Math.min(from, this.prev.from);
    }
    this.prev = { from, words };
    return this.pick({ from: from - 1000, to: now, words, cap: opts.cap ?? maxTurnFrames(), kind: "turn", userName: opts.userName });
  }

  /* record mode */

  get recording(): { startedAt: number; how: "voice" | "button" } | null {
    return this.rec ? { startedAt: this.rec.startedAt, how: this.rec.how } : null;
  }

  /**
   * Start recording. The words of the utterance that started it (already in
   * the timeline) open the clip; frames start from what is on screen now.
   * False if already recording.
   */
  startRecording(how: "voice" | "button", now = Date.now()): boolean {
    if (this.rec) return false;
    // By voice the recording starts where the utterance that started it did: "Watch this —
    // first I open this, then I click here" commits only at its end, and the frames it
    // talked over are part of the clip (Codex r1). Bounded pre-roll.
    const from = how === "voice" && this.timeline.length ? Math.max(now - 30_000, this.timeline[0].at - 500) : now;
    this.rec = { startedAt: Math.min(now, from), how };
    if (how === "button") this.timeline = [];
    this.prev = null;
    this.prune(now);
    return true;
  }

  /** An utterance that reached no turn (an aside, a command): its words are not the next turn's. */
  discardWords(): void {
    if (!this.rec) this.timeline = [];
  }

  /** Stop and hand back the clip for one review turn. Null when not recording. */
  stopRecording(opts: { now?: number; cap?: number; userName?: string } = {}): (WatchPick & { durationSec: number; words: TimedWord[] }) | null {
    const rec = this.rec;
    if (!rec) return null;
    const now = opts.now ?? Date.now();
    this.rec = null;
    const words = this.timeline;
    this.timeline = [];
    this.prev = null;
    const durationSec = (now - rec.startedAt) / 1000;
    const pick = this.pick({ from: rec.startedAt, to: now, words, cap: opts.cap ?? maxRecordFrames(), kind: "recording", userName: opts.userName, durationSec }) ?? {
      frames: [],
      note: "",
      tokens: 0,
      usd: 0,
      considered: 0,
      spanSec: durationSec,
    };
    // Back to the rolling window.
    this.prune(now);
    return { ...pick, durationSec, words };
  }

  /** Drop the recording without a review. */
  cancelRecording(now = Date.now()): boolean {
    if (!this.rec) return false;
    this.rec = null;
    this.timeline = [];
    this.prune(now);
    return true;
  }

  /** The whole call is over or sharing stopped: everything goes. */
  clear(): void {
    this.frames = [];
    this.bytes = 0;
    this.timeline = [];
    this.utt = null;
    this.prev = null;
    this.rec = null;
  }

  private pick(o: {
    from: number;
    to: number;
    words: TimedWord[];
    cap: number;
    kind: "turn" | "recording";
    userName?: string;
    durationSec?: number;
  }): WatchPick | null {
    let base = -1;
    for (let i = 0; i < this.frames.length; i++) if (this.frames[i].capturedAt < o.from) base = i;
    const inWindow = this.frames.filter((f) => f.capturedAt >= o.from && f.capturedAt <= o.to);
    const list = base >= 0 ? [this.frames[base], ...inWindow] : inWindow;
    if (!list.length) return null;
    const frames = chooseFrames(list, o.cap, o.words);
    const { labels, note } = buildNote(frames, o.words, {
      userName: o.userName,
      surface: this.surface,
      kind: o.kind,
      considered: list.length,
      from: o.kind === "recording" ? o.from : o.from + 1000,
      durationSec: o.durationSec,
    });
    const labelled = frames.map((f, i) => ({ ...f, label: labels[i] }));
    const tokens = labelled.reduce((s, f) => s + estimateImageTokens(f.width, f.height), 0);
    return {
      frames: labelled,
      note,
      tokens,
      usd: (tokens * usdPerMTok()) / 1_000_000,
      considered: list.length,
      spanSec: Math.max(0, (o.to - Math.max(o.from, list[0].capturedAt)) / 1000),
    };
  }
}

/** One log line for what a turn carried. Counts and sizes only. */
export function formatPick(voiceStreamId: string, p: WatchPick, kind: "turn" | "recording", suffix = ""): string {
  const kb = Math.round(p.frames.reduce((s, f) => s + f.data.length, 0) / 1024);
  return (
    `[voice-screen] ${voiceStreamId} ${kind === "recording" ? "recording review" : "turn"}: ${p.frames.length} frame(s) attached of ${p.considered} ` +
    `over ${p.spanSec.toFixed(1)}s, ${kb} kB ~${p.tokens} tokens ~$${p.usd.toFixed(3)}${suffix}`
  );
}
