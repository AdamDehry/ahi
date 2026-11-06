import { useCallback, useEffect, useRef, useState } from "react";
// Type only: the SDK (LiveKit included) loads as its own chunk when an
// ElevenLabs call starts, so a native-only app never downloads it.
import type { Callbacks, Conversation } from "@elevenlabs/client";
import { createKaraokeState, sanitizeForTranscript, setServerTextFollowsVoice, spokenCount } from "./karaoke";
import { ElevenTimeline, pacedWords, type ElevenAlignment } from "./elevenkaraoke";
import { startElevenEar, type ElevenEar } from "./elevenear";
import { WordPacer } from "./wordpacer";
import { onVoiceEvent, sendVoiceControl, setExternalVoiceClock, setVoiceUplinkMuted } from "./voicebus";
import { canShareScreen, startScreenShare, stopScreenShare } from "./screenshare";
import type { AgentVoiceTurn, UserVoiceTurn, VoiceLayerApi, VoicePhase, VoiceTurn } from "./voicelayer";
// Same-origin worklet files (copied by scripts/copy-eleven-worklets.mjs before
// every build): the SDK's default is a blob: URL, which our CSP (script-src
// 'self') rightly refuses — on the preview the mic never opened.
const WORKLETS = {
  rawAudioProcessor: "/eleven-worklets/rawAudioProcessor.js",
  audioConcatProcessor: "/eleven-worklets/audioConcatProcessor.js",
};

/* ============================================================
   elevencall.ts — a call over ElevenLabs (Speech Engine), behind the same
   call screen.

   When the gateway names the agent in `elevenBots` (VOICE_CALL_ROLLBACK=
   elevenlabs — the rollback since voice step 3), the call button opens an ElevenLabs conversation instead of
   the app's own audio pipeline: their SDK owns the mic, the recognizer, turn
   detection, barge-in and the voice, over WebRTC. The gateway is still the
   brain — ElevenLabs sends it each finished turn and speaks what it streams
   back (src/voice/eleven/) — and the gateway mints the conversation token,
   so this page never holds a key.

   This hook returns the SAME VoiceLayerApi the native call returns, so the
   screen, the pill and the transcript render it unchanged — and, since the
   parity build (10/22), behave the same:

     his words     painted as he says them: the side ear (elevenear.ts) feeds
                   the gateway's own recognizer and its `stt-interim` lines
                   fill the provisional line; ElevenLabs' final replaces it
     my words      revealed word by word as they are spoken, from the engine's
                   own per-chunk alignment on a playback clock anchored to the
                   real audio (elevenkaraoke.ts) — never ahead of the voice;
                   the whole text settles only when the voice has said it, or,
                   on a cut-in, only what was said
     share         the native screen share, the frames riding his turns
     work          `» ` work lines and the WORKING strip, from the gateway

   Fallback: no token (the transport is off, or the mint failed) or a
   connection that never comes up → `onFallback`, and the screen places a
   native call instead. The call still happens; the gateway logs one line.

   Not on this transport yet (said on screen, not hidden): dropping images or
   text into the call — ElevenLabs owns the turns, and a drop is a turn.
   ============================================================ */

export interface ElevenGrant {
  transport: "elevenlabs";
  conversationToken: string;
  conversationId: string;
  voiceStreamId: string;
  firstMessage?: string;
}

/** Ask the gateway for an ElevenLabs conversation; anything else means "place a native call". */
export async function requestElevenSession(bot: string): Promise<ElevenGrant | { transport: "native"; reason: string }> {
  try {
    const res = await fetch("/api/voice/eleven/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot }),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<ElevenGrant> & { reason?: string };
    if (res.ok && body.transport === "elevenlabs" && body.conversationToken && body.voiceStreamId) return body as ElevenGrant;
    return { transport: "native", reason: body.reason ?? (res.ok ? "native" : `http-${res.status}`) };
  } catch {
    return { transport: "native", reason: "unreachable" };
  }
}

/** One short token to the gateway log (and the cut-in marker to the brain). Fire and forget. */
export function reportElevenEvent(voiceStreamId: string | null, event: string, reason?: string): void {
  void fetch("/api/voice/eleven/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voiceStreamId: voiceStreamId ?? "", event, ...(reason ? { reason } : {}) }),
    keepalive: true,
  }).catch(() => {});
}

let seq = 0;
const nextId = (): string => `et-${++seq}`;
const BARGE_FLIP_MS = 150;
const UNSUPPORTED = "Not on this kind of call yet.";
/** Output level that counts as the voice playing, and as silence (getOutputVolume, 0–1). */
const LOUD = 0.02;
const QUIET = 0.005;
/** Silence this long before a rise counts as an onset (word gaps are shorter). */
const ONSET_AFTER_QUIET_MS = 150;
/** A response with text but no alignment after this long gets paced words (last resort). */
const NO_ALIGNMENT_AFTER_MS = 1_500;
/**
 * His words our recognizer has closed stay on screen until ElevenLabs' final
 * puts his line in the thread — across a pause, while his sentence is open
 * (one call: a 6-s hold cleared them and his line came back only
 * ~10 s later, with the reply). This is only the guard against words the
 * engine never takes (a noise our recognizer heard).
 */
const CAPTION_HOLD_MS = 30_000;
/** Test seam: the caption hold, shortened by tests (never by config). */
export const __captionHold = { ms: CAPTION_HOLD_MS };
/** A WORKING beat older than this no longer vouches for the turn (voicelayer's livenessTtlMs). */
const WORKING_TTL_MS = 30_000;
const WORKING_QUIET_MS = 6_000;
/** A nudge waits this long for the voice and him to go quiet, then is dropped (the gateway asks again). */
const NUDGE_WAIT_MS = 15_000;

/**
 * ONE ElevenLabs session per agent, held outside React. The screen
 * that started it owns it; when that screen unmounts without hanging up, the
 * session is parked for PARK_MS, and a screen mounting for the same agent in
 * that window ADOPTS it — same token, same connection, same transcript — and
 * never dials again. Only a session nobody adopts is ended. Before this, any
 * remount (the phone/desktop layouts each mounted their own call screen)
 * ended the live call and minted a second token while the first was still
 * connecting: calls 998fc9 and eff9f9, both connected off one tap.
 */
interface ElevenSession {
  bot: string;
  vsid: string | null;
  conv: Conversation | null;
  /** False once the call is over for good (hung up, fell back, dropped, or parked and never adopted). */
  wanted: boolean;
  /** The screen driving it; null while parked. */
  owner: symbol | null;
  /** The engine's callbacks go to the owner's handlers. */
  handlers: SessionHandlers | null;
  endSent: boolean;
  connected: boolean;
  heardAnything: boolean;
  /** What the screen showed, for the screen that adopts it. */
  view: { turns: VoiceTurn[]; phase: VoicePhase; startedAt: number };
  /** The connection, once up (null when it never came or was not wanted). */
  ready: Promise<Conversation | null>;
  /** The call's own state: it belongs to the call, not to the screen showing it. */
  call: CallState;
  /** Engine callbacks that landed while parked, with when (performance.now): replayed to the adopter, in order. */
  parked: { k: keyof SessionHandlers; a: unknown[]; at: number }[];
  /** While parked: the voice-bus listener that keeps a nudge ask (or its withdrawal) for the adopter. */
  offPark: (() => void) | null;
}
type SessionHandlers = Partial<Callbacks> & {
  granted(voiceStreamId: string): void;
  failed(err: unknown): void;
  fallback(reason: string): void;
};

/**
 * Everything a remount must not reset (revision-merge review): the
 * call clock, the word timeline and the row being spoken, the agent's audio
 * mode and since when, and a nudge still waiting. Held per screen, the
 * adopting screen started over: its events went to new rows, and its mode
 * read "listening since 0", so a waiting nudge fired over the voice.
 */
interface CallState {
  /** performance.now() at the call's start: zero of the call clock. */
  zero: number;
  timeline: ElevenTimeline;
  sync: SyncLog;
  /** The agent row still being spoken (or waiting for its words), if any. */
  row: AgentVoiceTurn | null;
  meta: WeakMap<AgentVoiceTurn, RowMeta>;
  /** Responses at or below this id were cut off: their late alignment is not shown. */
  cutEvent: number;
  /**
   * Responses whose row has settled (it shows their whole text already). A
   * chunk of one arriving late — the row settled in a pause — is dropped,
   * not started as a new row ("as it finishes..." shown twice).
   */
  doneEvents: Set<number>;
  loud: boolean;
  quietSince: number;
  /** The agent's audio mode and since when; when his voice was last detected. */
  mode: { mode: string; since: number };
  voiceAt: number;
  /** When the gateway asked for the nudge still waiting for quiet (null = none). */
  nudgeAskedAt: number | null;
  /** His words our recognizer closed that ElevenLabs has not finalised yet: the caption keeps them. */
  caption: string;
  /**
   * When the caption (closed words and any live partial) expires, ms epoch
   * (0 = nothing up). Absolute, on the call: every partial and every closed
   * utterance pushes it out, and a screen that adopts the call arms what is
   * left of it (a partial cleared the timer and never
   * restarted it, and a remount kept the words with no timer at all).
   */
  captionUntil: number;
  /**
   * The words of his line(s) ElevenLabs just finalised: our recognizer's late
   * partials of THAT line are not painted back, only their words past it.
   * Lines finalised while our recognizer's line runs on are added end to end
   * (its line covers them all). Cleared by our recognizer's own final, or the
   * moment a partial is something else (new speech shows at once — the fixed
   * 4-s window hid it, parity review).
   */
  finalWords: string[] | null;
}

function newCallState(): CallState {
  return {
    zero: performance.now(),
    timeline: new ElevenTimeline(),
    sync: { anchors: [], checks: [], paced: 0 },
    row: null,
    meta: new WeakMap(),
    cutEvent: -1,
    doneEvents: new Set(),
    loud: false,
    quietSince: 0,
    mode: { mode: "listening", since: 0 },
    voiceAt: 0,
    nudgeAskedAt: null,
    finalWords: null,
    caption: "",
    captionUntil: 0,
  };
}

const joinCaption = (held: string, more: string): string => [held.trim(), more.trim()].filter(Boolean).join(" ");

/**
 * The caption after ElevenLabs finalised `line`: only the words that line
 * covers go (they are in the thread now); closed words that came after it
 * stay (his second line vanished until the engine filed
 * it too). The caption's words are walked in order against the line's, a
 * few words of slack each, as two recognizers differ on a word here and
 * there; caption words left over against line words left over are the same
 * words heard differently. Nothing in common: the caption is something else
 * and stays whole.
 */
export function captionAfterFinal(caption: string, line: string): string {
  const words = caption.trim().split(/\s+/).filter(Boolean);
  const fin = lineWords(line);
  if (!words.length || !fin.length) return caption.trim();
  let j = 0;
  let last = -1;
  for (let i = 0; i < words.length && j < fin.length; i++) {
    const w = lineWords(words[i]).join(" ");
    const at = fin.slice(j, j + 4).indexOf(w);
    if (w && at >= 0) {
      j += at + 1;
      last = i;
    }
  }
  if (last < 0) return caption.trim();
  return words.slice(last + 1 + (fin.length - j)).join(" ");
}

const lineWords = (s: string): string[] => s.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);

const SLACK = 4;

/**
 * What of `text` (a partial, or our recognizer's final) is new past the line
 * ElevenLabs just finalised. Our recognizer does not break his speech where
 * ElevenLabs did: its line runs on from the start of its own segment, so a
 * text that opens with the finalised words is that line going on, and only
 * the words past them are new (a two-word final hid the
 * next 307 words until he paused). `null`: not that line, new speech, shown
 * whole. "": that line again, or our recognizer lagging behind it — nothing
 * new. Matched in order from the start, a few words of slack each, as two
 * recognizers differ on a word here and there: most of the text's first
 * words must be the line's.
 */
export function pastFinalLine(text: string, line: string[]): string | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  // His words, each with the token it came from (a dash is none, "e-mail" two).
  const words: { w: string; t: number }[] = [];
  tokens.forEach((tok, t) => lineWords(tok).forEach((w) => words.push({ w, t })));
  if (!words.length || !line.length) return null;
  const head = Math.min(words.length, line.length);
  let j = 0;
  let last = -1;
  let headHits = 0;
  let misses = 0;
  for (let i = 0; i < words.length && j < line.length && misses < SLACK; i++) {
    const at = line.slice(j, j + SLACK).indexOf(words[i].w);
    if (at < 0) {
      misses++;
      continue;
    }
    j += at + 1;
    last = i;
    misses = 0;
    if (i < head) headHits++;
  }
  if (headHits / head < 0.6) return null;
  // Line words left over are the same words heard differently, or not heard yet.
  const cut = last + 1 + (line.length - j);
  return cut < words.length ? tokens.slice(words[cut].t).join(" ") : "";
}

const sessions = new Map<string, ElevenSession>();
const PARK_MS = 1_500;
const forgetSession = (s: ElevenSession): void => {
  s.wanted = false;
  s.offPark?.();
  s.offPark = null;
  if (sessions.get(s.bot) === s) sessions.delete(s.bot);
};

/** While nobody owns the session: every callback is kept for the adopter; the audio mode and his voice are tracked live. */
function parkedHandlers(s: ElevenSession): SessionHandlers {
  const keep =
    (k: keyof SessionHandlers) =>
    (...a: unknown[]): void => {
      s.parked.push({ k, a, at: performance.now() });
    };
  return {
    onConnect: keep("onConnect"),
    onDisconnect: keep("onDisconnect"),
    onError: keep("onError"),
    onModeChange: (...a: unknown[]) => {
      const mode = (a[0] as { mode?: string } | undefined)?.mode;
      if (mode && mode !== s.call.mode.mode) s.call.mode = { mode, since: Date.now() };
      keep("onModeChange")(...a);
    },
    onIncomingEvent: keep("onIncomingEvent"),
    onMessage: keep("onMessage"),
    onAgentResponseCorrection: keep("onAgentResponseCorrection"),
    onVadScore: (v: { vadScore: number }) => {
      if (v.vadScore > 0.5) s.call.voiceAt = Date.now();
    },
    onInterruption: keep("onInterruption"),
    granted: keep("granted"),
    failed: keep("failed"),
    fallback: keep("fallback"),
  } as SessionHandlers;
}
/** Test seam: the sessions held now. */
export const __elevenSessions = sessions;

/** Mint and connect one session; its callbacks reach whichever screen owns it then. */
function openElevenSession(s: ElevenSession): Promise<Conversation | null> {
  const via = <K extends keyof Callbacks>(k: K): Callbacks[K] =>
    ((...a: unknown[]) => (s.handlers?.[k] as ((...x: unknown[]) => void) | undefined)?.(...a)) as Callbacks[K];
  return (async () => {
    const grant = await requestElevenSession(s.bot);
    if (!s.wanted) return null;
    if (grant.transport !== "elevenlabs") {
      if (grant.reason !== "native") reportElevenEvent(null, "fallback", grant.reason);
      forgetSession(s);
      s.handlers?.fallback(grant.reason);
      return null;
    }
    s.vsid = grant.voiceStreamId;
    s.handlers?.granted(grant.voiceStreamId);
    try {
      const { Conversation: ElevenConversation } = await import("@elevenlabs/client");
      if (!s.wanted) return null;
      const c = await ElevenConversation.startSession({
        conversationToken: grant.conversationToken,
        connectionType: "webrtc",
        workletPaths: WORKLETS,
        ...(grant.firstMessage ? { overrides: { agent: { firstMessage: grant.firstMessage } } } : {}),
        onConnect: via("onConnect"),
        onDisconnect: via("onDisconnect"),
        onError: via("onError"),
        onModeChange: via("onModeChange"),
        onIncomingEvent: via("onIncomingEvent"),
        onMessage: via("onMessage"),
        onAgentResponseCorrection: via("onAgentResponseCorrection"),
        onVadScore: via("onVadScore"),
        onInterruption: via("onInterruption"),
      });
      if (!s.wanted) {
        // Hung up (or the screen went for good) while it was still connecting:
        // end it the moment it exists, so the mic is never live on a call he left.
        void c.endSession().catch(() => {});
        return null;
      }
      s.conv = c;
      return c;
    } catch (err) {
      if (!s.wanted) return null;
      forgetSession(s);
      s.handlers?.failed(err);
      return null;
    }
  })();
}

/** Per-row bookkeeping: which responses (event ids) it carries, and their text. */
interface RowMeta {
  events: Set<number>;
  responses: Map<number, string>;
}

/** The sync measurements of this call (also read by the e2e harness). */
interface SyncLog {
  anchors: { eventId: number; errMs: number; latencyMs: number }[];
  checks: { errMs: number }[];
  paced: number;
}

/** This turn's last agent reply (after his last line), if any. */
function lastReplyOfTurn(turns: VoiceTurn[]): AgentVoiceTurn | null {
  const i = turns.findLastIndex((x) => x.kind === "agent");
  const lastUser = turns.findLastIndex((x) => x.kind === "user");
  return i >= 0 && i > lastUser ? (turns[i] as AgentVoiceTurn) : null;
}

export function useElevenLayer(bot: string, active: boolean, onFallback: (reason: string) => void): VoiceLayerApi {
  const [phase, setPhase] = useState<VoicePhase>("off");
  const [turns, setTurns] = useState<VoiceTurn[]>([]);
  const [provisional, paintProvisional] = useState("");
  // His live words arrive one at a time (wordpacer.ts). Only the ear's
  // partials are paced; every other change to the line is immediate.
  const pacer = useRef<WordPacer | null>(null);
  pacer.current ??= new WordPacer(paintProvisional);
  const setProvisional = useCallback((text: string) => pacer.current!.jump(text), []);
  const [muted, setMuted] = useState(false);
  const [barging, setBarging] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [interrupted, setInterrupted] = useState(false);
  const [voiceStreamId, setVoiceStreamId] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [working, setWorking] = useState<{ sec: number; steps: number } | null>(null);
  const conv = useRef<Conversation | null>(null);
  const ear = useRef<ElevenEar | null>(null);
  const vsid = useRef<string | null>(null);
  const startedAt = useRef(0);
  const fallbackRef = useRef(onFallback);
  fallbackRef.current = onFallback;
  /** This screen's session (module-held: it outlives a remount). */
  const session = useRef<ElevenSession | null>(null);
  const nudgeTimer = useRef<number | null>(null);

  /** Tell the gateway the call is over, once: the card lands now, not when ElevenLabs closes its socket. */
  const reportEnd = useCallback((reason: string) => {
    const s = session.current;
    if (!s || s.endSent || !s.vsid) return;
    s.endSent = true;
    reportElevenEvent(s.vsid, "ended", reason);
  }, []);
  const beat = useRef<{ at: number; sinceMs: number; quietMs: number; tools: number } | null>(null);
  const phaseRef = useRef<VoicePhase>("off");
  phaseRef.current = phase;
  const turnsRef = useRef<VoiceTurn[]>([]);
  turnsRef.current = turns;

  /* ── Start / stop ───────────────────────────────────────────────────── */
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const me = Symbol("eleven-screen");
    const held = sessions.get(bot);
    // A second screen for this agent while another one drives its live call
    // (unreachable with one CallHost; a belt): refused. Taking it over would
    // orphan the live connection behind a second token.
    if (held && held.wanted && held.owner) {
      console.warn(`[eleven] a second call screen for ${bot} — refused; the live call stays with the screen that has it (${held.vsid ?? "minting"})`);
      return;
    }
    // A session for this agent whose screen just went without hanging up (a
    // remount): adopt it. Never a second token while one is live.
    const adopted = held && held.wanted ? held : null;
    const sess: ElevenSession = adopted ?? {
      bot,
      vsid: null,
      conv: null,
      wanted: true,
      owner: null,
      handlers: null,
      endSent: false,
      connected: false,
      heardAnything: false,
      view: { turns: [], phase: "connecting", startedAt: Date.now() },
      ready: Promise.resolve(null),
      call: newCallState(),
      parked: [],
      offPark: null,
    };
    sess.owner = me;
    sess.offPark?.();
    sess.offPark = null;
    session.current = sess;
    sessions.set(bot, sess);
    const st = sess.call;
    setPhase(adopted ? adopted.view.phase : "connecting");
    setTurns(adopted ? adopted.view.turns : []);
    setProvisional(adopted ? adopted.call.caption : "");
    setMuted(false);
    setVoiceUplinkMuted(false);
    setErrorText(null);
    setInterrupted(false);
    setVoiceStreamId(sess.vsid);
    setWorking(null);
    setSharing(false);
    vsid.current = sess.vsid;
    beat.current = null;
    startedAt.current = sess.view.startedAt;
    setElapsedSec(Math.floor((Date.now() - startedAt.current) / 1000));
    if (adopted) {
      console.info(`[eleven] screen remounted: the live call carries on (${adopted.vsid ?? "minting"})`);
      reportElevenEvent(adopted.vsid, "adopted", adopted.conv ? "connected" : "connecting");
    }

    // The call clock: ms since the call started (the same clock across a
    // remount). Word timings live on it, and the transcript's karaoke reads
    // it as its playback position. A replayed callback reads the clock at
    // the moment it really landed.
    let replayAt: number | null = null;
    const clockMs = (): number => (replayAt ?? performance.now()) - st.zero;
    setExternalVoiceClock(() => clockMs() / 1000);
    // His words follow the voice on this call, as on the native one.
    setServerTextFollowsVoice(true);
    const timeline = st.timeline;
    const sync = st.sync;
    (globalThis as { __elevenSync?: SyncLog }).__elevenSync = sync;
    let interimHold = 0;
    /** The caption's expiry timer, for what is left of st.captionUntil. */
    const watchCaption = (): void => {
      window.clearTimeout(interimHold);
      if (!st.captionUntil) return;
      interimHold = window.setTimeout(() => {
        if (cancelled || !st.captionUntil) return;
        if (Date.now() < st.captionUntil) return watchCaption();
        st.caption = "";
        st.captionUntil = 0;
        setProvisional("");
      }, Math.max(0, st.captionUntil - Date.now()));
    };
    const armCaption = (): void => {
      st.captionUntil = Date.now() + __captionHold.ms;
      watchCaption();
    };
    // Adopted: the caption it carries keeps its original expiry.
    if (adopted && st.captionUntil && Date.now() >= st.captionUntil) {
      st.caption = "";
      st.captionUntil = 0;
      setProvisional("");
    } else if (adopted) watchCaption();
    const bump = (): void => setTurns((prev) => [...prev]);

    const newRow = (): AgentVoiceTurn => {
      const t: AgentVoiceTurn = {
        kind: "agent",
        id: nextId(),
        karaoke: createKaraokeState(),
        settled: false,
        interrupted: false,
        failed: null,
        committedText: "",
        work: [],
      };
      st.meta.set(t, { events: new Set(), responses: new Map() });
      st.row = t;
      setTurns((prev) => [...prev, t]);
      return t;
    };
    const speechRow = (): AgentVoiceTurn => st.row ?? newRow();

    /** The row is done: its text settles — all of it, or (cut) only what was said. */
    const settle = (t: AgentVoiceTurn, cut: boolean): void => {
      if (t.settled) return;
      const m = st.meta.get(t);
      const k = t.karaoke;
      let text: string;
      if (cut) {
        timeline.cut(clockMs());
        k.words = k.words.slice(0, spokenCount(k, clockMs() / 1000));
        text = k.words.map((w) => w.text).join(" ");
        t.interrupted = k.words.length > 0 || t.interrupted;
      } else {
        const said = m ? [...m.events].sort((a, b) => a - b).map((id) => m.responses.get(id) ?? "").join(" ") : "";
        text = said.trim() || k.words.map((w) => w.text).join(" ");
      }
      t.committedText = sanitizeForTranscript(text);
      k.committedText = t.committedText;
      k.displayText = t.committedText;
      k.consumed = t.committedText.length;
      t.settled = true;
      if (st.row === t) st.row = null;
      if (m) {
        timeline.forget(m.events);
        for (const id of m.events) st.doneEvents.add(id);
      }
      const empty = !t.committedText && !t.work.length;
      setTurns((prev) => (empty ? prev.filter((x) => x !== t) : [...prev]));
    };

    const onAlignment = (eventId: number, a: ElevenAlignment): void => {
      if (eventId <= st.cutEvent || st.doneEvents.has(eventId) || !a?.chars?.length) return;
      const t = speechRow();
      st.meta.get(t)?.events.add(eventId);
      timeline.ingest(eventId, a, t.karaoke, clockMs());
      bump();
    };

    const onAgentText = (text: string, eventId: number): void => {
      if (eventId <= st.cutEvent || st.doneEvents.has(eventId)) return;
      // The row already carrying this response, or the one being spoken, or a new one.
      let t = st.row;
      if (!t || !st.meta.get(t)?.events.has(eventId)) t = speechRow();
      const m = st.meta.get(t)!;
      m.events.add(eventId);
      m.responses.set(eventId, text);
      if (!timeline.has(eventId)) {
        window.setTimeout(() => {
          if (cancelled || timeline.has(eventId) || t!.settled || eventId <= st.cutEvent) return;
          // Never the normal path: the engine sent no word timings for this response.
          const startMs = Math.max(clockMs() + timeline.latencyMs, timeline.endMs);
          t!.karaoke.words.push(...pacedWords(text, startMs));
          sync.paced++;
          console.warn(`[eleven] e${eventId}: no alignment from the engine — words paced by estimate`);
          reportElevenEvent(vsid.current, "no-alignment");
          bump();
        }, NO_ALIGNMENT_AFTER_MS);
      }
    };

    // The engine's callbacks, for as long as this screen owns the session.
    const handlers: SessionHandlers = {
      onConnect: () => {
        sess.connected = true;
        st.mode = { mode: "listening", since: Date.now() };
        if (cancelled) return;
        setPhase("listening");
        reportElevenEvent(vsid.current, "connected");
      },
      onDisconnect: (d) => {
        // The call is over, whoever ended it: nothing is left to adopt.
        forgetSession(sess);
        if (cancelled) return;
        // Their service dropped the call before a single turn: place it natively instead.
        if (!sess.heardAnything && d.reason !== "user") {
          cancelled = true;
          conv.current = null;
          reportElevenEvent(vsid.current, "fallback", sess.connected ? "dropped-before-first-turn" : "connect-failed");
          reportEnd("fallback");
          fallbackRef.current("dropped-before-first-turn");
          return;
        }
        // The SDK's own ending, or ours. An error ending is a cut-off call.
        if (d.reason === "error") setInterrupted(true);
        reportEnd(d.reason === "user" ? "user" : d.reason === "agent" ? "agent" : "error");
        setPhase("ended");
      },
      onError: (message) => {
        console.warn("[eleven] call error:", message);
        if (!cancelled && !sess.connected) setErrorText("The call could not connect.");
      },
      onModeChange: ({ mode }) => {
        if (cancelled) return;
        if (mode !== st.mode.mode) st.mode = { mode, since: Date.now() };
        setPhase((p) => (p === "ended" ? p : mode === "speaking" ? "speaking" : "listening"));
      },
      // Every engine event: the audio ones carry the alignment (WebRTC
      // too — onAudioAlignment drops the event id we need).
      onIncomingEvent: (e) => {
        if (cancelled) return;
        const ev = e as { type?: string; audio_event?: { event_id?: number; alignment?: ElevenAlignment } };
        if (ev.type === "audio" && ev.audio_event?.alignment && typeof ev.audio_event.event_id === "number") {
          onAlignment(ev.audio_event.event_id, ev.audio_event.alignment);
        }
      },
      onMessage: (m) => {
        if (cancelled || !m.message?.trim()) return;
        sess.heardAnything = true;
        if (m.role === "user") {
          // The engine re-engaging a quiet line sends a "..." user turn: not him.
          if (/^[.…\s]+$/.test(m.message)) return;
          // ElevenLabs' final is the line: it replaces the words of it on
          // the caption; closed words after it stay until their own final.
          st.caption = captionAfterFinal(st.caption, m.message);
          if (!st.caption) {
            window.clearTimeout(interimHold);
            st.captionUntil = 0;
          }
          setProvisional(st.caption);
          st.finalWords = [...(st.finalWords ?? []), ...lineWords(m.message)];
          // He spoke: whatever is still on screen of my last reply settles —
          // whole if it was all said, cut at what was said if not.
          const r = st.row;
          if (r) {
            const last = r.karaoke.words[r.karaoke.words.length - 1];
            settle(r, !!last && clockMs() / 1000 < last.end);
          }
          const turn: UserVoiceTurn = { kind: "user", id: nextId(), text: m.message.trim() };
          setTurns((prev) => [...prev, turn]);
          setPhase((p) => (p === "ended" ? p : "thinking"));
          return;
        }
        onAgentText(m.message.trim(), m.event_id);
      },
      onAgentResponseCorrection: (corr) => {
        // What the engine says was really spoken of a cut response. Our own
        // cut (by the clock) already holds; this only fills a row with no words.
        if (cancelled) return;
        const r = st.row;
        if (r && st.meta.get(r)?.events.has(corr.event_id) && !r.karaoke.words.length) {
          st.meta.get(r)!.responses.set(corr.event_id, corr.corrected_agent_response.trim());
        }
      },
      onVadScore: ({ vadScore }) => {
        if (vadScore > 0.5) st.voiceAt = Date.now();
      },
      onInterruption: (i) => {
        if (cancelled) return;
        st.cutEvent = Math.max(st.cutEvent, typeof i?.event_id === "number" ? i.event_id : st.cutEvent);
        if (st.row) settle(st.row, true);
        setBarging(true);
        window.setTimeout(() => setBarging(false), BARGE_FLIP_MS);
        reportElevenEvent(vsid.current, "interruption");
      },
      granted: (id) => {
        if (cancelled) return;
        vsid.current = id;
        setVoiceStreamId(id);
      },
      failed: (err) => {
        if (cancelled) return;
        const name = (err as Error)?.name ?? "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          reportElevenEvent(vsid.current, "mic-denied");
          setPhase("denied");
          return;
        }
        // Their service would not take the call: place it natively instead.
        reportElevenEvent(vsid.current, "fallback", "connect-failed");
        fallbackRef.current("connect-failed");
      },
      fallback: (reason) => {
        if (!cancelled) fallbackRef.current(reason);
      },
    };
    sess.handlers = handlers;
    // What landed while the session was parked, in order, on the clock it landed on.
    const missed = sess.parked.splice(0);
    for (const e of missed) {
      replayAt = e.at;
      try {
        (handlers[e.k] as ((...x: unknown[]) => void) | undefined)?.(...e.a);
      } finally {
        replayAt = null;
      }
    }
    if (missed.length) console.info(`[eleven] ${missed.length} engine event(s) from the remount gap kept`);

    // The connection is up: this screen's ear and its voice clock attach to it.
    const attach = (c: Conversation): void => {
      conv.current = c;
      // Adopted after it connected: the connect callback went to the old screen.
      if (sess.connected) setPhase((p) => (p === "connecting" ? "listening" : p));
      // His words, live: tap the SDK's own mic for the gateway's recognizer.
      void startElevenEar(c, bot, sess.vsid ?? "").then((e) => {
        if (cancelled || conv.current !== c) e?.stop();
        else ear.current = e;
      });
      // The voice's real start and stops: anchors for the word clock, and the
      // measured lead/lag of the highlight against the audio.
      const iv = window.setInterval(() => {
        if (cancelled || conv.current !== c) return window.clearInterval(iv);
        const v = c.getOutputVolume();
        const now = clockMs();
        if (!st.loud && v > LOUD) {
          st.loud = true;
          const gap = st.quietSince ? now - st.quietSince : Infinity;
          if (gap >= ONSET_AFTER_QUIET_MS) {
            const anchored = timeline.onset(now);
            if (anchored) {
              sync.anchors.push(anchored);
              if (st.row) bump();
              console.info(`[eleven-sync] e${anchored.eventId} anchored: guess ${anchored.errMs >= 0 ? "+" : ""}${anchored.errMs}ms, latency now ${anchored.latencyMs}ms`);
            } else {
              // The voice resumed after a pause inside a response: measure the
              // highlight against it, then pull the rest of the line onto it.
              const r = st.row;
              const re = r ? timeline.realign(r.karaoke, now) : null;
              if (re) {
                sync.checks.push({ errMs: re.errMs });
                console.info(`[eleven-sync] onset check: highlight ${re.errMs >= 0 ? "+" : ""}${re.errMs}ms vs audio${re.corrected ? " (corrected)" : ""}`);
              }
            }
          }
        } else if (st.loud && v < QUIET) {
          st.loud = false;
          st.quietSince = now;
        }
        // A row whose responses are all in and whose last word has been said settles.
        // Never on text alone: the engine's text can land before its first
        // audio chunk, and settling then paints the whole block at once and
        // drops the alignment that follows. A response
        // with no timings at all gets paced words after NO_ALIGNMENT_AFTER_MS.
        const r = st.row;
        const m = r ? st.meta.get(r) : null;
        if (r && m && m.events.size > 0 && !st.loud) {
          const allIn = [...m.events].every((id) => m.responses.has(id));
          const last = r.karaoke.words[r.karaoke.words.length - 1];
          if (allIn && last && now / 1000 >= last.end + 0.15 && now - st.quietSince >= 150) settle(r, false);
        }
      }, 10);
    };
    if (!adopted) sess.ready = openElevenSession(sess);
    void sess.ready.then((c) => {
      if (c && !cancelled && sess.owner === me && sess.wanted) attach(c);
    });

    /**
     * Michael has speech owed and ElevenLabs has no open turn to carry it:
     * open one with a "..." (the shape of their own re-engage), once the
     * agent has stopped talking and he is not speaking — never over either.
     * `asked` is when the gateway asked: a nudge waiting across a remount
     * keeps its time, and the mode it waits on is the call's, not reset.
     */
    const waitToNudge = (asked: number): void => {
      st.nudgeAskedAt = asked;
      nudgeTimer.current = window.setInterval(() => {
        const now = Date.now();
        const quiet = st.mode.mode === "listening" && now - st.mode.since >= 1_200 && now - st.voiceAt >= 1_500;
        if (!conv.current || quiet || now - asked > NUDGE_WAIT_MS) {
          if (nudgeTimer.current !== null) window.clearInterval(nudgeTimer.current);
          nudgeTimer.current = null;
          st.nudgeAskedAt = null;
          // The gateway's log gets the wait, so dead air is measured end to end.
          if (conv.current && quiet) {
            conv.current.sendUserMessage("...");
            console.info(`[eleven] nudge sent after ${now - asked}ms`);
            reportElevenEvent(vsid.current, "nudge-sent", `after-${now - asked}ms`);
          } else if (conv.current) reportElevenEvent(vsid.current, "nudge-dropped", `after-${now - asked}ms`);
        }
      }, 200);
    };
    if (st.nudgeAskedAt !== null) waitToNudge(st.nudgeAskedAt);

    /* ── The gateway's side: his live words, work lines, liveness ─────── */
    const off = onVoiceEvent((ev) => {
      if (!vsid.current || ev.voiceStreamId !== vsid.current) return;
      if (ev.type === "stt-interim") {
        let text = typeof ev.text === "string" ? ev.text : "";
        // A late partial of the line ElevenLabs just finalised is not painted
        // back, but the words he says past it are, as he says them; anything
        // else is new speech, shown at once.
        if (text && st.finalWords) {
          const past = pastFinalLine(text, st.finalWords);
          if (past === "") return;
          if (past === null) st.finalWords = null;
          else text = past;
        }
        // After a pause in an open sentence: what he said before it stays, the new words follow it.
        if (text) armCaption();
        pacer.current!.to(joinCaption(st.caption, text));
      } else if (ev.type === "stt-ear-final") {
        // Our recognizer closed the utterance; ElevenLabs' final is the one
        // that counts and replaces it. Until it comes, the line stays up.
        // Of a line ElevenLabs finalised mid-way, only the words past it stay.
        let text = typeof ev.text === "string" ? ev.text.trim() : "";
        if (st.finalWords) {
          const past = text ? pastFinalLine(text, st.finalWords) : "";
          st.finalWords = null;
          if (past === "") return;
          if (past !== null) text = past;
        }
        if (text) st.caption = joinCaption(st.caption, text);
        setProvisional(st.caption);
        armCaption();
      } else if (ev.type === "voice-work" && typeof ev.text === "string" && ev.text.trim()) {
        // Shown, never spoken: under the reply being said, else under this
        // turn's last reply, else on a row of its own (work before any words).
        const line = ev.text.trim();
        const t = st.row ?? lastReplyOfTurn(turnsRef.current);
        if (t) {
          t.work = [...t.work, line];
          bump();
        } else newRow().work = [line];
      } else if (ev.type === "voice-eleven-nudge") {
        // A withdrawn ask (an event came first) clears a nudge still waiting.
        if (ev.cancel === true) {
          if (nudgeTimer.current !== null) window.clearInterval(nudgeTimer.current);
          nudgeTimer.current = null;
          st.nudgeAskedAt = null;
          return;
        }
        if (nudgeTimer.current !== null) return;
        waitToNudge(Date.now());
      } else if (ev.type === "voice-working") {
        if (ev.ended === true) {
          beat.current = null;
          return;
        }
        beat.current = {
          at: Date.now(),
          sinceMs: typeof ev.sinceMs === "number" ? ev.sinceMs : 0,
          quietMs: typeof ev.quietMs === "number" ? ev.quietMs : 0,
          tools: typeof ev.tools === "number" ? ev.tools : 0,
        };
      }
    });
    return () => {
      cancelled = true;
      if (nudgeTimer.current !== null) window.clearInterval(nudgeTimer.current);
      nudgeTimer.current = null;
      off();
      window.clearTimeout(interimHold);
      pacer.current?.cancel();
      ear.current?.stop();
      ear.current = null;
      stopScreenShare(bot);
      setExternalVoiceClock(null);
      setVoiceUplinkMuted(false);
      if (sync.anchors.length || sync.checks.length) {
        const worst = sync.checks.reduce((w, c) => Math.max(w, Math.abs(c.errMs)), 0);
        console.info(`[eleven-sync] call: ${sync.anchors.length} anchor(s), ${sync.checks.length} onset check(s), worst ${worst}ms, ${sync.paced} paced response(s)`);
      }
      conv.current = null;
      if (sess.owner === me) sess.owner = null;
      if (!sess.wanted) return;
      // Not hung up: park the session. A screen mounting for this agent in
      // the next PARK_MS adopts it (a remount), with every engine event and
      // nudge ask that lands meanwhile; otherwise the call ends here.
      sess.view = { turns: turnsRef.current, phase: phaseRef.current, startedAt: startedAt.current };
      sess.handlers = parkedHandlers(sess);
      sess.offPark = onVoiceEvent((ev) => {
        if (ev.type !== "voice-eleven-nudge" || !sess.vsid || ev.voiceStreamId !== sess.vsid) return;
        if (ev.cancel === true) st.nudgeAskedAt = null;
        else if (st.nudgeAskedAt === null) st.nudgeAskedAt = Date.now();
      });
      window.setTimeout(() => {
        if (sess.owner || !sess.wanted) return;
        forgetSession(sess);
        if (sess.vsid && !sess.endSent) {
          sess.endSent = true;
          reportElevenEvent(sess.vsid, "ended", "unmount");
        }
        if (sess.conv) void sess.conv.endSession().catch(() => {});
      }, PARK_MS);
    };
  }, [active, bot, reportEnd]);

  /* ── WORKING: the turn is in flight and nothing has been said for a while ── */
  useEffect(() => {
    if (!active) return;
    const iv = window.setInterval(() => {
      const b = beat.current;
      const now = Date.now();
      const p = phaseRef.current;
      const busy = !!b && now - b.at <= WORKING_TTL_MS && b.quietMs + (now - b.at) >= WORKING_QUIET_MS && p !== "speaking" && p !== "ended";
      setWorking((prev) => {
        if (!busy) return prev === null ? prev : null;
        const sec = Math.floor((b!.sinceMs + (now - b!.at)) / 1000);
        return prev && prev.sec === sec && prev.steps === b!.tools ? prev : { sec, steps: b!.tools };
      });
    }, 500);
    return () => window.clearInterval(iv);
  }, [active]);

  // Something said resets the quiet clock of the beat, as the gateway's own next beat will.
  useEffect(() => {
    if (phase === "speaking" && beat.current) beat.current = { ...beat.current, quietMs: 0, at: Date.now(), sinceMs: beat.current.sinceMs + (Date.now() - beat.current.at) };
    if (phase === "ended") beat.current = null;
  }, [phase]);

  /* ── Timer ──────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (!active || phase === "off" || phase === "ended") return;
    const iv = window.setInterval(() => setElapsedSec(Math.floor((Date.now() - startedAt.current) / 1000)), 500);
    return () => window.clearInterval(iv);
  }, [active, phase]);

  // The call is over: the ear and the share stop on the same frame.
  useEffect(() => {
    if (phase !== "ended" && phase !== "failed" && phase !== "denied") return;
    ear.current?.stop();
    ear.current = null;
    stopScreenShare(bot);
    setSharing(false);
    setProvisional("");
  }, [phase, bot]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      conv.current?.setMicMuted(next);
      // The side ear's frames stop on the device and on the gateway too.
      setVoiceUplinkMuted(next);
      sendVoiceControl({ type: "voice-mute", bot, on: next });
      if (next) {
        setProvisional("");
        if (session.current) {
          session.current.call.caption = "";
          session.current.call.captionUntil = 0;
        }
      }
      return next;
    });
  }, [bot]);

  const toggleShare = useCallback(() => {
    if (sharing) {
      stopScreenShare(bot);
      setSharing(false);
      return;
    }
    // The share belongs to THIS call: the gateway checks the id.
    void startScreenShare(bot, () => setSharing(false), vsid.current).then((ok) => setSharing(ok));
  }, [bot, sharing]);

  const end = useCallback(() => {
    reportEnd("user");
    const s = session.current;
    // Over for good: never adopted, and a connection still on its way is ended when it lands.
    if (s) forgetSession(s);
    const c = conv.current ?? s?.conv ?? null;
    conv.current = null;
    setPhase("ended");
    if (c) void c.endSession().catch(() => {});
  }, [reportEnd]);

  return {
    phase,
    provisional,
    turns,
    muted,
    barging,
    elapsedSec,
    errorText,
    hearing: "ok",
    sharing,
    canShare: canShareScreen(),
    toggleShare,
    // Record mode is native-only: the ElevenLabs engine answers on its own, it cannot be held quiet.
    recording: null,
    canRecord: false,
    toggleRecord: () => {},
    sendDrop: () => setDropError(UNSUPPORTED),
    dropBusy: false,
    dropError,
    interrupted,
    voiceStreamId,
    link: "ok",
    floor: "open",
    working,
    toggleMute,
    end,
    retryMic: () => fallbackRef.current("retry"),
    leave: end,
  };
}
