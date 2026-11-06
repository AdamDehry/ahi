import { ownerUserId } from "./users.js";
// ── interagent-loop.ts — the loop driver + termination contract ────────────
//
// Alternates sendToPeer() between two agents until the exchange terminates,
// then pushes ONE digest to the owner. Built on interagent-bus.ts; see that file's
// header for why read-back is free and why bus threads get their own sessions.
//
// ── Why the termination contract is the whole feature ─────────────────────
//
// A loop between two agents is an unbounded spend of real money that no human
// is watching. Every hop is a `claude -p` turn on Opus. So this module treats
// "stop" as the primary requirement and "converse" as the easy part. There
// are five independent ways out, and NONE of them can be disabled:
//
//   1. done signal    — a reply with `LOOP_DONE:` at the start of a line
//   2. hop budget     — maxHops, default 12
//   3. cost ceiling   — cumulative USD across the loop, default $4.00
//   4. token ceiling  — cumulative output tokens, default 60k
//   5. stall guard    — an empty/errored hop retries once, then aborts
//
// Ceilings are checked BEFORE each hop against cumulative totals, so the loop
// cannot overshoot by more than one in-flight turn. The per-turn
// `--max-budget-usd` ceiling in claude-invoke.ts bounds that final turn, which
// makes the true worst case (ceiling + one turn's budget) finite and known.
//
// A note on the done-signal check: we match `LOOP_DONE:` at the start of any
// line rather than anywhere in the text. Substring matching would let an agent
// end the loop just by *discussing* the protocol ("I'll reply LOOP_DONE: once
// we agree"), and the protocol hint is in their system prompt, so they can and
// will mention it. Line-anchored matching costs us nothing when agents follow
// the instruction to lead with the token, and when it does misfire the loop
// simply continues to its hop budget — the safe direction to fail.

import type { BotInstance } from "./telegram.js";
import type { GatewayConfig } from "./config.js";
import { broadcast } from "./websocket.js";
import { lookupByUserId } from "./users.js";
import {
  sendToPeer,
  busEnabled,
  logBusEvent,
  InteragentBusDisabledError,
  type PeerReply,
} from "./interagent-bus.js";

/** Emitted by an agent to end the exchange cleanly. */
export const DONE_TOKEN = "LOOP_DONE:";
const DONE_RE = /^[ \t>*_-]*LOOP_DONE:/m;

/**
 * Sentinel that claude-invoke substitutes when a turn ends on a tool use with
 * no trailing text. It is a successful turn that carries no conversational
 * content, so as a loop prompt it is useless — treat it as a stall.
 */
const EMPTY_RESULT_SENTINEL = "The agent completed the action but didn't send a text response";

const DEFAULTS = {
  maxHops: 12,
  maxCostUsd: 4.0,
  maxOutputTokens: 60_000,
};

export type LoopOutcome =
  | "done"          // a peer emitted LOOP_DONE:
  | "hop-budget"    // maxHops reached without convergence
  | "cost-ceiling"  // cumulative USD ceiling reached
  | "token-ceiling" // cumulative output-token ceiling reached
  | "stalled"       // a hop produced no usable reply twice running
  | "error";        // the bus refused or something threw

export interface HopRecord {
  hop: number;
  from: string;
  to: string;
  prompt: string;
  reply: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** True if the first attempt produced nothing usable and we retried. */
  retried: boolean;
}

export interface LoopResult {
  threadId: string;
  outcome: LoopOutcome;
  /** Human-readable reason, always populated. */
  reason: string;
  hops: HopRecord[];
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  durationMs: number;
  /** The final reply text, or the LOOP_DONE summary when converged. */
  finalReply: string;
  digest: string;
  digestDelivered: boolean;
}

export interface RunLoopOptions {
  /** The agent that speaks first — the seed message is sent AS this agent. */
  agentA: string;
  agentB: string;
  seedMessage: string;
  /** Defaults to a timestamped id; pass one to resume/label a loop. */
  threadId?: string;
  maxHops?: number;
  maxCostUsd?: number;
  maxOutputTokens?: number;
  /** Override the done detector. Default: `LOOP_DONE:` at a line start. */
  doneWhen?: (reply: string) => boolean;
  /** One-line description of the goal, used in the digest header. */
  goal?: string;
  /** userId to send the end-of-loop digest to. Pass null to skip delivery. */
  digestTo?: string | null;
  /**
   * Also write the digest into the PWA/app feed. OFF by default, and only
   * safe when this code is running INSIDE the gateway process.
   *
   * message-store keeps each thread in an in-memory `threadCache` and
   * rewrites the whole thread file on every append. The gateway is a
   * long-lived service holding the owner's threads in that cache, so a broadcast()
   * from any other process appends to a disk snapshot the service does not
   * know about — and the service's next append overwrites the file from its
   * stale cache, silently dropping whatever the foreign process wrote.
   *
   * For example: a CLI runner writes a digest, the gateway then serves a
   * normal turn, and the digest is gone. The same race can drop a real user
   * message, which is exactly the regression this must never introduce.
   *
   * Telegram has no such hazard — it is an API call, not a shared file — so
   * it is the default and always-safe surface.
   */
  digestToAppFeed?: boolean;
  instances: BotInstance[];
  config: GatewayConfig;
  /** Called after every hop — used by the CLI runner to stream the trace. */
  onHop?: (hop: HopRecord) => void;
  /**
   * Test seam. Substitutes the transport so the termination contract can be
   * exercised without spending model turns — the ceilings, the stall guard,
   * and the done signal are the parts that must be provably correct, and
   * proving them against live Opus turns would be both slow and expensive.
   * Production callers never set this; it defaults to the real bus.
   */
  sendFn?: typeof sendToPeer;
}

function defaultDoneWhen(reply: string): boolean {
  return DONE_RE.test(reply);
}

/** A reply we cannot meaningfully hand to the next agent as a prompt. */
function isUnusable(reply: PeerReply): boolean {
  const t = reply.text?.trim() ?? "";
  return t.length === 0 || t.includes(EMPTY_RESULT_SENTINEL);
}

function newThreadId(agentA: string, agentB: string): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
  return `${agentA}-${agentB}-${stamp}`;
}

/**
 * Run an alternating exchange between two agents until it terminates.
 *
 * Hop 1 sends `seedMessage` as `agentA` to `agentB`. Each reply becomes the
 * next hop's prompt, with the speaker alternating. Never throws for ordinary
 * termination — inspect `outcome`. Throws only if the bus is disabled.
 */
export async function runLoop(opts: RunLoopOptions): Promise<LoopResult> {
  if (!busEnabled()) throw new InteragentBusDisabledError();

  const {
    agentA, agentB, seedMessage, instances, config, goal, onHop,
    maxHops = DEFAULTS.maxHops,
    maxCostUsd = DEFAULTS.maxCostUsd,
    maxOutputTokens = DEFAULTS.maxOutputTokens,
    doneWhen = defaultDoneWhen,
    sendFn = sendToPeer,
  } = opts;
  const threadId = opts.threadId ?? newThreadId(agentA, agentB);
  const digestTo = opts.digestTo === undefined ? ownerUserId() : opts.digestTo;

  const startedAt = Date.now();
  const hops: HopRecord[] = [];
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  let outcome: LoopOutcome = "hop-budget";
  let reason = `hop budget of ${maxHops} reached without convergence`;
  let prompt = seedMessage;
  let speaker = agentA;
  let listener = agentB;
  let finalReply = "";

  console.log(
    `[interagent-loop] ${threadId} start — ${agentA} → ${agentB}, ` +
    `maxHops=${maxHops} maxCost=$${maxCostUsd.toFixed(2)} maxOut=${maxOutputTokens}`,
  );

  for (let hop = 1; hop <= maxHops; hop++) {
    // Ceilings are cumulative and checked BEFORE spending, so the loop can
    // never overshoot by more than the one turn already in flight.
    if (totalCostUsd >= maxCostUsd) {
      outcome = "cost-ceiling";
      reason = `cost ceiling hit — $${totalCostUsd.toFixed(4)} of $${maxCostUsd.toFixed(2)} after ${hops.length} hops`;
      break;
    }
    if (totalOutputTokens >= maxOutputTokens) {
      outcome = "token-ceiling";
      reason = `output-token ceiling hit — ${totalOutputTokens} of ${maxOutputTokens} after ${hops.length} hops`;
      break;
    }

    let reply: PeerReply | null = null;
    let retried = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await sendFn({
          from: speaker, to: listener, text: prompt, threadId, hop, maxHops,
          goal, instances, config,
        });
        if (!isUnusable(r)) {
          reply = r;
          break;
        }
        // A usable-but-empty turn still cost money — count it before retrying.
        totalCostUsd += r.costUsd;
        totalInputTokens += r.inputTokens;
        totalOutputTokens += r.outputTokens;
        console.warn(`[interagent-loop] ${threadId} hop ${hop} attempt ${attempt}: empty reply`);
      } catch (err) {
        console.warn(
          `[interagent-loop] ${threadId} hop ${hop} attempt ${attempt} threw: ${(err as Error).message}`,
        );
      }
      if (attempt === 1) retried = true;
    }

    if (!reply) {
      outcome = "stalled";
      reason = `hop ${hop} to ${listener} produced no usable reply after a retry`;
      break;
    }

    totalCostUsd += reply.costUsd;
    totalInputTokens += reply.inputTokens;
    totalOutputTokens += reply.outputTokens;
    finalReply = reply.text;

    const record: HopRecord = {
      hop, from: speaker, to: listener, prompt, reply: reply.text,
      costUsd: reply.costUsd, inputTokens: reply.inputTokens,
      outputTokens: reply.outputTokens, durationMs: reply.durationMs, retried,
    };
    hops.push(record);
    onHop?.(record);

    if (doneWhen(reply.text)) {
      outcome = "done";
      reason = `${listener} signalled ${DONE_TOKEN} on hop ${hop}`;
      break;
    }

    // The reply becomes the next prompt; the speakers swap.
    prompt = reply.text;
    [speaker, listener] = [listener, speaker];
  }

  const durationMs = Date.now() - startedAt;
  const result: LoopResult = {
    threadId, outcome, reason, hops, totalCostUsd, totalInputTokens,
    totalOutputTokens, durationMs, finalReply,
    digest: "", digestDelivered: false,
  };
  result.digest = buildDigest(result, { agentA, agentB, goal, maxHops, maxCostUsd });

  logBusEvent({
    ts: new Date().toISOString(), thread_id: threadId,
    stage: outcome === "done" ? "replied" : "error",
    from: agentA, to: agentB, cost_usd: totalCostUsd,
    input_tokens: totalInputTokens, output_tokens: totalOutputTokens,
    duration_ms: durationMs, reply: result.digest,
    error: outcome === "done" ? undefined : `${outcome}: ${reason}`,
  });
  console.log(
    `[interagent-loop] ${threadId} end — ${outcome} after ${hops.length} hops, ` +
    `$${totalCostUsd.toFixed(4)}, ${totalOutputTokens} out, ${durationMs}ms`,
  );

  if (digestTo) {
    result.digestDelivered = await deliverDigest(
      digestTo, agentA, result, opts.digestToAppFeed === true,
    );
  }
  return result;
}

const OUTCOME_LABEL: Record<LoopOutcome, string> = {
  done: "✅ converged",
  "hop-budget": "⏹️ budget reached, not converged",
  "cost-ceiling": "⏹️ cost ceiling, not converged",
  "token-ceiling": "⏹️ token ceiling, not converged",
  stalled: "⚠️ stalled",
  error: "⚠️ error",
};

/** One digest, written for the owner — the outcome, not the chatter. */
export function buildDigest(
  r: LoopResult,
  ctx: { agentA: string; agentB: string; goal?: string; maxHops: number; maxCostUsd: number },
): string {
  const names = `${ctx.agentA[0].toUpperCase()}${ctx.agentA.slice(1)} and ` +
    `${ctx.agentB[0].toUpperCase()}${ctx.agentB.slice(1)}`;
  const secs = (r.durationMs / 1000).toFixed(0);

  const lines = [
    `${OUTCOME_LABEL[r.outcome]} — ${names} ran ${r.hops.length} hop${r.hops.length === 1 ? "" : "s"}` +
      (ctx.goal ? ` on: ${ctx.goal}` : ""),
    "",
    `Outcome: ${r.reason}`,
    `Cost: $${r.totalCostUsd.toFixed(4)} of $${ctx.maxCostUsd.toFixed(2)} · ` +
      `${r.totalOutputTokens.toLocaleString()} output tokens · ${secs}s`,
    `Thread: ${r.threadId}`,
  ];

  if (r.finalReply.trim()) {
    // On convergence the LOOP_DONE summary IS the answer, so it leads. On a
    // non-convergent stop the last reply is just where they got to.
    const label = r.outcome === "done" ? "Result" : "Last exchange";
    const body = r.finalReply.trim().replace(new RegExp(`^[ \\t>*_-]*${DONE_TOKEN}\\s*`), "");
    lines.push("", `${label}:`, body.length > 1500 ? `${body.slice(0, 1500)}…` : body);
  }

  lines.push("", `Full hop trace: logs/interagent-${new Date().toISOString().slice(0, 10)}.jsonl`);
  return lines.join("\n");
}

/**
 * Push the digest to a user.
 *
 * Telegram is the default surface because it is safe from any process. The
 * app feed is opt-in and in-process only — see RunLoopOptions.digestToAppFeed
 * for why a foreign-process broadcast() silently loses writes.
 *
 * Attributed to `viaBot` (the agent that opened the loop) so it lands in a
 * thread the owner already reads. Each surface is best-effort and independent.
 */
async function deliverDigest(
  userId: string,
  viaBot: string,
  r: LoopResult,
  toAppFeed: boolean,
): Promise<boolean> {
  const user = lookupByUserId(userId);
  if (!user) {
    console.error(`[interagent-loop] no such user "${userId}" — digest not delivered`);
    return false;
  }

  let delivered = false;

  if (toAppFeed) {
    try {
      broadcast({
        type: "message", bot: viaBot, direction: "out", contentType: "text",
        text: r.digest, timestamp: new Date().toISOString(),
        chatId: user.telegramChatId ?? 0, userId: user.userId,
        senderName: user.name, source: "interagent",
      });
      delivered = true;
    } catch (err) {
      console.error("[interagent-loop] app digest failed:", (err as Error).message);
    }
  }

  const token = process.env[`${viaBot.toUpperCase()}_BOT_TOKEN`]?.trim();
  if (token && user.telegramChatId) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ chat_id: user.telegramChatId, text: r.digest }),
      });
      if (!res.ok) {
        console.error(`[interagent-loop] Telegram digest failed: ${res.status}`);
      } else {
        delivered = true;
      }
    } catch (err) {
      console.error("[interagent-loop] Telegram digest threw:", (err as Error).message);
    }
  }

  return delivered;
}
