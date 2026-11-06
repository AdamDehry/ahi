import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Hono } from "hono";
import { WebSocketServer } from "ws";
import type { GatewayConfig } from "../../config.js";
import type { BotInstance } from "../../telegram.js";
import type { UserConfig } from "../../users.js";
import { userCanAccessAgent } from "../../users.js";
import { resolveUser, tagDashboardMessageForBot } from "../../dashboard.js";
import { broadcastEvent, isVoiceModeEnabled, type VoiceSessionRecord } from "../../websocket.js";
import { invokeAgent } from "../../claude-invoke.js";
import { withBotSlot, ConcurrencyCapError } from "../../concurrency.js";
import { takeSentinelFiles } from "../../chat-files/sentinel.js";
import { logTurn, type TurnRecord } from "../../turn-logger.js";
import { callTurnInvokeOptions, talkLaneInvokeOptions, voiceTurnInvokeOptions } from "../voice-invoke.js";
import { agentDisplayName, frontLineFor, rememberFrontLine, RacedFrontVoice, FRONT_VOICE_MODEL_DEFAULT } from "../front-voice.js";
import { createAckClassifier, decideAck, silentAcksEnabled } from "../ack-gate.js";
import { FrontGate, frontGateFor } from "../front-gate.js";
import { asksToLook, estimateImageTokens, framePolicy } from "../screen-frame.js";
import { elevenScreenFrame, elevenScreenPick, endElevenCall, noteElevenCall } from "./side.js";
import { formatPick, screenWatchOn } from "../screen-watch.js";
import { ElevenCallBrain } from "./brain.js";
import { UpstreamLink, checkUpstreamRequest } from "./upstream.js";
import { doorCloseLine } from "../loop-watch.js";
import {
  callTransportFor,
  elevenFrontDeadlineMs,
  elevenHoldMs,
  elevenKeepaliveMs,
  elevenMaxOpenMs,
  elevenMaxResponseMs,
  elevenNudgeOn,
  elevenRevisionStrictOn,
  elevenAlreadySaidOn,
  elevenStatusPollMs,
  elevenTalkLaneOn,
  ELEVEN_UPSTREAM_PATH,
} from "./config.js";

/* ============================================================
   eleven/install.ts — the ElevenLabs call transport, wired into the gateway.

     POST /api/voice/eleven/session   the app asks to start a call. If the
       agent calls over ElevenLabs, the gateway mints a conversation token
       with OUR key (the browser never holds it) and files the conversation
       id against the caller. Otherwise, or if the mint fails, the answer is
       `transport: native` and the app places today's call. One log line.
     POST /api/voice/eleven/event     the app's client-SDK events worth a log
       line (connected, fallback, error), and the cut-in marker.
     WS   /api/eleven/upstream         ElevenLabs' socket to us, one per
       conversation (upstream.ts). Its `init` names the conversation; only one
       this gateway minted for a signed-in caller gets a brain. Anything else
       is closed.

   A call's card is written here through the SAME writer the native call
   uses (index.ts hands it in), so the thread, the call recap and the
   retrieval corpus see one kind of card — the moment the call is over, by
   whichever signal comes first (10/22: the upstream close alone came
   2.5–4.5 min after the app had lost the call):
     - the app says so (`ended` / `disconnected` client events);
     - ElevenLabs says so: while the upstream is quiet, the conversation API
       is asked every ELEVEN_STATUS_POLL_MS whether the call is still going;
     - the upstream closes.
   One card per call: the first signal writes it, the later ones find the
   call gone. A call ElevenLabs marks failed says why on the card's ending.
   ============================================================ */

/** Who a minted conversation belongs to, until ElevenLabs connects for it. */
interface PendingCall {
  user: UserConfig;
  bot: string;
  voiceStreamId: string;
  mintedAt: number;
}

interface LiveCall {
  user: UserConfig;
  bot: string;
  voiceStreamId: string;
  conversationId: string;
  brain: ElevenCallBrain;
  link: UpstreamLink;
  connectedAt: number;
  dispose: () => void;
  /** End the call now (idempotent): stop the brain, write the card. */
  end: (how: string, opts?: { checkFailure?: boolean; status?: ConversationStatus }) => void;
}

/** What ElevenLabs' conversation API says about a call. */
export interface ConversationStatus {
  status: string;
  /** The error reason when it failed (e.g. "speech_engine_error: LLM Cascade Error: TimeoutError"). */
  reason?: string;
}

/** A minted conversation ElevenLabs never connects for is forgotten after this. */
const PENDING_TTL_MS = 2 * 60_000;
const MINT_TIMEOUT_MS = 6_000;
const ELEVEN_API = "https://api.elevenlabs.io/v1";
const CLIENT_EVENTS = new Set(["connected", "disconnected", "ended", "fallback", "error", "interruption", "mic-denied", "nudge-sent", "nudge-dropped", "adopted"]);
/** How long a card waits on ElevenLabs for a failed call's reason. */
const STATUS_LOOKUP_MS = 1_500;
/** The upstream counts as quiet (worth asking about) after this long without a message. */
const QUIET_MS = 8_000;

/** A failed call's ending, in plain words for the card. */
export function describeElevenEnding(st: ConversationStatus | null, how: string): string | undefined {
  if (st?.status === "failed") {
    const r = st.reason ?? "";
    if (/timeout|took too long/i.test(r)) return "Call dropped: ElevenLabs gave up waiting for Michael's reply.";
    if (/reader error/i.test(r)) return "Call dropped: ElevenLabs lost its link to Michael.";
    if (/invalid message/i.test(r)) return "Call dropped: ElevenLabs refused one of Michael's replies.";
    return "Call dropped: ElevenLabs ended it with an error.";
  }
  if (st?.status === "done") return undefined;
  return /error|dropped/.test(how) ? "Call dropped." : undefined;
}

async function fetchConversationStatus(conversationId: string, timeoutMs: number): Promise<ConversationStatus | null> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${ELEVEN_API}/convai/conversations/${encodeURIComponent(conversationId)}`, {
      headers: { "xi-api-key": key },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { status?: string; metadata?: { error?: { reason?: string } } };
    if (typeof body.status !== "string") return null;
    const reason = body.metadata?.error?.reason;
    return { status: body.status, ...(typeof reason === "string" ? { reason: reason.slice(0, 200) } : {}) };
  } catch {
    return null;
  }
}

export interface ElevenTransportDeps {
  instances: BotInstance[];
  config: GatewayConfig;
  /** The native call's card writer (index.ts setVoiceSessionRecordHandler). */
  writeCallCard(opts: { botName: string; user: UserConfig; record: VoiceSessionRecord }): void;
  /** Token mint seam (tests). */
  mint?: (agentId: string, participant: string) => Promise<{ token: string; conversationId: string }>;
  /** Conversation-status seam (tests). */
  status?: (conversationId: string, timeoutMs: number) => Promise<ConversationStatus | null>;
}

/** Fast OR slow (front-gate.ts) on ElevenLabs calls; ELEVEN_FRONT_GATE=off restores the holding-line-only front voice. */
function frontGateOn(): boolean {
  const v = (process.env.ELEVEN_FRONT_GATE ?? "on").toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

function frontVoiceOn(bot: string): boolean {
  // Same switches as the native call's front voice (index.ts frontVoiceEnabled).
  const v = (process.env[`${bot.toUpperCase()}_FRONT_VOICE`] ?? process.env.FRONT_VOICE ?? "on").toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

async function mintConversationToken(agentId: string, participant: string): Promise<{ token: string; conversationId: string }> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("no ELEVENLABS_API_KEY");
  const url = `${ELEVEN_API}/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}&participant_name=${encodeURIComponent(participant)}`;
  const res = await fetch(url, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(MINT_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`token ${res.status}`);
  const body = (await res.json()) as { token?: string; conversation_id?: string };
  if (!body.token || !body.conversation_id) throw new Error("token: malformed response");
  return { token: body.token, conversationId: body.conversation_id };
}

export function installElevenTransport(app: Hono, deps: ElevenTransportDeps) {
  const pending = new Map<string, PendingCall>();
  /**
   * The fast-OR-slow gate's model, started when the conversation is minted:
   * a cold process took 3–6 s for its first verdict (a loaded box),
   * and the first thing he says is usually the one it should answer itself.
   */
  const warmGates = new Map<string, FrontGate>(); // by voiceStreamId
  const live = new Map<string, LiveCall>(); // by voiceStreamId
  const wss = new WebSocketServer({ noServer: true });
  const mint = deps.mint ?? mintConversationToken;
  const lookup = deps.status ?? fetchConversationStatus;

  const sweep = (): void => {
    const now = Date.now();
    for (const [id, p] of pending) {
      if (now - p.mintedAt > PENDING_TTL_MS) {
        pending.delete(id);
        endElevenCall(p.voiceStreamId, "never-connected");
        warmGates.get(p.voiceStreamId)?.close();
        warmGates.delete(p.voiceStreamId);
        console.log(`[eleven] ${p.voiceStreamId} minted but ElevenLabs never connected — forgotten`);
      }
    }
  };

  app.post("/api/voice/eleven/session", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { bot?: unknown };
    const bot = typeof body.bot === "string" ? body.bot : "";
    if (!bot || !userCanAccessAgent(user, bot) || !isVoiceModeEnabled(bot)) return c.json({ transport: "native", reason: "not-allowed" }, 403);
    if (callTransportFor(bot) !== "elevenlabs") return c.json({ transport: "native" });
    sweep();
    const voiceStreamId = `eleven-${Date.now()}-${randomBytes(3).toString("hex")}`;
    try {
      const t0 = Date.now();
      const { token, conversationId } = await mint(process.env.ELEVENLABS_AGENT_ID!, user.name || user.userId);
      pending.set(conversationId, { user, bot, voiceStreamId, mintedAt: Date.now() });
      // The app's side channels (live words, shared screen) may open for this call.
      noteElevenCall(voiceStreamId, user.userId, bot);
      if (frontVoiceOn(bot) && frontGateOn()) {
        const g = new FrontGate(process.env.FRONT_VOICE_MODEL || FRONT_VOICE_MODEL_DEFAULT, { agent: agentDisplayName(bot), user: user.name || "the owner" });
        g.warm();
        warmGates.set(voiceStreamId, g);
      }
      console.log(`[eleven] ${voiceStreamId} token minted for ${bot} in ${Date.now() - t0}ms`);
      // The owner's call: an opener on connect ("Yeah."), or nothing until he speaks.
      const firstMessage = (process.env.ELEVENLABS_FIRST_MESSAGE ?? "").trim().slice(0, 200);
      return c.json({ transport: "elevenlabs", conversationToken: token, conversationId, voiceStreamId, ...(firstMessage ? { firstMessage } : {}) });
    } catch (err) {
      // The call still happens: on the native path.
      console.warn(`[eleven] token mint failed for ${bot} (${(err as Error).message}) — this call falls back to native`);
      return c.json({ transport: "native", reason: "mint-failed" });
    }
  });

  app.post("/api/voice/eleven/event", async (c) => {
    const user = resolveUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const event = typeof body.event === "string" ? body.event : "";
    const voiceStreamId = typeof body.voiceStreamId === "string" ? body.voiceStreamId.slice(0, 60) : "";
    if (!CLIENT_EVENTS.has(event)) return c.json({ ok: false }, 400);
    // Short tokens only into the log; never free text.
    const reason = typeof body.reason === "string" && /^[a-z0-9-]{1,40}$/.test(body.reason) ? ` ${body.reason}` : "";
    const call = live.get(voiceStreamId);
    if (call && call.user.userId !== user.userId) return c.json({ ok: false }, 403);
    if (event === "fallback") console.warn(`[eleven] ${voiceStreamId || "-"} app fell back to native${reason}`);
    else console.log(`[eleven-client] ${voiceStreamId || "-"} ${event}${reason}`);
    if (event === "interruption") call?.brain.noteInterruption();
    // The app's call is over: the card now, not when ElevenLabs closes our socket minutes later.
    if (call && (event === "ended" || event === "disconnected")) {
      const clean = event === "ended" && (reason === " user" || reason === " unmount");
      call.end(`app ${event}${reason}`, { checkFailure: !clean });
    }
    return c.json({ ok: true });
  });

  /** Bind ElevenLabs' socket for a conversation to the caller who minted it. */
  const open = (ws: import("ws").WebSocket): void => {
    let call: LiveCall | null = null;
    // Step 0 (voice-speed): the upstream's own close code, logged even after
    // the call was ended by the app's event (unbind() empties `call`, so the
    // handlers below see none) — a listener only, nothing here acts on it.
    let label = "eleven-?";
    ws.on("close", (code: number, reason: Buffer) => {
      console.log(doorCloseLine("eleven", label, code, reason?.toString() ?? "", link.lastMessageAt, ws.bufferedAmount));
    });
    const link = new UpstreamLink(ws, {
      onInit: (conversationId) => {
        if (call) return;
        sweep();
        const p = pending.get(conversationId);
        pending.delete(conversationId);
        // A grant is good for PENDING_TTL_MS from the mint, however it is reached.
        if (!p || Date.now() - p.mintedAt > PENDING_TTL_MS) {
          console.warn(`[eleven] upstream for a conversation this gateway did not mint${p ? " in time" : ""} — closed`);
          link.close();
          return;
        }
        const instance = deps.instances.find((i) => i.config.name === p.bot);
        if (!instance) {
          link.close();
          return;
        }
        call = startCall(instance, p, conversationId, link, () => {
          call = null;
        });
        live.set(p.voiceStreamId, call);
        label = p.voiceStreamId;
        console.log(`[eleven] ${p.voiceStreamId} connected (${p.bot}, ${Date.now() - p.mintedAt}ms after mint)`);
      },
      onTranscript: (history, eventId) => call?.brain.onTranscript(history, eventId),
      onClose: () => call?.end("clean"),
      // ElevenLabs ends a call by closing with 1000 and, often, no `close` message first.
      onDisconnect: (code) => call?.end(code === 1000 ? "clean 1000" : `dropped ${code}`, { checkFailure: code !== 1000 }),
      onError: (message) => console.warn(`[eleven] upstream error: ${message.slice(0, 160)}`),
    });
  };

  const startCall = (instance: BotInstance, p: PendingCall, conversationId: string, link: UpstreamLink, unbind: () => void): LiveCall => {
    const { user, bot, voiceStreamId } = p;
    const persona = { agent: agentDisplayName(bot), user: user.name || "the owner" };
    const frontModel = process.env.FRONT_VOICE_MODEL || FRONT_VOICE_MODEL_DEFAULT;
    // One fast-model pair per call either way: the gate's (fast OR slow), or the holding-line front voice's.
    const prewarmed = warmGates.get(voiceStreamId) ?? null;
    warmGates.delete(voiceStreamId);
    const gate = frontVoiceOn(bot) && frontGateOn() ? (prewarmed ?? new FrontGate(frontModel, persona)) : null;
    if (!gate) prewarmed?.close();
    const fv = frontVoiceOn(bot) && !gate ? new RacedFrontVoice(frontModel, 2, undefined, undefined, persona) : null;
    gate?.warm();
    fv?.warm();
    const ack = silentAcksEnabled(bot) ? createAckClassifier(undefined, persona) : null;
    ack?.warm();
    const userKey = `${bot}:${user.userId}`;
    const invokeOpts = voiceTurnInvokeOptions(instance.config, user, voiceStreamId);
    // The talk lane (brain.ts): read once per call, so a flip of the knob takes the next call.
    const talkLane = elevenTalkLaneOn();

    const brain = new ElevenCallBrain({
      voiceStreamId,
      bot,
      frontDeadlineMs: elevenFrontDeadlineMs(),
      holdMs: elevenHoldMs(),
      keepaliveMs: elevenKeepaliveMs(),
      maxOpenMs: elevenMaxOpenMs(),
      maxResponseMs: elevenMaxResponseMs(),
      revisionStrict: elevenRevisionStrictOn(),
      alreadySaid: elevenAlreadySaidOn(),
      ...(elevenNudgeOn() ? { nudge: (on = true) => broadcastEvent({ type: "voice-eleven-nudge", voiceStreamId, botName: bot, userId: user.userId, ...(on ? {} : { cancel: true }) }) } : {}),
      respond: (eventId, content, isFinal) => link.respond(eventId, content, isFinal),
      toApp: (msg) => broadcastEvent({ ...msg, botName: bot, userId: user.userId }),
      log: (line) => console.log(line),
      isCapError: (err) => err instanceof ConcurrencyCapError,
      logTurn: (row) =>
        logTurn({
          user: user.userId,
          spec_invoked: false,
          spec_committed: false,
          spec_aborted: false,
          model: invokeOpts.model,
          effort: instance.config.voiceModeEffort,
          ...row,
        } as TurnRecord),
      ...(gate
        ? {
            frontGate: (heard: string, recentCall: { role: "user" | "agent"; text: string }[], signal: AbortSignal) =>
              frontGateFor(gate.ask, userKey, heard, recentCall, signal, Date.now, gate.persona),
            frontLineSaid: (line: string) => rememberFrontLine(userKey, line),
          }
        : {}),
      ...(fv
        ? {
            frontLine: (heard: string, signal: AbortSignal) => frontLineFor(fv.generate, userKey, heard, signal, Date.now, fv.persona),
            frontLineSaid: (line: string) => rememberFrontLine(userKey, line),
          }
        : {}),
      ...(ack
        ? {
            isAck: (heard: string, lastAgentLine: string | null, signal: AbortSignal) =>
              decideAck({ heard, lastAgentLine, ask: ack.ask, names: persona, signal }),
          }
        : {}),
      invoke: async ({ message, signal, onChunk, onToolUse }) => {
        // "Look at my screen": the shared frame rides the turn exactly as on a
        // native call (every turn by default; CALL_SCREEN_FRAMES=ask limits it).
        // Always-on (voice/screen-watch.ts): the frames since he began, by the side ear's words.
        const pick = screenWatchOn() ? elevenScreenPick(voiceStreamId, user.name) : null;
        const screenPick = pick && (framePolicy() === "every" || asksToLook(message)) ? pick : null;
        if (screenPick) console.log(formatPick(voiceStreamId, screenPick, "turn", " (eleven)"));
        const frame = screenWatchOn() ? null : elevenScreenFrame(voiceStreamId);
        const turnFrame = frame && (framePolicy() === "every" || asksToLook(message)) ? frame : null;
        if (turnFrame) {
          console.log(
            `[voice-screen] ${voiceStreamId} frame attached ${turnFrame.width}x${turnFrame.height} ` +
              `${Math.round(turnFrame.data.length / 1024)} kB ~${estimateImageTokens(turnFrame.width, turnFrame.height)} tokens ` +
              `age=${Date.now() - turnFrame.capturedAt}ms (eleven)`,
          );
        }
        // The call lane: a live call's turn is never refused for chat or wake
        // work, and a superseded turn frees its slot the moment it is aborted.
        const result = await withBotSlot(bot, () =>
          invokeAgent({
            // Same brain, same memory, same session scope as a native call
            // (plus, with the talk lane, the talk-before-work rule).
            ...(talkLane ? callTurnInvokeOptions(instance.config, user, voiceStreamId) : voiceTurnInvokeOptions(instance.config, user, voiceStreamId)),
            message: tagDashboardMessageForBot(screenPick ? `${message}\n\n${screenPick.note}` : message, bot, user),
            sessionMap: instance.sessionMap,
            config: deps.config,
            abortSignal: signal,
            ...(screenPick ? { images: screenPick.frames } : turnFrame ? { images: [turnFrame] } : {}),
            onStreamEvent: (e) => {
              if (e.type === "stream-chunk" && e.chunk) onChunk(e.chunk);
              else if (e.type === "stream-tool-use") onToolUse();
            },
          }),
          { lane: "call", signal },
        );
        // Files and bills handed over on the call land in the chat, as in text.
        result.response = takeSentinelFiles(result.response, { userId: user.userId, admin: user.admin, bot });
        return { response: result.response, cost: result.cost, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
      },
      talkLane,
      // The talk lane's turn: no tools, never the call's session, the call so
      // far in its message. It shares the call lane with the work turn (two
      // call turns at once is what the lane is sized for).
      ...(talkLane
        ? {
            companion: async ({ message, signal, onChunk, onToolUse }: { message: string; signal: AbortSignal; onChunk: (t: string) => void; onToolUse: () => void }) => {
              const result = await withBotSlot(
                bot,
                () =>
                  invokeAgent({
                    ...talkLaneInvokeOptions(instance.config, user, voiceStreamId),
                    message: tagDashboardMessageForBot(message, bot, user),
                    sessionMap: instance.sessionMap,
                    config: deps.config,
                    abortSignal: signal,
                    onStreamEvent: (e) => {
                      if (e.type === "stream-chunk" && e.chunk) onChunk(e.chunk);
                      else if (e.type === "stream-tool-use") onToolUse();
                    },
                  }),
                { lane: "call", signal },
              );
              return { response: result.response, cost: result.cost, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
            },
          }
        : {}),
    });

    const connectedAt = Date.now();
    let over = false;
    let polling = false;
    const end: LiveCall["end"] = (how, opts = {}) => {
      if (over) return;
      over = true;
      clearInterval(watch);
      unbind();
      live.delete(voiceStreamId);
      // The side ear stops the instant the call does (and the shared screen goes).
      endElevenCall(voiceStreamId);
      const record = brain.close();
      gate?.close();
      fv?.close();
      ack?.close();
      const minutes = (Date.now() - connectedAt) / 60_000;
      // The cost line: ElevenLabs bills agent minutes per conversation; the
      // Costs tab has no per-call meter, so every call says what it used.
      console.log(
        `[eleven] call ${voiceStreamId} ended (${how}) — ${minutes.toFixed(2)} elevenlabs-agent minute(s), ${brain.turns} turn(s)` +
          (record ? " — writing its card" : ""),
      );
      if (!record || !isVoiceModeEnabled(bot)) return;
      const write = (st: ConversationStatus | null): void => {
        if (st?.status === "failed") console.warn(`[eleven] call ${voiceStreamId} failed at ElevenLabs: ${(st.reason ?? "no reason").slice(0, 160)}`);
        const ending = describeElevenEnding(st, how);
        deps.writeCallCard({ botName: bot, user, record: ending ? { ...record, ending } : record });
      };
      if (opts.status) write(opts.status);
      else if (opts.checkFailure) void lookup(conversationId, STATUS_LOOKUP_MS).then(write, () => write(null));
      else write(null);
    };
    // ElevenLabs' own word on whether the call is still going, asked only
    // while the upstream is quiet (an idle call still gets a ping every 30 s).
    const pollMs = elevenStatusPollMs();
    const watch = setInterval(() => {
      if (over || polling || Date.now() - link.lastMessageAt < QUIET_MS) return;
      polling = true;
      void lookup(conversationId, 5_000)
        .then((st) => {
          if (st && (st.status === "done" || st.status === "failed")) end(`elevenlabs ${st.status}`, { status: st });
        })
        .finally(() => {
          polling = false;
        });
    }, pollMs > 0 ? pollMs : 2 ** 30);
    watch.unref?.();

    return {
      user,
      bot,
      voiceStreamId,
      conversationId,
      brain,
      link,
      connectedAt,
      dispose: () => {
        gate?.close();
        fv?.close();
        ack?.close();
      },
      end,
    };
  };

  return {
    /** True when the request was ours (handled or refused); false = not this path. */
    handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): boolean {
      const url = req.url || "";
      if (url !== ELEVEN_UPSTREAM_PATH && !url.startsWith(`${ELEVEN_UPSTREAM_PATH}?`)) return false;
      const bad = checkUpstreamRequest(req.headers);
      if (bad) {
        console.warn(`[eleven] upstream refused: ${bad}`);
        socket.destroy();
        return true;
      }
      wss.handleUpgrade(req, socket, head, (ws) => open(ws));
      return true;
    },
    /** Live calls (health / tests). */
    liveCalls: (): number => live.size,
  };
}
