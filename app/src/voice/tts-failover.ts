import type { CallTtsStream, VoiceTtsStreamHandlers } from "../voice-tts-stream.js";
import type { PieceReason } from "./seam-log.js";

/* ============================================================
   tts-failover.ts — a turn whose voice fails mid-answer finishes in another
   voice instead of going quiet (B3, peer review 10/14).

   Before: when ElevenLabs' HTTP sentence failed AND its fallback socket was
   down, the answer produced no audio, or stopped after the prefix already
   rendered. The stream still reported `ready`, the turn just settled, and
   the call's provider switch only ever handled the connect at call start.

   Now the call speaks through this wrapper. The primary (ElevenLabs) reports
   a turn it cannot finish with `onFailed` — emitted after the last audio it
   will ever release for that turn, carrying the text it never spoke. The
   wrapper speaks that text, and every later piece of the turn, on the
   alternate (Cartesia, at the primary's sample rate so the listener's clock
   is unchanged):

     - order: the alternate's audio only starts after the primary's last
       frame, and its word timings are shifted by the primary audio already
       released — karaoke never knows;
     - no replay: what was already heard is not in `unspoken`;
     - two failed turns: the call speaks on the alternate from then on, so it
       stops paying the primary's timeouts;
     - if the alternate fails too, the turn ends with a `TtsVoiceLost` error
       (index.ts shows it on screen as not spoken), never a silent hang.
   ============================================================ */

/** Failed turns before the call stays on the alternate. */
const STICKY_AFTER_FAILED_TURNS = 2;

interface Turn {
  ctx: string;
  /** The primary gave up; everything from here goes to the alternate. */
  failed: boolean;
  altCtx: string | null;
  altQueue: string[];
  altStarting: boolean;
  ended: boolean;
  altDone: boolean;
  lost: boolean;
  doneSent: boolean;
  /** Primary audio already released this turn — the alternate's word shift. */
  primarySec: number;
  usedAlt: boolean;
}

export class FailoverTtsStream implements CallTtsStream {
  private handlers: VoiceTtsStreamHandlers = {};
  private turn: Turn | null = null;
  private alt: CallTtsStream | null = null;
  private altConnecting: Promise<CallTtsStream> | null = null;
  private failedTurns = 0;
  private closed = false;
  private altChars = 0;
  /** The last turn spoke on the alternate — read after the turn, so not tied to `turn`. */
  private lastUsedAlt = false;

  constructor(
    readonly primary: CallTtsStream,
    /** Builds the alternate at the primary's sample rate. Connected lazily, on first need. */
    private readonly makeAlternate: (sampleRate: number) => CallTtsStream,
    private readonly label = "",
  ) {
    primary.on({
      onAudio: (pcm, ctx) => {
        const t = this.turn;
        if (!t || ctx !== t.ctx || t.failed) return;
        t.primarySec += Math.floor(pcm.length / 2) / this.primary.sampleRate;
        this.handlers.onAudio?.(pcm, ctx);
      },
      onTimestamps: (wt, ctx) => {
        const t = this.turn;
        if (!t || ctx !== t.ctx || t.failed) return;
        this.handlers.onTimestamps?.(wt, ctx);
      },
      onDone: (ctx) => {
        const t = this.turn;
        if (!t || ctx !== t.ctx || t.failed || t.doneSent) return;
        t.doneSent = true;
        this.handlers.onDone?.(ctx);
      },
      // A primary failure that loses words always arrives as `onFailed`;
      // the error itself is only logged here, so the turn is not settled early.
      onError: (err) => console.warn(`${this.tag} primary: ${err.message}`),
      onFailed: (f) => this.onPrimaryFailed(f),
    });
  }

  get provider(): CallTtsStream["provider"] {
    return this.primary.provider;
  }

  get activeModel(): string {
    return this.primary.activeModel;
  }

  get lastTurnModels(): string[] | undefined {
    const base = this.primary.lastTurnModels ?? [this.primary.activeModel];
    return this.lastUsedAlt ? [...base.filter(Boolean), `${this.alt?.provider ?? "alternate"}(failover)`] : this.primary.lastTurnModels;
  }

  get sampleRate(): number {
    return this.primary.sampleRate;
  }

  get ready(): boolean {
    return !this.closed && (this.primary.ready || Boolean(this.sticky && this.alt?.ready));
  }

  get sticky(): boolean {
    return this.failedTurns >= STICKY_AFTER_FAILED_TURNS;
  }

  get charsSent(): number {
    return this.primary.charsSent + this.altChars;
  }

  set charsSent(n: number) {
    this.primary.charsSent = n;
    this.altChars = 0;
  }

  private get tag(): string {
    return `[tts-failover]${this.label ? ` ${this.label}` : ""}`;
  }

  on(handlers: VoiceTtsStreamHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  connect(): Promise<void> {
    return this.primary.connect();
  }

  beginTurn(): string {
    this.retireAltTurn();
    this.altChars = 0;
    this.lastUsedAlt = false;
    if (this.sticky && this.alt?.ready) {
      // The call lives on the alternate now.
      const ctx = this.alt.beginTurn();
      this.turn = this.newTurn(ctx);
      Object.assign(this.turn, { failed: true, altCtx: ctx, usedAlt: true });
      this.lastUsedAlt = true;
      return ctx;
    }
    this.turn = this.newTurn(this.primary.beginTurn());
    return this.turn.ctx;
  }

  speakPiece(text: string, why?: PieceReason): void {
    const t = this.turn;
    if (!t || t.ended) return;
    if (!t.failed) {
      this.primary.speakPiece(text, why);
      return;
    }
    if (t.lost) return;
    this.toAlt(t, text);
  }

  endTurn(): void {
    const t = this.turn;
    if (!t || t.ended) return;
    t.ended = true;
    if (!t.failed || t.altCtx !== t.ctx) this.primary.endTurn();
    if (t.failed && t.altCtx && this.alt) this.alt.endTurn();
    this.finishIfDone(t);
  }

  cancel(): void {
    const t = this.turn;
    this.turn = null;
    this.primary.cancel();
    if (t?.altCtx) this.alt?.cancel();
  }

  close(): void {
    this.closed = true;
    this.turn = null;
    this.primary.close();
    this.alt?.close();
  }

  private newTurn(ctx: string): Turn {
    return {
      ctx,
      failed: false,
      altCtx: null,
      altQueue: [],
      altStarting: false,
      ended: false,
      altDone: false,
      lost: false,
      doneSent: false,
      primarySec: 0,
      usedAlt: false,
    };
  }

  private retireAltTurn(): void {
    if (this.turn?.altCtx) this.alt?.cancel();
  }

  private onPrimaryFailed(f: { contextId: string; unspoken: string; reason: string }): void {
    const t = this.turn;
    if (!t || f.contextId !== t.ctx || t.failed) return;
    t.failed = true;
    this.failedTurns++;
    console.warn(
      `${this.tag} ${this.primary.provider} could not finish the turn (${f.reason.slice(0, 120)}) — ` +
        `${f.unspoken ? `${f.unspoken.length} chars` : "nothing left"} to the alternate` +
        (this.sticky ? "; the call stays on the alternate" : ""),
    );
    if (f.unspoken.trim()) this.toAlt(t, f.unspoken);
    this.finishIfDone(t);
  }

  private toAlt(t: Turn, text: string): void {
    const clean = text.trim();
    if (!clean) return;
    t.usedAlt = true;
    this.lastUsedAlt = true;
    this.altChars += clean.length + 1;
    if (t.altCtx && this.alt) {
      this.alt.speakPiece(clean);
      return;
    }
    t.altQueue.push(clean);
    if (t.altStarting) return;
    t.altStarting = true;
    this.ensureAlt().then(
      (alt) => {
        t.altStarting = false;
        if (this.turn !== t || t.lost) return;
        t.altCtx = alt.beginTurn();
        for (const piece of t.altQueue.splice(0)) alt.speakPiece(piece);
        if (t.ended) alt.endTurn();
      },
      (err: Error) => {
        t.altStarting = false;
        this.lose(t, `alternate unavailable: ${err.message}`);
      },
    );
  }

  private ensureAlt(): Promise<CallTtsStream> {
    if (this.alt?.ready) return Promise.resolve(this.alt);
    if (this.altConnecting) return this.altConnecting;
    const alt = this.makeAlternate(this.primary.sampleRate);
    this.alt = alt;
    alt.on({
      onAudio: (pcm, ctx) => {
        const t = this.turn;
        if (!t || ctx !== t.altCtx || t.lost) return;
        this.handlers.onAudio?.(pcm, t.ctx);
      },
      onTimestamps: (wt, ctx) => {
        const t = this.turn;
        if (!t || ctx !== t.altCtx || t.lost) return;
        const shift = (xs: number[]) => xs.map((x) => Math.round((x + t.primarySec) * 1000) / 1000);
        this.handlers.onTimestamps?.({ words: wt.words, start: shift(wt.start), end: shift(wt.end) }, t.ctx);
      },
      onDone: (ctx) => {
        const t = this.turn;
        if (!t || ctx !== t.altCtx) return;
        t.altDone = true;
        this.finishIfDone(t);
      },
      onError: (err) => {
        const t = this.turn;
        if (!t?.altCtx || t.altDone) return;
        this.lose(t, `alternate failed: ${err.message}`);
      },
    });
    this.altConnecting = alt.connect().then(
      () => {
        this.altConnecting = null;
        return alt;
      },
      (err: Error) => {
        this.altConnecting = null;
        if (this.alt === alt) this.alt = null;
        throw err;
      },
    );
    return this.altConnecting;
  }

  /** Both voices failed: say so (index.ts puts it on screen) and end the turn. */
  private lose(t: Turn, why: string): void {
    if (t.lost || this.turn !== t) return;
    t.lost = true;
    console.error(`${this.tag} the rest of this turn could not be spoken — ${why}`);
    const err = new Error(`voice lost for the rest of the turn: ${why}`);
    err.name = "TtsVoiceLost";
    this.handlers.onError?.(err);
    this.finishIfDone(t);
  }

  private finishIfDone(t: Turn): void {
    if (!t.failed || t.doneSent || !t.ended || this.turn !== t) return;
    const altIdle = !t.altCtx && !t.altStarting && !t.altQueue.length;
    if (t.lost || t.altDone || altIdle) {
      t.doneSent = true;
      this.handlers.onDone?.(t.ctx);
    }
  }
}
