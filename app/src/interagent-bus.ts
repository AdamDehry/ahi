import { AI_ROOT } from "./ai-root.js";
// ── interagent-bus.ts — two-way peer channel between AHI agents ─────────────
//
// Lets one agent send a message to another agent and receive that agent's
// reply, so Michael and Tzali can run round-trips without the owner relaying.
//
// ── What already existed, and what this actually adds ──────────────────────
//
// The build spec assumed the gateway "SDK-enqueues a prompt into a live agent
// session" and that receiving the peer's reply was the hard, missing half.
// The code says otherwise, and the difference matters enough to write down:
//
//   `invokeAgent()` (claude-invoke.ts) spawns `claude -p --resume <sessionId>`
//   as a subprocess and AWAITS the terminal result event. It is already plain
//   request/response — it returns `{ response, sessionId, cost, tokens }`.
//
// The `promptSource: "sdk"` / `entrypoint: "sdk-cli"` / `userType: "external"`
// stamps seen on agent-to-agent turns are not the signature of
// a special injection path. They are what the Claude CLI stamps on EVERY
// non-interactive `-p` turn, which is how all Telegram traffic flows. A turn the
// bus starts is an ordinary `invokeAgent()` call whose text comes from code
// instead of from Telegram.
//
// So the read-back leg is free, and of the two options the spec floated:
//   (a) await the peer's next assistant turn from the call itself, versus
//   (b) tail the peer's session transcript and correlate replies by threadId
// we take (a) — because it is already implemented, synchronous, and exact.
// (b) would be strictly worse here: it needs a file watcher, it has to guess
// when a turn is "finished", it races against session rotation, and it would
// have to reconstruct cost/token data that (a) hands back directly. There is
// no reason to reach for transcript tailing when the callee returns the value.
//
// The real work, then, is not read-back. It is ISOLATION — see below.
//
// ── Isolation: why bus turns get their own synthetic chatIds ───────────────
//
// This is the actual hazard the spec flagged as "touches LIVE routing", and
// it is sharper than it looks. `SessionMap` is keyed `${botName}:${chatId}`.
// If a bus hop reused the owner's chatId, then every hop would:
//   1. `--resume` the owner's live Michael session, pushing agent-to-agent chatter
//      into the context window of the owner's real conversation, and
//   2. `sessionMap.set(...)` over the owner's session pointer on the way out.
// The owner's thread would silently fill with loop traffic he never sent.
//
// So the bus never touches a human chatId. Each thread derives a stable
// synthetic chatId in a reserved negative band (see BUS_CHAT_ID_BASE), which
// produces a SessionMap entry disjoint from every human one. Two independent
// guarantees keep it that way, belt and braces:
//   - the reserved band is far from any id Telegram issues, and
//   - `assertBusChatId()` hard-refuses any id that resolves to a known user or
//     is not inside the band, so a hashing mistake fails loudly instead of
//     quietly writing into a person's session.
//
// On top of that, bus threads do not share the human SessionMap FILE either.
// `SessionMap` keeps the whole store in memory and rewrites the entire JSON
// file on every `set()`. The gateway runs as a long-lived service holding one
// such instance, so a second process (the CLI loop runner) constructing its
// own SessionMap over the same `sessions.json` would load a snapshot, then
// overwrite the file wholesale — silently reverting any human session pointer
// prod wrote in between. That is a lost-session bug in the owner's live thread,
// caused entirely by running a loop next to the service.
//
// So the bus keeps its own store at `<sessionDir>/interagent/sessions.json`
// (see busSessionMap). Bus and human sessions can then never clobber each
// other, in-process or across processes, whatever the chatIds say.
//
// Consequence: an idle bus is a no-op. It registers no routes, no timers, no
// listeners, and shares no mutable state or files with the Telegram/app path.
// Nothing in normal delivery reads anything this module writes.
//
// ── Visibility ────────────────────────────────────────────────────────────
//
// Hops are NOT broadcast to the PWA feed or the message store. The owner asked to
// see the result, not the chatter; the loop driver pushes one digest at the
// end. Every hop is appended to logs/interagent-YYYY-MM-DD.jsonl for forensics.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { BotInstance } from "./telegram.js";
import type { GatewayConfig } from "./config.js";
import { invokeAgent } from "./claude-invoke.js";
import { withBotSlot, ConcurrencyCapError } from "./concurrency.js";
import { lookupByChatId } from "./users.js";
import { SessionMap } from "./session-map.js";

/**
 * Reserved synthetic-chatId band for bus threads: [BASE - SPAN + 1, BASE].
 *
 * Telegram user chats are positive; legacy groups sit around -1e9 and
 * supergroups around -1.0e12 to -1.9e12 (the `-100…` prefix form). This band
 * sits between those two clusters and is never issued by Telegram. The band
 * is a convenience, not the safety property — `assertBusChatId` is.
 */
const BUS_CHAT_ID_BASE = -8_000_000_000;
const BUS_CHAT_ID_SPAN = 1_000_000_000;

const LOG_DIR = resolve(AI_ROOT, "builds/gateway/logs");

/** Feature flag. The bus is inert until this is explicitly turned on. */
export function busEnabled(): boolean {
  return process.env.INTERAGENT_BUS_ENABLED === "1";
}

export class InteragentBusDisabledError extends Error {
  constructor() {
    super("[interagent-bus] disabled — set INTERAGENT_BUS_ENABLED=1 to enable");
    this.name = "InteragentBusDisabledError";
  }
}

export class InteragentBusError extends Error {
  constructor(message: string) {
    super(`[interagent-bus] ${message}`);
    this.name = "InteragentBusError";
  }
}

export interface PeerReply {
  /** The peer's reply text. */
  text: string;
  /** Claude session id backing this thread's side of the conversation. */
  sessionId?: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface SendToPeerOptions {
  /** Speaking agent's bot name, e.g. "michael". Tagged into the message. */
  from: string;
  /** Receiving agent's bot name, e.g. "tzali". Must be a configured bot. */
  to: string;
  text: string;
  /** Loop identity — scopes the session so concurrent loops never cross. */
  threadId: string;
  /** 1-based hop number, for the message tag and the trace. */
  hop?: number;
  /** Total hop budget, shown to the peer so it can pace itself. */
  maxHops?: number;
  /**
   * One-line statement of what the exchange is for, repeated to BOTH agents
   * on every hop. Without it only the agent that receives the seed knows the
   * task: the opener sees nothing but its peer's bare reply and has to guess
   * what the two are converging on.
   */
  goal?: string;
  instances: BotInstance[];
  config: GatewayConfig;
  /** Extra protocol instruction appended to the peer's system prompt. */
  extraSystemHint?: string;
}

/**
 * Stable synthetic chatId for a thread's conversation with one agent.
 *
 * Keyed by thread AND agent so each side of a loop keeps its own session and
 * its own memory of the exchange — Michael resuming Michael's view, Tzali
 * resuming Tzali's. Deterministic, so a resumed loop rejoins its sessions.
 */
export function busChatId(threadId: string, agent: string): number {
  // NUL separator, written as an escape so it is visible in source (a raw
  // 0x00 byte here makes grep treat this whole file as binary). It also can't
  // appear inside a threadId or agent name, so no two different (thread,
  // agent) pairs can ever hash the same concatenation.
  const digest = createHash("sha256").update(`${threadId}\u0000${agent}`).digest();
  const offset = digest.readUInt32BE(0) % BUS_CHAT_ID_SPAN;
  return BUS_CHAT_ID_BASE - offset;
}

/**
 * Refuse to proceed unless `chatId` is a bus id that belongs to no human.
 *
 * This is the load-bearing safety check: it stands between a hashing bug and
 * writing agent chatter into the owner's live session. Fail loud, never silent.
 */
export function assertBusChatId(chatId: number, config: GatewayConfig): void {
  const lo = BUS_CHAT_ID_BASE - BUS_CHAT_ID_SPAN + 1;
  if (!Number.isInteger(chatId) || chatId > BUS_CHAT_ID_BASE || chatId < lo) {
    throw new InteragentBusError(
      `refusing chatId ${chatId} — outside the reserved bus band [${lo}, ${BUS_CHAT_ID_BASE}]`,
    );
  }
  if (lookupByChatId(chatId)) {
    throw new InteragentBusError(`refusing chatId ${chatId} — resolves to a registered user`);
  }
  if (config.userIdentityMap[chatId]) {
    throw new InteragentBusError(`refusing chatId ${chatId} — present in userIdentityMap`);
  }
}

let busMap: SessionMap | null = null;

/**
 * The bus's OWN session store, held apart from the human one.
 *
 * Lazily constructed so an idle bus creates no directory and touches no disk.
 * See the header note on why sharing `sessions.json` with the running gateway
 * is a lost-session hazard rather than a mere tidiness concern.
 */
export function busSessionMap(config: GatewayConfig): SessionMap {
  if (!busMap) {
    const dir = resolve(config.sessionDir, "interagent");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    busMap = new SessionMap(dir);
    console.log(`[interagent-bus] session store: ${resolve(dir, "sessions.json")}`);
  }
  return busMap;
}

export interface BusTraceRecord {
  ts: string;
  thread_id: string;
  hop?: number;
  stage: "sent" | "replied" | "error";
  from: string;
  to: string;
  chat_id?: number;
  session_id?: string;
  text?: string;
  reply?: string;
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  duration_ms?: number;
  error?: string;
}

/** Append one hop record to the daily bus trail. Never throws. */
export function logBusEvent(record: BusTraceRecord): void {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    const path = resolve(LOG_DIR, `interagent-${record.ts.slice(0, 10)}.jsonl`);
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    console.error("[interagent-bus] failed to write trace:", (err as Error).message);
  }
}

/**
 * Protocol contract handed to the receiving agent as a system hint.
 *
 * Kept out of the message body so the thread transcript stays readable — the
 * same reasoning as the glasses HUD hint (see InvokeOptions.extraSystemHint).
 */
export function protocolHint(opts: {
  from: string;
  to: string;
  threadId: string;
  hop: number;
  maxHops: number;
  goal?: string;
}): string {
  return [
    "[Surface context — AHI inter-agent bus]",
    `You are ${opts.to}. This turn was sent by ${opts.from}, another AHI agent —`,
    "not by the owner. The owner is not reading these turns live; he receives one digest",
    "when the exchange ends. Answer your peer directly and concretely.",
    ...(opts.goal
      ? [`\n\nWHAT THIS EXCHANGE IS FOR: ${opts.goal}\n\nThat is the shared`,
         "objective for both of you. If your peer's message arrives without",
         "context, judge it against that objective rather than asking them to",
         "restate it — a hop spent re-establishing the premise is a hop wasted.\n"]
      : []),
    `This is hop ${opts.hop} of a ${opts.maxHops}-hop budget on thread`,
    `"${opts.threadId}". Your reply becomes your peer's next prompt, so end`,
    "with whatever you actually need from them — a question, a decision, or a",
    "result. Do not sign off politely and stall; a wasted hop costs real money.",
    "",
    "TERMINATION CONTRACT — when the shared goal is genuinely met, begin your",
    "reply with the exact token `LOOP_DONE:` followed by a one-paragraph",
    "summary of the outcome. That token ends the exchange immediately, so emit",
    "it only when there is nothing left to resolve. If the budget runs out",
    "first the loop is reported to the owner as unconverged.",
  ].join(" ");
}

/** The from/thread/hop tag prepended to the message body, so the peer's own
 *  transcript records who was speaking (cf. Miriam's "[from: …]" tagging). */
function tagMessage(opts: { from: string; threadId: string; hop: number; maxHops: number; text: string }): string {
  return (
    `[inter-agent bus · from: ${opts.from} · thread: ${opts.threadId} · ` +
    `hop ${opts.hop}/${opts.maxHops}]\n${opts.text}`
  );
}

/**
 * Send `text` to `to`'s bus session for this thread and return its reply.
 *
 * Reuses the same `invokeAgent` path Telegram and the glasses endpoint use —
 * including `withBotSlot`, so bus traffic obeys the existing per-bot
 * concurrency cap and can never starve the owner of a slot.
 */
export async function sendToPeer(opts: SendToPeerOptions): Promise<PeerReply> {
  if (!busEnabled()) throw new InteragentBusDisabledError();

  const { from, to, text, threadId, instances, config } = opts;
  const hop = opts.hop ?? 1;
  const maxHops = opts.maxHops ?? 12;

  if (!threadId.trim()) throw new InteragentBusError("threadId is required");
  if (!text.trim()) throw new InteragentBusError("refusing to send an empty message");
  if (from === to) throw new InteragentBusError(`refusing self-send for "${from}"`);

  const instance = instances.find((i) => i.config.name === to);
  if (!instance) throw new InteragentBusError(`unknown peer "${to}" — not a configured bot`);

  const chatId = busChatId(threadId, to);
  assertBusChatId(chatId, config);

  const tagged = tagMessage({ from, threadId, hop, maxHops, text });
  const base = protocolHint({ from, to, threadId, hop, maxHops, goal: opts.goal });
  const hint = opts.extraSystemHint ? `${base}\n\n${opts.extraSystemHint}` : base;

  logBusEvent({
    ts: new Date().toISOString(), thread_id: threadId, hop, stage: "sent",
    from, to, chat_id: chatId, text,
  });

  const started = Date.now();
  let result: Awaited<ReturnType<typeof invokeAgent>>;
  try {
    result = await withBotSlot(to, () =>
      invokeAgent({
        chatId,
        botName: to,
        message: tagged,
        // NOT instance.sessionMap — the bus keeps its own store so it can
        // never rewrite the file the live gateway is using.
        sessionMap: busSessionMap(config),
        config,
        model: instance.config.model,
        // The peer is talking to an agent, not to a person. Tagging the
        // sender as the peer agent keeps session logging honest and stops
        // anything downstream from mistaking a bus turn for the owner.
        telegramUser: `agent:${from}`,
        extraSystemHint: hint,
      }),
    );
  } catch (err) {
    const busy = err instanceof ConcurrencyCapError;
    const detail = busy ? `peer "${to}" at concurrency cap` : (err as Error).message;
    logBusEvent({
      ts: new Date().toISOString(), thread_id: threadId, hop, stage: "error",
      from, to, chat_id: chatId, text, duration_ms: Date.now() - started,
      error: detail.slice(0, 300),
    });
    throw new InteragentBusError(`hop ${hop} to "${to}" failed — ${detail}`);
  }

  const reply: PeerReply = {
    text: result.response ?? "",
    sessionId: result.sessionId,
    costUsd: result.cost ?? 0,
    inputTokens: result.inputTokens ?? 0,
    outputTokens: result.outputTokens ?? 0,
    durationMs: result.durationMs ?? Date.now() - started,
  };

  logBusEvent({
    ts: new Date().toISOString(), thread_id: threadId, hop, stage: "replied",
    from, to, chat_id: chatId, session_id: reply.sessionId, text,
    reply: reply.text, cost_usd: reply.costUsd, input_tokens: reply.inputTokens,
    output_tokens: reply.outputTokens, duration_ms: reply.durationMs,
  });
  console.log(
    `[interagent-bus] ${threadId} hop ${hop} ${from}→${to} — ` +
    `${reply.durationMs}ms, $${reply.costUsd.toFixed(4)}, ${reply.outputTokens} out`,
  );

  return reply;
}
