import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Socket } from "net";
import { storeMessage, getMessagesForUser } from "./message-store.js";
import {
  startStreamingRecognize,
  transcribeShort,
  type StreamingSttHandle,
} from "./stt.js";
import { lookupByToken, userCanAccessAgent, toPublic, type UserConfig } from "./users.js";
import { classifyVoiceNoise, type VoiceNoiseClassification } from "./voice-noise-classifier.js";

/** Optional hook invoked whenever the PWA's voice-mode finalizes a
 *  transcript. Wired by index.ts to the invokeAgent pipeline so a
 *  finalized utterance automatically drives a streaming reply. */
type VoiceTurnHandler = (opts: {
  botName: string;
  transcript: string;
  voiceStreamId: string;
  ws: WebSocket;
  user: UserConfig;
  audioRoute: string;
  speculationEnabled: boolean;
  forceSpeculationOnBluetooth: boolean;
  voiceStartedAt: number;
  tentativeFiredAt: number | null;
}) => void;

let voiceTurnHandler: VoiceTurnHandler | null = null;
export function setVoiceTurnHandler(fn: VoiceTurnHandler): void {
  voiceTurnHandler = fn;
}

type VoiceTentativeHandler = (opts: {
  botName: string;
  interimText: string;
  voiceStreamId: string;
  ws: WebSocket;
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

type VoiceInterruptHandler = (opts: {
  botName: string;
  voiceStreamId: string;
  ws: WebSocket;
  user: UserConfig;
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

/** Per-connection voice-mode state — one recognizer at a time. */
interface VoiceSession {
  bot: string;
  voiceStreamId: string;
  stt: StreamingSttHandle | null;
  /** Buffer of raw s16le PCM accumulated for REST fallback. Only
   *  populated if streaming recognize fails early. */
  pcmFallback: Buffer[] | null;
  /**
   * Google's streaming recognizer emits `isFinal: true` at every
   * end-of-segment boundary it detects — mid-utterance pauses, phrase
   * breaks, breath boundaries — not once per utterance. The VAD tier-2
   * silence window (~3.5s, decided client-side) is the only true
   * utterance boundary we care about.
   *
   * We therefore accumulate each Google-final segment here as it
   * arrives, but NEVER emit a `stt-final` to the PWA until the client
   * sends `voice-end` (VAD commit). At commit, we join these segments
   * with the currently-pending interim hypothesis, emit a SINGLE
   * `stt-final`, and hand off to `voiceTurnHandler`.
   *
   * Without this buffer (the pre-2026-04-21 behavior) every Google
   * segment was broadcast as its own `stt-final`, which the client
   * wrote as its own user bubble AND raced against the Claude response
   * triggered by whichever segment landed first — producing the split,
   * out-of-order transcript the operator saw.
   */
  finalSegments: string[];
  lastInterim: string;
  audioRoute: string;
  speculationEnabled: boolean;
  forceSpeculationOnBluetooth: boolean;
  startedAt: number;
  tentativeFiredAt: number | null;
  lastNoiseClassification: VoiceNoiseClassification | null;
}

const voiceSessions = new WeakMap<WebSocket, VoiceSession>();

/**
 * Per-socket authenticated user. Populated on upgrade (see handleUpgrade)
 * and consulted by every message handler so downstream logic knows
 * which user (and which agent visibility) the socket represents.
 */
const socketUsers = new WeakMap<WebSocket, UserConfig>();
const socketVoiceTurnCounts = new WeakMap<WebSocket, Map<string, number>>();

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
   * Canonical user id (lowercased user name: e.g. "primary",
   * or "unknown" when no user could be resolved from the chatId). Used
   * to scope the message store into per-user threads.
   */
  userId: string;
  /**
   * Human-readable sender display name (per-user from users.json, or
   * "unknown"). Populated from users.json by the ingress path and
   * surfaced to the UI so the feed shows real authorship instead of
   * a hardcoded fallback.
   */
  senderName: string;
  // Provenance of this message event. "telegram" = real user/bot exchange
  // over the Telegram edge; "ui-send" = dashboard Quick Send injection (test
  // tool, forged chatId, MUST be excluded from the retrieval corpus);
  // "app" = PWA (ahigate app on app-dev.ahigate.com) — real user turns,
  // INCLUDED in retrieval corpus.
  // Undefined on legacy records written before 2026-04-19 — treat as
  // "telegram" for backward compat.
  source?: "telegram" | "ui-send" | "app";
  meta?: {
    voiceDuration?: number;
    photoPath?: string;
    fileName?: string;
  };
}

const wss = new WebSocketServer({ noServer: true });

/**
 * Resolve the request's bearer token from query string or cookie and
 * look it up in the user registry. Returns the matched user or null.
 * Cookie name is `ahi_token` to match the dashboard login flow.
 */
function resolveUser(req: IncomingMessage): UserConfig | null {
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
    ws.send(JSON.stringify({ type: "session", user: toPublic(user) }));
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

  // Inbound handler — routes JSON control messages AND binary audio
  // frames arriving from the PWA's Voice Mode. Plain text chat still
  // goes through the HTTP /app/send path; WS inbound is a voice-only
  // channel. Silent drop for unknown shapes.
  ws.on("message", async (raw, isBinary) => {
    if (isBinary) {
      const session = voiceSessions.get(ws);
      if (!session) return; // unexpected binary without a voice-start
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      if (session.stt) {
        session.stt.write(buf);
      }
      session.lastNoiseClassification = classifyVoiceNoise(buf, { sampleRate: 16_000 });
      if (session.pcmFallback) {
        session.pcmFallback.push(buf);
      }
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const type = parsed.type as string;
    if (type === "ping") return; // app-level keepalive, see ws.ts

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
    if (type === "voice-cancel") {
      handleVoiceCancel(ws);
      return;
    }
    if (type === "voice-interrupt") {
      const session = voiceSessions.get(ws);
      const user = socketUsers.get(ws);
      if (session && user && voiceInterruptHandler) {
        voiceInterruptHandler({
          botName: session.bot,
          voiceStreamId: session.voiceStreamId,
          ws,
          user,
        });
      }
      try {
        ws.send(JSON.stringify({ type: "voice-interrupt-ack" }));
      } catch {
        /* noop */
      }
      return;
    }
  });

  ws.on("close", () => {
    const session = voiceSessions.get(ws);
    if (session?.stt) {
      try {
        session.stt.destroy();
      } catch {
        /* noop */
      }
    }
    voiceSessions.delete(ws);
    socketUsers.delete(ws);
  });
});

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

  // Close any prior session for this socket — only one recognizer at
  // a time per connection (PWA enforces this too).
  const prior = voiceSessions.get(ws);
  if (prior?.stt) {
    try {
      prior.stt.destroy();
    } catch {
      /* noop */
    }
  }

  const session: VoiceSession = {
    bot,
    voiceStreamId,
    stt: null,
    pcmFallback: null,
    finalSegments: [],
    lastInterim: "",
    audioRoute,
    speculationEnabled,
    forceSpeculationOnBluetooth,
    startedAt: Date.now(),
    tentativeFiredAt: null,
    lastNoiseClassification: null,
  };
  voiceSessions.set(ws, session);

  // Compose the full text the PWA should render live: everything
  // Google has already committed as final segments (joined with
  // spaces) plus whatever interim hypothesis is currently on the
  // wire. Used for BOTH `stt-interim` and `stt-final` payloads so the
  // client sees a single monotonically-growing string per utterance.
  const composeLive = (interim: string): string => {
    const committed = session.finalSegments.join(" ").trim();
    const live = interim.trim();
    if (committed && live) return `${committed} ${live}`;
    return committed || live;
  };

  try {
    session.stt = startStreamingRecognize({
      onInterim: (text) => {
        if (!text || text === session.lastInterim) return;
        session.lastInterim = text;
        const combined = composeLive(text);
        // INSTRUMENTATION 2026-04-21 — prove whether the gateway is
        // broadcasting interim frames to the PWA socket. If this logs
        // but Eruda doesn't show an [ws] stt-interim, the broadcast is
        // dropping (socket closed, readyState mismatch, JSON throw).
        console.log("[ws-tx] stt-interim", JSON.stringify(combined.slice(0, 80)));
        safeSend(ws, {
          type: "stt-interim",
          voiceStreamId,
          bot,
          text: combined,
        });
      },
      onFinal: (text) => {
        // Google emits `isFinal: true` per segment, NOT per utterance.
        // Accumulate here; do not emit `stt-final` to the PWA — that
        // happens once, at VAD commit, inside `handleVoiceEnd`. See
        // the VoiceSession.finalSegments comment for background.
        if (!text) return;
        session.finalSegments.push(text);
        session.lastInterim = "";
        // Push the committed text as an interim frame so the PWA keeps
        // the full running transcript visible even when Google moves
        // a phrase from interim → final (interim buffer clears on
        // finalization).
        const combined = composeLive("");
        console.log("[ws-tx] stt-interim (post-final)", JSON.stringify(combined.slice(0, 80)));
        safeSend(ws, {
          type: "stt-interim",
          voiceStreamId,
          bot,
          text: combined,
        });
      },
      onError: (err) => {
        console.warn(
          "[voice] streaming STT failed, enabling REST fallback:",
          err.message
        );
        session.stt = null;
        session.pcmFallback = session.pcmFallback ?? [];
        safeSend(ws, {
          type: "stt-mode",
          voiceStreamId,
          bot,
          mode: "final-only",
          reason: "streaming-auth-fallback",
        });
      },
    });
  } catch (err) {
    console.warn(
      "[voice] could not start streaming STT, using REST fallback:",
      (err as Error).message
    );
    session.pcmFallback = [];
    safeSend(ws, {
      type: "stt-mode",
      voiceStreamId,
      bot,
      mode: "final-only",
      reason: "no-streaming-client",
    });
  }

  safeSend(ws, { type: "voice-started", voiceStreamId, bot });
}

function handleVoiceTentativePause(ws: WebSocket, msg: Record<string, unknown>): void {
  const session = voiceSessions.get(ws);
  const user = socketUsers.get(ws);
  if (!session || !user) return;
  const voiceStreamId = typeof msg.voiceStreamId === "string" ? msg.voiceStreamId : session.voiceStreamId;
  if (voiceStreamId !== session.voiceStreamId) return;
  const interimText = typeof msg.text === "string" ? msg.text.trim() : composeSessionTranscript(session);
  if (!interimText) return;
  session.tentativeFiredAt = Date.now();
  const counts = socketVoiceTurnCounts.get(ws) ?? new Map<string, number>();
  socketVoiceTurnCounts.set(ws, counts);
  voiceTentativeHandler?.({
    botName: session.bot,
    interimText,
    voiceStreamId: session.voiceStreamId,
    ws,
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

  // Close the streaming recognizer if we had one — it will emit any
  // pending final via onFinal before firing onEnd. Wait a short beat
  // for it to settle before we decide to dispatch.
  if (session.stt) {
    try {
      session.stt.end();
    } catch {
      /* noop */
    }
    // Small drain window — onFinal events may still land after .end().
    await new Promise((r) => setTimeout(r, 350));
  }

  // Concatenate all of Google's per-segment finals into ONE utterance
  // transcript. This is the VAD-commit boundary — the single place
  // where we consider the user's turn complete. Trailing interim that
  // never got promoted to final is still appended so we don't drop
  // the user's last word when they stop mid-hypothesis.
  let transcript = session.finalSegments.join(" ").trim();
  const tailingInterim = session.lastInterim.trim();
  if (tailingInterim) {
    transcript = transcript ? `${transcript} ${tailingInterim}` : tailingInterim;
  }

  // REST fallback path: no streaming final, fire a one-shot recognize
  // against the buffered PCM.
  if (!transcript && session.pcmFallback && session.pcmFallback.length > 0) {
    const pcm = Buffer.concat(session.pcmFallback);
    try {
      transcript = (await transcribeShort(pcm)).trim();
    } catch (err) {
      console.error("[voice] REST transcribe failed:", (err as Error).message);
    }
  }

  if (!transcript) {
    // Nothing transcribable — let the PWA reset to listening.
    safeSend(ws, {
      type: "voice-empty",
      voiceStreamId: session.voiceStreamId,
      bot: session.bot,
    });
    // Keep the session alive for the next utterance.
    session.stt = null;
    session.pcmFallback = null;
    session.finalSegments = [];
    session.lastInterim = "";
    return;
  }

  // Final transcript confirmed — this is the ONE AND ONLY `stt-final`
  // the PWA will see for this utterance. The client writes exactly one
  // user bubble to the conversation store on receipt. See the
  // VoiceSession.finalSegments comment for why per-Google-segment
  // `stt-final` events were the wrong boundary.
  console.log("[ws-tx] stt-final (VAD commit)", JSON.stringify(transcript.slice(0, 120)));
  safeSend(ws, {
    type: "stt-final",
    voiceStreamId: session.voiceStreamId,
    bot: session.bot,
    text: transcript,
  });

  const user = socketUsers.get(ws);
  if (voiceTurnHandler && user) {
    voiceTurnHandler({
      botName: session.bot,
      transcript,
      voiceStreamId: session.voiceStreamId,
      ws,
      user,
      audioRoute: session.audioRoute,
      speculationEnabled: session.speculationEnabled,
      forceSpeculationOnBluetooth: session.forceSpeculationOnBluetooth,
      voiceStartedAt: session.startedAt,
      tentativeFiredAt: session.tentativeFiredAt,
    });
    const counts = socketVoiceTurnCounts.get(ws) ?? new Map<string, number>();
    counts.set(session.bot, (counts.get(session.bot) ?? 0) + 1);
    socketVoiceTurnCounts.set(ws, counts);
  } else if (!user) {
    console.warn("[voice] no authenticated user on socket — dropping utterance");
  } else {
    console.warn("[voice] no voiceTurnHandler registered — dropping utterance");
  }

  // Reset so the same session can capture the next utterance when the
  // user resumes listening in locked mode.
  session.stt = null;
  session.pcmFallback = null;
  session.finalSegments = [];
  session.lastInterim = "";
}

function composeSessionTranscript(session: VoiceSession): string {
  const transcript = session.finalSegments.join(" ").trim();
  const tail = session.lastInterim.trim();
  return transcript && tail ? `${transcript} ${tail}` : transcript || tail;
}

function handleVoiceCancel(ws: WebSocket): void {
  const session = voiceSessions.get(ws);
  if (!session) return;
  if (session.stt) {
    try {
      session.stt.destroy();
    } catch {
      /* noop */
    }
  }
  session.stt = null;
  session.pcmFallback = null;
  session.finalSegments = [];
  session.lastInterim = "";
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

/** Send a TTS audio payload to a specific socket. The PWA expects
 *  base64-encoded audio with an explicit mime so it can pick a codec. */
export function sendTtsAudio(
  ws: WebSocket,
  payload: { voiceStreamId: string; bot: string; audioBase64: string; mimeType: string; text?: string }
): void {
  safeSend(ws, { type: "voice-tts", ...payload });
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
 * messages are visible to anyone who can see that bot (e.g. the operator sees
 * Miriam messages from unrecognized senders even if they weren't from
 * his Telegram account).
 */
export function broadcast(event: MessageEvent): void {
  // Persist to disk (per-user keyed)
  storeMessage(event);

  const data = JSON.stringify(event);
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
}

/**
 * Broadcast an arbitrary JSON event to all authenticated WS clients
 * WITHOUT persisting. Used for streaming chunk events and similar
 * ephemeral signals. Stream events currently lack explicit userId/bot
 * scoping metadata; they are broadcast to all authenticated sockets
 * that can see the referenced bot when a `botName` field is present.
 */
export function broadcastEvent(event: Record<string, unknown>): void {
  const data = JSON.stringify(event);
  const eventBot = typeof event.botName === "string" ? event.botName : null;
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const user = socketUsers.get(client);
    if (!user) continue;
    if (eventBot && !userCanAccessAgent(user, eventBot)) continue;
    client.send(data);
  }
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
