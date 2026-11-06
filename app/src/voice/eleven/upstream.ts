import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { WebSocket } from "ws";
import { ELEVEN_SECRET_HEADER } from "./config.js";

/* ============================================================
   eleven/upstream.ts — the Speech Engine upstream socket, our side.

   ElevenLabs is the WebSocket CLIENT here: for every conversation on the
   engine it opens a socket to our ws_url and speaks a tiny JSON protocol
   (docs: eleven-agents/api-reference/speech-engine-upstream):

     in   init {conversation_id}
          user_transcript {user_transcript: [{role, content}…], event_id}
          ping · close · error {message}
     out  agent_response {content, event_id, is_final} · pong

   A response is any number of `is_final:false` chunks, then one
   `is_final:true` with empty content. A transcript with a higher event_id
   means he spoke again; anything we send for an older id is dropped by
   ElevenLabs. Implemented here on `ws` rather than through their server SDK:
   the SDK wants to own the HTTP server's upgrade listener, and the gateway's
   upgrade router destroys any socket it does not route.

   Auth, both required:
     - X-Elevenlabs-Speech-Engine-Authorization: an HS256 JWT keyed by the
       SHA-256 of our API key (iss/sub fixed, exp/iat with 60 s leeway) —
       the same check as their SDK's verifySpeechEngineJwt;
     - x-ahi-eleven-secret: ELEVENLABS_LLM_SECRET, sent by the engine config
       (request_headers). Required: with no secret configured the socket is
       refused outright, so their JWT is never the only lock on the door.
   ============================================================ */

const ISSUER = "https://api.elevenlabs.io/convai/speech-engine";
const SUBJECT = "convai_speech_engine_upstream";
const LEEWAY_S = 60;
const RESIDENCY_SUFFIX = /_residency_[a-z0-9]+$/;

const b64url = (s: string): Buffer => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Null when the JWT is valid for this API key; otherwise why not (never echoes the token). */
export function verifyUpstreamJwt(value: string, apiKey: string, nowSec = Math.floor(Date.now() / 1000)): string | null {
  let token = value.trim();
  if (token.toLowerCase().startsWith("bearer ")) token = token.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 3) return "jwt: not three parts";
  const [h, p, sig] = parts;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(b64url(p).toString("utf8")) as Record<string, unknown>;
  } catch {
    return "jwt: bad payload";
  }
  const secret = createHash("sha256").update(apiKey.trim().replace(RESIDENCY_SUFFIX, ""), "utf8").digest();
  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  const actual = b64url(sig);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return "jwt: signature mismatch";
  if (payload.iss !== ISSUER) return "jwt: wrong issuer";
  if (payload.sub !== SUBJECT) return "jwt: wrong subject";
  if (typeof payload.exp !== "number" || typeof payload.iat !== "number") return "jwt: missing exp/iat";
  if (payload.exp + LEEWAY_S < nowSec) return "jwt: expired";
  if (payload.iat - LEEWAY_S > nowSec) return "jwt: issued in the future";
  return null;
}

const header = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
};

/** Null when an upgrade request may become an upstream socket; otherwise why not. */
export function checkUpstreamRequest(
  headers: IncomingHttpHeaders,
  env: NodeJS.ProcessEnv = process.env,
  nowSec?: number,
): string | null {
  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) return "no ELEVENLABS_API_KEY";
  const jwt = header(headers, "x-elevenlabs-speech-engine-authorization");
  if (!jwt) return "missing speech-engine authorization header";
  const bad = verifyUpstreamJwt(jwt, apiKey, nowSec);
  if (bad) return bad;
  const secret = env.ELEVENLABS_LLM_SECRET;
  if (!secret) return "no ELEVENLABS_LLM_SECRET";
  const got = header(headers, ELEVEN_SECRET_HEADER) ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "secret header missing or wrong";
  return null;
}

export interface TranscriptMessage {
  role: "user" | "agent";
  content: string;
}

export interface UpstreamHandlers {
  onInit(conversationId: string): void;
  onTranscript(history: TranscriptMessage[], eventId: number): void;
  /** ElevenLabs said the conversation is over (clean end). */
  onClose(): void;
  /** The socket went away without a `close` message. */
  onDisconnect(code: number): void;
  onError(message: string): void;
}

/** Bound on what one transcript event may carry into the gateway. The brain
 *  tells a new turn from a re-engage by counting user lines, so the history
 *  must never be cut inside a real call: an idle engine re-engages every few
 *  seconds, each one a user line, and a 40-minute call can carry well over
 *  400 of them. Only an authenticated engine reaches this. */
const MAX_HISTORY = 4_000;
const MAX_CONTENT = 8_000;

/** Parse one upstream message; null for anything malformed or unknown. */
export function parseUpstreamMessage(raw: string):
  | { type: "init"; conversationId: string }
  | { type: "user_transcript"; history: TranscriptMessage[]; eventId: number }
  | { type: "ping" | "close" }
  | { type: "error"; message: string }
  | null {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (msg.type) {
    case "init":
      return typeof msg.conversation_id === "string" ? { type: "init", conversationId: msg.conversation_id } : null;
    case "user_transcript": {
      if (!Array.isArray(msg.user_transcript)) return null;
      const history = msg.user_transcript
        .slice(-MAX_HISTORY)
        .map((m) => m as Record<string, unknown>)
        .filter((m) => (m.role === "user" || m.role === "agent") && typeof m.content === "string")
        .map((m) => ({ role: m.role as "user" | "agent", content: String(m.content).slice(0, MAX_CONTENT) }));
      const eventId = typeof msg.event_id === "number" && Number.isFinite(msg.event_id) ? msg.event_id : -1;
      return { type: "user_transcript", history, eventId };
    }
    case "ping":
    case "close":
      return { type: msg.type };
    case "error":
      return { type: "error", message: String(msg.message ?? "").slice(0, 300) };
    default:
      return null;
  }
}

/** One conversation's upstream socket. */
export class UpstreamLink {
  private closedByPeer = false;
  private ended = false;
  /** When anything (ping included) last arrived from ElevenLabs. */
  lastMessageAt = Date.now();

  constructor(
    private readonly ws: Pick<WebSocket, "send" | "close" | "on" | "readyState">,
    private readonly handlers: UpstreamHandlers,
  ) {
    ws.on("message", (data: Buffer | string) => this.receive(typeof data === "string" ? data : data.toString("utf8")));
    ws.on("close", (code: number) => {
      if (this.ended) return;
      this.ended = true;
      if (this.closedByPeer) handlers.onClose();
      else handlers.onDisconnect(code);
    });
    ws.on("error", (err: Error) => handlers.onError(err.message));
  }

  get open(): boolean {
    return !this.ended && this.ws.readyState === WebSocket.OPEN;
  }

  private receive(raw: string): void {
    this.lastMessageAt = Date.now();
    const msg = parseUpstreamMessage(raw);
    if (!msg) return;
    switch (msg.type) {
      case "init":
        this.handlers.onInit(msg.conversationId);
        return;
      case "user_transcript":
        this.handlers.onTranscript(msg.history, msg.eventId);
        return;
      case "ping":
        this.write({ type: "pong" });
        return;
      case "close":
        // The clean end. The socket's own close follows; report once, as clean.
        this.closedByPeer = true;
        if (!this.ended) {
          this.ended = true;
          this.handlers.onClose();
        }
        return;
      case "error":
        this.handlers.onError(msg.message);
        return;
    }
  }

  /** One text chunk (or, with isFinal, the end of the response) for this event. */
  respond(eventId: number, content: string, isFinal: boolean): void {
    this.write({ type: "agent_response", content, event_id: eventId, is_final: isFinal });
  }

  private write(msg: Record<string, unknown>): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      console.warn("[eleven] upstream send failed:", (err as Error).message);
    }
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}
