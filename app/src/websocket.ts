import { WebSocketServer, WebSocket } from "ws";
import {
  dropBatchRefusal,
  dropMaxWaitMs,
  dropPairMs,
  dropSummary,
  dropWindowDelay,
  loadDropImage,
  MAX_CONCURRENT_DROP_LOADS,
  MAX_DROP_TEXT,
  MAX_PENDING_DROPS,
  type CallDrop,
} from "./voice/call-drop.js";
import { parseScreenFrame, type ScreenFrame } from "./voice/screen-frame.js";
import {
  formatPick,
  matchRecordCancel,
  matchRecordStart,
  matchRecordStop,
  parseSurface,
  ScreenWatch,
  screenRecordOn,
  screenWatchOn,
  stopWaitMaxMs,
  type WatchPick,
} from "./voice/screen-watch.js";
import type { IncomingMessage } from "http";
import type { Socket } from "net";
import { storeMessage, getMessagesForUser, upsertMessageById, LIVE_THREAD_CAP } from "./message-store.js";
import { deliveryHub } from "./delivery-hub.js";
import { lookupByToken, lookupByUserId, userCanAccessAgent, toPublic, type UserConfig } from "./users.js";
import { CallCheckpoints, type CallCheckpoint } from "./voice/call-checkpoint.js";
import { TurnComposer, type TurnMeta } from "./voice/turn-composer.js";
import { createVoiceStt, type VoiceSttStream } from "./voice/stt-select.js";
import type { CallAudioIn, CallTransport, CallTransportKind } from "./voice/call-transport.js";
import type { MediaRef } from "./media-store.js";
import type { SearchCardMeta } from "./search/service.js";
import type { StudioCardMeta } from "./studio/cards.js";
import { sendPushForMessage } from "./push.js";
import { SEAM_WARN_MS } from "./voice/seam-log.js";
import { describeWork, turnsInFlight } from "./voice/turn-liveness.js";
import { Floor, floorCommand, floorEnabled, formatFloorChange, hasWakeName, isBareWakeName, type FloorCommand } from "./voice/floor.js";
import { formatAddress, judgeAddress } from "./voice/address.js";
import { heardDuringPlayout, playoutEndsAt } from "./voice/echo-window.js";
import { formatEchoVerdict } from "./voice/echo-rule.js";
import { bargeWindow, isStopOnly, judgeBarge, serverBargeOn, stopInterruptOn, STOP_AFTER_BARGE_MS } from "./voice/server-barge.js";
import { doorCloseLine } from "./voice/loop-watch.js";
import { elevenBotsAmong } from "./voice/eleven/config.js";
import { CallMouth, forgetMouth, mouthFor, registerMouth, type DoorReport } from "./voice/mouth.js";
import { withPlayoutClock } from "./voice/echo-window.js";
import { feedEar, handleEarControl, handleScreenControl, muteEar, socketGone } from "./voice/eleven/side.js";

/** Optional hook invoked whenever the PWA's voice-mode finalizes a
 *  transcript. Wired by index.ts to the invokeAgent pipeline so a
 *  finalized utterance automatically drives a streaming reply. */
type VoiceTurnHandler = (opts: {
  botName: string;
  transcript: string;
  voiceStreamId: string;
  /** The call's wire — the app's socket or a phone line (voice/call-transport.ts). */
  transport: CallTransport;
  user: UserConfig;
  audioRoute: string;
  speculationEnabled: boolean;
  forceSpeculationOnBluetooth: boolean;
  voiceStartedAt: number;
  /**
   * When the caller's speech for this turn began (first VAD onset or partial
   * since the last committed turn), or null when the recognizer gave no
   * sign. The echo filter's timing evidence (voice/echo-window.ts).
   */
  utteranceStartedAt?: number | null;
  /** His speech ended (first end signal since it last started), or null if none was seen. */
  speechEndedAt?: number | null;
  tentativeFiredAt: number | null;
  /**
   * What his shared screen shows right now, when he is sharing one — the
   * latest frame the app sent, in memory only. Null when not sharing.
   */
  screenFrame?: ScreenFrame | null;
  /**
   * Always-on screen watch (voice/screen-watch.ts): the frames on screen while
   * he said this, aligned to his words. Called ONCE by the turn, after it knows
   * whether it merges into the last one. Absent when not sharing.
   */
  takeScreen?: (merge: boolean) => WatchPick | null;
  /** Record mode: the recording he just stopped, for this one review turn. */
  screenReview?: WatchPick | null;
  /**
   * Images, links and notes he dropped into the call (part six), paired with
   * this utterance — or the whole turn, when he dropped something and said
   * nothing (then `transcript` is empty).
   */
  drops?: CallDrop[];
}) => void;

let voiceTurnHandler: VoiceTurnHandler | null = null;

/** A recording's open-sentence guard has run out (see VoiceSession.screenRecord.tail). */
function tailExpired(t: { armedAt: number; endedAt: number | null }, now = Date.now()): boolean {
  if (now - t.armedAt > 120_000) return true;
  return t.endedAt !== null && now - t.endedAt > 8_000;
}

/** The review turn's words when he stopped a recording without saying what he wants (the button, or a bare "stop recording"). */
export const REVIEW_ASK = "That's the recording. Look it over against what I said and take it from there.";
export function setVoiceTurnHandler(fn: VoiceTurnHandler): void {
  voiceTurnHandler = fn;
}

type VoiceTentativeHandler = (opts: {
  botName: string;
  interimText: string;
  voiceStreamId: string;
  transport: CallTransport;
  user: UserConfig;
  audioRoute: string;
  speculationEnabled: boolean;
  forceSpeculationOnBluetooth: boolean;
  turnIndex: number;
}) => void;

let voiceTentativeHandler: VoiceTentativeHandler | null = null;
export function setVoiceTentativeHandler(fn: VoiceTentativeHandler): void {
  voiceTentativeHandler = fn;
}

/**
 * He paused (voice step 4, voice/gate-draft.ts): what he has said so far, for
 * the fast layer to draft on. Server-side, so both doors have it (no client
 * sends the old tentative pause any more). `why`: "speech-end" (the
 * recognizer's partial when his speech stopped) or "utterance" (the
 * composer's buffered thought, now held in case he goes on). Never while a
 * phone call waits for its passphrase, while muted, or on standby.
 */
type VoiceDraftHandler = (opts: {
  botName: string;
  voiceStreamId: string;
  text: string;
  why: "speech-end" | "utterance";
  transport: CallTransport;
  user: UserConfig;
}) => void;

let voiceDraftHandler: VoiceDraftHandler | null = null;
export function setVoiceDraftHandler(fn: VoiceDraftHandler): void {
  voiceDraftHandler = fn;
}

type VoiceInterruptHandler = (opts: {
  botName: string;
  voiceStreamId: string;
  transport: CallTransport;
  user: UserConfig;
  /**
   * `hangup`: the call is over — stop everything AND drop any turn still
   * queued, not just the one speaking. Absent = a barge-in.
   */
  reason?: "barge-in" | "hangup";
  /**
   * How far into the turn's audio the listener had heard when it cut the
   * voice (seconds on the turn's clock, filler included). Absent when the
   * listener could not tell, or is an older app.
   */
  heardSec?: number;
}) => void;

let voiceInterruptHandler: VoiceInterruptHandler | null = null;
export function setVoiceInterruptHandler(fn: VoiceInterruptHandler): void {
  voiceInterruptHandler = fn;
}

type VoiceSpecCancelHandler = (opts: {
  voiceStreamId: string;
  reason: "manual_cancel" | "user_bargein";
}) => void;

let voiceSpecCancelHandler: VoiceSpecCancelHandler | null = null;
export function setVoiceSpecCancelHandler(fn: VoiceSpecCancelHandler): void {
  voiceSpecCancelHandler = fn;
}

/**
 * Voice-session lifecycle, for owners of per-call resources.
 *
 * Streaming TTS holds a Cartesia socket for the length of a CALL, not a turn —
 * connecting per turn would re-pay the handshake on every reply, which is the
 * latency this whole path exists to remove. But the Cartesia voice config
 * lives on BotConfig, which this module deliberately does not know about. So
 * websocket.ts signals open/close and index.ts owns the socket.
 */
type VoiceSessionLifecycleHandler = (opts: {
  botName: string;
  voiceStreamId: string;
  /** Who is calling — the front voice and ack gate speak to them by name. */
  userName?: string;
}) => void;

let voiceSessionOpenHandler: VoiceSessionLifecycleHandler | null = null;
export function setVoiceSessionOpenHandler(fn: VoiceSessionLifecycleHandler): void {
  voiceSessionOpenHandler = fn;
}

let voiceSessionCloseHandler: VoiceSessionLifecycleHandler | null = null;
export function setVoiceSessionCloseHandler(fn: VoiceSessionLifecycleHandler): void {
  voiceSessionCloseHandler = fn;
}

/**
 * The call log — one card appended to the chat thread when a call ends.
 *
 * This MUST be written by the service process. Gateway state files are read
 * through an in-process cache and rewritten whole, so a card written from
 * anywhere else is erased by the next save from here. The client therefore
 * reports what happened and the server is what persists it.
 */
export interface VoiceSessionRecord {
  startedAt: number;
  durationSec: number;
  turns: number;
  transcript: { role: "user" | "agent"; text: string }[];
  /** Present on a phone call's card only; an app call's card is unchanged. */
  channel?: "phone";
  direction?: "inbound" | "outbound";
  /** How the call ended, in plain words, when it did not end cleanly (an ElevenLabs failure, a drop). */
  ending?: string;
  /** The call's id, on cards the server writes: with `startedAt` it names the call, so a restart never cards it twice. */
  callId?: string;
}

type VoiceSessionRecordHandler = (opts: {
  botName: string;
  user: UserConfig;
  record: VoiceSessionRecord;
}) => void;

let voiceSessionRecordHandler: VoiceSessionRecordHandler | null = null;
export function setVoiceSessionRecordHandler(fn: VoiceSessionRecordHandler): void {
  voiceSessionRecordHandler = fn;
}

/**
 * A spoken command or the bare wake name on a standing call (voice/floor.ts):
 * "Michael, go to sleep / wake up / go quiet", or just "Michael." The floor
 * has already moved; index.ts answers with one fixed line, no model.
 */
export type VoiceCommandHandler = (ev: {
  botName: string;
  voiceStreamId: string;
  user: UserConfig;
  command: FloorCommand | "name" | "watch" | "watch-dropped" | "watch-share-first";
  transport: CallTransport;
}) => void;
let voiceCommandHandler: VoiceCommandHandler | null = null;
export function setVoiceCommandHandler(fn: VoiceCommandHandler): void {
  voiceCommandHandler = fn;
}

/** Per-call voice-mode state — one recognizer at a time. */
interface VoiceSession {
  bot: string;
  voiceStreamId: string;
  /** What the session is filed under: the app's socket, or a phone call's handle. */
  key: object;
  /** The call's wire (voice/call-transport.ts). Everything toward the listener goes through it. */
  transport: CallTransport;
  /**
   * Consumes a committed turn before anything else sees it — the phone's
   * passphrase gate. A consumed turn is not logged, recorded or answered.
   */
  interceptTurn: ((text: string) => boolean) | null;
  /** May what he says now be shown to a model before it commits (voice/gate-draft.ts)? False while the passphrase is owed. */
  mayDraft: (() => boolean) | null;
  /** For the card: which surface, and on the phone which way the call went. */
  channel: CallTransportKind;
  direction?: "inbound" | "outbound";
  /**
   * The provider stream (ink-2 / openai / google), behind one interface.
   * Null until `createVoiceStt` resolves — see `pendingFrames`.
   */
  stt: VoiceSttStream | null;
  /**
   * PCM that arrived before the provider stream finished opening. The PWA
   * starts streaming the moment it has the mic, which is before the upstream
   * socket is up; without this the user loses their first word or two.
   * (CartesiaStt has its own inner queue for the same reason one layer
   * down — this one covers the async gap before `stt` even exists.)
   */
  pendingFrames: Buffer[];
  pendingBytes: number;
  /**
   * Fragment coalescing. STT utterance boundaries are NOT thought
   * boundaries: a pause mid-sentence closes an utterance, and committing
   * there is what chopped the owner's opening into five messages and three
   * interruptions. Every provider's utterances feed this; it decides when a
   * whole thought is done and fires exactly one turn.
   */
  composer: TurnComposer;
  /** Latest provisional transcript, for the tentative/speculation path. */
  lastPartial: string;
  /**
   * Speech has been detected since the last committed turn. Distinguishes
   * "the user said nothing" from "the provider has not finished the turn
   * yet" — see handleVoiceEnd.
   */
  speechSeen: boolean;
  /** When speech for the turn being composed began; null between turns. */
  utteranceStartedAt: number | null;
  /**
   * The first end-of-speech signal (the recognizer's, or the client's VAD)
   * since speech last started; null while he talks. Step 0's clock: his last
   * word → Michael's first sound (voice-speed). Late by the VAD's own
   * silence window, which the report states.
   */
  speechEndedAt: number | null;
  /** The last barge-in on this call (ms epoch), 0 if none: a lone "stop" right after it is part of it (voice/server-barge.ts). */
  lastBargeAt: number;
  /** The gateway already cut Michael for the utterance he is saying now (voice/server-barge.ts): once per utterance. */
  serverBarged: boolean;
  /**
   * The user has muted their mic.
   *
   * Enforced server-side as well as client-side because MUTE is a privacy
   * promise, not a UI state: while it is on, this session must not transcribe
   * the room. The client stops sending (web/src/lib/voicebus.ts); this drops
   * anything already in flight, or anything from a client that did not.
   */
  muted: boolean;
  audioRoute: string;
  speculationEnabled: boolean;
  forceSpeculationOnBluetooth: boolean;
  startedAt: number;
  tentativeFiredAt: number | null;
  /**
   * Who ended the call and why — set by every ending path BEFORE teardown,
   * which logs it as the one `[call-end]` line. Absent means the teardown
   * was reached by a path that never said (and the line says so).
   */
  ending?: CallEnding;
  /**
   * The authenticated owner of this call, captured at voice-start.
   *
   * Held on the session rather than looked up at flush time because the flush
   * runs from `ws.on("close")`, which also clears `socketUsers` — reading it
   * there is a race against our own cleanup.
   */
  user: UserConfig | null;
  /**
   * What was said in this call, accumulated turn by turn.
   *
   * The client builds its own (karaoke-accurate) copy and reports it when the
   * call ends normally. This one exists for every OTHER ending — a force-quit,
   * a dropped network, a killed app — where that report never arrives. See
   * `flushVoiceSessionRecord`.
   */
  transcript: { role: "user" | "agent"; text: string }[];
  /** User turns committed — the countable unit, matching the client's count. */
  userTurns: number;
  /** A card has been written for this call; do not write a second one. */
  recorded: boolean;
  /**
   * Screen sharing ("look at my screen"). Null unless the app says sharing is
   * on. Holds ONLY the latest frame, in memory; replaced by each new one,
   * dropped when sharing stops or the call ends. Never written anywhere.
   */
  screen: { frame: ScreenFrame | null; frames: number; since: number; watch: ScreenWatch } | null;
  /**
   * Record mode (voice/screen-watch.ts), set by handleVoiceStart: start, stop
   * (one review turn) or drop a recording — from his words or the REC button.
   */
  screenRecord: {
    start: (how: "voice" | "button") => boolean;
    /**
     * End the recording and review it. `why` other than "voice" (the button,
     * the time limit, the share stopping) can land mid-sentence: the review
     * then waits for that sentence (bounded) so it joins the clip instead of
     * becoming an answered turn of its own (Codex r1). `after` runs once the
     * review has been dispatched (share-off drops the screen there).
     */
    stop: (ask: string, why?: "voice" | "button" | "limit" | "share-off", after?: () => void) => void;
    cancel: (why: string) => void;
    timer: NodeJS.Timeout | null;
    /** Stopped, waiting for the sentence in progress; `finish` reviews now; `after` runs on finish or cancel. */
    stopping: { finish: () => void; timer: NodeJS.Timeout; after: Array<() => void> } | null;
    /**
     * A review went out (or a recording was dropped) while a sentence of it was
     * still open: that sentence's final — the next one — is the recording's
     * tail: shown and recorded, never a turn of its own, never part of a later
     * recording (Codex r2-r4). Armed until that sentence ends (`endedAt`), then
     * 8 s for its transcript; 2 min absolute in case the recognizer never closes it.
     */
    tail: { armedAt: number; endedAt: number | null } | null;
  } | null;
  /**
   * Drops waiting to be paired with his next words (part six). `timer`
   * closes the pairing window; `since` bounds how long speech that started
   * but has not committed may hold them.
   */
  drops: { items: CallDrop[]; timer: NodeJS.Timeout | null; since: number } | null;
  /** Dropped images being read/resized right now (S3: bounded). */
  dropLoads?: number;
  /** Fire a turn from the waiting drops alone (set by handleVoiceStart). */
  dispatchDrops: (() => void) | null;
  /**
   * The app socket this call is attached to right now; null on a phone call,
   * and null while the call is PARKED: its socket closed and the resume grace
   * window is running (always-on, slice 1). Everything toward the app goes
   * through `deliverToApp`, which reads this at send time — so a turn that
   * captured its transport before the socket died keeps working, and its
   * output is held for the socket that resumes the call.
   */
  ws: WebSocket | null;
  parked: ParkedCall | null;
  /** Times this call was resumed on a new socket, and the total gap. */
  resumed: number;
  gapMs: number;
  /** Open floor / standby (voice/floor.ts). Always open on a phone call. */
  floor: Floor;
}

/** A call between sockets: what arrived for the app while nobody was on the line. */
interface ParkedCall {
  since: number;
  key: object;
  timer: NodeJS.Timeout;
  held: HeldItem[];
  heldBytes: number;
  audioDropped: boolean;
  code: number;
  detail: string;
}
type HeldItem = { json: Record<string, unknown>; bytes: number } | { pcm: Buffer; bytes: number };

/**
 * How long a call outlives its socket. 0 disables resume (the old behaviour).
 *
 * Voice step 2 (the call outlives its doors): 2 minutes was the always-on
 * default, and most native calls that dropped were muted
 * when the app did not come back inside it — a cellular call, a locked
 * phone. The call is now held 10 minutes on an open floor, and an hour when
 * he is muted or on standby (`quietResumeGraceMs`): the state a door is most
 * likely to be gone longest in, and the one where he has not left.
 */
export function resumeGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CALL_RESUME_GRACE_MS;
  if (raw === undefined || raw === "") return 600_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 600_000;
}

/** The hold while muted or on standby: never shorter than the open one. 0 for the open hold disables both. */
export function quietResumeGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const open = resumeGraceMs(env);
  if (open === 0) return 0;
  const raw = env.CALL_RESUME_QUIET_GRACE_MS;
  const n = raw === undefined || raw === "" ? 3_600_000 : Number(raw);
  return Math.max(open, Number.isFinite(n) && n >= 0 ? n : 3_600_000);
}

/** The holds, for the app: its own wait for the socket matches the gateway's (voice-started `hold`). */
function holdSnapshot(): { openMs: number; quietMs: number } {
  return { openMs: resumeGraceMs(), quietMs: quietResumeGraceMs() };
}

/**
 * Events worth replaying to the socket that resumes a call: the reply being
 * said and shown, and the state changes. NOT the beats (`voice-working`) or
 * the live preview (`stt-interim`) — those are only true in the moment; the
 * resume snapshot carries the current beat instead.
 */
const HELD_EVENT_TYPES = new Set([
  "voice-thinking", "voice-tts-start", "voice-tts-words", "voice-tts-done", "stream-chunk", "stream-tool-use", "voice-work",
  "voice-filler", "voice-tts", "stt-final", "voice-ack", "voice-aside", "voice-gate", "voice-floor", "voice-error", "stt-health",
  "call-drop-ack", "voice-mute-state", "voice-empty",
]);
const MAX_HELD_ITEMS = 400;
/** ~34 s of 44.1 kHz mono s16le; text is small, this is for the audio. */
const MAX_HELD_BYTES = 3 * 1024 * 1024;

/**
 * Which agents have voice mode switched on. Populated by index.ts at startup
 * from BotConfig, after applySavedSettings — so a dashboard toggle beats the
 * env bootstrap, same precedence as ttsProvider.
 *
 * DEFAULT OFF, and the default lives here as well as in config: an agent this
 * map has never heard of cannot open a voice session. The client hides the
 * voice button when it is off, but the client is not the authority — a stale
 * or hand-rolled client must not be able to drive a disabled backend, which
 * is why the gate is in handleVoiceStart rather than only in the UI.
 */
const voiceModeEnabled = new Map<string, boolean>();

export function setVoiceModeEnabled(bot: string, enabled: boolean): void {
  voiceModeEnabled.set(bot, enabled);
}

export function isVoiceModeEnabled(bot: string): boolean {
  return voiceModeEnabled.get(bot) === true;
}

/** Agents this user may address that also have voice mode on. */
function voiceEnabledBotsFor(user: UserConfig): string[] {
  return [...voiceModeEnabled.entries()]
    .filter(([bot, on]) => on && userCanAccessAgent(user, bot))
    .map(([bot]) => bot);
}

/** Keyed by the app's socket, or by a phone call's CallAudioIn handle. */
const voiceSessions = new WeakMap<object, VoiceSession>();

/**
 * Live sessions by voiceStreamId.
 *
 * The socket-keyed map above is the authority; this is the index the TURN
 * side needs. index.ts knows a reply's text and its voiceStreamId but never
 * sees the socket the call is on, and the agent's half of the transcript has
 * to reach the session somehow — see `recordVoiceAgentTurn`. Entries are
 * removed in `teardownVoiceSession`, which every ending path runs through.
 */
const voiceSessionsById = new Map<string, VoiceSession>();

/** Calls live right now (app calls and phone legs alike) — /health carries it so a ship can wait for them. */
export function liveCallCount(): number {
  return voiceSessionsById.size;
}

/**
 * This user's live call with this agent, if there is one (the newest, when a
 * stale session lingers). The live studio says one line on it when a job
 * lands; nothing else here changes.
 */
export function liveCallFor(userId: string, bot: string): { voiceStreamId: string; transport: CallTransport } | null {
  let found: VoiceSession | null = null;
  for (const s of voiceSessionsById.values()) {
    if (s.bot !== bot || s.user?.userId !== userId || s.ending) continue;
    if (!found || s.startedAt > found.startedAt) found = s;
  }
  return found ? { voiceStreamId: found.voiceStreamId, transport: found.transport } : null;
}

/**
 * Cap on PCM held while the provider stream opens. 16kHz s16le = 32kB/sec,
 * so this is ~4 seconds of audio.
 */
const MAX_PENDING_FRAME_BYTES = 128 * 1024;

/**
 * Per-socket authenticated user. Populated on upgrade (see handleUpgrade)
 * and consulted by every message handler so downstream logic knows
 * which user (and which agent visibility) the socket represents.
 */
const socketUsers = new WeakMap<WebSocket, UserConfig>();
const socketVoiceTurnCounts = new WeakMap<object, Map<string, number>>();

export function getSocketUser(ws: WebSocket): UserConfig | null {
  return socketUsers.get(ws) ?? null;
}

export interface MessageEvent {
  type: "message";
  bot: string;
  direction: "in" | "out";
  contentType: "text" | "voice" | "photo" | "document";
  text: string;
  timestamp: string;
  chatId: number;
  /**
   * Canonical user id (lowercased user name,
   * or "unknown" when no user could be resolved from the chatId). Used
   * to scope the message store into per-user threads.
   */
  userId: string;
  /**
   * Human-readable sender display name ("the owner", "a family member", "another user", or
   * "unknown"). Populated from users.json by the ingress path and
   * surfaced to the UI so the feed shows real authorship instead of
   * a hardcoded "the owner".
   */
  senderName: string;
  // Provenance of this message event. "telegram" = real user/bot exchange
  // over the Telegram edge; "ui-send" = dashboard Quick Send injection (test
  // tool, forged chatId, MUST be excluded from the retrieval corpus);
  // "app" = the web app (PWA) — real user turns,
  // INCLUDED in retrieval corpus; "glasses" = Even G2 HUD via
  // /api/glasses/ask — real the owner turns, INCLUDED in retrieval corpus;
  // "interagent" = end-of-loop digest from the inter-agent bus (see
  // interagent-loop.ts) — a real outcome the owner should be able to recall
  // later, so INCLUDED in the retrieval corpus. Note this tags only the
  // digest: the individual agent↔agent hops are never broadcast or
  // persisted here, they live in logs/interagent-*.jsonl.
  // Undefined on legacy records written by older versions — treat as
  // "telegram" for backward compat.
  source?: "telegram" | "ui-send" | "private-edge" | "app" | "glasses" | "interagent";
  meta?: {
    voiceDuration?: number;
    photoPath?: string;
    fileName?: string;
    clientMessageId?: string;
    /**
     * Stable server-assigned id, stamped on persist (see ensureMessageId).
     * The canonical dedupe/upsert key clients use to recognize an update to
     * a message they already have (e.g. a voice reply upgrading its text
     * placeholder). Absent on legacy records — clients fall back to their
     * existing text/timestamp dedupe.
     */
    messageId?: string;
    /**
     * Voice-turn correlation id (= PWA voiceStreamId). Lets the canonical
     * voice-media upsert find the fast text out-message it should upgrade.
     */
    turnId?: string;
    /**
     * Call log (frame 3F). Present ONLY on the card a voice call appends to
     * the thread; its presence is what makes the client render a card instead
     * of a plain line. Readers that don't know about it still show true text.
     */
    voiceSession?: VoiceSessionRecord;
    /**
     * Present ONLY on a message an agent posted with files attached
     * (src/chat-files/, the send-file CLI): which agent sent them. The thread
     * tail tells the agent it sent those files, by name.
     */
    agentFiles?: { by: string };
    /**
     * Present ONLY on a foreman build message rendered in code from a status
     * record (src/foreman-messages/): which build, and which kind
     * (needs_operator | closed | failed). Lets a client link it to the build's
     * timeline. Readers that don't know about it still show the text.
     */
    foreman?: { build: string; kind: string };
    /**
     * Present ONLY on Michael's announcement of a new review card
     * (src/review/announce.ts): its push opens that card (/?review=<id>).
     */
    review?: { item: string };
    /**
     * Present ONLY on an inline search card (src/search/): the query, who ran
     * it, and the bounded results. Its presence makes the app render the card;
     * `text` carries the plain-text twin for every other reader.
     */
    search?: SearchCardMeta;
    /**
     * Present ONLY on a live-studio card (src/studio/): a job's working card,
     * or a decision with 1–4 lettered options (the user's own media). Its
     * presence makes the app render the card; `text` is the plain twin.
     */
    studio?: StudioCardMeta;
  };
  media?: MediaRef;
  /**
   * Every attachment travelling with this message, in send order.
   *
   * Design lock v4: words and cargo are ONE message, so a caption and its
   * files share a single record and a single agent turn — they can never
   * arrive separately or out of order. `media` stays populated with the
   * FIRST item, so every existing single-media path (voice notes, a lone
   * photo, the voice-media upsert) keeps working untouched and older
   * clients still render something sensible.
   *
   * Absent on text and single-attachment messages — those are byte-identical
   * to what they were before staging existed.
   */
  mediaList?: MediaRef[];
}

const wss = new WebSocketServer({ noServer: true });

// Periodically drop expired unacked deliveries so the hub can't accumulate
// stale base64 audio for users who never reconnect. Cheap; runs forever.
setInterval(() => deliveryHub.sweep(), 30_000).unref?.();

// ── Test seam (auth only) ─────────────────────────────────────────────
//
// The voice-mode socket tests drive a REAL ws client/server pair through the
// REAL upgrade path, because the thing under test is this file's wiring. The
// one step they cannot reproduce is the token lookup: `lookupByToken` loads
// `config/users.json`, a gitignored secrets file that does not exist in a
// checkout, and THROWS when it is missing — so an upgrade could never
// complete under test.
//
// This override replaces the token→user lookup and nothing else. The HTTP
// upgrade, the ws handshake, the connection handler, every message handler
// and the whole voice path below stay exactly as production runs them. It is
// null in production, where `resolveUser` is unchanged.
type SocketAuthResolver = (req: IncomingMessage) => UserConfig | null;
let testAuthResolver: SocketAuthResolver | null = null;

/** TEST ONLY. Pass null to restore real token authentication. */
export function __setSocketAuthForTests(fn: SocketAuthResolver | null): void {
  testAuthResolver = fn;
}

/**
 * Resolve the request's bearer token from query string or cookie and
 * look it up in the user registry. Returns the matched user or null.
 * Cookie name is `ahi_token` to match the dashboard login flow.
 */
function resolveUser(req: IncomingMessage): UserConfig | null {
  if (testAuthResolver) return testAuthResolver(req);
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const qToken = url.searchParams.get("token");
  if (qToken) {
    const u = lookupByToken(qToken);
    if (u) return u;
  }
  const cookies = req.headers.cookie || "";
  const match = cookies.match(/ahi_token=([^;]+)/);
  if (match) {
    const u = lookupByToken(decodeURIComponent(match[1]));
    if (u) return u;
  }
  return null;
}

wss.on("connection", (ws, req: IncomingMessage) => {
  // User was resolved during upgrade; re-resolve as a safety net in
  // case something in the upgrade flow lost it. Unauthenticated sockets
  // never reach this handler (handleUpgrade rejects them with 401).
  const user = socketUsers.get(ws) || resolveUser(req);
  if (!user) {
    try {
      ws.close(4401, "unauthorized");
    } catch {
      /* noop */
    }
    return;
  }
  socketUsers.set(ws, user);

  // Announce the authenticated identity to the client so the UI can
  // render only the agents this user is allowed to see.
  try {
    ws.send(JSON.stringify({
      type: "session",
      user: toPublic(user),
      // Which agents this user can actually enter voice mode with. The
      // composer renders the voice button only for these.
      voiceBots: voiceEnabledBotsFor(user),
      // Which of those call over ElevenLabs (voice/eleven/config.ts). Absent
      // while that transport is off, so a native call's session is unchanged.
      ...(elevenBotsAmong(voiceEnabledBotsFor(user)).length ? { elevenBots: elevenBotsAmong(voiceEnabledBotsFor(user)) } : {}),
    }));
  } catch {
    /* noop */
  }

  // Send persisted history on connect — ONLY this user's threads with
  // agents they're allowed to see. Last 100 across their allowed bots,
  // merged and time-sorted.
  const history: MessageEvent[] = [];
  for (const bot of user.agents) {
    history.push(...getMessagesForUser(bot, user.userId, 100));
  }
  history.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  ws.send(JSON.stringify({ type: "history", messages: history.slice(-100) }));

  // Replay any unacked deliveries for this user that a previous (now-closed)
  // socket never confirmed — e.g. a `voice-tts` payload that was generated
  // while the PWA was backgrounded. Sent AFTER history so the client already
  // has its base transcript; clients dedupe `message` events by messageId and
  // ACK each delivery, so replay is idempotent. (P0 ACK/replay.)
  try {
    for (const delivery of deliveryHub.pending(user.userId)) {
      ws.send(JSON.stringify(delivery.payload));
    }
  } catch {
    /* noop — a failed replay is recovered from disk history anyway */
  }

  // Inbound handler — routes JSON control messages AND binary audio
  // frames arriving from the PWA's Voice Mode. Plain text chat still
  // goes through the HTTP /app/send path; WS inbound is a voice-only
  // channel. Silent drop for unknown shapes.
  ws.on("message", async (raw, isBinary) => {
    lastInboundAt.set(ws, Date.now());
    if (isBinary) {
      const session = voiceSessions.get(ws);
      // No native call on this socket: an ElevenLabs call's side ear, or nothing.
      if (!session) {
        feedEar(ws, Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
        return;
      }
      // Muted means muted. Dropped before it can reach the recognizer, and
      // before it can be queued for one — audio captured while the user
      // believes the mic is off must not be transcribed, buffered, or billed.
      if (session.muted) return;
      feedSessionAudio(session, Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const type = parsed.type as string;
    if (type === "ping") {
      // App-level keepalive (ws.ts). Answered since voice step 2: the app
      // tells a live socket from a dead one by the pong, and a dead one under
      // a call is dropped and reopened at once — the call resumes by id.
      safeSend(ws, { type: "pong" });
      return;
    }

    if (type === "ack") {
      // Client confirms it applied/played a delivery — stop replaying it.
      const deliveryId = typeof parsed.deliveryId === "string" ? parsed.deliveryId : "";
      const acker = socketUsers.get(ws);
      if (acker && deliveryId) deliveryHub.ack(acker.userId, deliveryId);
      return;
    }

    if (type === "voice-start") {
      handleVoiceStart(ws, parsed);
      return;
    }
    if (type === "voice-end") {
      await handleVoiceEnd(ws);
      return;
    }
    if (type === "voice-tentative-pause") {
      handleVoiceTentativePause(ws, parsed);
      return;
    }
    if (type === "voice-tentative-resume") {
      handleVoiceTentativeResume(ws, parsed);
      return;
    }
    if (type === "eleven-ear-start" || type === "eleven-ear-stop") {
      const user = socketUsers.get(ws);
      if (user) handleEarControl(ws, user.userId, parsed);
      return;
    }
    if (type === "voice-standby") {
      // FINAL's Standby button: the same floor move as "Michael, go to sleep" / "wake up".
      // The floor reports itself (voice-floor), so the app's header and button follow the real state.
      const session = voiceSessions.get(ws);
      if (!session || parsed.voiceStreamId !== session.voiceStreamId) return;
      if (parsed.on === true) session.floor.sleep();
      else session.floor.wakeUp();
      console.log(`[voice] ${session.voiceStreamId} ${parsed.on === true ? "standby (button)" : "resumed (button)"}`);
      return;
    }
    if (type === "voice-mute") {
      // No ack: the client has already muted its own uplink and does not wait
      // on us. This is the second lock on the same door — see VoiceSession.
      const session = voiceSessions.get(ws);
      if (!session) muteEar(ws, parsed.on === true);
      if (session) {
        session.muted = parsed.on === true;
        // Logged so the next "it stopped hearing me" has a mute timeline.
        console.log(`[voice] ${session.voiceStreamId} ${session.muted ? "muted" : "unmuted"}`);
        checkpointCall(session);
      }
      return;
    }
    if (type === "voice-cancel") {
      handleVoiceCancel(ws, parsed);
      return;
    }
    if (type === "voice-session-record") {
      handleVoiceSessionRecord(ws, parsed);
      return;
    }
    if (type === "call-drop") {
      void handleCallDrop(ws, parsed);
      return;
    }
    if (type === "screen-share") {
      const session = voiceSessions.get(ws);
      if (!session) {
        // An ElevenLabs call has no native session: its share is held per call (eleven/side.ts).
        const user = socketUsers.get(ws);
        if (user) handleScreenControl(user.userId, parsed);
        return;
      }
      // B5: sharing is for THE call that asked for it. A late picker from a
      // call that already ended must not start sharing into the next one on
      // this socket. Stopping is always allowed.
      if (parsed.on === true && parsed.voiceStreamId !== session.voiceStreamId) {
        console.warn(`[voice-screen] ${session.voiceStreamId} rejected a share for another call`);
        return;
      }
      if (parsed.on === true) {
        // A review still waiting on the last share's sentence goes now: a new share starts clean (Codex r2).
        session.screenRecord?.stopping?.finish();
        session.screen ??= { frame: null, frames: 0, since: Date.now(), watch: new ScreenWatch() };
        session.screen.watch.surface = parseSurface(parsed.surface);
        console.log(`[voice-screen] ${session.voiceStreamId} sharing ON (${session.screen.watch.surface})`);
      } else if (session.screen) {
        const secs = Math.round((Date.now() - session.screen.since) / 1000);
        console.log(`[voice-screen] ${session.voiceStreamId} sharing OFF after ${secs}s, ${session.screen.frames} frame(s) received`);
        const shared = session.screen;
        const drop = (): void => {
          shared.watch.clear();
          if (session.screen === shared) session.screen = null;
        };
        // Sharing stopped mid-recording: he is done showing. The clip is reviewed, then everything goes.
        if (shared.watch.recording && session.screenRecord) session.screenRecord.stop("", "share-off", drop);
        else drop();
      }
      return;
    }
    if (type === "screen-record") {
      // The REC button. Only for THIS call's share; the gateway owns the state and tells the app.
      const session = voiceSessions.get(ws);
      if (!session || parsed.voiceStreamId !== session.voiceStreamId || !session.screenRecord) return;
      if (parsed.on === true) session.screenRecord.start("button");
      else if (parsed.cancel === true) session.screenRecord.cancel("button");
      else session.screenRecord.stop("", "button");
      return;
    }
    if (type === "screen-frame") {
      // Accepted only while sharing is on: nothing is held unless he chose
      // to share. Validated and size-capped; the pixels are never logged.
      const session = voiceSessions.get(ws);
      if (!session) {
        const user = socketUsers.get(ws);
        if (user) handleScreenControl(user.userId, parsed);
        return;
      }
      if (!session.screen) return;
      if (parsed.voiceStreamId !== session.voiceStreamId) return; // B5: another call's capture
      const frame = session.screen.watch.addFrame(parsed);
      if (!frame) {
        console.warn(`[voice-screen] ${session.voiceStreamId} rejected an off-shape frame`);
        return;
      }
      session.screen.frame = session.screen.watch.latest();
      session.screen.frames++;
      return;
    }
    if (type === "voice-mic-error") {
      // A call that could not open the mic (web/src/lib/voicemode.ts). There
      // is no voice session yet, so this is logged against the socket's user.
      // Error NAMES and short tokens only; nothing is stored.
      console.log(`[voice-mic] ${formatVoiceMicError(socketUsers.get(ws)?.userId ?? "?", parsed)}`);
      return;
    }
    if (type === "voice-client-event") {
      // The app's view of its own playback (web/src/lib/voicebus.ts): cuts
      // and their reasons, audio-context and output-device changes, and what
      // a turn scheduled. Numbers and short tokens only — anything else is
      // dropped, and nothing here is stored beyond the log line.
      const session = voiceSessions.get(ws);
      if (!session) return;
      const line = formatVoiceClientEvent(session.voiceStreamId, parsed);
      if (line) console.log(line);
      return;
    }
    if (type === "voice-interrupt") {
      const session = voiceSessions.get(ws);
      const heard = typeof parsed.heardSec === "number" && Number.isFinite(parsed.heardSec) && parsed.heardSec >= 0 ? parsed.heardSec : undefined;
      if (session) interruptSession(session, "the app", "barge-in", heard);
      try {
        ws.send(JSON.stringify({ type: "voice-interrupt-ack" }));
      } catch {
        /* noop */
      }
      return;
    }
  });

  ws.on("close", (code: number, reason: Buffer | string) => {
    socketGone(ws);
    const session = voiceSessions.get(ws);
    voiceSessions.delete(ws);
    if (session) {
      // Step 0 (voice-speed): every app door that closes under a call, with
      // what it last did and whether the gateway itself was stalling.
      console.log(doorCloseLine("app", session.voiceStreamId, code, reason?.toString() ?? "", lastInboundAt.get(ws) ?? 0, ws.bufferedAmount));
      // The socket closed under the call. The code is the browser's (1001
      // page gone, 1006 no close frame = network), or ours (1012 restart). A
      // client that hangs up on purpose sends voice-cancel first and this is
      // not reached with a session still filed. Since always-on slice 1 the
      // call does not end here: it is parked for the resume grace window, and
      // ends with by=transport only if no socket claims it in time.
      const detail = reason?.toString() ?? "";
      if (resumeGraceMs() > 0 && !session.ending) parkSession(session, code, detail);
      else {
        session.ending ??= { by: "transport", why: "socket-closed", code, detail };
        void teardownVoiceSession(session);
      }
    }
    socketUsers.delete(ws);
  });
});

/**
 * Everything toward the app for one call. The live socket is read HERE, at
 * send time, never captured: a parked call holds what matters for the socket
 * that resumes it, and a call that is gone drops it.
 */
function deliverToApp(voiceStreamId: string, item: { json?: Record<string, unknown>; pcm?: Buffer }): void {
  const session = voiceSessionsById.get(voiceStreamId);
  if (!session || session.channel !== "app") return;
  if (session.ws) {
    if (item.json) safeSend(session.ws, item.json);
    else if (item.pcm) sendVoiceAudioFrame(session.ws, item.pcm);
    return;
  }
  const parked = session.parked;
  if (!parked) return;
  if (item.json) {
    const type = typeof item.json.type === "string" ? item.json.type : "";
    if (!HELD_EVENT_TYPES.has(type)) return;
    const bytes = JSON.stringify(item.json).length;
    // Text always fits: make room by dropping held audio, oldest first.
    while (parked.held.length && (parked.held.length >= MAX_HELD_ITEMS || parked.heldBytes + bytes > MAX_HELD_BYTES)) {
      const i = parked.held.findIndex((h) => "pcm" in h);
      if (i < 0) break;
      parked.heldBytes -= parked.held[i].bytes;
      parked.held.splice(i, 1);
      parked.audioDropped = true;
    }
    if (parked.held.length >= MAX_HELD_ITEMS) return;
    parked.held.push({ json: item.json, bytes });
    parked.heldBytes += bytes;
    return;
  }
  if (item.pcm) {
    if (parked.held.length >= MAX_HELD_ITEMS || parked.heldBytes + item.pcm.length > MAX_HELD_BYTES) {
      parked.audioDropped = true;
      return;
    }
    parked.held.push({ pcm: item.pcm, bytes: item.pcm.length });
    parked.heldBytes += item.pcm.length;
  }
}

/**
 * The socket under a call closed. Instead of ending the call, PARK it: keep
 * the session (its recognizer, its composer, the turn in flight, the thread)
 * for the grace window, hold what the app would have received, and end it
 * honestly only if nobody resumes. The call-end line then says how long the
 * call waited and how often it had been resumed before.
 */
function parkSession(session: VoiceSession, code: number, detail: string): void {
  // The hold follows what he was doing when the door closed: muted or on
  // standby is the long one. The app picks the same one from the same state.
  const quiet = session.muted || session.floor.snapshot().state === "standby";
  const grace = quiet ? quietResumeGraceMs() : resumeGraceMs();
  const key = {};
  session.ws = null;
  session.key = key;
  voiceSessions.set(key, session);
  // A thought still inside the composer's hold at the drop is half-heard: its
  // tail never arrived. It is dropped, as it always was; turns already
  // dispatched keep running and their output is held for the resume.
  session.composer.reset();
  session.lastPartial = "";
  session.speechSeen = false;
  session.utteranceStartedAt = null;
  const timer = setTimeout(() => {
    if (session.parked?.key !== key || voiceSessions.get(key) !== session) return;
    session.ending ??= { by: "transport", why: "socket-closed", code, detail };
    voiceSessions.delete(key);
    void teardownVoiceSession(session);
  }, grace);
  timer.unref?.();
  session.parked = { since: Date.now(), key, timer, held: [], heldBytes: 0, audioDropped: false, code, detail };
  // What was on air is the boundary the resume settles (voice/mouth.ts).
  mouthFor(session.voiceStreamId)?.doorClosed();
  console.log(
    `[voice] ${session.voiceStreamId} parked: socket closed (code=${code}) with ${turnsInFlight(session.voiceStreamId)} turn(s) in flight; resumable for ${Math.round(grace / 1000)}s${quiet ? ` (${session.muted ? "muted" : "standby"})` : ""}`,
  );
}

/**
 * A socket claims a call by id: the parked call (or one still attached to a
 * socket the client has already given up on) moves to this socket, and the
 * held output is replayed in order behind a resume snapshot.
 */
function attachSession(session: VoiceSession, ws: WebSocket, user: UserConfig | null, report: DoorReport = { lost: false }): void {
  const now = Date.now();
  const parked = session.parked;
  let heldEvents = 0;
  let heldAudio = 0;
  if (parked) {
    clearTimeout(parked.timer);
    voiceSessions.delete(parked.key);
    session.gapMs += now - parked.since;
    session.parked = null;
  } else if (session.ws && session.ws !== ws) {
    // Takeover: the old socket is still open as far as we know (the client saw
    // the drop first). Unfile it so its eventual close does not end this call.
    voiceSessions.delete(session.ws);
  }
  session.resumed++;
  session.ws = ws;
  session.key = ws;
  session.user ??= user;
  checkpointCall(session);
  voiceSessions.set(ws, session);
  socketsThatCalled.add(ws);
  safeSend(ws, {
    type: "voice-started",
    voiceStreamId: session.voiceStreamId,
    bot: session.bot,
    resumed: true,
    resumedCount: session.resumed,
    gapMs: session.gapMs,
    working: describeWork(session.voiceStreamId),
    floor: session.floor.snapshot(),
    muted: session.muted,
    heldAudioDropped: parked?.audioDropped ?? false,
    textFollowsVoice: callTextFollowsVoice(),
    hold: holdSnapshot(),
  });
  // The app says how far it played the reply that was on when the door broke,
  // and whether that audio survived (voicelayer.ts). If it did not, the
  // mouth re-says from the start of that sentence — once — before what was held.
  const mouth = mouthFor(session.voiceStreamId);
  if (mouth && !parked) mouth.doorClosed();
  const resay = mouth?.reattached(report) ?? null;
  if (resay) {
    safeSend(ws, { type: "voice-tts-start", voiceStreamId: session.voiceStreamId, bot: session.bot, sampleRate: resay.sampleRate, resay: true });
    const step = Math.max(2, Math.round(resay.sampleRate / 10) * 2); // 100 ms frames
    for (let off = 0; off < resay.pcm.length; off += step) sendVoiceAudioFrame(ws, resay.pcm.subarray(off, Math.min(resay.pcm.length, off + step)));
    if (resay.close) safeSend(ws, { type: "voice-tts-done", voiceStreamId: session.voiceStreamId, bot: session.bot });
  }
  if (parked) {
    for (const h of parked.held) {
      if ("json" in h) {
        heldEvents++;
        safeSend(ws, h.json);
      } else {
        heldAudio += h.bytes;
        sendVoiceAudioFrame(ws, h.pcm);
      }
    }
    parked.held = [];
    parked.heldBytes = 0;
  }
  // What was held is out: the next lane may go on air (voice/mouth.ts).
  mouth?.doorOpen();
  console.log(
    `[voice] ${session.voiceStreamId} resumed on a new socket (#${session.resumed}, gap ${Math.round((parked ? now - parked.since : 0) / 1000)}s, total ${Math.round(session.gapMs / 1000)}s)` +
      (parked ? `: replayed ${heldEvents} event(s), ${Math.round(heldAudio / 1024)} kB audio${parked.audioDropped ? ", some audio dropped" : ""}` : " (takeover)"),
  );
}

/**
 * The app's account of the reply that was playing when its door broke
 * (`voice-start` resume, `played: {sec, lost}`). An older app sends nothing:
 * nothing lost, as before.
 */
export function doorReportFrom(raw: unknown): DoorReport {
  if (!raw || typeof raw !== "object") return { lost: false };
  const p = raw as { sec?: unknown; lost?: unknown };
  const sec = typeof p.sec === "number" && Number.isFinite(p.sec) && p.sec >= 0 ? p.sec : null;
  return { lost: p.lost === true, heardSec: sec };
}

function handleVoiceStart(ws: WebSocket, msg: Record<string, unknown>): void {
  const bot = typeof msg.bot === "string" ? msg.bot : "";
  const voiceStreamId =
    typeof msg.voiceStreamId === "string"
      ? msg.voiceStreamId
      : `voice-${Date.now()}`;
  if (!bot) return;
  const audioRoute = typeof msg.audio_route === "string" ? msg.audio_route : "builtin_mic_only";
  const speculationEnabled = msg.speculation_enabled === true;
  const forceSpeculationOnBluetooth = msg.force_speculation_on_bluetooth === true;

  // Voice mode is off for this agent — refuse before opening anything. This
  // is the authoritative gate: the UI hides the button, but a stale client
  // still holding one must not be able to start a session (or spend credits)
  // against a disabled backend.
  if (!isVoiceModeEnabled(bot)) {
    console.warn(`[voice] voice-start refused — voice mode disabled for ${bot}`);
    safeSend(ws, {
      type: "voice-error",
      voiceStreamId,
      bot,
      error: "Voice mode is not enabled for this agent.",
    });
    return;
  }

  // Deny voice-start for agents the user isn't allowed to talk to.
  const user = socketUsers.get(ws);
  if (user && !userCanAccessAgent(user, bot)) {
    safeSend(ws, {
      type: "voice-error",
      voiceStreamId,
      bot,
      error: `You don't have access to ${bot}`,
    });
    return;
  }

  // A `voice-start` naming a call that already exists is one of three things:
  // the next utterance of the call on this very socket (a no-op: tearing the
  // provider stream down per utterance would throw away ink-2's native turn
  // detection); a RESUME of a parked call from a socket that reconnected
  // (always-on, slice 1); or a takeover from a socket the client gave up on
  // before we saw it close. Never another user's call.
  const existing = voiceSessionsById.get(voiceStreamId);
  if (existing && existing.channel === "app" && existing.bot === bot) {
    if (existing.user && user && existing.user.userId !== user.userId) {
      console.warn(`[voice] ${voiceStreamId} resume refused: another user's call`);
      safeSend(ws, { type: "voice-error", voiceStreamId, bot, code: "not-your-call", error: "That call belongs to another account." });
      return;
    }
    if (existing.ws === ws) {
      safeSend(ws, { type: "voice-started", voiceStreamId, bot, textFollowsVoice: callTextFollowsVoice(), hold: holdSnapshot() });
      return;
    }
    const other = voiceSessions.get(ws);
    if (other && other !== existing) {
      other.ending ??= { by: "server", why: "replaced-by-new-call" };
      voiceSessions.delete(ws);
      void teardownVoiceSession(other);
    }
    attachSession(existing, ws, user ?? null, doorReportFrom(msg.played));
    return;
  }
  if (msg.resume === true && restorableCalls.has(voiceStreamId)) {
    resumeRestoredCall(ws, user ?? null, { bot, audioRoute, speculationEnabled, forceSpeculationOnBluetooth }, restorableCalls.get(voiceStreamId)!);
    return;
  }
  if (msg.resume === true) {
    // The client is resuming a call we no longer have: the grace window ran
    // out, or a restart left no checkpoint for it. Say so; the app ends the call honestly.
    console.log(`[voice] ${voiceStreamId} resume refused: no such call (expired or restarted)`);
    safeSend(ws, { type: "voice-error", voiceStreamId, bot, code: "no-such-call", error: "That call ended while the connection was down." });
    return;
  }
  const prior = voiceSessions.get(ws);
  if (prior) {
    prior.ending ??= { by: "server", why: "replaced-by-new-call" };
    void teardownVoiceSession(prior);
  }

  startCallSession(ws, appTransport(voiceStreamId, bot), {
    bot,
    voiceStreamId,
    user: user ?? null,
    audioRoute,
    speculationEnabled,
    forceSpeculationOnBluetooth,
  });

  // This socket has now genuinely made a call, which is the precondition for
  // writing a call card later — see handleVoiceSessionRecord.
  socketsThatCalled.add(ws);

  safeSend(ws, { type: "voice-started", voiceStreamId, bot, textFollowsVoice: callTextFollowsVoice(), hold: holdSnapshot() });
  // Warm the TTS socket now, while the user is still drawing breath, so the
  // first reply does not pay the handshake. Deliberately NOT fired on the
  // repeat-`voice-start` path above: that is the next utterance of a call
  // already in progress, and its socket is already up.
  voiceSessionOpenHandler?.({ botName: bot, voiceStreamId, userName: user?.name });
}

/**
 * Does the call screen show a reply as it is spoken (voice-streaming-bargein)?
 * Sent to the app on every `voice-started`; CALL_TEXT_FOLLOWS_VOICE=off gives
 * back the old read-ahead without a web release.
 */
export function callTextFollowsVoice(env: NodeJS.ProcessEnv = process.env): boolean {
  return !["off", "false", "0", "no"].includes((env.CALL_TEXT_FOLLOWS_VOICE ?? "").toLowerCase());
}

/**
 * The app's socket as a call transport: JSON events and binary PCM frames,
 * exactly the messages the PWA has always received.
 */
function appTransport(callId: string, bot: string): CallTransport {
  const json = (msg: Record<string, unknown>): void => deliverToApp(callId, { json: msg });
  // The call's one mouth (voice/mouth.ts): every lane goes on air through it,
  // on the call's playout clock (echo-window.ts) from the moment it is really sent.
  const mouth = new CallMouth({
    callId,
    open: () =>
      withPlayoutClock(callId, {
        start: (sampleRate) => json({ type: "voice-tts-start", voiceStreamId: callId, bot, sampleRate }),
        frame: (pcm) => deliverToApp(callId, { pcm }),
        words: (wt) => json({ type: "voice-tts-words", voiceStreamId: callId, bot, words: wt.words, start: wt.start, end: wt.end }),
        done: () => json({ type: "voice-tts-done", voiceStreamId: callId, bot }),
        filler: (text) => json({ type: "voice-filler", voiceStreamId: callId, bot, text }),
      }),
  });
  registerMouth(callId, mouth);
  return {
    kind: "app",
    event: (msg) => {
      // The app stops what it had queued when a real turn starts (voicebus.ts
      // resetVoiceTurnAudio on `voice-thinking`): the mouth's clock follows.
      // The cut event goes FIRST: a line the cut releases must reach the app after it, not be erased by it.
      json(msg);
      if (msg.type === "voice-thinking") mouth.listenerCut();
    },
    audioOut: (ids) => mouth.lane({ turnId: ids.turnId ?? "turn", priority: ids.priority ?? "turn", label: ids.label ?? "turn", text: ids.text }),
  };
}

/**
 * Open a call on any transport other than the app's socket — the phone leg
 * (phone/stream.ts). Same gates as the app's voice-start: voice mode on for
 * the agent, and the user allowed to reach it. The returned handle is the
 * transport's uplink; the session is filed under it.
 */
export function openCall(
  transport: CallTransport,
  opts: {
    bot: string;
    user: UserConfig;
    voiceStreamId: string;
    interceptTurn?: (text: string) => boolean;
    mayDraft?: () => boolean;
    direction?: "inbound" | "outbound";
  },
): CallAudioIn | { error: string } {
  if (!isVoiceModeEnabled(opts.bot)) return { error: `voice mode is off for ${opts.bot}` };
  if (!userCanAccessAgent(opts.user, opts.bot)) return { error: `${opts.user.userId} cannot reach ${opts.bot}` };
  if (voiceSessionsById.has(opts.voiceStreamId)) return { error: "call already open" };

  let session: VoiceSession | null = null;
  const handle: CallAudioIn = {
    voiceStreamId: opts.voiceStreamId,
    audio: (pcm) => {
      if (session && voiceSessions.get(handle) === session && !session.muted) feedSessionAudio(session, pcm);
    },
    endUtterance: async () => {
      if (session && voiceSessions.get(handle) === session) await endSessionUtterance(session);
    },
    speechResumed: () => {
      if (session && voiceSessions.get(handle) === session && callAnchorLast()) session.speechEndedAt = null;
    },
    interrupt: () => {
      if (session && voiceSessions.get(handle) === session) interruptSession(session, "the phone");
    },
    reattached: (gapMs: number) => {
      if (!session || voiceSessions.get(handle) !== session) return;
      session.resumed++;
      session.gapMs += Math.max(0, gapMs);
    },
    hangup: async (why?: string) => {
      if (!session || voiceSessions.get(handle) !== session) return;
      // The call is over: stop the agent turn in flight and every turn queued
      // behind it BEFORE tearing down — nothing may keep running tools for a
      // line nobody is on.
      interruptSession(session, "the hang-up", "hangup");
      session.ending ??= { by: "phone", why: callEndToken(why) ?? "hangup" };
      voiceSessions.delete(handle);
      await teardownVoiceSession(session);
    },
  };
  session = startCallSession(handle, transport, {
    bot: opts.bot,
    voiceStreamId: opts.voiceStreamId,
    user: opts.user,
    // A phone has no client to speculate from (no tentative pauses arrive).
    audioRoute: transport.kind === "phone" ? "phone" : "builtin_mic_only",
    speculationEnabled: false,
    forceSpeculationOnBluetooth: false,
    interceptTurn: opts.interceptTurn,
    mayDraft: opts.mayDraft,
    direction: opts.direction,
  });
  voiceSessionOpenHandler?.({ botName: opts.bot, voiceStreamId: opts.voiceStreamId, userName: opts.user.name });
  return handle;
}

/**
 * The call core: one recognizer, one composer, one dispatch point — for every
 * transport. Files the session under `key` (the app's socket, or a phone
 * call's handle) and starts the STT.
 */
function startCallSession(
  key: object,
  transport: CallTransport,
  opts: {
    bot: string;
    voiceStreamId: string;
    user: UserConfig | null;
    audioRoute: string;
    speculationEnabled: boolean;
    forceSpeculationOnBluetooth: boolean;
    interceptTurn?: (text: string) => boolean;
    mayDraft?: () => boolean;
    direction?: "inbound" | "outbound";
    /** What a call resumed after a gateway restart carries over (restoreLiveCalls). */
    carry?: Pick<VoiceSession, "startedAt" | "transcript" | "userTurns" | "muted" | "resumed" | "gapMs">;
  },
): VoiceSession {
  const { bot, voiceStreamId, user } = opts;
  // A new call under the id of a call held from before a restart: that call is
  // over. Card it now, before this one's checkpoint takes its file (a resume
  // has already claimed it and left nothing here to settle).
  settleRestoredCall(voiceStreamId);
  const composer = new TurnComposer();
  const session: VoiceSession = {
    bot,
    voiceStreamId,
    key,
    transport,
    interceptTurn: opts.interceptTurn ?? null,
    // A call with a passphrase gate and no say on drafting never drafts: the phrase must not reach a model.
    mayDraft: opts.mayDraft ?? (opts.interceptTurn ? () => false : null),
    channel: transport.kind,
    ...(opts.direction ? { direction: opts.direction } : {}),
    stt: null,
    pendingFrames: [],
    pendingBytes: 0,
    composer,
    lastPartial: "",
    speechSeen: false,
    utteranceStartedAt: null,
    speechEndedAt: null,
    lastBargeAt: 0,
    serverBarged: false,
    muted: false,
    audioRoute: opts.audioRoute,
    speculationEnabled: opts.speculationEnabled,
    forceSpeculationOnBluetooth: opts.forceSpeculationOnBluetooth,
    startedAt: Date.now(),
    tentativeFiredAt: null,
    user,
    transcript: [],
    userTurns: 0,
    recorded: false,
    screen: null,
    screenRecord: null,
    drops: null,
    dispatchDrops: null,
    ws: key instanceof WebSocket ? key : null,
    parked: null,
    resumed: 0,
    gapMs: 0,
    floor: new Floor({
      enabled: transport.kind === "app" && floorEnabled(),
      busy: () => turnsInFlight(voiceStreamId) > 0,
      onChange: (c) => {
        // The log explains every state change; the app mirrors it in its header.
        console.log(formatFloorChange(voiceStreamId, c));
        transport.event({ type: "voice-floor", voiceStreamId, bot, state: c.state, reason: c.reason, untilMs: c.untilMs });
      },
    }),
    ...opts.carry,
  };
  voiceSessions.set(key, session);
  voiceSessionsById.set(voiceStreamId, session);
  checkpointCall(session);
  // `session.key` moves when a call is parked and resumed (always-on): the
  // check must follow it, not the key this function was handed.
  const current = () => voiceSessions.get(session.key) === session;
  session.floor.start();

  // The live preview the PWA renders: everything buffered for this thought
  // so far, plus the hypothesis currently on the wire.
  const composeLive = (partial: string): string => {
    const buffered = composer.pendingText.trim();
    const live = partial.trim();
    if (buffered && live) return `${buffered} ${live}`;
    return buffered || live;
  };

  // ONE committed thought → ONE `stt-final` → ONE agent turn. This is the
  // only place a voice turn is dispatched.
  // A turn is what he said, what he dropped in, or both (part six). One
  // dispatch for all three, so a drop rides his next words as ONE turn.
  const dispatchTurn = (text: string, meta: TurnMeta | null, review: WatchPick | null = null): void => {
    if (!current()) return; // session was replaced
    // The phone's passphrase gate. Before the log line, the transcript and
    // the agent: a consumed turn leaves no trace anywhere.
    if (text && session.interceptTurn?.(text)) {
      session.lastPartial = "";
      session.speechSeen = false;
      session.utteranceStartedAt = null;
      return;
    }
    const heardAt = Date.now();
    const resetUtterance = (): void => {
      session.lastPartial = "";
      session.speechSeen = false;
      session.utteranceStartedAt = null;
      // Words that reached no turn are not the next turn's (screen-watch.ts).
      session.screen?.watch.discardWords();
    };
    // Record mode (voice/screen-watch.ts): while a recording runs, what he says
    // is part of the clip — shown and recorded, never answered — until he says
    // stop (one review turn) or cancel. The floor stays his throughout.
    if (!review && text && transport.kind === "app" && session.screen?.watch.recording && session.screenRecord) {
      session.floor.wake();
      if (matchRecordCancel(text)) {
        transport.event({ type: "stt-final", voiceStreamId, bot, text });
        appendVoiceTranscript(session, "user", text);
        session.screenRecord.cancel("voice");
        resetUtterance();
        return;
      }
      const stop = matchRecordStop(text);
      transport.event({ type: "stt-final", voiceStreamId, bot, text });
      appendVoiceTranscript(session, "user", text);
      session.lastPartial = "";
      session.speechSeen = false;
      session.utteranceStartedAt = null;
      // He had already stopped it (DONE, share-off, the limit) mid-sentence: that sentence was the last of the clip.
      if (session.screenRecord.stopping) {
        session.screenRecord.stopping.finish();
        return;
      }
      if (!stop) {
        session.speechEndedAt = null;
        console.log(`[voice-screen] ${voiceStreamId} recording: ${text.split(/\s+/).length} word(s) held, not answered`);
        return;
      }
      session.screenRecord.stop(stop.after, "voice");
      return;
    }
    if (text && transport.kind === "app" && !review) {
      // "Michael, go to sleep / wake up / go quiet", or the bare name: the
      // floor moves, one fixed line answers, and nothing reaches the thread.
      const command = floorCommand(text);
      if (command) {
        if (command === "sleep") session.floor.sleep();
        else if (command === "wake") session.floor.wakeUp();
        else {
          session.muted = true;
          console.log(`[voice] ${voiceStreamId} muted by voice`);
          checkpointCall(session);
          transport.event({ type: "voice-mute-state", voiceStreamId, bot, on: true });
        }
        console.log(`[floor] ${voiceStreamId} command ${command}`);
        const cmdUser = session.key instanceof WebSocket ? socketUsers.get(session.key) : session.user;
        if (cmdUser) voiceCommandHandler?.({ botName: bot, voiceStreamId, user: cmdUser, command, transport });
        resetUtterance();
        return;
      }
      if (!session.floor.isOpen) {
        // Standby: only the wake name, early, opens the floor. Anything else
        // was not said to him — not logged, not recorded, not answered (§6).
        if (!hasWakeName(text)) {
          console.log(formatAddress(voiceStreamId, { addressed: false, reason: "standby-no-name" }, Date.now() - heardAt));
          transport.event({ type: "voice-aside", voiceStreamId, bot, text, reason: "standby-no-name" });
          resetUtterance();
          return;
        }
        session.floor.wake();
      }
      if (isBareWakeName(text)) {
        // "Michael." — the floor is his; a short answer so he knows it, no model.
        session.floor.wake();
        console.log(formatAddress(voiceStreamId, { addressed: true, reason: "name" }, Date.now() - heardAt));
        const nameUser = session.key instanceof WebSocket ? socketUsers.get(session.key) : session.user;
        if (nameUser && turnsInFlight(voiceStreamId) === 0) voiceCommandHandler?.({ botName: bot, voiceStreamId, user: nameUser, command: "name", transport });
        transport.event({ type: "voice-gate", voiceStreamId, bot, verdict: "name", text });
        resetUtterance();
        return;
      }
      // Open floor: the two cheapest address rules (voice/address.ts).
      const verdict = judgeAddress(text);
      if (!verdict.addressed) {
        console.log(formatAddress(voiceStreamId, verdict, Date.now() - heardAt));
        transport.event({ type: "voice-aside", voiceStreamId, bot, text, reason: verdict.reason });
        resetUtterance();
        return;
      }
      if (verdict.reason === "name") console.log(formatAddress(voiceStreamId, verdict, Date.now() - heardAt));
    }
    // "Watch this" / "start recording", said to Michael: the recording starts
    // and he goes quiet; the words of this utterance open the clip.
    if (!review && text && transport.kind === "app" && screenRecordOn() && matchRecordStart(text)) {
      if (session.screen && session.screenRecord?.start("voice")) {
        transport.event({ type: "stt-final", voiceStreamId, bot, text });
        appendVoiceTranscript(session, "user", text);
        session.lastPartial = "";
        session.speechSeen = false;
        session.utteranceStartedAt = null;
        session.speechEndedAt = null;
        return;
      }
      if (!session.screen && /\b(?:start recording|record my screen|watch my screen)\b/i.test(text)) {
        // Asked for a recording with nothing shared: one fixed line, no model.
        const u = session.key instanceof WebSocket ? socketUsers.get(session.key) : session.user;
        transport.event({ type: "stt-final", voiceStreamId, bot, text });
        appendVoiceTranscript(session, "user", text);
        if (u) voiceCommandHandler?.({ botName: bot, voiceStreamId, user: u, command: "watch-share-first", transport });
        resetUtterance();
        return;
      }
    }
    if (review) text = text.trim() || REVIEW_ASK;
    const drops = takeDrops(session);
    if (!text && !drops.length) return;
    // He addressed Michael (or dropped something in): the floor is his, held
    // open while the turn runs.
    session.floor.userTurn();
    if (text) {
      console.log(
        "[ws-tx] stt-final (turn committed)",
        `${meta?.fragments ?? 1} fragment(s)`,
        JSON.stringify(text.slice(0, 120)),
        drops.length ? `+ ${drops.length} drop(s)` : "",
      );
      // A review's words were shown and recorded as he said them, during the recording.
      if (!review) transport.event({ type: "stt-final", voiceStreamId, bot, text });
    } else {
      console.log(`[voice-drop] ${voiceStreamId} turn from ${drops.length} drop(s) alone`);
    }

    // The user's half of the call record. Appended the moment the thought
    // commits, so a call that dies three turns in still has those three.
    if (!review) appendVoiceTranscript(session, "user", [text, drops.length ? dropSummary(drops) : ""].filter(Boolean).join(" "));

    // "Wait, stop." while he was audible, just after, or right after a barge-in:
    // an interrupt, never a turn (voice/server-barge.ts). Shown and recorded above; not answered.
    if (!review && text && !drops.length && stopInterruptOn() && isStopOnly(text)) {
      const mouth = mouthFor(voiceStreamId);
      const audible = !!mouth?.audible;
      const recentBarge = session.lastBargeAt > 0 && Date.now() - session.lastBargeAt <= STOP_AFTER_BARGE_MS;
      if (audible || recentBarge || heardDuringPlayout(voiceStreamId, session.utteranceStartedAt)) {
        // Whatever is audible or running now is cut, even if this utterance already cut an earlier
        // turn — newer work may have started since (Codex r2). Cutting work already cut is harmless.
        if (audible || turnsInFlight(voiceStreamId) > 0) cutCall(session, "a stop");
        console.log(`[voice] ${voiceStreamId} stop heard — an interrupt, not a turn${recentBarge ? " (after the barge-in)" : ""}`);
        session.speechEndedAt = null;
        session.lastPartial = "";
        session.speechSeen = false;
        session.utteranceStartedAt = null;
        session.tentativeFiredAt = null;
        return;
      }
    }
    session.userTurns++;
    checkpointCall(session);

    // The app's socket re-checks its live user (a closed socket has none);
    // any other transport carries the user it was opened for.
    const turnUser = session.key instanceof WebSocket ? socketUsers.get(session.key) : session.user;
    if (!turnUser) {
      console.warn("[voice] no authenticated user on socket — dropping utterance");
      return;
    }
    session.user ??= turnUser;
    if (!voiceTurnHandler) {
      console.warn("[voice] no voiceTurnHandler registered — dropping utterance");
      return;
    }
    // Always-on: the turn takes its frames once it knows whether it merges into the last one.
    const watch = session.screen && screenWatchOn() && !review ? session.screen.watch : null;
    const uttFrom = session.utteranceStartedAt;
    const userName = turnUser.name;
    voiceTurnHandler({
      screenFrame: session.screen?.frame ?? null,
      ...(watch ? { takeScreen: (merge: boolean) => watch.takeTurn({ merge, fallbackFrom: uttFrom, userName }) } : {}),
      ...(review ? { screenReview: review } : {}),
      ...(drops.length ? { drops } : {}),
      botName: session.bot,
      transcript: text,
      voiceStreamId: session.voiceStreamId,
      transport,
      user: turnUser,
      audioRoute: session.audioRoute,
      speculationEnabled: session.speculationEnabled,
      forceSpeculationOnBluetooth: session.forceSpeculationOnBluetooth,
      voiceStartedAt: session.startedAt,
      utteranceStartedAt: session.utteranceStartedAt,
      speechEndedAt: session.speechEndedAt,
      tentativeFiredAt: session.tentativeFiredAt,
    });
    session.speechEndedAt = null;
    const counts = socketVoiceTurnCounts.get(session.key) ?? new Map<string, number>();
    counts.set(session.bot, (counts.get(session.bot) ?? 0) + 1);
    socketVoiceTurnCounts.set(session.key, counts);
    session.lastPartial = "";
    session.speechSeen = false;
    session.utteranceStartedAt = null;
    session.tentativeFiredAt = null;
  };
  composer.onTurn = (text: string, meta: TurnMeta) => dispatchTurn(text, meta);
  session.dispatchDrops = () => dispatchTurn("", null);

  // Record mode (voice/screen-watch.ts). The gateway owns the recording; the
  // app shows the red dot and timer from `voice-screen-record`.
  const recordUser = (): UserConfig | null | undefined => (session.key instanceof WebSocket ? socketUsers.get(session.key) : session.user);
  session.screenRecord = {
    timer: null,
    stopping: null,
    tail: null,
    start: (how) => {
      const rec = session.screenRecord;
      const watch = session.screen?.watch;
      if (!rec || !watch || !screenRecordOn() || watch.recording || transport.kind !== "app") return false;
      watch.startRecording(how);
      // Michael goes quiet for it: whatever he was saying or doing stops now.
      if (mouthFor(voiceStreamId)?.audible || turnsInFlight(voiceStreamId) > 0) cutCall(session, "a recording");
      // No clock by default: the recording runs until he stops it (DONE, "stop recording", share-off, hang-up).
      // Only an explicit CALL_SCREEN_RECORD_MAX_SEC arms a limit.
      if (watch.recordMaxMs > 0) {
        rec.timer = setTimeout(() => {
          console.log(`[voice-screen] ${voiceStreamId} recording reached its ${Math.round(watch.recordMaxMs / 1000)}s limit — reviewing it`);
          session.screenRecord?.stop("", "limit");
        }, watch.recordMaxMs);
        rec.timer.unref?.();
      }
      const startedAt = watch.recording!.startedAt;
      transport.event({ type: "voice-screen-record", voiceStreamId, bot, on: true, startedAt, how, ...(watch.recordMaxMs > 0 ? { maxSec: Math.round(watch.recordMaxMs / 1000) } : {}) });
      console.log(`[voice-screen] ${voiceStreamId} recording ON (${how})`);
      const u = recordUser();
      if (how === "voice" && u) voiceCommandHandler?.({ botName: bot, voiceStreamId, user: u, command: "watch", transport });
      return true;
    },
    stop: (ask, why = "voice", after) => {
      const rec = session.screenRecord;
      const watch = session.screen?.watch;
      if (rec?.stopping) {
        // Already stopping (DONE, then share-off): the same wait, one review; cleanup joins it (Codex r2).
        if (after) rec.stopping.after.push(after);
        return;
      }
      if (!rec || !watch?.recording) {
        after?.();
        return;
      }
      if (rec.timer) clearTimeout(rec.timer);
      rec.timer = null;
      // The red dot goes the moment he stops it.
      transport.event({ type: "voice-screen-record", voiceStreamId, bot, on: false, reason: "stopped" });
      const afters: Array<() => void> = after ? [after] : [];
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        if (rec.stopping) clearTimeout(rec.stopping.timer);
        const runAfters = rec.stopping?.after ?? afters;
        rec.stopping = null;
        // What was heard of a sentence still open joins the clip; its late final is the clip's tail, not a turn.
        const talking = composer.talking;
        if (watch.closeOpen() || talking) rec.tail = { armedAt: Date.now(), endedAt: talking ? null : Date.now() };
        // Every closed sentence is in the clip already (finals reach the watch before the composer):
        // nothing buffered may become a turn of its own.
        composer.reset();
        session.lastPartial = "";
        session.speechSeen = false;
        session.utteranceStartedAt = null;
        const u = recordUser();
        const clip = watch.stopRecording({ userName: u?.name });
        if (clip && current()) {
          console.log(formatPick(voiceStreamId, clip, "recording", ` · ${clip.durationSec.toFixed(1)}s recorded, ${clip.words.length} word(s), stopped by ${why}`));
          dispatchTurn(ask, null, clip);
        }
        for (const fn of runAfters) fn();
      };
      // Stopped mid-sentence (not by his words): the review waits for that sentence to land — while
      // he is still talking the wait goes on (checked each second; 60 s backstop); once he has stopped
      // talking, at most 3 s more for its transcript (Codex r3/r4: never review over him by the clock).
      const open = why !== "voice" && (composer.talking || composer.pending || session.lastPartial.trim() !== "");
      if (open) {
        console.log(`[voice-screen] ${voiceStreamId} recording stopped (${why}) mid-sentence — the review waits for it`);
        const stoppedAt = Date.now();
        let quietSince = composer.talking ? 0 : stoppedAt;
        const check = (): void => {
          if (done || !rec.stopping) return;
          const now = Date.now();
          if (composer.talking) quietSince = 0;
          else if (!quietSince) quietSince = now;
          // While he talks the review waits; the only hard ceiling is a backstop for a recognizer
          // that never reports the end of speech (Codex r4).
          if (now - stoppedAt >= stopWaitMaxMs() || (quietSince && now - quietSince >= 3_000)) return finish();
          rec.stopping.timer = setTimeout(check, 1000);
          rec.stopping.timer.unref?.();
        };
        rec.stopping = { finish, timer: setTimeout(check, 1000), after: afters };
        rec.stopping.timer.unref?.();
        return;
      }
      finish();
    },
    cancel: (why) => {
      const rec = session.screenRecord;
      if (rec?.timer) clearTimeout(rec.timer);
      if (rec) rec.timer = null;
      const afters = rec?.stopping?.after ?? [];
      if (rec?.stopping) {
        clearTimeout(rec.stopping.timer);
        rec.stopping = null;
      }
      // Drop the recording first, THEN any cleanup a share-off left waiting (it drops the screen) (Codex r2).
      const dropped = !!session.screen?.watch.cancelRecording();
      if (dropped) {
        // The rest of the sentence it was cancelled in is not a turn either.
        if (rec && (composer.talking || session.lastPartial.trim() !== "")) rec.tail = { armedAt: Date.now(), endedAt: composer.talking ? null : Date.now() };
        composer.reset();
        transport.event({ type: "voice-screen-record", voiceStreamId, bot, on: false, reason: "cancelled" });
        console.log(`[voice-screen] ${voiceStreamId} recording dropped (${why}), not reviewed`);
        const u = recordUser();
        if (u) voiceCommandHandler?.({ botName: bot, voiceStreamId, user: u, command: "watch-dropped", transport });
      }
      for (const fn of afters) fn();
    },
  };

  /** He paused: the fast layer drafts on what he has said so far (voice/gate-draft.ts). */
  const draftAt = (why: "speech-end" | "utterance", text: string): void => {
    if (!voiceDraftHandler || !current() || session.muted) return;
    // A recording is watched in silence: nothing is drafted until he stops it (voice/screen-watch.ts).
    if (session.screen?.watch.recording) return;
    if (session.mayDraft && !session.mayDraft()) return;
    if (transport.kind === "app" && !session.floor.isOpen) return;
    const t = text.trim();
    if (!t) return;
    const turnUser = session.key instanceof WebSocket ? socketUsers.get(session.key) : session.user;
    if (!turnUser) return;
    voiceDraftHandler({
      botName: session.bot,
      voiceStreamId: session.voiceStreamId,
      text: t,
      why,
      transport,
      user: turnUser,
    });
  };
  composer.onPending = (text: string) => draftAt("utterance", text);

  createVoiceStt(bot, {
    onSpeechStart: () => {
      // Nothing may commit under a speaker who is still talking.
      session.speechSeen = true;
      session.speechEndedAt = null;
      session.serverBarged = false;
      session.utteranceStartedAt ??= Date.now();
      session.screen?.watch.speechStart();
      composer.speechStart();
    },
    onPartial: (text) => {
      if (!current()) return;
      session.utteranceStartedAt ??= Date.now();
      session.lastPartial = text;
      // Each new word is stamped as it first appears: the screen watch aligns frames to it.
      session.screen?.watch.partial(text);
      const combined = composeLive(text);
      if (!combined) return;
      if (!session.floor.isOpen && !session.screen?.watch.recording) {
        // Standby: the name, early in the partial, opens the floor at once —
        // the rest of the sentence is then heard as addressed. Until then the
        // live preview stays off the screen: an overheard line is nobody's.
        if (!hasWakeName(text) && !hasWakeName(combined)) return;
        session.floor.wake();
      }
      maybeServerBarge(session, text);
      transport.event({ type: "stt-interim", voiceStreamId, bot, text: combined });
    },
    onSpeechEnd: () => {
      // The open sentence a stopped recording is waiting on has ended: its transcript gets 8 s from here.
      const tail = session.screenRecord?.tail;
      if (tail && tail.endedAt === null) tail.endedAt = Date.now();
      session.speechEndedAt ??= Date.now();
      composer.speechEnd();
      // What the recognizer has so far, before it closes the utterance: the earliest draft.
      if (session.lastPartial) draftAt("speech-end", composeLive(session.lastPartial));
    },
    onTurnEnd: (text, meta) => {
      session.lastPartial = "";
      // The late end of a sentence a stopped recording already reviewed (the very next final): shown
      // and recorded, never a turn — and never part of a recording started since. Before the standby
      // check, so it is consumed whatever the floor (Codex r3).
      if (session.screenRecord?.tail && !tailExpired(session.screenRecord.tail)) {
        session.screenRecord.tail = null;
        session.screen?.watch.final(""); // closes that utterance in the watch without counting it twice
        if (text.trim()) {
          transport.event({ type: "stt-final", voiceStreamId, bot, text });
          appendVoiceTranscript(session, "user", text);
          console.log(`[voice-screen] ${voiceStreamId} the recording's last sentence landed after its review — shown, not answered`);
        }
        session.speechSeen = false;
        session.utteranceStartedAt = null;
        return;
      }
      const recording = !!session.screen?.watch.recording;
      if (transport.kind === "app" && !recording && !session.floor.isOpen && text.trim() && !hasWakeName(text) && !hasWakeName(composer.pendingText)) {
        session.screen?.watch.final(""); // closes the utterance; an aside's words are nobody's
        // Standby, no name: an overheard fragment. It never enters the
        // composer — its hold would weld it onto the addressed sentence that
        // may follow ("…the plumber Michael, send the brief" puts the name
        // fifth and loses the wake). An aside now, and nothing kept.
        console.log(formatAddress(voiceStreamId, { addressed: false, reason: "standby-no-name" }, 0));
        transport.event({ type: "voice-aside", voiceStreamId, bot, text: text.trim(), reason: "standby-no-name" });
        session.speechSeen = false;
        session.utteranceStartedAt = null;
        return;
      }
      // His words over Michael, before the composer holds them: the closed
      // utterance is the barge signal a short "wait, stop" has (voice/server-barge.ts).
      maybeServerBarge(session, text);
      session.screen?.watch.final(text, Date.now(), typeof meta?.audioSec === "number" ? meta.audioSec : undefined);
      if (transport.kind === "phone") transport.event({ type: "stt-utterance", voiceStreamId, bot, text });
      // An utterance closed. It joins the buffered thought; the composer's
      // hold decides whether it is the end of one.
      composer.fragment(text, meta);
    },
    onError: (err) => {
      console.warn(`[voice] STT error (${session.stt?.provider ?? "starting"}):`, err.message);
    },
    onDegraded: (mode, reason) => {
      transport.event({ type: "stt-mode", voiceStreamId, bot, mode, reason });
    },
    // The recognizer's own health, told to the app so a call never goes deaf
    // without saying so. "reconnecting" is usually invisible (it heals in
    // well under a second); "lost" is the one the screen must show.
    onReconnecting: (reason) => {
      console.warn(`[voice] ${voiceStreamId} STT reconnecting (${reason})${session.muted ? " while muted" : ""}`);
      transport.event({ type: "stt-health", voiceStreamId, bot, state: "reconnecting" });
    },
    onRecovered: (attempt, lostMs = 0) => {
      console.log(`[voice] ${voiceStreamId} STT recovered on attempt ${attempt}${lostMs ? `, ${lostMs} ms of speech lost` : ""}`);
      if (lostMs > 0) {
        // B4: not an unqualified "ok" — some of what he said is gone.
        transport.event({
          type: "stt-health",
          voiceStreamId,
          bot,
          state: "ok",
          gap: true,
          lostMs,
          error: "I missed a few seconds while the line reconnected. Say that again?",
        });
        return;
      }
      transport.event({ type: "stt-health", voiceStreamId, bot, state: "ok" });
    },
    onLost: (reason) => {
      console.error(`[voice] ${voiceStreamId} STT lost, call cannot hear: ${reason}`);
      transport.event({
        type: "stt-health",
        voiceStreamId,
        bot,
        state: "lost",
        error: "I can't hear you right now. Hang up and call again.",
      });
    },
  })
    .then((stream) => {
      if (!current()) {
        // The session was superseded while we were connecting.
        void stream.close(bot);
        return;
      }
      session.stt = stream;
      console.log(`[voice] STT stream open for ${bot} via ${stream.provider}`);
      for (const frame of session.pendingFrames) stream.feed(frame);
      session.pendingFrames = [];
      session.pendingBytes = 0;
    })
    .catch((err: Error) => {
      console.error("[voice] could not open any STT stream:", err.message);
      transport.event({
        type: "voice-error",
        voiceStreamId,
        bot,
        error: "Speech recognition is unavailable right now.",
      });
    });

  return session;
}

/**
 * Caller audio into the session's recognizer.
 *
 * HOT PATH — 50 frames/sec per live voice session, on the same event loop
 * that is streaming the reply and its audio back. Nothing here may do real
 * work. `classifyVoiceNoise` used to run on every frame and its result was
 * never read by anything: a 512-bin DFT (~1ms measured per 20ms frame, ~5% of
 * a core per session) of pure latency. If server-side noise gating is wanted,
 * classify where the decision is made — not unconditionally, and not here.
 * Barge-in is decided client-side in the app from the mic worklet's RMS
 * (web/src/lib/voicemode.ts), and by phone/stream.ts on a phone call.
 */
function feedSessionAudio(session: VoiceSession, buf: Buffer): void {
  if (session.stt) {
    session.stt.feed(buf);
  } else if (session.pendingBytes < MAX_PENDING_FRAME_BYTES) {
    // The provider stream is still opening. Hold the audio rather than
    // dropping the user's first words; bounded so a stalled connect
    // cannot grow without limit.
    session.pendingFrames.push(buf);
    session.pendingBytes += buf.length;
  }
}

/**
 * The app barges like the phone (voice/server-barge.ts): his words — a live
 * preview or a closed utterance — while Michael is audible on the app cut
 * him, judged here by the phone's rule. Once per utterance. The phone keeps
 * its own detector (phone/stream.ts), which hears the same words.
 */
function maybeServerBarge(session: VoiceSession, text: string, now: number = Date.now()): void {
  if (session.transport.kind !== "app" || !serverBargeOn()) return;
  if (session.serverBarged || session.muted || !text.trim()) return;
  const mouth = mouthFor(session.voiceStreamId);
  if (!mouth?.audible) return;
  const w = bargeWindow(session.utteranceStartedAt ?? now, now);
  const v = judgeBarge(text, mouth.playedNear(w.at, w.backSec, w.aheadSec));
  if (!v.barge) {
    if (v.words) console.log(formatEchoVerdict(session.voiceStreamId, "app-barge", true, null, v.share, v.words));
    return;
  }
  session.serverBarged = true;
  cutCall(session, "the gateway");
}

/** Interrupt the turn and stop what the listener is playing (the app's own cut message; the phone clears its stream). */
function cutCall(session: VoiceSession, from: string): void {
  interruptSession(session, from);
  session.transport.event({ type: "voice-interrupt-ack", voiceStreamId: session.voiceStreamId, bot: session.bot });
}

/** A barge-in, from the app's button/mic or the phone's own detector. */
function interruptSession(session: VoiceSession, from: string, reason: "barge-in" | "hangup" = "barge-in", heardSec?: number): void {
  // A barge-in is decided by the listener's side; this line is the only
  // server-side trace that one happened.
  console.log(`[voice] ${session.voiceStreamId} ${reason === "hangup" ? "stop-all" : "barge-in"} from ${from}`);
  if (reason === "barge-in") session.lastBargeAt = Date.now();
  // Nothing on air or waiting may put audio back on top of the cut (voice/mouth.ts).
  mouthFor(session.voiceStreamId)?.cancel(reason);
  const user = session.key instanceof WebSocket ? socketUsers.get(session.key) : session.user;
  if (user && voiceInterruptHandler) {
    voiceInterruptHandler({
      botName: session.bot,
      voiceStreamId: session.voiceStreamId,
      transport: session.transport,
      user,
      ...(reason === "hangup" ? { reason } : {}),
      ...(heardSec !== undefined ? { heardSec } : {}),
    });
  }
}

function handleVoiceTentativePause(ws: WebSocket, msg: Record<string, unknown>): void {
  const session = voiceSessions.get(ws);
  const user = socketUsers.get(ws);
  if (!session || !user) return;
  const voiceStreamId = typeof msg.voiceStreamId === "string" ? msg.voiceStreamId : session.voiceStreamId;
  if (voiceStreamId !== session.voiceStreamId) return;
  const interimText = typeof msg.text === "string" ? msg.text.trim() : composeSessionTranscript(session);
  if (!interimText) return;
  // A speculated reply is generated without the screen or a waiting drop;
  // while either is in play, the real turn (which carries it) is the answer.
  if (session.screen || session.drops) return;
  session.tentativeFiredAt = Date.now();
  const counts = socketVoiceTurnCounts.get(ws) ?? new Map<string, number>();
  socketVoiceTurnCounts.set(ws, counts);
  voiceTentativeHandler?.({
    botName: session.bot,
    interimText,
    voiceStreamId: session.voiceStreamId,
    transport: session.transport,
    user,
    audioRoute: session.audioRoute,
    speculationEnabled: session.speculationEnabled,
    forceSpeculationOnBluetooth: session.forceSpeculationOnBluetooth,
    turnIndex: counts.get(session.bot) ?? 0,
  });
}

function handleVoiceTentativeResume(ws: WebSocket, msg: Record<string, unknown>): void {
  const session = voiceSessions.get(ws);
  const user = socketUsers.get(ws);
  if (!session || !user) return;
  const voiceStreamId = typeof msg.voiceStreamId === "string" ? msg.voiceStreamId : session.voiceStreamId;
  if (voiceStreamId !== session.voiceStreamId) return;
  voiceSpecCancelHandler?.({ voiceStreamId: session.voiceStreamId, reason: "manual_cancel" });
}

async function handleVoiceEnd(ws: WebSocket): Promise<void> {
  const session = voiceSessions.get(ws);
  if (!session) return;
  await endSessionUtterance(session);
}

/**
 * CALL_ANCHOR=first: the turn's clock counts from the first end of speech
 * even if the transport's VAD then heard him go on (step 4). Default: from
 * the last one — a resumed speaker clears the earlier end (voice step 5).
 */
function callAnchorLast(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CALL_ANCHOR ?? "last").trim().toLowerCase() !== "first";
}

async function endSessionUtterance(session: VoiceSession): Promise<void> {
  session.speechEndedAt ??= Date.now();
  // The client's VAD says this utterance ended. That is an UTTERANCE
  // boundary, not necessarily a THOUGHT boundary — which is the whole
  // lesson of the five-fragment opening. So we close the utterance with the
  // provider and hand the text to the composer; the composer's hold decides
  // whether the thought is finished and fires the turn (see composer.onTurn
  // in startCallSession, the single dispatch point).
  //
  // Providers with native turn detection have already emitted their turn and
  // treat this as advisory.
  if (session.stt) {
    await session.stt.endUtterance();
  } else {
    // Frames are still queued waiting for the stream to open; there is
    // nothing to close yet.
    session.composer.speechEnd();
  }

  // Nothing buffered and nothing transcribable — let the PWA reset to
  // listening. (With a thought still held, silence is expected: the hold is
  // deliberately waiting to see whether the user continues.)
  //
  // `speechSeen` is what keeps this honest on a native-turn provider. The
  // client's VAD commits on ITS silence window, which is shorter than ink-2's
  // turn_end_timeout — so at this point the model may still have the turn
  // open and simply not have returned the transcript yet. Reporting "empty"
  // there would tell the user their speech did not register moments before it
  // does.
  if (!session.composer.pending && !session.speechSeen) {
    session.transport.event({
      type: "voice-empty",
      voiceStreamId: session.voiceStreamId,
      bot: session.bot,
    });
  }
}

function composeSessionTranscript(session: VoiceSession): string {
  const buffered = session.composer.pendingText.trim();
  const tail = session.lastPartial.trim();
  return buffered && tail ? `${buffered} ${tail}` : buffered || tail;
}

/**
 * Append one turn to a call's server-side transcript.
 *
 * Bounded here, at the point of growth, rather than at the point of writing:
 * a long call must not be able to grow this array without limit just because
 * nobody has ended it yet.
 * Returns the line's index (for a later trim), or -1 when it was not kept.
 */
function appendVoiceTranscript(
  session: VoiceSession,
  role: "user" | "agent",
  text: string,
): number {
  const trimmed = text.trim();
  if (!trimmed) return -1;
  if (session.transcript.length >= MAX_RECORD_TURNS) return -1;
  session.transcript.push({ role, text: trimmed.slice(0, MAX_RECORD_TEXT) });
  checkpointCall(session);
  return session.transcript.length - 1;
}

/**
 * The agent's half of the call record.
 *
 * Called from index.ts once a voice turn has produced its reply. The reply
 * text is the FULL generated response; on a turn the user barged in on, the
 * client's own record is more truthful about what was actually heard, and it
 * is the one that wins whenever it arrives (see `handleVoiceSessionRecord`).
 * This is the copy that survives when it does not.
 */
/** What the agent last said on this call, or null before its first reply. */
export function lastVoiceAgentLine(voiceStreamId: string): string | null {
  const session = voiceSessionsById.get(voiceStreamId);
  if (!session) return null;
  for (let i = session.transcript.length - 1; i >= 0; i--) {
    // An agent line cut before he heard any of it is blank: it was never said.
    if (session.transcript[i].role === "agent" && session.transcript[i].text) return session.transcript[i].text;
  }
  return null;
}

/** When each app socket last sent us anything (step 0's door lines). */
const lastInboundAt = new WeakMap<WebSocket, number>();

/** The last `n` lines of this call's record, oldest first (the fast voice's context). */
/** Is he talking on this call right now (the recognizer heard speech start and not yet its end)? */
export function callTalking(voiceStreamId: string): boolean {
  return voiceSessionsById.get(voiceStreamId)?.composer.talking ?? false;
}

export function recentVoiceLines(voiceStreamId: string, n: number): { role: "user" | "agent"; text: string }[] {
  const session = voiceSessionsById.get(voiceStreamId);
  if (!session || n <= 0) return [];
  return session.transcript.slice(-n).filter((l) => l.text).map((l) => ({ role: l.role, text: l.text }));
}

/** Record what the agent said on this call. Returns the line's index (for a later trim), or -1. */
export function recordVoiceAgentTurn(voiceStreamId: string, text: string): number {
  const session = voiceSessionsById.get(voiceStreamId);
  if (!session) return -1;
  return appendVoiceTranscript(session, "agent", text);
}

/**
 * A barge-in cut that line short: keep only what he heard. Blank = he heard
 * none of it, and the line drops out of the record. (voice-streaming-bargein)
 */
export function trimVoiceAgentTurn(voiceStreamId: string, at: number, text: string): void {
  const session = voiceSessionsById.get(voiceStreamId);
  const line = session?.transcript[at];
  if (!session || !line || line.role !== "agent") return;
  line.text = text.trim().slice(0, MAX_RECORD_TEXT);
  checkpointCall(session);
}

/**
 * The agent's turn is over (however it ended). The floor stays open for a
 * while after his last line — longer if that line asked something.
 */
export function voiceAgentTurnEnded(voiceStreamId: string): void {
  const session = voiceSessionsById.get(voiceStreamId);
  if (!session) return;
  // The line ends when he has HEARD it, not when it was synthesized: a long
  // reply plays on for seconds after this, and a window counted from here
  // closed the floor while Michael was still talking (voice-streaming-bargein).
  session.floor.agentLine(lastVoiceAgentLine(voiceStreamId), playoutEndsAt(voiceStreamId));
}

/** The floor state of a live call, for tests and the status line. */
export function voiceFloorState(voiceStreamId: string): "open" | "standby" | null {
  return voiceSessionsById.get(voiceStreamId)?.floor.current ?? null;
}

/**
 * Write the call card from what the SERVER saw, for a call that ended without
 * the client reporting one.
 *
 * The client composes the record on the normal end-of-call path, and that copy
 * is better — it knows how long the call looked from the user's side and which
 * words were actually spoken before an interrupt. But it can only be sent over
 * a socket that is still open, so a WiFi drop, a force-quit or a killed tab
 * lost the ENTIRE call: no card, no transcript, nothing (R4-1). Every ending
 * now runs through here, and a call with real turns in it always lands
 * somewhere.
 */
function flushVoiceSessionRecord(session: VoiceSession): void {
  if (session.recorded) return;
  // Matches the client's rule: entering voice mode and leaving without saying
  // anything is not a call, and must not put a card in the thread.
  if (session.userTurns < 1) return;
  const user = session.user;
  if (!user || !isVoiceModeEnabled(session.bot)) return;
  session.recorded = true;
  if (session.channel === "phone") {
    // A phone has no client to report a record: the server's IS the record.
    console.log(`[voice] phone call ${session.voiceStreamId} ended — writing its card (${session.userTurns} turn(s))`);
  } else {
    console.warn(
      `[voice] call ${session.voiceStreamId} ended without a client record — ` +
        `writing the server's (${session.userTurns} turn(s))`,
    );
  }
  voiceSessionRecordHandler?.({
    botName: session.bot,
    user,
    record: {
      callId: session.voiceStreamId,
      startedAt: session.startedAt,
      durationSec: Math.max(0, Math.round((Date.now() - session.startedAt) / 1000)),
      turns: session.userTurns,
      transcript: session.transcript.filter((l) => l.text).slice(0, MAX_RECORD_TURNS),
      ...(session.channel === "phone" ? { channel: "phone" as const, ...(session.direction ? { direction: session.direction } : {}) } : {}),
    },
  });
}

// ── Calls that outlive the process (call-crash-survival) ─────────────

/** Every live call's checkpoint file (voice/call-checkpoint.ts). */
const callCheckpoints = new CallCheckpoints();

/** The call changed: its checkpoint follows (throttled). Calls without an owner, or already carded, keep none. */
function checkpointCall(session: VoiceSession): void {
  const id = session.voiceStreamId;
  if (voiceSessionsById.get(id) !== session) return;
  if (session.recorded) {
    callCheckpoints.clear(id);
    return;
  }
  const userId = session.user?.userId;
  if (!userId) return;
  callCheckpoints.touch(id, () => ({
    voiceStreamId: id,
    bot: session.bot,
    userId,
    channel: session.channel,
    ...(session.direction ? { direction: session.direction } : {}),
    startedAt: session.startedAt,
    turns: session.userTurns,
    muted: session.muted,
    resumed: session.resumed,
    gapMs: session.gapMs,
    transcript: session.transcript.filter((l) => l.text),
  }));
}

/** App calls the last process left, held for the app to resume them. */
const restorableCalls = new Map<string, { cp: CallCheckpoint; timer: NodeJS.Timeout; resolveUser: (userId: string) => UserConfig | null }>();

/** End a held call now: its card, then its file. Before anything else may take its id. */
function settleRestoredCall(id: string): void {
  const held = restorableCalls.get(id);
  if (!held) return;
  clearTimeout(held.timer);
  restorableCalls.delete(id);
  writeRestartCard(held.cp, held.resolveUser);
}

/** Does this call (id + start) already have a card in its owner's thread? */
function callAlreadyCarded(bot: string, userId: string, callId: string, startedAt: number): boolean {
  return getMessagesForUser(bot, userId, LIVE_THREAD_CAP).some((m) => {
    const v = m.meta?.voiceSession;
    return v?.callId === callId && v.startedAt === startedAt;
  });
}

/** Write the card for a call the gateway died under, from its checkpoint. */
function writeRestartCard(cp: CallCheckpoint, resolveUser: (userId: string) => UserConfig | null): void {
  const user = resolveUser(cp.userId);
  const durationSec = Math.max(0, Math.round((cp.aliveAt - cp.startedAt) / 1000));
  if (user && callAlreadyCarded(cp.bot, user.userId, cp.voiceStreamId, cp.startedAt)) {
    // The last process wrote the card and died before removing the file.
    console.log(`[voice] call ${cp.voiceStreamId} already has its card — removing the leftover checkpoint`);
  } else if (cp.turns >= 1 && user && isVoiceModeEnabled(cp.bot) && voiceSessionRecordHandler) {
    console.warn(`[voice] call ${cp.voiceStreamId} ended by a gateway restart — writing its card (${cp.turns} turn(s), ${durationSec}s)`);
    voiceSessionRecordHandler({
      botName: cp.bot,
      user,
      record: {
        callId: cp.voiceStreamId,
        startedAt: cp.startedAt,
        durationSec,
        turns: cp.turns,
        transcript: cp.transcript.slice(0, MAX_RECORD_TURNS),
        ...(cp.channel === "phone" ? { channel: "phone" as const, ...(cp.direction ? { direction: cp.direction } : {}) } : {}),
        ending: "Ended by a gateway restart",
      },
    });
  } else {
    console.log(`[voice] call ${cp.voiceStreamId} ended by a gateway restart — no card (${cp.turns} turn(s)${user ? "" : ", owner unknown"})`);
  }
  callCheckpoints.remove(cp.voiceStreamId);
}

/**
 * Boot: every checkpoint still on disk is a call the last process never
 * ended. An app call is held for what is left of its resume window, counted
 * from when that process was last alive — the app's own wait started then.
 * A phone call cannot come back (its media stream died with the process).
 * Whatever is not resumed in time gets its card, marked as ended by the restart.
 */
export function restoreLiveCalls(resolveUser: (userId: string) => UserConfig | null = lookupByUserId): number {
  const now = Date.now();
  let held = 0;
  for (const cp of callCheckpoints.list()) {
    const id = cp.voiceStreamId;
    if (voiceSessionsById.has(id) || restorableCalls.has(id)) continue;
    const grace = cp.muted ? quietResumeGraceMs() : resumeGraceMs();
    const left = cp.channel === "app" ? grace - (now - cp.aliveAt) : 0;
    if (left <= 0) {
      writeRestartCard(cp, resolveUser);
      continue;
    }
    const timer = setTimeout(() => settleRestoredCall(id), left);
    timer.unref?.();
    restorableCalls.set(id, { cp, timer, resolveUser });
    held++;
    console.log(
      `[voice] ${id} survived a gateway restart: ${cp.turns} turn(s) since ${new Date(cp.startedAt).toISOString()}, resumable for ${Math.round(left / 1000)}s${cp.muted ? " (muted)" : ""}`,
    );
  }
  return held;
}

/** The app came back for a call the last process held: a new session carrying everything the checkpoint knew. */
function resumeRestoredCall(
  ws: WebSocket,
  user: UserConfig | null,
  opts: { bot: string; audioRoute: string; speculationEnabled: boolean; forceSpeculationOnBluetooth: boolean },
  restored: { cp: CallCheckpoint; timer: NodeJS.Timeout },
): void {
  const { cp } = restored;
  const id = cp.voiceStreamId;
  const { bot } = opts;
  if (!user || user.userId !== cp.userId || bot !== cp.bot || cp.channel !== "app") {
    console.warn(`[voice] ${id} resume after restart refused: another user's or agent's call`);
    safeSend(ws, { type: "voice-error", voiceStreamId: id, bot, code: "not-your-call", error: "That call belongs to another account." });
    return;
  }
  clearTimeout(restored.timer);
  restorableCalls.delete(id);
  const prior = voiceSessions.get(ws);
  if (prior) {
    prior.ending ??= { by: "server", why: "replaced-by-new-call" };
    void teardownVoiceSession(prior);
  }
  const gap = Math.max(0, Date.now() - cp.aliveAt);
  const session = startCallSession(ws, appTransport(id, bot), {
    ...opts,
    voiceStreamId: id,
    user,
    carry: {
      startedAt: cp.startedAt,
      transcript: cp.transcript.slice(0, MAX_RECORD_TURNS),
      userTurns: cp.turns,
      muted: cp.muted,
      resumed: cp.resumed + 1,
      gapMs: cp.gapMs + gap,
    },
  });
  socketsThatCalled.add(ws);
  safeSend(ws, {
    type: "voice-started",
    voiceStreamId: id,
    bot,
    resumed: true,
    restarted: true,
    resumedCount: session.resumed,
    gapMs: session.gapMs,
    working: null,
    floor: session.floor.snapshot(),
    muted: session.muted,
    // Whatever was on air when the old process died is gone.
    heldAudioDropped: true,
    textFollowsVoice: callTextFollowsVoice(),
    hold: holdSnapshot(),
  });
  voiceSessionOpenHandler?.({ botName: bot, voiceStreamId: id, userName: user.name });
  console.log(`[voice] ${id} resumed after a gateway restart (gap ${Math.round(gap / 1000)}s, ${cp.turns} turn(s) carried)`);
}

/** Close a session's provider stream and log what the session burned. */
async function teardownVoiceSession(session: VoiceSession): Promise<void> {
  // The one line that says how this call ended. First, before anything can
  // throw or await: the next "the call just vanished" is diagnosed from the
  // log alone, or not at all (voice-call-drop: the client's own watchdog can
  // end a call the server knows nothing about).
  console.log(formatCallEnd(session, turnsInFlight(session.voiceStreamId)));
  // BEFORE anything can throw or await: whatever happened to this call, the
  // turns it completed are not allowed to vanish with it.
  flushVoiceSessionRecord(session);
  // Ended here, so no later boot may end it again (call-crash-survival).
  if ((voiceSessionsById.get(session.voiceStreamId) ?? session) === session) callCheckpoints.clear(session.voiceStreamId);
  // The call is over: whatever his screen showed goes with it. A drop that
  // never got its turn is still saved in the chat.
  // A recording in progress is dropped, not reviewed: the call it would answer on is gone.
  if (session.screenRecord?.timer) clearTimeout(session.screenRecord.timer);
  if (session.screenRecord?.stopping) clearTimeout(session.screenRecord.stopping.timer);
  if (session.screenRecord) {
    session.screenRecord.stopping = null;
    session.screenRecord.tail = null;
  }
  session.screen?.watch.clear();
  session.screen = null;
  if (session.drops?.timer) clearTimeout(session.drops.timer);
  session.drops = null;
  session.floor.dispose();
  if (session.parked) {
    clearTimeout(session.parked.timer);
    voiceSessions.delete(session.parked.key);
    session.parked = null;
  }
  session.ws = null;
  if (voiceSessionsById.get(session.voiceStreamId) === session) {
    voiceSessionsById.delete(session.voiceStreamId);
  }
  session.composer.reset();
  {
    const mouth = mouthFor(session.voiceStreamId);
    mouth?.close();
    if (mouth) forgetMouth(session.voiceStreamId, mouth);
  }
  // Release the call's TTS socket before the STT close awaits — a dropped
  // connection must not leave a Cartesia socket (and its billing) open.
  voiceSessionCloseHandler?.({ botName: session.bot, voiceStreamId: session.voiceStreamId });
  const stream = session.stt;
  session.stt = null;
  session.pendingFrames = [];
  session.pendingBytes = 0;
  if (!stream) return;
  try {
    const usage = await stream.close(session.bot);
    // Burn watch: ink-2 bills per second of audio against a fixed pool, so
    // every voice session reports what it cost. The owner is watching this for the
    // first week to decide whether the latency is worth the credits.
    if (usage && usage.audioSec > 0) {
      console.log(
        `[voice] session ${session.voiceStreamId} (${session.bot}/${stream.provider}): ` +
          `${usage.audioSec}s audio · ${usage.turns} turns · ~${usage.credits} credits`,
      );
    }
  } catch (err) {
    console.warn("[voice] STT close failed:", (err as Error).message);
  }
}

/**
 * A call ended — persist its log card.
 *
 * Gated on `voiceModeEnabled` like every other voice path: with the flag off
 * the server will not write a card even if a client asks it to, so a stale
 * or hostile client cannot inject rows into a thread.
 *
 * The turn count and duration are the CLIENT's, because the client is what
 * watched the call happen; the transcript is bounded here rather than trusted,
 * since it lands in a file the agent later reads back as context.
 */
/**
 * Sockets that have actually opened a voice session, and how many call cards
 * they have written.
 *
 * The record is composed by the CLIENT and writes a message into the thread,
 * so on its own `voice-session-record` is an unauthenticated way to put text
 * in someone's history. Membership here is the missing precondition: a call
 * card can only come from a socket that really made a call. Deliberately NOT
 * cleared on teardown — the card is written after the session closes, so
 * checking the live session map would be a race, not a check.
 */
const socketsThatCalled = new WeakSet<WebSocket>();
const socketRecordCounts = new WeakMap<WebSocket, number>();
/** A long call is a handful of cards, not hundreds. */
const MAX_RECORDS_PER_SOCKET = 50;
/** A call cannot have started in the future, or more than a day ago. */
const MAX_RECORD_AGE_MS = 24 * 60 * 60 * 1000;

function handleVoiceSessionRecord(ws: WebSocket, msg: Record<string, unknown>): void {
  const bot = typeof msg.bot === "string" ? msg.bot : null;
  const user = socketUsers.get(ws);
  if (!bot || !user || !isVoiceModeEnabled(bot)) return;
  if (!userCanAccessAgent(user, bot)) return;
  if (!socketsThatCalled.has(ws)) return;

  // The client got its report out, so the server's fallback copy must stand
  // down — otherwise the teardown that follows a normal end-of-call writes a
  // SECOND card for the same call. The client's record is the better one
  // (it knows what was actually heard), so it wins by arriving first.
  const live =
    (typeof msg.voiceStreamId === "string" ? voiceSessionsById.get(msg.voiceStreamId) : null) ??
    voiceSessions.get(ws);
  if (live && live.bot === bot) {
    live.recorded = true;
    callCheckpoints.clear(live.voiceStreamId);
  }

  const written = socketRecordCounts.get(ws) ?? 0;
  if (written >= MAX_RECORDS_PER_SOCKET) return;
  socketRecordCounts.set(ws, written + 1);

  const raw = (msg.record ?? {}) as Record<string, unknown>;
  const turns = Number(raw.turns);
  const durationSec = Number(raw.durationSec);
  const rawStartedAt = Number(raw.startedAt);
  if (!Number.isFinite(turns) || !Number.isFinite(durationSec) || !Number.isFinite(rawStartedAt)) {
    return;
  }
  // The client derives this from its own wall clock, so it is a hint, not a
  // fact. Clamp it into the only window a real call could have started in
  // rather than letting a card date itself into next year.
  const now = Date.now();
  const startedAt = Math.min(Math.max(rawStartedAt, now - MAX_RECORD_AGE_MS), now);

  const transcript = Array.isArray(raw.transcript)
    ? raw.transcript
        .slice(0, MAX_RECORD_TURNS)
        .map((t) => t as Record<string, unknown>)
        .filter((t) => t.role === "user" || t.role === "agent")
        .map((t) => ({
          role: t.role as "user" | "agent",
          text: String(t.text ?? "").slice(0, MAX_RECORD_TEXT),
        }))
    : [];

  voiceSessionRecordHandler?.({
    botName: bot,
    user,
    record: {
      startedAt,
      durationSec: Math.max(0, Math.round(durationSec)),
      turns: Math.max(0, Math.round(turns)),
      transcript,
    },
  });
}

/** A long call is still a bounded record — the thread is not a transcript store. */
const MAX_RECORD_TURNS = 200;
const MAX_RECORD_TEXT = 4000;

function handleVoiceCancel(ws: WebSocket, msg: Record<string, unknown>): void {
  const session = voiceSessions.get(ws);
  if (!session) return;
  // The app says why it hung up (web/src/lib/voicelayer.ts): the END button,
  // its watchdog, the screen closing. A short token, allow-listed below —
  // never free text into the log.
  session.ending ??= { by: "client", why: callEndToken(msg.reason) ?? "cancel" };
  // Cancel discards the buffered thought — composer.reset() inside teardown
  // is what stops a half-spoken sentence from reaching the agent later.
  void teardownVoiceSession(session);
  voiceSessions.delete(ws);
  safeSend(ws, {
    type: "voice-cancelled",
    voiceStreamId: session.voiceStreamId,
    bot: session.bot,
  });
}

function safeSend(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    console.warn("[voice] safeSend failed:", (err as Error).message);
  }
}

/** Send an ephemeral voice-call JSON event to one socket only. */
export function sendVoiceJson(ws: WebSocket, payload: Record<string, unknown>): void {
  safeSend(ws, payload);
}

/** Send a JSON payload to every currently-open socket owned by `userId`.
 *  Returns how many sockets received it. */
function sendToUser(userId: string, payload: Record<string, unknown>): number {
  const data = JSON.stringify(payload);
  let sent = 0;
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const u = socketUsers.get(client);
    if (u && u.userId === userId) {
      try {
        client.send(data);
        sent += 1;
      } catch (err) {
        console.warn("[delivery] sendToUser failed:", (err as Error).message);
      }
    }
  }
  return sent;
}

/**
 * Deliver a TTS audio payload to a user with ACK/replay (P0). Unlike the
 * pre-CP2 path, this does NOT target the single socket captured at
 * voice-start — it enqueues the payload keyed by userId/turnId, sends it to
 * ANY current socket the user has open, and (because it's enqueued) replays
 * it on reconnect until the client ACKs or it expires. The base64 audio +
 * explicit mime let the PWA pick a codec.
 */
export function sendVoiceTts(
  userId: string,
  voiceStreamId: string,
  payload: { bot: string; audioBase64: string; mimeType: string; text?: string }
): void {
  const delivery = deliveryHub.enqueue(
    userId,
    "voice-tts",
    { type: "voice-tts", voiceStreamId, ...payload },
    { key: `tts:${voiceStreamId}` },
  );
  sendToUser(userId, delivery.payload);
}

/* ── Streaming TTS downlink (voice mode only) ─────────────────────────────
   These carry a reply that is being SPOKEN as it generates, which is a
   different delivery problem from `sendVoiceTts` above.

   `sendVoiceTts` goes through the delivery hub with ACK/replay because a
   voice-note payload is an artifact worth redelivering. Streamed call audio
   is the opposite: it is only meaningful in time. Replaying a frame from
   thirty seconds ago onto a reconnected socket would speak the middle of a
   dead sentence into a live call. So these bypass the hub entirely — a
   dropped socket ends the call, exactly as it does in the sim, and what
   survives the reconnect is the durable voice-media record the turn writes
   at the end.                                                              */

/** First audio of a turn is on its way — flip the layer to `speaking`. */
export function sendVoiceTtsStart(
  ws: WebSocket,
  opts: { voiceStreamId: string; bot: string; sampleRate: number },
): void {
  safeSend(ws, { type: "voice-tts-start", ...opts });
}

/**
 * Word timings for speech already scheduled — the karaoke clock.
 *
 * Sent as they arrive rather than batched at the end: the highlighter needs
 * the timings for the words it is ABOUT to speak, not a transcript after the
 * fact.
 */
export function sendVoiceTtsWords(
  ws: WebSocket,
  opts: {
    voiceStreamId: string;
    bot: string;
    words: string[];
    start: number[];
    end: number[];
  },
): void {
  safeSend(ws, { type: "voice-tts-words", ...opts });
}

/** Synthesis finished. NOT playback — the client still has audio queued. */
export function sendVoiceTtsDone(
  ws: WebSocket,
  opts: { voiceStreamId: string; bot: string },
): void {
  safeSend(ws, { type: "voice-tts-done", ...opts });
}

/**
 * One raw PCM s16le frame, as a binary WS message.
 *
 * Binary rather than base64-in-JSON: base64 inflates by a third on the single
 * most latency-sensitive payload in the product, and the client is already
 * set up for an ArrayBuffer on the mic path.
 */
/**
 * Send one PCM frame of the reply downstream.
 *
 * NO BACKPRESSURE, on purpose. `ws.send` buffers when the socket cannot keep
 * up, and `bufferedAmount` is the signal a normal streaming sender would pause
 * on. Pausing is the wrong move here: this is realtime speech, and audio that
 * arrives late is worse than audio that never arrives — the karaoke clock has
 * moved on and the words no longer match the voice. A turn's whole reply is
 * seconds of 16-bit mono, so the buffer a stalled client can accumulate is
 * bounded by the turn itself, and a client stalled that badly is about to be
 * torn down anyway.
 *
 * If this ever needs a limit, the correct one is to DROP frames and let the
 * gap show up in `gapOffset` on the client, not to queue them.
 */
export function sendVoiceAudioFrame(ws: WebSocket, pcm: Buffer): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(pcm, { binary: true });
  } catch {
    /* socket died mid-call; teardown handles it */
  }
}

/** Notify the PWA that an agent turn has started (for orb state
 *  transitions: listening → thinking). */
export function sendVoiceThinking(
  ws: WebSocket,
  opts: { voiceStreamId: string; bot: string }
): void {
  safeSend(ws, { type: "voice-thinking", ...opts });
}

export function handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
  const user = resolveUser(req);
  if (!user) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // Stash the resolved user on the socket BEFORE emitting the
    // connection event so the connection handler can read it directly
    // (avoids a second cookie/query parse).
    socketUsers.set(ws, user);
    wss.emit("connection", ws, req);
  });
}

/**
 * Broadcast an event to all connected sockets that (a) are authenticated
 * as a user with access to this event's bot, AND (b) belong to the same
 * user as the event (when the event carries a userId). Persists the event
 * to disk regardless.
 *
 * Per-user isolation: when `event.userId` is set, only sockets owned by
 * that user receive the event. Setting `userId` to "unknown" still
 * broadcasts to all users who can see the bot — unknown-sender telegram
 * messages are visible to anyone who can see that bot (e.g. The owner sees
 * Miriam messages from unrecognized senders even if they weren't from
 * his Telegram account).
 */
export function broadcast(event: MessageEvent): void {
  // Persist to disk (per-user keyed). storeMessage stamps meta.messageId.
  storeMessage(event);
  deliverMessageEvent(event);
}

/**
 * Update an already-persisted message (matched by meta.messageId / turnId)
 * and re-deliver it to clients (P0 voice-reply upsert). Clients recognize the
 * messageId and replace their existing copy in place — e.g. upgrade a text
 * reply to a voice reply with playable media. Falls back to delivering the
 * patch as-is if no matching record exists (so nothing is silently dropped).
 */
export function broadcastUpdate(event: MessageEvent): void {
  const merged = upsertMessageById(event) ?? event;
  deliverMessageEvent(merged);
}

/**
 * Send a persisted message event to every matching socket, and (for a
 * concrete owning user) enqueue it for ACK/replay so a momentarily-absent
 * socket recovers it on reconnect. "unknown"-user events keep the original
 * fan-out-to-all-with-access behavior and are not queued (no single owner);
 * they're still recoverable from disk history.
 */
function deliverMessageEvent(event: MessageEvent): void {
  const concreteUser =
    event.userId && event.userId !== "unknown" ? event.userId : null;

  let payload: Record<string, unknown> = { ...event };
  if (concreteUser) {
    const delivery = deliveryHub.enqueue(concreteUser, "message", payload, {
      key: event.meta?.messageId ? `msg:${event.meta.messageId}` : undefined,
    });
    payload = delivery.payload; // carries deliveryId
  }

  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const user = socketUsers.get(client);
    if (!user) continue;
    if (!userCanAccessAgent(user, event.bot)) continue;
    // Scope by user: only the owning user sees their thread. "unknown"
    // passes through to everyone with agent access so we never hide
    // truly anonymous traffic from the operator.
    if (event.userId && event.userId !== "unknown" && event.userId !== user.userId) continue;
    client.send(data);
  }

  // Web Push (Step 8): notify the owning user's devices about agent
  // replies. Fire-and-forget — settings (per-agent mute, quiet hours) are
  // enforced inside; the service worker suppresses the banner when the
  // app is focused; the voice upgrade re-push replaces the text one via
  // the shared notification tag (meta.messageId).
  sendPushForMessage(event);
}

/**
 * Broadcast an arbitrary JSON event to all authenticated WS clients
 * WITHOUT persisting. Used for streaming chunk events and similar
 * ephemeral signals. Stream events can include bot and user scope; when
 * present, only matching authenticated sockets receive them.
 */
export function broadcastEvent(event: Record<string, unknown>): void {
  const data = JSON.stringify(event);
  const eventBot = typeof event.botName === "string" ? event.botName : null;
  const eventUserId = typeof event.userId === "string" ? event.userId : null;
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const user = socketUsers.get(client);
    if (!user) continue;
    if (eventBot && !userCanAccessAgent(user, eventBot)) continue;
    if (eventUserId && eventUserId !== "unknown" && eventUserId !== user.userId) continue;
    // Admin-only events (the owner's mission control) never reach a non-admin app.
    if (event.adminOnly === true && !user.admin) continue;
    client.send(data);
  }
}

/**
 * Planned restart (systemd SIGTERM): tell every connected app before the
 * process goes — a `restarting` frame, then close code 1012 ("service
 * restart"), the standard code for exactly this. The app shows RESTARTING
 * until its socket is back (web/src/lib/connection.ts). Two signals because
 * either can be lost on the way out; both are written synchronously here, so
 * they leave before the exit handler that follows. Returns sockets told.
 */
export function announceRestart(): number {
  const data = JSON.stringify({ type: "restarting", at: new Date().toISOString() });
  let told = 0;
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN || !socketUsers.get(client)) continue;
    try {
      client.send(data);
      client.close(1012, "restarting");
      told++;
    } catch {
      /* a socket already going away — nothing to tell */
    }
  }
  return told;
}

/** History for a specific user — merged across their allowed bots. */
export function getHistoryForUser(user: UserConfig, limit = 100): MessageEvent[] {
  const all: MessageEvent[] = [];
  for (const bot of user.agents) {
    all.push(...getMessagesForUser(bot, user.userId, limit));
  }
  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return all.slice(-limit);
}


/* ── Mid-call drops (part six) ──────────────────────────────────────────── */

/** Take (and clear) the drops waiting on this call. */
function takeDrops(session: VoiceSession): CallDrop[] {
  const d = session.drops;
  if (!d) return [];
  if (d.timer) clearTimeout(d.timer);
  session.drops = null;
  return d.items;
}

/**
 * (Re)arm the pairing window. When it closes: if he is mid-utterance, keep
 * waiting (his words will carry the drop), up to dropMaxWaitMs(); otherwise
 * the drop is its own turn.
 */
function armDropWindow(session: VoiceSession, ms = dropPairMs()): void {
  const d = session.drops;
  if (!d) return;
  if (d.timer) clearTimeout(d.timer);
  // S3: never past the batch's hard age, however often a new drop rearms it.
  d.timer = setTimeout(() => {
    if (session.drops !== d) return;
    const speaking = session.speechSeen || session.composer.pending;
    if (speaking && Date.now() - d.since < dropMaxWaitMs()) {
      armDropWindow(session, 500);
      return;
    }
    session.dispatchDrops?.();
  }, dropWindowDelay(d.since, Date.now(), ms));
  d.timer.unref?.();
}

/**
 * An image (already uploaded save-only, by media id) or text dropped into the
 * call. Saved to the chat thread, acknowledged to the app, and held for his
 * next words.
 */
async function handleCallDrop(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
  const session = voiceSessions.get(ws);
  const user = socketUsers.get(ws);
  if (!session || !user) return;
  // S4: a drop names the call it was made in, and its agent. One from a call
  // that already ended (a slow upload finishing after hang-up) must not land
  // in the next call on this socket — even with another agent.
  if (msg.voiceStreamId !== session.voiceStreamId || (typeof msg.bot === "string" && msg.bot !== session.bot)) {
    console.warn(`[voice-drop] ${session.voiceStreamId} refused a drop for another call`);
    safeSend(ws, { type: "call-drop-ack", voiceStreamId: session.voiceStreamId, ok: false, error: "That was for a call that already ended." });
    return;
  }
  const text = typeof msg.text === "string" ? msg.text.trim().slice(0, MAX_DROP_TEXT) : "";
  const mediaId = typeof msg.mediaId === "string" ? msg.mediaId : "";
  const refuse = (error: string): void => {
    console.warn(`[voice-drop] ${session.voiceStreamId} refused a drop: ${error}`);
    safeSend(ws, { type: "call-drop-ack", voiceStreamId: session.voiceStreamId, ok: false, error });
  };
  // S3: cheap bounds first, before any image is read.
  if ((session.drops?.items.length ?? 0) >= MAX_PENDING_DROPS) {
    refuse(`That's more than ${MAX_PENDING_DROPS} things at once. Give me a second with these first.`);
    return;
  }
  if (mediaId && (session.dropLoads ?? 0) >= MAX_CONCURRENT_DROP_LOADS) {
    refuse("Still reading your last images. Send this one in a moment.");
    return;
  }
  const items: CallDrop[] = [];
  let failed = "";
  if (mediaId) {
    session.dropLoads = (session.dropLoads ?? 0) + 1;
    try {
      const img = await loadDropImage(user.userId, mediaId, user.name);
      if (img) items.push(img);
      else failed = "That image couldn't be read.";
    } catch (err) {
      console.warn(`[voice-drop] ${session.voiceStreamId} image load failed: ${(err as Error).message}`);
      failed = "That image couldn't be read.";
    } finally {
      session.dropLoads = Math.max(0, (session.dropLoads ?? 1) - 1);
    }
  }
  if (text) items.push({ kind: "text", text });
  if (voiceSessions.get(ws) !== session) return; // the call ended while loading
  if (!items.length) {
    safeSend(ws, { type: "call-drop-ack", voiceStreamId: session.voiceStreamId, ok: false, error: failed || "Nothing to send." });
    return;
  }
  // S3: the whole batch stays bounded — count, images, bytes, text.
  const tooMuch = dropBatchRefusal(session.drops?.items ?? [], items);
  if (tooMuch) {
    refuse(tooMuch);
    return;
  }

  // Saved to the chat thread like anything he sends there — visible, not a
  // hidden call-turn message — so it is in his history after the call.
  const image = items.find((d): d is Extract<CallDrop, { kind: "image" }> => d.kind === "image");
  const event: MessageEvent = {
    type: "message",
    bot: session.bot,
    direction: "in",
    contentType: image ? "photo" : "text",
    text: text || "[image]",
    timestamp: new Date().toISOString(),
    chatId: user.telegramChatId ?? 0,
    userId: user.userId,
    senderName: user.name,
    source: "app",
    ...(image ? { media: image.media } : {}),
    meta: { fromCall: session.voiceStreamId },
  } as MessageEvent;
  try {
    broadcast(event);
  } catch (err) {
    console.warn(`[voice-drop] ${session.voiceStreamId} could not save to chat: ${(err as Error).message}`);
  }

  session.drops ??= { items: [], timer: null, since: Date.now() };
  session.drops.items.push(...items);
  console.log(
    `[voice-drop] ${session.voiceStreamId} dropped ${items.map((d) => d.kind).join("+")}` +
      `${image ? ` ${image.frame.width}x${image.frame.height}` : ""}${text ? ` ${text.length} chars` : ""}; ` +
      `pairing with his next words for ${dropPairMs()} ms`,
  );
  safeSend(ws, { type: "call-drop-ack", voiceStreamId: session.voiceStreamId, ok: true, kinds: items.map((d) => d.kind) });
  armDropWindow(session);
}

/**
 * One log line for a failed call-mic open. Exported for its test: every
 * field is allow-listed and shape-checked, so a client cannot write
 * arbitrary text into the gateway log.
 */
/**
 * One `[voice-client]` log line from the app's playback telemetry, or null if
 * the event is off-shape. Numbers and short tokens only — anything else is
 * dropped. A `seam` that inserted SEAM_WARN_MS or more of silence is flagged
 * `!! GAP <ms>` so it stands out next to the server's `[call-seam]` lines.
 */
export function formatVoiceClientEvent(voiceStreamId: string, parsed: Record<string, unknown>): string | null {
  const event = typeof parsed.event === "string" ? parsed.event.slice(0, 24) : "";
  if (!/^[a-z-]+$/.test(event)) return null;
  const kept = Object.entries(parsed)
    .filter(([k]) => k !== "type" && k !== "event" && /^[a-zA-Z]{1,24}$/.test(k))
    .filter(([, v]) => typeof v === "number" || typeof v === "boolean" || v === null ||
      (typeof v === "string" && /^[a-z-]{1,24}$/.test(v)))
    .slice(0, 8);
  const fields = kept.map(([k, v]) => `${k}=${v}`).join(" ");
  const gap = event === "seam" ? kept.find(([k]) => k === "gapMs")?.[1] : undefined;
  const flag = typeof gap === "number" && gap >= SEAM_WARN_MS ? `!! GAP ${Math.round(gap)}ms ` : "";
  return `[voice-client] ${flag}${voiceStreamId} ${event}${fields ? ` ${fields}` : ""}`;
}

/** Who ended a call, and why. `code`/`detail` only for a transport close. */
export interface CallEnding {
  by: "client" | "server" | "transport" | "phone";
  /** A short token: end-button, stall, screen-closed, socket-closed, replaced-by-new-call, hangup… */
  why: string;
  code?: number;
  detail?: string;
}

/** A client-supplied end reason, or null if it is not a short lowercase token. */
export function callEndToken(v: unknown): string | null {
  return typeof v === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(v) ? v : null;
}

/**
 * The `[call-end]` line: one per call, content-free. Reading it:
 *   by       who ended it — client (the app said so, `why` is its token),
 *            server (we replaced or refused it), transport (the socket
 *            closed with no word from the app: `code` is the WebSocket close
 *            code — 1001 page gone, 1006 network, 1012 our restart), phone
 *   why      the reason token from that side
 *   age      seconds since the call started
 *   turns    user turns the call had
 *   working  whether an agent turn was still in flight (yes = the call
 *            ended under work; the turn is aborted by the teardown)
 *   muted    the mic was muted at the end
 *   resumed  (always-on) times the call moved to a new socket; `gap` is the
 *            total seconds it spent parked between sockets
 */
export function formatCallEnd(
  session: Pick<VoiceSession, "voiceStreamId" | "bot" | "channel" | "startedAt" | "userTurns" | "muted" | "ending"> &
    Partial<Pick<VoiceSession, "resumed" | "gapMs">>,
  inFlight: number,
  now: number = Date.now(),
): string {
  const e = session.ending;
  const parts = [
    `[call-end] ${session.voiceStreamId}`,
    `bot=${session.bot}`,
    `via=${session.channel}`,
    `by=${e?.by ?? "unknown"}`,
    `why=${e ? callEndToken(e.why) ?? "other" : "unrecorded"}`,
  ];
  if (e?.code !== undefined) parts.push(`code=${e.code}`);
  const detail = e?.detail?.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 40);
  if (detail) parts.push(`detail=${JSON.stringify(detail)}`);
  parts.push(`age=${Math.max(0, Math.round((now - session.startedAt) / 1000))}s`);
  parts.push(`turns=${session.userTurns}`);
  parts.push(`working=${inFlight > 0 ? "yes" : "no"}`);
  if (session.muted) parts.push("muted=yes");
  // always-on: how often the call changed sockets, and how long it waited in all.
  if (session.resumed) parts.push(`resumed=${session.resumed}`, `gap=${Math.round((session.gapMs ?? 0) / 1000)}s`);
  return parts.join(" ");
}

export function formatVoiceMicError(user: string, msg: Record<string, unknown>): string {
  const token = (v: unknown, re: RegExp): string | null => (typeof v === "string" && re.test(v) ? v : null);
  const parts = [`user=${token(user, /^[a-z0-9_-]{1,32}$/i) ?? "?"}`];
  const errName = token(msg.errName, /^[A-Za-z]{1,40}$/);
  const stage = token(msg.stage, /^(mic|audio)$/);
  const permission = token(msg.permission, /^(granted|denied|prompt|unknown)$/);
  const audioSession = token(msg.audioSession, /^[a-z-]{1,24}$/);
  parts.push(`err=${errName ?? "?"}`);
  if (stage) parts.push(`stage=${stage}`);
  if (permission) parts.push(`permission=${permission}`);
  if (audioSession) parts.push(`audioSession=${audioSession}`);
  if (typeof msg.retried === "boolean") parts.push(`retried=${msg.retried}`);
  if (typeof msg.standalone === "boolean") parts.push(`standalone=${msg.standalone}`);
  return parts.join(" ");
}
