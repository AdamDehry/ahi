/* ============================================================
   phone/index.ts — Michael's phone line (Twilio), both directions.

     POST /api/phone/voice    Twilio's voice webhook (signed). The owner's cell →
                              TwiML that bridges the call to our media stream
                              with a one-time ticket; anyone else → a polite
                              line and a hang-up.
     POST /api/phone/reattach Twilio's <Redirect> after the media stream closed
                              (signed): the same call gets a fresh stream that
                              re-attaches to it, or a hang-up if it is over.
     POST /api/phone/status   Twilio's call-status callback (signed); logged,
                              and a call that completed is ended here too.
     POST /api/phone/call     Michael calls the owner. Bearer REVIEW_DESK_TOKEN
                              (the gateway's service token; scripts/phone-call.mjs).
     WS   /api/phone/stream   The Media Stream itself (phone/stream.ts).

   The whole module is dark unless PHONE_ENABLED=true and the Twilio creds
   load (phone/twilio.ts). It never throws at boot.

   WHY A TICKET. Twilio refuses query strings on a Stream url, and the
   WebSocket itself carries nothing we can check against our own state. So
   the signed webhook — the one request we can authenticate — mints a random,
   single-use, two-minute ticket bound to the CallSid, and the stream must
   present both in its `start` message. A stream with no valid ticket is
   closed before it is heard.

   THE CALL OUTLIVES ITS STREAM (voice step 2). The TwiML after <Connect> is
   a <Redirect> back here, not <Hangup/>: when the media socket breaks
   (Twilio alert 31903 — three calls the week of 10/20), Twilio asks us what
   next on the same call. While that call is live the answer is a new stream
   with a fresh ticket marked `reattach`, and the stream hands its socket to
   the call (phone/stream.ts `attach`): same session, passphrase state as it
   was, no opener. Bounded per call. Every re-attach is logged next to the
   step-0 door line that says why the stream broke: recovery, never hiding.
   ============================================================ */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Context, Hono } from "hono";
import { WebSocketServer, type WebSocket } from "ws";
import type { CallAudioIn, CallTransport } from "../voice/call-transport.js";
import type { UserConfig } from "../users.js";
import { readPassphrase, type PassphraseRecord } from "./passphrase.js";
import { phoneLinesFor, PhoneStream, type PhoneCallInfo, type PhoneStreamOptions } from "./stream.js";
import { turnsInFlight } from "../voice/turn-liveness.js";
import {
  classifyCaller,
  connectStreamTwiml,
  hangupTwiml,
  sayAndHangupTwiml,
  TwilioRest,
  validTwilioSignature,
  type TwilioCreds,
} from "./twilio.js";

export interface PhoneDeps {
  creds: TwilioCreds;
  /** Where Twilio reaches us, e.g. https://your-address (no trailing slash). */
  publicUrl: string;
  bot: string;
  /** The person the line belongs to . */
  user(): UserConfig | null;
  openCall(
    transport: CallTransport,
    opts: { bot: string; user: UserConfig; voiceStreamId: string; interceptTurn?: (text: string) => boolean; mayDraft?: () => boolean; direction?: "inbound" | "outbound" },
  ): CallAudioIn | { error: string };
  say(text: string, voiceStreamId: string): Promise<{ pcm: Buffer; sampleRate: number }>;
  passphraseFile: string;
  /** Bearer token for POST /api/phone/call. Unset = the endpoint answers 503. */
  serviceToken(): string | undefined;
  rest?: TwilioRest;
  streamOptions?: Partial<PhoneStreamOptions>;
  /** Seconds Michael's outbound call rings before giving up (before voicemail picks up). */
  ringSec?: number;
  /** Outbound calls allowed per rolling day — a runaway loop must not ring the owner all night. */
  maxOutboundPerDay?: number;
  /** Minimum gap between outbound calls. */
  minOutboundGapMs?: number;
  /**
   * The media-stream handshake must carry a valid X-Twilio-Signature
   * (default). `log-only` admits a bad or missing one and logs it loudly —
   * the rollback lever if Twilio ever signs the handshake differently.
   */
  streamSignature?: "require" | "log-only";
  /**
   * The call outlives a broken media stream (default on). `false` = the old
   * TwiML (`<Hangup/>` after the stream) — the rollback lever, PHONE_REATTACH=off.
   */
  reattach?: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export interface PhoneInstall {
  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void;
  /** Live streams, for tests and shutdown. */
  readonly streams: Set<PhoneStream>;
}

const TICKET_TTL_MS = 2 * 60_000;
/** Twilio retries a webhook it got no answer to; the same call gets the same TwiML for this long. */
const TWIML_CACHE_MS = 2 * 60_000;
const OUTBOUND_CTX_TTL_MS = 10 * 60_000;
const MAX_REASON = 300;

const NOT_FOR_YOU = "Hi, you've reached Michael. This line is private. Goodbye.";
const NOT_SET_UP = "Michael's line isn't set up yet. Please use the app.";
const CANNOT_CONNECT = "Sorry, this call can't be connected. Goodbye.";

function tokenMatches(header: string | undefined, expected: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!m) return false;
  const a = createHash("sha256").update(m[1].trim()).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function registerPhoneRoutes(app: Hono<any>, deps: PhoneDeps): PhoneInstall {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((l: string) => console.log(l));
  const rest = deps.rest ?? new TwilioRest(deps.creds);
  const base = deps.publicUrl.replace(/\/+$/, "");
  const streamUrl = base.replace(/^http/, "ws") + "/api/phone/stream";

  const tickets = new Map<string, PhoneCallInfo & { exp: number }>();
  /** Live calls by CallSid: the one a re-attach stream belongs to. */
  const calls = new Map<string, PhoneStream>();
  const reattachOn = deps.reattach !== false;
  const reattachUrl = `${base}/api/phone/reattach`;
  /**
   * Calls Michael placed, by context id (in the webhook url). Live until
   * used: the first webhook binds it to its CallSid and consumes it; Twilio's
   * retries for that CallSid get the cached TwiML (below), and anything else
   * — missing, expired, consumed, another CallSid — gets a polite hang-up.
   */
  const outboundCtx = new Map<string, { reason: string; exp: number; callSid?: string; consumed?: boolean }>();
  /** The TwiML each call got, so a Twilio retry is answered identically. */
  const twimlByCall = new Map<string, { body: string; exp: number }>();
  const outboundTimes: number[] = [];
  const streams = new Set<PhoneStream>();

  const sweep = () => {
    const t = now();
    for (const [k, v] of tickets) if (v.exp < t) tickets.delete(k);
    for (const [k, v] of outboundCtx) if (v.exp < t) outboundCtx.delete(k);
    for (const [k, v] of twimlByCall) if (v.exp < t) twimlByCall.delete(k);
  };

  const passphrase = (): PassphraseRecord | null => readPassphrase(deps.passphraseFile);

  /** The public URL Twilio signed: our public base + this path + its query. */
  const signedUrl = (c: Context): string => {
    const internal = new URL(c.req.url);
    return `${base}${internal.pathname}${internal.search}`;
  };

  /** Read and verify a Twilio form POST. Null = not from Twilio. */
  const verified = async (c: Context): Promise<Record<string, string> | null> => {
    const raw = await c.req.text();
    const form = new URLSearchParams(raw);
    const params: Record<string, string> = {};
    for (const [k, v] of form) params[k] = v;
    const sig = c.req.header("X-Twilio-Signature");
    if (!validTwilioSignature(deps.creds.authToken, sig, signedUrl(c), params)) {
      log(`[phone] refused an unsigned or mis-signed request to ${c.req.path}`);
      return null;
    }
    return params;
  };

  const twiml = (c: Context, body: string) => c.body(body, 200, { "Content-Type": "text/xml; charset=utf-8" });

  // ── The voice webhook ────────────────────────────────────────────────
  app.post("/api/phone/voice", async (c) => {
    const params = await verified(c);
    if (!params) return c.text("Forbidden", 403);
    sweep();
    const callSid = params.CallSid ?? "";
    const verdict = classifyCaller(params, deps.creds);
    const tail = callSid.slice(-6);
    // A retry for a call already answered gets the same answer — never a fresh ticket.
    const cached = callSid ? twimlByCall.get(callSid) : undefined;
    if (cached) {
      log(`[phone] call …${tail}: webhook retry — same answer as before`);
      return twiml(c, cached.body);
    }
    const answer = (body: string) => {
      if (callSid) twimlByCall.set(callSid, { body, exp: now() + TWIML_CACHE_MS });
      return twiml(c, body);
    };
    if (verdict.kind === "other" || !callSid) {
      // Never log the caller's number: the last digits of the call id are enough to find it in Twilio.
      log(`[phone] call …${tail} not for Michael (${verdict.kind === "other" ? verdict.reason : "no call id"}) — polite hang-up`);
      return twiml(c, sayAndHangupTwiml(NOT_FOR_YOU));
    }
    if (!deps.user()) {
      log(`[phone] call …${tail}: the line's user is not in the registry`);
      return twiml(c, sayAndHangupTwiml(NOT_SET_UP));
    }
    let info: PhoneCallInfo;
    if (verdict.kind === "owner-inbound") {
      if (!passphrase()) {
        log(`[phone] call …${tail} from the owner refused: no passphrase set (scripts/phone-passphrase.mjs)`);
        return twiml(c, sayAndHangupTwiml(NOT_SET_UP));
      }
      info = { callSid, direction: "inbound" };
    } else {
      // An outbound call skips the passphrase, so it must be one this gateway
      // placed, live, and this call's own: a replayed signed webhook, or one
      // for a context already used by another call, is not a way in.
      const ctxId = new URL(c.req.url).searchParams.get("ctx") ?? "";
      const ctx = ctxId ? outboundCtx.get(ctxId) : undefined;
      const live = ctx && !ctx.consumed && ctx.exp >= now() && (!ctx.callSid || ctx.callSid === callSid);
      if (!ctx || !live) {
        log(`[phone] call …${tail}: outbound webhook with no live context (${!ctxId ? "none" : !ctx ? "unknown or expired" : "already used"}) — polite hang-up`);
        return answer(sayAndHangupTwiml(CANNOT_CONNECT));
      }
      ctx.callSid = callSid;
      ctx.consumed = true;
      info = { callSid, direction: "outbound", ...(ctx.reason ? { reason: ctx.reason } : {}) };
    }
    const ticket = randomBytes(18).toString("base64url");
    tickets.set(ticket, { ...info, exp: now() + TICKET_TTL_MS });
    log(`[phone] call …${tail} ${info.direction} for the owner — bridging to the stream`);
    return answer(connectStreamTwiml(streamUrl, { ticket }, reattachOn ? reattachUrl : undefined));
  });

  // ── The stream closed: Twilio asks what next on the same call ───────
  app.post("/api/phone/reattach", async (c) => {
    const params = await verified(c);
    if (!params) return c.text("Forbidden", 403);
    sweep();
    const callSid = params.CallSid ?? "";
    const tail = callSid.slice(-6);
    const call = callSid ? calls.get(callSid) : undefined;
    // Nothing to re-attach to: the call ended on our side (goodbye, his
    // hang-up) or it is not one of ours. A hang-up, silently.
    if (!call || call.isOver) {
      log(`[phone] call …${tail}: stream closed and the call is over — hang-up`);
      return twiml(c, hangupTwiml());
    }
    if (!call.requestReattach()) {
      log(`[phone] call …${tail}: stream closed again and the call is out of re-attaches — hang-up`);
      return twiml(c, hangupTwiml());
    }
    const ticket = randomBytes(18).toString("base64url");
    const info = call.callInfo;
    tickets.set(ticket, { ...info, reattach: true, exp: now() + TICKET_TTL_MS });
    log(`[phone] call …${tail}: stream closed under a live call — re-attaching on a new stream`);
    return twiml(c, connectStreamTwiml(streamUrl, { ticket }, reattachUrl));
  });

  // ── Call status (rings out, busy, no answer, completed) ─────────────
  app.post("/api/phone/status", async (c) => {
    const params = await verified(c);
    if (!params) return c.text("Forbidden", 403);
    const dur = params.CallDuration ? ` after ${params.CallDuration}s` : "";
    log(`[phone] call …${(params.CallSid ?? "").slice(-6)} ${params.Direction ?? ""} status ${params.CallStatus ?? "?"}${dur}`);
    // The phone call itself is over: a call waiting for a new stream will
    // never get one. (A live stream gets Twilio's `stop` too; whichever is first ends it.)
    if (/^(completed|busy|failed|no-answer|canceled)$/.test(params.CallStatus ?? "")) {
      const call = calls.get(params.CallSid ?? "");
      if (call && !call.isOver) void call.end("call completed");
    }
    return c.body(null, 204);
  });

  // ── Michael calls the owner ───────────────────────────────────────────────
  app.post("/api/phone/call", async (c) => {
    const expected = deps.serviceToken();
    if (!expected) return c.json({ error: "Phone service API disabled (no REVIEW_DESK_TOKEN)" }, 503);
    if (!tokenMatches(c.req.header("authorization"), expected)) return c.json({ error: "Unauthorized" }, 401);
    let body: { reason?: unknown } = {};
    try {
      body = (await c.req.json()) as { reason?: unknown };
    } catch {
      body = {};
    }
    const reason = typeof body.reason === "string" ? body.reason.replace(/\s+/g, " ").trim().slice(0, MAX_REASON) : "";

    const t = now();
    while (outboundTimes.length && outboundTimes[0] < t - 24 * 3600_000) outboundTimes.shift();
    const maxDay = deps.maxOutboundPerDay ?? 10;
    const gap = deps.minOutboundGapMs ?? 60_000;
    if (outboundTimes.length >= maxDay) return c.json({ error: `Outbound limit reached (${maxDay} a day)` }, 429);
    const last = outboundTimes[outboundTimes.length - 1];
    if (last && t - last < gap) return c.json({ error: "Michael just called; wait a minute" }, 429);

    // Reserve the slot NOW, before the await: two requests at once must not
    // both pass the checks above. Released if Twilio refuses the call.
    // (In memory: a gateway restart resets the day's count.)
    outboundTimes.push(t);
    const release = () => {
      const i = outboundTimes.lastIndexOf(t);
      if (i >= 0) outboundTimes.splice(i, 1);
    };
    sweep();
    const ctxId = randomBytes(12).toString("base64url");
    outboundCtx.set(ctxId, { reason, exp: t + OUTBOUND_CTX_TTL_MS });
    try {
      const call = await rest.createCall({
        to: deps.creds.ownerCell,
        from: deps.creds.michaelNumber,
        url: `${base}/api/phone/voice?ctx=${ctxId}`,
        statusCallback: `${base}/api/phone/status`,
        timeoutSec: deps.ringSec ?? 20,
      });
      // Bind the context to the call now (the webhook comes after he answers).
      const ctx = outboundCtx.get(ctxId);
      if (ctx && !ctx.callSid) ctx.callSid = call.sid;
      log(`[phone] calling the owner (call …${call.sid.slice(-6)})${reason ? ` about: ${reason.slice(0, 80)}` : ""}`);
      return c.json({ ok: true, callSid: call.sid, status: call.status });
    } catch (err) {
      outboundCtx.delete(ctxId);
      release();
      log(`[phone] outbound call failed: ${(err as Error).message}`);
      return c.json({ error: "Twilio refused the call", detail: (err as Error).message }, 502);
    }
  });

  // ── The media stream ─────────────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  const claimTicket = (ticket: string, callSid: string): PhoneCallInfo | null => {
    sweep();
    const t = tickets.get(ticket);
    if (!t || t.callSid !== callSid) return null;
    tickets.delete(ticket);
    const { exp: _exp, ...info } = t;
    return info;
  };

  // Twilio signs the handshake over the Stream url it was given (wss://…);
  // the https spelling of the same url is accepted too.
  const handshakeUrls = [streamUrl, streamUrl.replace(/^ws/, "http")];
  const handleUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    const sig = req.headers["x-twilio-signature"];
    const signed = typeof sig === "string" && handshakeUrls.some((u) => validTwilioSignature(deps.creds.authToken, sig, u));
    if (!signed) {
      const why = typeof sig === "string" ? "a WRONG signature" : "NO signature";
      if ((deps.streamSignature ?? "require") === "require") {
        log(`[phone] REFUSED a media-stream handshake with ${why} — not Twilio, or Twilio signs differently (PHONE_STREAM_SIGNATURE=log-only admits it)`);
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      log(`[phone] WARNING: media-stream handshake with ${why} admitted (log-only); the ticket still decides`);
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const user = deps.user();
      const stream: PhoneStream = new PhoneStream(ws, {
        claimTicket,
        ...(reattachOn
          ? {
              adopt: (info: PhoneCallInfo, sock: WebSocket, streamSid: string) => {
                const call = calls.get(info.callSid);
                return !!call && call.attach(sock, streamSid);
              },
              onOpened: (s: PhoneStream) => calls.set(s.callSid, s),
              onEnded: (s: PhoneStream) => {
                if (calls.get(s.callSid) === s) calls.delete(s.callSid);
                streams.delete(s);
              },
              hangupCall: (sid: string) => rest.hangup(sid),
            }
          : {}),
        openCall: (transport, o) =>
          user
            ? deps.openCall(transport, { bot: deps.bot, user, voiceStreamId: o.voiceStreamId, interceptTurn: o.interceptTurn, mayDraft: o.mayDraft, direction: o.direction })
            : { error: "no user for the line" },
        say: deps.say,
        turnsInFlight,
        passphrase,
        // The owner by name (setup's user record) shapes the greeting and the prompt; explicit options still win.
        options: { ...phoneLinesFor(user?.name), ...(deps.streamOptions ?? {}) },
        log,
        now,
      });
      streams.add(stream);
      // A call that re-attached lives on past this socket; a doorway that
      // handed its socket over, or a stream that ended, goes.
      ws.on("close", () => {
        if (stream.isOver) streams.delete(stream);
      });
    });
  };

  return { handleUpgrade, streams };
}
