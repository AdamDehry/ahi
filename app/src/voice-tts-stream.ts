import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type { CartesiaConfig } from "./config.js";
import type { PieceReason } from "./voice/seam-log.js";
import { isIncompleteFragment, speechCut, splitSentences } from "./voice/speech-boundary.js";
import { logSayText, sayText } from "./voice/say-text.js";

/* ============================================================
   voice-tts-stream.ts — streaming TTS for VOICE MODE ONLY.

   Ported from the simulator's proven `lib/tts-cartesia.mjs`, which ran live
   against Michael on 2026-07-21. One Cartesia context per agent turn: the
   reply's text is forwarded in sentence-ish pieces as continuations while it
   is still generating, and the context is closed with an empty final piece.
   Audio comes back as raw PCM s16le chunks plus word-level timestamps
   (`add_timestamps`) — those timestamps ARE the karaoke clock.

   ── Why this exists alongside voice-out.ts ────────────────────────────────
   voice-out.ts synthesizes a WHOLE utterance over REST and transcodes it to
   OGG. That is correct for a voice NOTE: the note is an artifact, it is
   played after the fact, and a container is what makes it seekable in the
   thread. It is wrong for a call. Waiting for the full reply before the
   first sample plays is what makes a voice assistant feel like it is reading
   a prepared statement — the exact voice-note experience the owner rejected.

   So the split is PER-MODE, not global:
     - chat voice notes  → voice-out.ts, REST → whole PCM → pcmToOgg. UNCHANGED.
     - voice-mode turns  → this module, WS → PCM frames as they generate.

   Nothing here is reachable unless `voiceModeEnabled` is on for the agent, so
   the entire streaming path stays dark until the flag is flipped.

   ── The context guard ─────────────────────────────────────────────────────
   Barge-in cancels the context. Cartesia may still have frames in flight for
   it, and a late frame played after the user has started talking is the
   agent's voice coming back from the dead. Every inbound message is therefore
   matched against the CURRENT contextId and dropped if it does not belong —
   and `cancel()` clears contextId outright, so after a barge-in nothing from
   the old turn can match.
   ============================================================ */

const TTS_WS_URL = "wss://api.cartesia.ai/tts/websocket";
/** Pinned to the same API version the REST path uses (voice-out.ts). */
const CARTESIA_VERSION = "2026-03-01";

export interface WordTimestamps {
  words: string[];
  start: number[];
  end: number[];
}

export interface VoiceTtsStreamHandlers {
  /** A PCM s16le frame at `sampleRate`, for the given turn context. */
  onAudio?: (pcm: Buffer, contextId: string) => void;
  /** Word-level timings for speech already scheduled. The karaoke clock. */
  onTimestamps?: (words: WordTimestamps, contextId: string) => void;
  /** Synthesis finished for this context. NOT the same as playback finishing. */
  onDone?: (contextId: string) => void;
  onError?: (err: Error) => void;
  /**
   * This stream gave up on the turn (B3). Emitted AFTER the last audio
   * it will ever release for that turn, with the text it never spoke — the
   * failover (voice/tts-failover.ts) speaks `unspoken` on another provider,
   * in order, without replaying anything already heard. Later pieces of the
   * same turn are not spoken by this stream.
   */
  onFailed?: (f: { contextId: string; unspoken: string; reason: string }) => void;
}

/**
 * What a call's turn loop needs from a streaming TTS, whoever provides it.
 * Cartesia (`VoiceTtsStream`, below) and ElevenLabs (`ElevenTtsStream`,
 * voice-tts-eleven.ts) both implement it, so index.ts speaks through either
 * without knowing which. One instance per call; one context per turn.
 */
export interface CallTtsStream {
  readonly provider: "cartesia" | "elevenlabs" | "gemini";
  /** The model actually speaking this call — the filler must use the same one. */
  readonly activeModel: string;
  /** The model that spoke each sentence of the last turn, where the path knows it (HTTP path). */
  readonly lastTurnModels?: string[];
  readonly sampleRate: number;
  readonly ready: boolean;
  charsSent: number;
  on(handlers: VoiceTtsStreamHandlers): void;
  connect(): Promise<void>;
  beginTurn(): string;
  /** `why` is what made the piece ready — for the seam log only (voice/seam-log.ts). */
  speakPiece(text: string, why?: PieceReason): void;
  endTurn(): void;
  cancel(): void;
  close(): void;
}

/**
 * A single Cartesia streaming-TTS socket, reused across the turns of one call.
 *
 * Connecting costs a round trip, so the socket outlives individual turns; only
 * the CONTEXT is per-turn. That is what keeps second and later turns from
 * re-paying connection latency.
 */
export class VoiceTtsStream implements CallTtsStream {
  readonly provider = "cartesia" as const;
  get activeModel(): string {
    return this.cartesia.model;
  }
  private ws: WebSocket | null = null;
  private contextId: string | null = null;
  private handlers: VoiceTtsStreamHandlers = {};

  /** Characters sent to synthesis this turn — the billing figure. */
  charsSent = 0;

  constructor(private readonly cartesia: CartesiaConfig) {}

  get sampleRate(): number {
    return this.cartesia.sampleRate;
  }

  /** Is the socket up and usable? */
  get ready(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  on(handlers: VoiceTtsStreamHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  async connect(): Promise<void> {
    const key = process.env.CARTESIA_API_KEY;
    if (!key) throw new Error("[tts-stream] No CARTESIA_API_KEY set");

    const ws = new WebSocket(`${TTS_WS_URL}?cartesia_version=${CARTESIA_VERSION}`, {
      headers: { "X-API-Key": key },
    });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.off("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        ws.off("open", onOpen);
        reject(err);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });

    ws.on("message", (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // Context guard — see the header. A frame from a cancelled or previous
      // turn is silently dropped rather than played over the live one.
      const ctx = typeof msg.context_id === "string" ? msg.context_id : null;
      if (ctx && ctx !== this.contextId) return;

      switch (msg.type) {
        case "chunk":
          if (typeof msg.data === "string" && ctx) {
            this.handlers.onAudio?.(Buffer.from(msg.data, "base64"), ctx);
          }
          break;
        case "timestamps":
          if (msg.word_timestamps && ctx) {
            this.handlers.onTimestamps?.(msg.word_timestamps as WordTimestamps, ctx);
          }
          break;
        case "done":
          if (ctx) this.handlers.onDone?.(ctx);
          break;
        case "error":
          this.handlers.onError?.(
            new Error(`[tts-stream] ${msg.title ?? ""} ${msg.message ?? ""}`.trim()),
          );
          break;
      }
    });

    ws.on("error", (err: Error) => this.handlers.onError?.(err));
  }

  /** Open a new turn context. Any previous context is implicitly stale. */
  beginTurn(): string {
    this.contextId = `turn-${randomUUID()}`;
    this.charsSent = 0;
    return this.contextId;
  }

  private payload(transcript: string, cont: boolean): Record<string, unknown> {
    return {
      context_id: this.contextId,
      model_id: this.cartesia.model,
      transcript,
      voice: { mode: "id", id: this.cartesia.voiceId },
      language: this.cartesia.language,
      speed: this.cartesia.speed,
      output_format: {
        container: "raw",
        encoding: "pcm_s16le",
        sample_rate: this.cartesia.sampleRate,
      },
      add_timestamps: true,
      continue: cont,
    };
  }

  /** Stream a piece of this turn's text. Safe to call before audio starts. */
  speakPiece(text: string): void {
    if (!this.ready || !this.contextId || text.length === 0) return;
    this.charsSent += text.length;
    this.ws!.send(JSON.stringify(this.payload(text, true)));
  }

  /**
   * No more text this turn. Closes the context with an empty final piece so
   * Cartesia flushes the tail — without this the last sentence never arrives.
   */
  endTurn(): void {
    if (!this.ready || !this.contextId) return;
    this.ws!.send(JSON.stringify(this.payload("", false)));
  }

  /**
   * Barge-in: stop generating for the current context immediately.
   *
   * Clearing contextId is load-bearing, not tidiness — it is what makes the
   * guard above reject frames that were already in flight when we cancelled.
   */
  cancel(): void {
    if (!this.ready || !this.contextId) {
      this.contextId = null;
      return;
    }
    this.ws!.send(JSON.stringify({ context_id: this.contextId, cancel: true }));
    this.contextId = null;
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* already closing */
    }
    this.ws = null;
    this.contextId = null;
  }
}

/**
 * Is this chunk the agent stream re-emitting text we already have?
 *
 * `claude-invoke` forwards live `content_block_delta` text AND a terminal
 * `assistant` event carrying the fully-assembled block. It tries to suppress
 * the second copy, but that dedup is keyed on the block INDEX, which the delta
 * events do not always carry — when the index is missing the terminal event
 * re-emits the whole reply as one more chunk.
 *
 * Nothing noticed before because the only consumer was the chat bubble, which
 * REPLACES its text on `stream-end` and so heals itself invisibly. TTS is the
 * first consumer that accumulates, and an unguarded append makes the agent
 * speak every reply twice — which is exactly what the synthetic e2e caught.
 *
 * ── Why the boundary argument, and not plain equality ────────────────────
 * `claude-invoke` re-emits PER ASSISTANT MESSAGE, and a turn that uses a tool
 * is several assistant messages: "Let me check." → tool_use → "All green."
 * Comparing the chunk against EVERYTHING pushed so far only ever catches the
 * first message's copy — msg 2's re-emission ("All green.") never equals the
 * whole stream ("Let me check.All green."), so it sailed through and the agent
 * said the second half twice. Tool-use turns are the common case for these
 * agents, so that was the usual path, not the edge.
 *
 * `messageStart` is where the CURRENT assistant message's text begins inside
 * `pushedSoFar`; a re-emission is byte-identical to everything pushed since
 * that boundary. The caller advances the boundary each time one is detected —
 * a detected re-emission IS the end of a message.
 *
 * The residual false positive is unchanged and accepted: a genuine delta that
 * is byte-identical to the whole of its own message so far (a one-token
 * message whose next token repeats it verbatim).
 *
 * NOTE: the underlying dedup bug in claude-invoke.ts is shared with the chat
 * path and is NOT fixed here — fixing it would change behaviour with voice
 * mode off, which this build is not allowed to do. Reported separately.
 */
export function isStreamReemission(
  pushedSoFar: string,
  chunk: string,
  messageStart = 0,
): boolean {
  return chunk.length > 0 && chunk === pushedSoFar.slice(messageStart);
}

/**
 * `isStreamReemission` with the bookkeeping attached.
 *
 * The predicate on its own was never the hard part — tracking what to compare
 * against is, and getting that wrong is what let tool-use turns speak twice
 * while the predicate itself looked correct in isolation. Keeping the
 * accumulator and the boundary in here means there is one implementation of
 * that bookkeeping, it is the one production runs, and a test can drive a
 * whole turn through it.
 *
 * Returns the text to speak, or null if the chunk was a re-emission.
 */
export function createReemissionFilter(): (chunk: string) => string | null {
  let seen = "";
  let messageStart = 0;
  return (chunk: string): string | null => {
    if (isStreamReemission(seen, chunk, messageStart)) {
      // A detected re-emission IS the end of an assistant message.
      messageStart = seen.length;
      return null;
    }
    seen += chunk;
    return chunk;
  };
}

/* ── Spoken vs work lines (part five) ──────────────────────────
   On a call, technical narration ("identical 15 failures, only numbering and
   path differ", "build:web needs npm ci --include=dev") was being read aloud.
   Every line of a call reply is now one of two kinds:
     spoken — short human speech; goes to the voice and the transcript;
     work   — progress and technical detail; shown on screen as a muted
              "not spoken" line, NEVER sent to TTS.
   Two signals, either of which makes a line work:
     1. the agent tagged it: a line starting with WORK_LINE_TAG (the voice
        prompt asks for this, see VOICE_CALL_SYSTEM_HINT);
     2. it LOOKS technical: code, paths, files, commands, flags, ids, error
        text, test counts (`looksTechnical`).
   The default fails toward NOT speaking: a sentence that trips any pattern is
   shown, not said.                                                          */

/** The prefix the voice prompt asks the agent to put on work lines. */
export const WORK_LINE_TAG = "»";

const FILE_EXT =
  /[A-Za-z0-9_\-)]\.(?:tsx?|jsx?|mjs|cjs|json|jsonl|md|sh|py|css|html?|ya?ml|env|log|txt|sql|lock|toml|ini|conf|service|pid|wav|mp3|png|jpe?g|pdf|csv|xlsx?)\b/i;
const COMMANDS =
  /\b(?:npm|npx|pnpm|yarn|node|tsc|tsx|vite|git|gh|curl|wget|grep|rg|sed|awk|bash|zsh|sudo|ssh|scp|rsync|chmod|chown|systemctl|journalctl|crontab|cron|pm2|docker|kubectl|python3?|pip|jq|tmux|ffmpeg|restic|pkill|kill -\d)\b/i;
const TECH_WORDS =
  /\b(?:worktree|stdout|stderr|stack ?trace|regex|cwd|PID|JSON|YAML|TypeScript|node_modules|dist folder|repo|rebase|lint(?:er)?|typecheck|endpoint|webhook|websocket|env var|dotenv|localhost|SIGTERM|SIGKILL|ENOENT|EADDRINUSE|ECONNREFUSED|null pointer|undefined is not|exit code|status code|HTTP \d{3}|\d{3} error|traceback|segfault|commit(?:ted)? (?:hash|id)|diff(?:ed|ing)?|stub|mock|fixture|assert(?:ion)?s?)\b/i;

/** Does this text read as technical work narration rather than speech? */
export function looksTechnical(text: string): boolean {
  // Everyday words that would otherwise trip a code pattern.
  const t = text
    .trim()
    .replace(/\b(?:and\/or|i(?:Phone|Pad|Pod|OS|Cloud|Message)s?|macOS|watchOS|eBay)\b/g, "x");
  if (!t) return false;
  return (
    /[`{}<>\[\]|\\~^]/.test(t) || // code punctuation, markup, pipes
    /(?:^|[\s(])(?:\.{0,2}\/|~\/)[\w.-]/.test(t) || // ./x ../x /x ~/x
    /\b[A-Za-z][\w.-]*\/[\w.-]*[A-Za-z]/.test(t) || // a/b, a/b/c — paths, "numbering/path" (not 24/7, $689/mo)
    FILE_EXT.test(t) ||
    /(?:^|\s)--?[a-z][\w-]*/i.test(t) || // --flags, -x
    /\b[a-z]+_[a-z0-9_]+\b/i.test(t) || // snake_case
    /\b[a-z]+[A-Z][A-Za-z0-9]*\b/.test(t) || // camelCase
    /\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/.test(t) || // ENV_VARS
    /\b[a-z][\w-]*:[a-z][\w-]*\b/i.test(t) || // build:web, foo:bar (not 2:25)
    /\w\(\)|=>|::|===?|!=|\+\+|&&/.test(t) || // calls and operators
    /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/.test(t) || // commit-ish hashes
    /\bv?\d+\.\d+\.\d+\b/.test(t) || // versions
    /:\d{4,5}\b/.test(t) || // ports
    /\bhttps?:\/\/|\bwww\./i.test(t) ||
    /\b\d+\s*(?:\/\s*\d+\s*)?(?:tests?|failures?|failing|fails|passing|passes|passed|checks?|errors?|warnings?|commits?|files? changed|lines? changed)\b/i.test(t) ||
    /\b\d+\s+(?:of|out of)\s+\d+\s+(?:pass|passed|passing|fail|failed|failing|tests?|checks?|green|red)\b/i.test(t) ||
    /\b(?:test )?suite\b.*\d|\d.*\b(?:test )?suite\b/i.test(t) || // "the suite: 1107 ..."
    COMMANDS.test(t) ||
    TECH_WORDS.test(t)
  );
}

/** One line of a call reply, as the screen and the voice see it. */
export type CallLineKind = "spoken" | "work";

/**
 * Split a raw piece into runs of spoken and work text. A line that starts
 * with the tag is work; any other line is cut into sentences and each one is
 * judged by `looksTechnical`. Whitespace is preserved so the runs re-join to
 * the original text (minus tags).
 */
export function splitCallLines(raw: string, startInWork = false): Array<{ kind: CallLineKind; text: string }> {
  const out: Array<{ kind: CallLineKind; text: string }> = [];
  const push = (kind: CallLineKind, text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let carryWork = startInWork;
  for (const line of raw.split(/(?<=\n)/)) {
    const tagged = line.trimStart().startsWith(WORK_LINE_TAG);
    if (tagged) {
      const at = line.indexOf(WORK_LINE_TAG);
      push("work", line.slice(0, at) + line.slice(at + WORK_LINE_TAG.length).replace(/^ /, ""));
      carryWork = false;
      continue;
    }
    // The call path's one sentence detector (voice/speech-boundary.ts).
    for (const sentence of splitSentences(line)) {
      if (!sentence) continue;
      const work = carryWork || looksTechnical(sentence);
      push(work ? "work" : "spoken", sentence);
      // A work sentence cut mid-way (no terminator yet) keeps the rest of it
      // as work: the second half of a path is still a path.
      carryWork = work && !/[.!?…]["')\]]?\s*$/.test(sentence);
    }
  }
  return out;
}

/** Markdown the voice must never read aloud ("asterisk"). */
const stripForVoice = (text: string): string => text.replace(/[*_`#>]+/g, "");

/** What a turn says when everything it wrote was work lines. */
export const ALL_WORK_FALLBACK = "Done. The details are on your screen.";

/**
 * The agent's text stream → what a call says and what it only shows, one
 * turn's worth.
 *
 * Owns the things that decide WHEN and WHETHER text is spoken: the
 * re-emission filter (a whole message repeated once it completes), the
 * sentence buffer, the message boundary, and the spoken/work split.
 *
 * Part four: a line written before a tool call ends "...one."
 * with no trailing space, so the chunker kept it until the agent wrote again
 * AFTER the tools ran, then glued it to the next message ("one.I sent it").
 * The agent moving on to a tool call means that message is complete, so it
 * is handled then.
 *
 * Part five: each piece is split into spoken and work runs; only spoken runs
 * reach `speak`. `show` gets every run, in order, with its kind, so the screen
 * shows everything exactly once.
 */
export class SpokenTextFeed {
  private buffered = "";
  private seen = "";
  private messageStart = 0;
  private inWork = false;
  private spokeAny = false;
  private shownWork = false;
  private lastShown: { kind: CallLineKind; text: string } | null = null;
  /**
   * Does the next piece begin at a line start in the agent's text? Pieces are
   * cut mid-line too ("…count? " | "7. That's all."), and only a real line
   * start makes "7." a list number (voice/say-text.ts).
   */
  private atLineStart = true;

  constructor(
    private readonly speak: (piece: string, why: PieceReason) => void,
    private readonly show: (kind: CallLineKind, text: string) => void = () => {},
  ) {}

  /** A stream chunk. Handles every whole sentence it completes. */
  push(chunk: string): void {
    if (isStreamReemission(this.seen, chunk, this.messageStart)) {
      // A re-emission IS the end of an assistant message.
      this.messageStart = this.seen.length;
      this.endMessage("reemit");
      return;
    }
    this.seen += chunk;
    this.buffered += chunk;
    // One chunk can complete more than one cut (a whole reply arriving at once).
    for (;;) {
      const { piece, rest, why } = cutForSpeech(this.buffered, false);
      if (!piece) break;
      this.buffered = rest;
      this.emit(piece, why);
    }
  }

  /** The current assistant message is complete (the agent called a tool). */
  boundary(): void {
    this.messageStart = this.seen.length;
    this.endMessage("tool");
    // A new message starts a new block of text — unless a held fragment leads it.
    if (!this.buffered) this.atLineStart = true;
    // Messages arrive with nothing between them ("one.I sent it"): end this
    // one on screen — a space after speech, a line break after a work line.
    const last = this.lastShown;
    if (last && !/\s$/.test(last.text)) this.showRun(last.kind, last.kind === "work" ? "\n" : " ");
    // A message's last line ends with its message; the next one starts fresh.
    this.inWork = false;
  }

  /**
   * The turn's text is complete. A turn that showed work but said nothing
   * still says one short human line, so the call is never silent.
   */
  finish(): void {
    this.flush("finish");
    if (!this.spokeAny && this.shownWork) {
      this.spokeAny = true;
      this.speak(ALL_WORK_FALLBACK, "fallback");
    }
  }

  /** True once anything has been sent to the voice this turn. */
  get spoke(): boolean {
    return this.spokeAny;
  }

  private showRun(kind: CallLineKind, text: string): void {
    this.lastShown = { kind, text };
    this.show(kind, text);
  }

  /**
   * The message is complete: speak what is buffered — unless it is the
   * unfinished front of a sentence ("So," / "and then the"). Spoken alone
   * before a tool call, that is the mid-sentence pause the owner heard (diagnosis
   * #2); it waits for its continuation, or for the turn's finish, instead.
   * Work text is never held: it is shown, not spoken, and must not swallow
   * the next message into a work line.
   */
  private endMessage(why: PieceReason): void {
    const held = this.buffered;
    if (isIncompleteFragment(held) && splitCallLines(held, this.inWork).every((r) => r.kind === "spoken")) {
      // The next message starts with no separator: keep the words apart.
      if (!/\s$/.test(held)) this.buffered = `${held} `;
      return;
    }
    this.flush(why);
  }

  private flush(why: PieceReason): void {
    const { piece } = cutForSpeech(this.buffered, true);
    this.buffered = "";
    if (piece) this.emit(piece, why);
  }

  private emit(piece: string, why: PieceReason): void {
    const runs = splitCallLines(piece, this.inWork);
    let lineStart = this.atLineStart;
    for (const [i, run] of runs.entries()) {
      const runLineStart = lineStart;
      lineStart = /\n[ \t]*$/.test(run.text);
      this.showRun(run.kind, run.text);
      if (run.kind === "work") {
        if (run.text.trim()) this.shownWork = true;
        continue;
      }
      // As it should be SAID (voice/say-text.ts) — every call voice speaks through here.
      const written = stripForVoice(run.text);
      const voice = sayText(written, { lineStart: runLineStart });
      logSayText("call", written, voice);
      if (voice.trim()) {
        this.spokeAny = true;
        // A spoken run with more runs after it ended where a work line began.
        this.speak(voice, i === runs.length - 1 ? why : "work");
      }
    }
    this.atLineStart = /\n[ \t]*$/.test(piece);
    const last = runs[runs.length - 1];
    this.inWork = !!last && last.kind === "work" && !/[.!?…]["')\]]?\s*$/.test(last.text) && !/\n\s*$/.test(last.text);
  }
}

/**
 * Where to cut the buffer — the call path's boundary rules
 * (voice/speech-boundary.ts), on the RAW text, so the spoken/work split still
 * sees the backticks and underscores that mark code.
 */
function cutForSpeech(
  buffered: string,
  force: boolean,
): { piece: string | null; rest: string; why: PieceReason } {
  if (force) return { piece: buffered.trim() ? buffered : null, rest: "", why: "finish" };
  const at = speechCut(buffered);
  if (!at) return { piece: null, rest: buffered, why: "finish" };
  return { piece: buffered.slice(0, at.cut), rest: buffered.slice(at.cut), why: at.why };
}

/**
 * Sentence-ish chunker: the agent's token stream → TTS pieces.
 *
 * Ported from the sim's `flushTts`. Sonic sounds materially better when fed
 * whole clauses than token fragments — it can place prosody across a phrase it
 * can see the end of — so text is buffered to a sentence boundary before it is
 * spoken. The clause and hard-cap escapes (voice/speech-boundary.ts) exist
 * because a reply that opens with a long clause and no terminal punctuation
 * would otherwise sit in the buffer while the user hears nothing.
 *
 * Returns the pieces to speak and the remainder still buffered.
 */
export function chunkForSpeech(
  buffered: string,
  force: boolean,
): { piece: string | null; rest: string } {
  // Strip stray markdown. The voice system hint should already prevent it, but
  // a leaked asterisk is read aloud as "asterisk" by some voices.
  const text = buffered.replace(/[*_`#>]+/g, "");

  if (force) {
    const tail = text.trim();
    return { piece: tail.length > 0 ? text : null, rest: "" };
  }

  // The same boundary rules as the live feed (voice/speech-boundary.ts).
  const at = speechCut(text);
  if (!at) return { piece: null, rest: text };
  return { piece: text.slice(0, at.cut), rest: text.slice(at.cut) };
}
