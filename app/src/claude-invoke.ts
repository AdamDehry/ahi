import { AI_ROOT } from "./ai-root.js";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { newFrameNonce, scrubScreenFrames, streamJsonUserMessage, type ScreenFrame } from "./voice/screen-frame.js";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { delimiter, dirname, join, resolve } from "path";
import { homedir } from "os";
import type { SessionMap } from "./session-map.js";
import type { GatewayConfig } from "./config.js";
import { logSession, transcriptPath } from "./session-logger.js";
import { getRelevantContext } from "./retrieval.js";
import { acquireGlobalSpawnSlot } from "./concurrency.js";
import { claudeCommand } from "./claude-bin.js";
import { assembleStableSystemPrompt } from "./prompt-assembly.js";
import { lookupByUserId, resolveUserId } from "./users.js";
import { billsAgentHint } from "./bills.js";
import { vaultAgentHint } from "./vault/hint.js";
import { agentFilesHint } from "./chat-files/sentinel.js";
import { searchAgentHint } from "./search/sentinel.js";
import { studio as liveStudio, studioAgentHint } from "./studio/sentinel.js";
import { normalizeEffort } from "./claude-effort.js";
import { recordConversationEvent } from "./temporal-events.js";
import { getMessagesForUser } from "./message-store.js";
import { callRecapFor, removeThreadTailFile, threadTailEnabled, threadTailFor, writeThreadTailFile } from "./thread-tail.js";
import {
  GatewayDegradedError,
  isDiskFullError,
  notifyDegraded,
  notifyRecovered,
  readFreshDiskSnapshot,
} from "./degraded-notifier.js";
import { isVoiceScopedChatId } from "./voice/session-scope.js";
import { unshieldChild } from "./lifecycle.js";

// The runtime root (skills, documents) is AI_ROOT (ai-root.ts); the agents' generated documents go to
// <AI_ROOT>/documents.

// Generate .claude/settings.json at startup so permission-allowlist paths are
// correct for this host. Runs synchronously before any subprocess is spawned.
// On failure: warn and continue — the subprocess will use whatever settings.json
// is already on disk (the Mac default from git is always valid on Mac).
// Not under the test runner (NODE_TEST_CONTEXT, inherited by the drivers tests
// spawn): every suite run used to rewrite the CHECKOUT's settings.json, which
// in a foreman build worktree silently strips the foreman's merged overlay —
// its PreToolUse gate guard included (restart-resume build).
//
// Nor in a foreman build worktree at all (phone-leg): an isolated
// gateway booted from a build checkout rewrote its settings.json and stripped
// the foreman's Stop hook, so the build's closing record never woke Michael
// and the heartbeat called the build dark. A checkout carrying `.foreman/` or
// the foreman's `settings.json.pre-foreman` backup keeps its settings as-is.
export function foremanOwnsSettings(gatewayRoot: string): boolean {
  return (
    existsSync(resolve(gatewayRoot, ".foreman")) ||
    existsSync(resolve(gatewayRoot, ".claude", "settings.json.pre-foreman"))
  );
}

// import.meta.dirname here is dist/ (built output lives in dist/).
// Target is gateway/.claude/, which is one level up from dist/.
// Previously used "../../.claude" which resolved one level too high
// and silently wrote the file outside the gateway directory.
const GATEWAY_ROOT = resolve(import.meta.dirname, "..");
// The memory-search hook runs as `node <hook>` inside every claude subprocess (which inherits this env): make
// that `node` the one running this server — on an AHI Setup install the bundled runtime, on any OS.
if (!(process.env.PATH ?? "").split(delimiter).includes(dirname(process.execPath))) {
  process.env.PATH = [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter);
}
if (!process.env.NODE_TEST_CONTEXT && foremanOwnsSettings(GATEWAY_ROOT)) {
  console.log("[gateway] foreman build checkout — leaving .claude/settings.json as the foreman wrote it");
} else if (!process.env.NODE_TEST_CONTEXT) try {
  const settingsDir = resolve(GATEWAY_ROOT, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    resolve(settingsDir, "settings.json"),
    JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  // Node, not a shell script: one hook for Mac, Windows and Linux. An absolute path with
                  // forward slashes after a bare `node` parses the same in bash, cmd and PowerShell.
                  command: `node "${resolve(GATEWAY_ROOT, "hooks/ahi-retrieval.mjs").replace(/\\/g, "/")}"`,
                  timeout: 10,
                },
              ],
            },
          ],
        },
        permissions: {
          allow: [
            `Bash(python3 ${AI_ROOT}/skills/**:*)`,
            `Bash(python ${AI_ROOT}/skills/**:*)`,
            `Bash(python3 ${AI_ROOT}/skills/miriam/*:*)`,
            `Bash(python ${AI_ROOT}/skills/miriam/*:*)`,
            `Bash(python3 ${AI_ROOT}/skills/vision/*:*)`,
            `Bash(python ${AI_ROOT}/skills/vision/*:*)`,
            `Write(${AI_ROOT}/documents/**)`,
            `Write(${AI_ROOT}/skills/**)`,
          ],
        },
      },
      null,
      2,
    ) + "\n",
  );
} catch (err) {
  console.warn("[gateway] Failed to generate .claude/settings.json:", err);
}

export interface InvokeOptions {
  chatId: number;
  botName: string;
  message: string;
  sessionMap: SessionMap;
  config: GatewayConfig;
  model?: string;
  onStreamEvent?: (event: GatewayStreamEvent) => void;
  /** Resolved friendly name for the sender ("owner", "family", "unknown"). */
  telegramUser?: string;
  /** Optional external cancellation hook for H-040 speculative voice turns. */
  abortSignal?: AbortSignal;
  /**
   * Optional surface-specific instruction appended to the assembled system
   * prompt (e.g. the glasses HUD's "reply in 1–2 sentences" cap). Kept out
   * of `message` so the session transcript stays clean.
   */
  extraSystemHint?: string;
  /**
   * Tool patterns denied for this turn on top of the bot's own denials — a
   * surface's rails (the phone leg keeps destructive commands off a call).
   */
  disallowedTools?: string[];
  /**
   * Tools allowed for this turn ON TOP of the bot's own allowlist. Only the
   * live studio's background worker sets it (src/studio/: a background Avi
   * that may use the Higgsfield MCP and run the video pipeline); every
   * other turn leaves it unset and is unchanged.
   */
  extraAllowedTools?: string[];
  /** Extra `--add-dir` folders for this turn (the studio worker's job folder). */
  extraAddDirs?: string[];
  /** Present when the turn is inside immersive voice mode. */
  voiceStreamId?: string;
  /**
   * `--effort` for this spawn. Absent = the CLI's configured default (what
   * chat uses). Voice mode passes its own, lower level — see
   * VOICE_MODE_EFFORT_DEFAULT in config.ts.
   */
  effort?: string;
  /**
   * The authenticated principal, for turns whose chatId is not a person's
   * Telegram chat. A voice call runs under a synthetic per-call chatId
   * (voiceScopedChatId), which `resolveUserId` cannot map to anyone — so
   * without this a call reached retrieval and the time block as nobody: no
   * personal sessions, no timezone. The caller passes the user its socket
   * authenticated, never anything taken from message content. A chatId that
   * DOES resolve always wins.
   */
  principalUserId?: string;
  /**
   * Extra env vars for the spawned `claude`, applied AFTER the gateway's own
   * (so a caller can deliberately override AHI_AGENT), e.g. to give each outside account its own
   * per-account state.
   */
  childEnv?: Record<string, string>;
  /**
   * One-shot turn: no `--resume`, no sessionMap write, no session-index row,
   * no context-bloat session eviction. For surfaces that carry their own
   * conversation history (replayed per request), where a resumed session would double-count context and a
   * shared sessionMap key would braid two surfaces into one conversation.
   * Also passes `--no-session-persistence`, so Claude itself writes no
   * transcript under ~/.claude/projects/ for the distiller to ingest.
   */
  ephemeral?: boolean;
  /**
   * No tools at all for this turn (`--tools ""`, MCP servers off): a turn that
   * may only talk — the call's talk lane (voice/eleven/brain.ts). A tool use
   * event can then only mean something slipped through; the caller decides.
   */
  noTools?: boolean;
  /**
   * Customer-facing containment, enforced by the CLI rather than the prompt. When set, the spawn runs `--restricted`: user, project and
   * local settings files are ignored, so no inherited allow rules and no hooks
   * (no retrieval, no temporal envelope). Only `tools` exist, only
   * `allowedTools` are pre-approved (print mode denies everything else),
   * `disallowedTools` are denied on top of the bot's own skill denials, MCP
   * servers are off and no extra dirs are added. The system prompt is the bot's
   * soul plus `toolScope` — no state pointers, memory index or retrieval context.
   */
  containment?: {
    tools: string[];
    allowedTools: string[];
    disallowedTools: string[];
    toolScope: string;
  };
  /**
   * The person's thread this turn answers in. When the turn
   * starts WITHOUT a resumed Claude session, the last messages of this thread
   * ride into the UserPromptSubmit context verbatim (thread-tail.ts) — a
   * resumed session already has them, so they are not paid for twice.
   * `alwaysTail` forces it (a turn resumed after a gateway restart).
   * `excludeMessageId` names the message being answered, which is the prompt
   * itself; when absent the newest inbound message is assumed.
   */
  thread?: {
    userId: string;
    excludeMessageId?: string | null;
    alwaysTail?: boolean;
    /**
     * False when the prompt is NOT a message in this thread (a voice call's
     * spoken turn). Then nothing is excluded as "the message being answered"
     * — otherwise the newest real inbound message would be dropped from the
     * tail. Default true.
     */
    promptInThread?: boolean;
  };
  /**
   * Screen frames for this turn ("look at my screen" on a call). Sent inline
   * as image blocks over stream-json input, never written by the gateway, and
   * scrubbed from the CLI's own session transcript when the turn ends — see
   * voice/screen-frame.ts.
   */
  images?: ScreenFrame[];
}

export interface InvokeResult {
  response: string;
  sessionId?: string;
  cost?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface GatewayStreamEvent {
  [key: string]: unknown;
  type: "stream-start" | "stream-chunk" | "stream-tool-use" | "stream-end" | "stream-error";
  streamId: string;
  botName: string;
  chunk?: string;
  toolName?: string;
  error?: string;
  finalText?: string;
  cost?: number;
  durationMs?: number;
}

export interface StreamChunkReemissionGate {
  noteDelta(text: string, index?: number): void;
  shouldEmitAssistantText(blockText: string, blockIndex: number): boolean;
  finishAssistantMessage(): void;
}

/**
 * Claude CLI partial mode emits live text deltas, then a terminal assistant
 * event containing the same fully assembled text block. Some delta events do
 * not carry a numeric block index, so deduping by index alone re-broadcasts
 * whole assistant messages. This gate tracks the current assistant message by
 * text boundary, with index dedupe as an additional fast path.
 */
export function createStreamChunkReemissionGate(): StreamChunkReemissionGate {
  let streamed = "";
  let messageStart = 0;
  let assistantConsumed = 0;
  const indexedBlocks = new Set<number>();

  return {
    noteDelta(text: string, index?: number): void {
      if (!text) return;
      streamed += text;
      if (typeof index === "number") indexedBlocks.add(index);
    },
    shouldEmitAssistantText(blockText: string, blockIndex: number): boolean {
      if (!blockText) return false;
      const remaining = streamed.slice(messageStart + assistantConsumed);
      const textMatched = remaining.startsWith(blockText);
      const indexed = indexedBlocks.has(blockIndex);
      if (textMatched || indexed) {
        if (textMatched) assistantConsumed += blockText.length;
        return false;
      }
      return true;
    },
    finishAssistantMessage(): void {
      if (assistantConsumed > 0 || indexedBlocks.size > 0) messageStart = streamed.length;
      assistantConsumed = 0;
      indexedBlocks.clear();
    },
  };
}

interface ClaudeJsonResult {
  type: string;
  subtype: string;
  is_error: boolean;
  errors?: string[];
  api_error_status?: string | null;
  result: string;
  session_id: string;
  total_cost_usd: number;
  duration_ms: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  /**
   * NOT from the CLI. The context size of the turn's LAST model call
   * (input + cache read + cache create of its final `assistant` message),
   * set by streamClaude. `usage` above is the SUM over every call in the
   * turn — a 17-tool-call turn reads its ~60k context 17 times and reports
   * ~1M cached tokens. Only this number says how big the session is.
   */
  last_call_context_tokens?: number;
}

const SOUL_DIR = resolve(AI_ROOT, "agents/soul");

function loadSharedAHICore(): string {
  const corePath = resolve(AI_ROOT, "mission-control/AHI_NESHAMA.md");
  try {
    const content = readFileSync(corePath, "utf-8");
    console.log(`[claude-invoke] Shared AHI Core loaded (${content.length} chars)`);
    return content;
  } catch {
    console.warn(`[claude-invoke] AHI_NESHAMA.md not found at ${corePath} — proceeding without shared core`);
    return "";
  }
}

// Cache shared core at module load — file doesn't change mid-session.
const SHARED_AHI_CORE = loadSharedAHICore();

function loadAHIFoundation(): string {
  const foundationPath = resolve(AI_ROOT, "soul/AHI-FOUNDATION.md");
  try {
    const content = readFileSync(foundationPath, "utf-8");
    console.log(`[claude-invoke] AHI Foundation loaded (${content.length} chars)`);
    return content;
  } catch {
    console.warn(`[claude-invoke] AHI-FOUNDATION.md not found at ${foundationPath} — proceeding without foundation`);
    return "";
  }
}

const AHI_FOUNDATION = loadAHIFoundation();

// Fallback text when Claude CLI returns an empty result (happens when the
// agent's final action is a tool use with no trailing text — e.g., Agent or
// Bash as the last step). An empty string propagating to ctx.reply() causes
// Telegram to 400 with "message text is empty", so we substitute sentinel
// text here before it can ever leak into the send path.
const EMPTY_RESULT_FALLBACK =
  "Done. (The agent completed the action but didn't send a text response this turn.)";

const CLAUDE_ENOSPC_REASON = "claude-spawn-enospc";
const LOW_DISK_REASON = "pre-flight-low-disk";
const CLAUDE_DISK_FULL_MESSAGE =
  "I tried to respond but my disk is full. Cleanup in progress — please retry your message in a few minutes.";

function lowDiskMessage(freeGb: number): string {
  return `Disk is critically low (${freeGb}GB free). Skipping this turn to avoid silent failure. Please free space and retry.`;
}

async function markClaudeDiskDegraded(detail: string): Promise<GatewayDegradedError> {
  await notifyDegraded(CLAUDE_ENOSPC_REASON, `claude --print failed: ${detail.slice(0, 1200)}`);
  console.error("[claude-invoke] DEGRADED — ENOSPC detected, alerted the owner");
  return new GatewayDegradedError(CLAUDE_ENOSPC_REASON, CLAUDE_DISK_FULL_MESSAGE, detail);
}

// H-046 — When the Claude CLI hits `--max-budget-usd` mid-turn it exits
// code=1 with an empty `result` field but still emits a terminal `result`
// event carrying total_cost_usd. Without this branch the empty result trips
// EMPTY_RESULT_FALLBACK and Telegram shows "Done." for what was actually a
// silent kill. We detect the case by checking cost vs the configured ceiling
// (95% threshold absorbs the small overshoot the CLI rounds in) and surface
// a clear message instead.
const BUDGET_EXHAUSTION_THRESHOLD = 0.95;
const DEFAULT_BUDGET_USD = 1.5;
function parsePositiveNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function configuredBudgetUsd(botName: string): number {
  const perBotKey = `BOT_MAX_BUDGET_USD_${botName.toUpperCase()}`;
  return (
    parsePositiveNumber(process.env[perBotKey]) ??
    parsePositiveNumber(process.env.BOT_MAX_BUDGET_USD) ??
    DEFAULT_BUDGET_USD
  );
}
function configuredBudgetHint(botName: string): string {
  return `BOT_MAX_BUDGET_USD_${botName.toUpperCase()}`;
}
function isBudgetExhaustion(cost: number | undefined, botName: string): boolean {
  if (typeof cost !== "number" || !Number.isFinite(cost)) return false;
  return cost >= configuredBudgetUsd(botName) * BUDGET_EXHAUSTION_THRESHOLD;
}
function budgetExhaustionMessage(cost: number, botName: string): string {
  // Only Michael talks to the operator. Anyone else's agent is talking to the
  // person who wrote, who should never hear an operator settings note. The
  // detail stays in the log line.
  if (botName.toLowerCase() !== "michael") {
    return "Sorry, I lost the thread on that one. Could you send it to me again?";
  }
  return (
    `⚠️ Hit the per-turn budget ceiling at $${cost.toFixed(2)} before finishing. ` +
    `the owner — the turn was cut short. Bump \`${configuredBudgetHint(botName)}\` if this is recurring.`
  );
}

const DEFAULT_MICHAEL_CACHE_READ_RESET_TOKENS = 750_000;
const MICHAEL_CONTEXT_BLOAT_REASON = "michael-context-bloat";

/**
 * What the agent is told about being on a CALL (R3-10 + R4-4).
 *
 * Applied wherever `voiceStreamId` is set rather than passed per call site, so
 * it cannot be forgotten on one path — the cold turn and the speculative turn
 * both get it, which matters because a speculated turn that answers in a
 * different register is a different agent, and committing it would show.
 *
 * The replay clause is R4-4. Asked to "repeat that" mid-call, Michael read the
 * ENTIRE session transcript back out loud. Nothing was injecting a transcript
 * to cause it: reading a log back is a reasonable thing to do in TEXT, where
 * you can skim it. Spoken it is unbearable, and nobody on a phone call has
 * ever meant "read me the minutes" by "say that again."
 */
/**
 * The call hint for one caller: their own name and neutral pronouns.
 */
export function voiceCallSystemHint(user = "the person you're with"): string {
  const [he, him, his, is, asks, approves] = ["they", "them", "their", "are", "ask", "approve"];
  return [
  "[MODE: VOICE CALL]",
  `You are on a phone call with ${user} right now. Every line of this reply is`,
  `spoken aloud, except work lines (below); ${he} ${is} listening, not reading, and`,
  "cannot skim, scroll back, or skip ahead.",
  "Answer in 1-3 short sentences, the answer first, then stop. Plain spoken",
  "prose only: no markdown, no headers, no bullet points, no dashes, no code,",
  "no URLs, no implementation briefs. Write exactly what should be said aloud.",
  "NEVER read back the transcript, the message log, or the conversation so far.",
  `If ${he} ${asks} you to repeat, to say that again, or to remind ${him} what you said,`,
  "restate ONLY your last point in one fresh sentence — never replay the",
  "history, and never recite more than one earlier turn.",
  "If the matter genuinely needs depth, give the one-line spoken answer and say",
  "you will put the detail in the chat.",
  `If ${he} ${approves} something you just offered ("go ahead", "do it"), do it`,
  "and confirm in a few words.",
  // Part five: technical narration was being read aloud.
  "WORK LINES: while you work (tools, checks, builds), anything technical is",
  `shown on ${his} screen, NOT spoken: file names, paths, commands, flags, code,`,
  "error text, test counts, ids, build or tool details. Put each such line on its",
  "own line starting with \"» \" (for example: \"» suite: 1107 of 1117 pass, same 10",
  "failures as base\"). Lines without \"» \" are spoken, so keep those short and",
  "human: \"Checking now.\", \"Found it.\", \"Done, the details are on your screen.\"",
  "Never put technical detail in a spoken line; when unsure, use \"» \".",
].join(" ");
}

export const VOICE_CALL_SYSTEM_HINT = voiceCallSystemHint();

function configuredCacheReadResetTokens(botName: string): number | null {
  const perBotKey = `BOT_MAX_CACHE_READ_TOKENS_${botName.toUpperCase()}`;
  const configured =
    parsePositiveNumber(process.env[perBotKey]) ??
    parsePositiveNumber(process.env.BOT_MAX_CACHE_READ_TOKENS);
  if (configured !== null) return configured;
  // Miriam too: a long-running session can grow to hundreds of thousands of
  // tokens of context with nothing resetting it, and every cold turn then
  // blows the per-turn budget. Same ceiling as Michael's; recent turns still ride in via the
  // thread tail and memory retrieval.
  return ["michael", "miriam"].includes(botName.toLowerCase()) ? DEFAULT_MICHAEL_CACHE_READ_RESET_TOKENS : null;
}

function shouldResetSessionForCacheRead(botName: string, cacheRead: number | undefined): boolean {
  const ceiling = configuredCacheReadResetTokens(botName);
  return ceiling !== null && typeof cacheRead === "number" && cacheRead > ceiling;
}

/**
 * What happens to the session after a turn whose summed cache reads crossed
 * the ceiling. "keep-voice-call": the chat is a per-call voice session
 * (negative, synthetic chatId) — it ends with the call, so it is never
 * cleared under a live call. Exported for its test.
 */
export function sessionResetAfterTurn(turn: {
  botName: string;
  chatId: number;
  ephemeral?: boolean;
  cacheRead: number | undefined;
}): "keep" | "clear" | "keep-voice-call" {
  if (turn.ephemeral || !shouldResetSessionForCacheRead(turn.botName, turn.cacheRead)) return "keep";
  return isVoiceScopedChatId(turn.chatId) ? "keep-voice-call" : "clear";
}

function claudeResultErrorDetail(result: ClaudeJsonResult, stderr: string): string {
  const parts = [
    result.errors?.join("; "),
    result.result?.trim(),
    result.api_error_status ? `api_error_status=${result.api_error_status}` : "",
    result.subtype ? `subtype=${result.subtype}` : "",
    stderr.trim(),
  ].filter(Boolean);
  return parts.join(" | ").slice(0, 1000) || "Claude returned an error result with no detail";
}

// Per-bot wall-clock ceiling. The 300s default is the runaway-detector put in
// during crash hardening. Avi's room-redesign render flow
// legitimately exceeds 300s (read 12 input photos → reason → fal.ai gpt-image-2
// at 30–60s → compose commentary), so the ceiling is now per-bot-overridable.
//
// Pattern (read at call time so a value change doesn't need a rebuild):
//   1. BOT_MAX_TURN_SECONDS_<UPPER_BOT_NAME> if set (e.g. BOT_MAX_TURN_SECONDS_AVI=600)
//   2. else BOT_MAX_TURN_SECONDS (global default override)
//   3. else 300
//
// The financial safety floor is the BOT_MAX_BUDGET_USD ceiling (H-046); this
// time wall is just an extra "definitely runaway" backstop. Long-research bots
// can be granted larger per-bot windows without loosening everyone else.
const DEFAULT_TURN_CEILING_SECONDS = 300;
function configuredTurnCeilingSeconds(botName: string): number {
  const perBotKey = `BOT_MAX_TURN_SECONDS_${botName.toUpperCase()}`;
  const candidates = [process.env[perBotKey], process.env.BOT_MAX_TURN_SECONDS];
  for (const raw of candidates) {
    if (!raw) continue;
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_TURN_CEILING_SECONDS;
}

// One-time startup log of resolved per-bot turn ceilings so a misnamed env
// var (e.g. BOT_MAX_TURN_SECS_AVI) is visible in gateway.log on boot rather
// than only on the rare SIGTERM line. Reads process.env at module load — if
// the env file changes, restart the gateway.
(function logTurnCeilings() {
  const bots = ["michael", "tzali", "avi", "miriam"];
  const resolved = bots.map((b) => `${b}=${configuredTurnCeilingSeconds(b)}s`).join(" ");
  console.log(`[claude-invoke] turn-ceilings (default=${DEFAULT_TURN_CEILING_SECONDS}s): ${resolved}`);
})();

(function logBudgetCeilings() {
  const bots = ["michael", "tzali", "avi", "miriam"];
  const resolved = bots.map((b) => `${b}=$${configuredBudgetUsd(b).toFixed(2)}`).join(" ");
  console.log(`[claude-invoke] budget-ceilings (default=$${DEFAULT_BUDGET_USD.toFixed(2)}): ${resolved}`);
})();

function loadSoulContent(botName: string): string {
  const soulFile = resolve(SOUL_DIR, `${botName.toUpperCase()}.md`);
  if (!existsSync(soulFile)) {
    console.warn(`[claude] No soul file found at ${soulFile}, using minimal prompt`);
    return `You are ${botName}, an AHI agent.`;
  }
  return readFileSync(soulFile, "utf-8");
}

const RETRIEVAL_ENABLED = process.env.GATEWAY_RETRIEVAL_ENABLED === "true";

// H-029 Ship 1 — per-bot allowed-tools allowlist.
// Replaces the prior unified list. Each bot now sees only the tools its
// kavana actually requires. Agent is deliberately unavailable to Michael's
// interactive gateway turns: Agent children
// are separately metered and bypass both the parent --max-budget-usd ceiling
// and this gateway's spawn semaphore. Foreman remains the supervised path for
// delegated/fan-out work. Tzali keeps Agent for explicitly assigned builds.
// Lookup is by `botName` lowercase; unknown bots get Michael's conservative
// set rather than inheriting recursive delegation.
const PER_BOT_ALLOWED_TOOLS: Record<string, string[]> = {
  michael:  ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch",          "Skill", "TodoWrite"],
  tzali:    ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch", "Agent", "Skill", "TodoWrite"],
  avi:      ["Read", "Write",         "Glob", "Grep",         "WebFetch", "WebSearch",          "Skill", "TodoWrite"],
  miriam:   ["Read", "Write",         "Glob", "Grep", "Bash", "WebFetch", "WebSearch",          "Skill", "TodoWrite"],
};

function allowedToolsFor(botName: string): string {
  const key = botName.toLowerCase();
  const list = PER_BOT_ALLOWED_TOOLS[key];
  if (!list) {
    console.warn(`[claude-invoke] No allowlist for bot=${botName} — falling back to Michael/Tzali set`);
    return PER_BOT_ALLOWED_TOOLS.michael.join(",");
  }
  return list.join(",");
}

// H-029 Ship 2 — per-bot Skill scoping via --disallowed-tools.
// The 3 user-scope skills at ~/.claude/skills/ (avi-video-pipeline,
// video-prompt-builder, youtube-lessons) auto-load into every spawned
// claude. We gate them with Skill(name) patterns in --disallowed-tools so
// only the right bot can invoke each:
//   - avi-video-pipeline → Avi only
//   - video-prompt-builder → Avi only
//   - youtube-lessons → Michael only
// Anthropic file-handling skills (anthropic-skills:pdf/xlsx/docx/pptx)
// remain available to any bot whose allowlist includes Skill (Miriam needs
// these for file handling).
const HEAVY_SKILLS = ["avi-video-pipeline", "video-prompt-builder", "youtube-lessons"] as const;
const PER_BOT_ALLOWED_SKILLS: Record<string, ReadonlyArray<string>> = {
  michael: ["youtube-lessons"],
  tzali:   [],
  avi:     ["avi-video-pipeline", "video-prompt-builder"],
  miriam:  [],
};

// A bot listed here is skill-EXCLUSIVE: every other skill installed at ~/.claude/skills is disallowed by
// name, scanned at startup (restart after installing skills). None in this release.
const SKILL_EXCLUSIVE_BOTS: Record<string, ReadonlyArray<string>> = {};

const USER_SKILLS_DIR = resolve(homedir(), ".claude/skills");
const installedUserSkills: string[] = (() => {
  try {
    return readdirSync(USER_SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
})();

function disallowedToolsFor(botName: string): string {
  const key = botName.toLowerCase();
  const exclusive = SKILL_EXCLUSIVE_BOTS[key];
  if (exclusive) {
    const blocked = installedUserSkills.filter((s) => !exclusive.includes(s));
    return blocked.map((s) => `Skill(${s})`).join(" ");
  }
  const allowed = PER_BOT_ALLOWED_SKILLS[key] ?? [];
  const blocked = HEAVY_SKILLS.filter((s) => !allowed.includes(s));
  // CLI pattern syntax: "Skill(name1) Skill(name2)" — space-separated tokens.
  return blocked.map((s) => `Skill(${s})`).join(" ");
}

// A failed resumed turn is safe to repeat only when the CLI explicitly says
// the saved session itself is invalid or missing. Retrying every other error
// can duplicate a runaway turn after it was externally killed. Rate limits, budget exits, OOM kills, cancellations, and generic
// failures must fail closed rather than silently starting the work again.
export function shouldRetryWithoutSessionResume(errorMessage: string): boolean {
  const msg = errorMessage.toLowerCase();
  return [
    "no conversation found",
    "conversation not found",
    "invalid session id",
    "invalid session_id",
    "session does not exist",
    "session not found",
  ].some((signature) => msg.includes(signature));
}

// Ship 1 — when true, retrieval moves to the UserPromptSubmit hook so the
// system prompt stays stable turn-over-turn and Anthropic's prompt cache can
// actually hit. The hook is wired via the app folder's .claude/settings.json →
// hooks/ahi-retrieval.mjs → dist/retrieval-cli.js. Setting this
// flag to "false" reverts to the legacy path where retrieval is baked into
// the system prompt (breaks caching but is preserved as a safety net).
const RETRIEVAL_VIA_HOOK = process.env.AHI_RETRIEVAL_HOOK === "true";

// H-034 — when true, the stable preamble drops from ~28K tokens (full soul +
// AHI Foundation + AHI_NESHAMA on every turn) to ~1.5–2K tokens (identity
// paragraph + universal core + methodology pointer + tool scope + state
// pointer). Everything else lazy-loads via the `memory-fetch` skill and the
// UserPromptSubmit hook. Default OFF during the rollout so we can A/B with
// the legacy hook path until token-reduction telemetry confirms the win.
// Set `AHI_STABLE_PROMPT=true` to opt in. Requires AHI_RETRIEVAL_HOOK=true
// (the H-034 stable preamble assumes the hook handles recent context).
const STABLE_PROMPT = process.env.AHI_STABLE_PROMPT === "true";

async function assembleSystemPrompt(
  botName: string,
  message: string,
  // Authenticated principal for principal-scoped retrieval categories. Same
  // resolver that feeds AHI_USER_ID on the hook path, so the live path and this
  // flip-back path cannot disagree about who is asking.
  userId: string | null = null,
): Promise<string> {
  // H-034 path: ~1.5–2K-token stable preamble. Identity + universal core +
  // methodology pointer + tool scope + state pointer. Everything else
  // lazy-loads via memory-fetch / hook. Byte-stable per bot (precondition
  // for prompt-cache hits) and ~85–90% smaller than the previous hook path.
  if (STABLE_PROMPT) {
    const t0 = Date.now();
    const stable = assembleStableSystemPrompt(botName);
    console.log(
      `[claude-invoke] assembleSystemPrompt (h034-stable): ${Date.now() - t0}ms, ` +
        `chars=${stable.lengthChars} (~${Math.round(stable.lengthChars / 4)} tokens)`,
    );
    return stable.full;
  }

  // Hook-path (legacy Ship 1): system prompt is soul + Foundation + Shared
  // AHI Core ONLY. Retrieval is injected into the user turn by the
  // UserPromptSubmit hook, so this function stays cheap (a sync disk read)
  // and — more importantly — its output is byte-identical across turns for
  // a given bot, which is the precondition for prompt cache hits.
  if (RETRIEVAL_VIA_HOOK) {
    const t0 = Date.now();
    const soul = loadSoulContent(botName);
    const parts: string[] = [soul];
    if (AHI_FOUNDATION) parts.push(`---\n\n## AHI Foundation\n\n${AHI_FOUNDATION}`);
    if (SHARED_AHI_CORE) parts.push(`---\n\n## Shared AHI Core\n\n${SHARED_AHI_CORE}`);
    console.log(
      `[claude-invoke] assembleSystemPrompt (hook-path): ${Date.now() - t0}ms, retrieval deferred to UserPromptSubmit hook`,
    );
    return parts.join("\n\n");
  }

  // Legacy path — retrieval baked into the system prompt. Kept as a
  // flip-back safety net for Ship 1 rollout. H-026.5 Task 2: soul read
  // (sync disk) and retrieval (async, may spawn Haiku if summaries are
  // missing) run concurrently.
  const t0 = Date.now();
  const [soul, ctxRaw] = await Promise.all([
    Promise.resolve().then(() => loadSoulContent(botName)),
    getRelevantContext(botName, message, userId ?? null).catch((err) => {
      console.warn(`[retrieval] Error during context retrieval for ${botName}:`, (err as Error).message);
      return "";
    }),
  ]);

  let recentContext = "";
  if (ctxRaw) {
    const lines = ctxRaw.split("\n").filter((l) => l.startsWith("###"));
    const sessionTitles = lines.map((l) => l.slice(4).split("—")[0].trim()).join(" | ");
    if (RETRIEVAL_ENABLED) {
      recentContext = ctxRaw;
      console.log(`[retrieval] Injecting ${lines.length} session(s) for ${botName}: ${sessionTitles}`);
    } else {
      console.log(`[retrieval] Shadow (flag off): would inject ${lines.length} session(s) for ${botName} — ${sessionTitles}`);
    }
  }
  console.log(`[claude-invoke] assembleSystemPrompt (legacy-path): ${Date.now() - t0}ms (soul + retrieval concurrent)`);

  // Assembly order: soul → recent context → Foundation → Shared AHI Core
  const parts: string[] = [soul];
  if (recentContext) parts.push(recentContext);
  if (AHI_FOUNDATION) parts.push(`---\n\n## AHI Foundation\n\n${AHI_FOUNDATION}`);
  if (SHARED_AHI_CORE) parts.push(`---\n\n## Shared AHI Core\n\n${SHARED_AHI_CORE}`);

  return parts.join("\n\n");
}

/**
 * Write this spawn's thread tail when it is owed (see InvokeOptions.thread).
 * Fail-open: any error means no tail, never a failed turn. Logs counts only.
 */
function prepareThreadTail(opts: InvokeOptions, streamId: string, fresh: boolean): string | null {
  const thread = opts.thread;
  if (!thread || opts.ephemeral || opts.containment || !threadTailEnabled()) return null;
  if (!thread.userId || thread.userId === "unknown") return null;
  // A resumed session already has the thread — but not a voice call that ran
  // in its own session since. A resumed CHAT turn gets just those calls (the
  // recap); a resumed voice turn is inside the call and needs nothing.
  const recapOnly = !fresh && !thread.alwaysTail;
  if (recapOnly && opts.voiceStreamId) return null;
  try {
    const user = lookupByUserId(thread.userId);
    const agentName = opts.botName.charAt(0).toUpperCase() + opts.botName.slice(1);
    const tailOpts = {
      userName: user?.name ?? thread.userId,
      agentName,
      timeZone: user?.timezone ?? null,
      excludeMessageId: thread.excludeMessageId ?? null,
      promptInThread: thread.promptInThread,
    };
    const text = recapOnly
      ? callRecapFor(getMessagesForUser, opts.botName, thread.userId, tailOpts)
      : threadTailFor(getMessagesForUser, opts.botName, thread.userId, tailOpts);
    if (!text) return null;
    const path = writeThreadTailFile(streamId, text);
    console.log(`[thread-tail] bot=${opts.botName} chat=${opts.chatId} kind=${recapOnly ? "call-recap" : "tail"} fresh=${fresh ? 1 : 0} forced=${thread.alwaysTail ? 1 : 0} chars=${text.length}`);
    return path;
  } catch (err) {
    console.warn(`[thread-tail] skipped bot=${opts.botName} err=${(err as Error).message}`);
    return null;
  }
}

/**
 * A turn whose `claude` died under it (SIGTERM, a crash exit) waits this long
 * before its fallback line is returned. On a gateway restart systemd SIGTERMs
 * the whole cgroup at once; if the child's death is handled before the
 * gateway's own signal, the "cut short" line would be delivered and the turn's
 * in-flight marker cleared — and the turn would never be resumed. The grace
 * lets the process exit first. Normal replies never wait.
 */
function failureGraceMs(): number {
  const n = Number(process.env.TURN_FAILURE_GRACE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 2_500;
}
const failureGrace = (): Promise<void> => new Promise((r) => setTimeout(r, failureGraceMs()));

/**
 * Who this turn is for, as far as retrieval and the time block are concerned.
 * A chatId that maps to a user always wins; the explicit principal only fills
 * in for synthetic chatIds (voice calls) — see InvokeOptions.principalUserId.
 */
export function principalFor(chatId: number, principalUserId?: string | null): string | null {
  return resolveUserId(chatId) ?? (principalUserId?.trim() || null);
}

export async function invokeAgent(opts: InvokeOptions): Promise<InvokeResult> {
  // The tail file lives exactly as long as the turn that reads it.
  const tail: { path: string | null } = { path: null };
  // Screen frames live exactly as long as the turn that sees them.
  const frames = (opts.images ?? []).map((frame) => ({ frame, nonce: newFrameNonce() }));
  // Only a frame turn looks up the session it will scrub. An ephemeral or
  // contained turn must not even read the shared session key (F-27), and a
  // turn without frames has nothing to scrub.
  const readSession = (): string | null =>
    frames.length && !opts.ephemeral ? opts.sessionMap.get(opts.chatId, opts.botName)?.claudeSessionId ?? null : null;
  const sessionIds: Array<string | null> = [readSession()];
  let result: InvokeResult | undefined;
  try {
    result = await invokeAgentTurn(opts, tail, frames);
    return result;
  } finally {
    removeThreadTailFile(tail.path);
    if (frames.length) {
      sessionIds.push(result?.sessionId ?? null, readSession());
      try {
        const scrub = scrubScreenFrames(frames.map((f) => f.nonce), { sessionIds });
        console.log(`[voice-screen] scrubbed ${scrub.images}/${frames.length} frame(s) from ${scrub.files} session transcript(s)`);
        if (scrub.images < frames.length) {
          console.warn(`[voice-screen] a frame was not found to scrub; it may remain in a session transcript`);
        }
      } catch (err) {
        console.error(`[voice-screen] scrub FAILED, a frame may remain in a session transcript: ${(err as Error).message}`);
      }
    }
  }
}

async function invokeAgentTurn(
  opts: InvokeOptions,
  tail: { path: string | null },
  frames: Array<{ frame: ScreenFrame; nonce: string }> = [],
): Promise<InvokeResult> {
  const { chatId, botName, message, sessionMap, config, model = "claude-sonnet-5", onStreamEvent, telegramUser, abortSignal, extraSystemHint, voiceStreamId, childEnv, ephemeral, containment, effort, disallowedTools: surfaceDenied } = opts;
  // A contained turn is a customer's, not a gateway principal's.
  const principal = containment ? null : principalFor(chatId, opts.principalUserId);

  const assembled = containment
    ? `${loadSoulContent(botName)}\n\n## Tool Scope\n\n${containment.toolScope}`
    : await assembleSystemPrompt(botName, message, principal);
  const callerName = principal ? lookupByUserId(principal)?.name ?? principal : "you";
  // Bills (bills.ts): the agent may keep THIS user's private bills tab.
  const billsHint = containment ? "" : billsAgentHint(botName, principal, callerName);
  const filesHint = containment ? "" : agentFilesHint(botName, principal, callerName);
  // Vault (vault/hint.ts): how Michael reads the owner's masked picture — never the picture itself.
  const vaultHint = containment ? "" : vaultAgentHint(botName, principal, callerName);
  // Inline search (search/sentinel.ts): pictures and links as a card in the chat.
  const searchHint = containment ? "" : searchAgentHint(botName, principal, callerName);
  // Live studio (studio/sentinel.ts): Avi's background jobs and decision cards.
  // Not on an ephemeral turn: the call's talk lane has no tools and must not
  // start work, and the studio's own background worker must not start more.
  const studioHint = containment || ephemeral ? "" : studioAgentHint(botName, principal, callerName);
  const hints = [extraSystemHint, voiceStreamId ? voiceCallSystemHint(callerName) : "", billsHint, filesHint, vaultHint, searchHint, studioHint].filter(Boolean);
  const systemPrompt = hints.length ? `${assembled}\n\n${hints.join("\n\n")}` : assembled;
  // An ephemeral turn never resumes and never writes — it must not even LOOK
  // at the shared session key, or a future refactor could resume the owner's
  // Telegram thread into a customer-facing surface.
  const existingSession = ephemeral ? undefined : sessionMap.get(chatId, botName);
  const previousSessionId = existingSession?.claudeSessionId ?? null;
  const streamId = `${botName}-${chatId}-${Date.now()}`;
  const invokedAt = new Date().toISOString();
  tail.path = prepareThreadTail(opts, streamId, !existingSession?.claudeSessionId);
  // Always set (empty = none) so a value can never leak in from a parent env.
  const tailEnv = (): Record<string, string> => ({ AHI_THREAD_TAIL_FILE: tail.path ?? "", ...(childEnv ?? {}) });

  const args: string[] = [
    "-p",
    "--verbose",
    "--output-format", "stream-json",
    // H-026.5 Task 1 — emit partial content_block_delta events so the gateway
    // can forward text as it streams from the model, not as one block at end.
    "--include-partial-messages",
    // Ship 1 — surface hook lifecycle events on the stdout stream so the
    // gateway can log whether the UserPromptSubmit retrieval hook fired, how
    // long it took, and what it injected. Hook stderr comes through the
    // hook_response event's "stderr" field; it does NOT appear on the
    // subprocess's own stderr stream.
    "--include-hook-events",
    "--model", model,
    "--system-prompt", systemPrompt,
    // Per-invocation dollar ceiling. `--max-budget-usd` is the only CLI-native
    // ceiling that bounds subagent/child fan-out (no --max-children flag).
    // Resolve per-bot first so Michael can handle larger research/ops turns
    // without loosening the default rails for smaller agents.
    "--max-budget-usd", configuredBudgetUsd(botName).toFixed(2),
  ];
  const effortLevel = normalizeEffort(effort);
  if (effortLevel) args.push("--effort", effortLevel);
  // A turn carrying screen frames sends one stream-json user message (image
  // blocks + text) instead of plain text; everything else is unchanged.
  if (frames.length) args.push("--input-format", "stream-json");
  const stdinInput = frames.length ? streamJsonUserMessage(message, frames, callerName) : message;

  if (containment) {
    // See InvokeOptions.containment. No --add-dir: a contained turn has no
    // file tools, and widening its working set would only matter if it did.
    args.push(
      "--restricted",
      "--strict-mcp-config",
      "--tools", containment.tools.join(","),
      "--allowed-tools", containment.allowedTools.join(","),
    );
  } else {
    args.push(
      "--allowed-tools", [allowedToolsFor(botName), ...(opts.extraAllowedTools ?? [])].join(","),
      // Grant cross-directory read/write access for shared AHI resources outside
      // the gateway project root. Miriam needs the skills dir for her generation
      // scripts (gen_pdf.py, gen_excel.py, gen_booklet.py, vision/ocr.py) and
      // the documents dir as the output destination for generated files.
      // Applied globally — all bots in this gateway are trusted, and the dirs
      // are AHI-internal (not user data outside the ecosystem).
      "--add-dir", `${AI_ROOT}/skills`,
      "--add-dir", `${AI_ROOT}/documents`,
    );
    // The studio agent reads its guides and looks at its job folders.
    const st = studioHint && principal ? liveStudio() : null;
    if (st) {
      // His own job folders only (never another user's).
      const mine = join(st.root, principal!);
      try {
        mkdirSync(mine, { recursive: true });
        args.push("--add-dir", st.guidesDir, "--add-dir", mine);
      } catch {
        args.push("--add-dir", st.guidesDir);
      }
    }
    for (const d of opts.extraAddDirs ?? []) args.push("--add-dir", d);
  }

  // H-029 Ship 2 — gate heavy user-scope skills per-bot (only emit if
  // there's something to disallow; empty string would be a CLI parse error).
  const disallowed = [disallowedToolsFor(botName), ...(containment?.disallowedTools ?? []), ...(surfaceDenied ?? [])]
    .filter(Boolean)
    .join(",");
  if (disallowed) {
    args.push("--disallowed-tools", disallowed);
  }

  // A talk-only turn: no built-in tools, no MCP servers. (Last --tools wins.)
  if (opts.noTools && !containment) {
    args.push("--tools", "", "--strict-mcp-config");
  }

  // Ephemeral means ephemeral on Claude's side too: no transcript on disk, so
  // nothing for the hourly distiller to pick up (F-27 critical #2).
  if (ephemeral) {
    args.push("--no-session-persistence");
  }

  // Resume existing session if we have one
  if (existingSession?.claudeSessionId) {
    args.push("--resume", existingSession.claudeSessionId);
  }

  // Temporal timeline (AHI_TEMPORAL_ENVELOPE): the moment this turn reached the
  // agent, written BEFORE the spawn so the UserPromptSubmit hook can tell this
  // message apart from the previous one. Timing only; fail-open.
  recordConversationEvent(principal, botName, "user_message_received", previousSessionId);

  // Log the ceiling read at invoke time, not module load — the module-load
  // "budget-ceilings" banner prints env defaults when claude-invoke is
  // imported before dotenv runs (config.js is a type-only import here), which
  // can misreport the budget caps in force. This line is the
  // authoritative per-turn value actually passed via --max-budget-usd.
  console.log(`[claude] Invoking for ${botName}:${chatId} (session: ${existingSession?.claudeSessionId || "new"}, streamId: ${streamId}, budget: $${configuredBudgetUsd(botName).toFixed(2)})`);

  const emit = onStreamEvent ?? (() => {});

  try {
    // A contained turn is a customer's, not a gateway principal's: it runs no
    // hooks and must not be attributed to any user in config/users.json.
    const result = await streamClaude(args, stdinInput, streamId, botName, emit, abortSignal, principal, tailEnv());

    // Update session map with the session ID for continuity
    if (!ephemeral) sessionMap.set(chatId, botName, result.session_id);

    // Log new sessions only (not resumes — same session_id means it's a continuation)
    if (!ephemeral && result.session_id && result.session_id !== previousSessionId) {
      const resolvedUser = telegramUser ?? config.userIdentityMap[chatId] ?? null;
      logSession({
        session_id: result.session_id,
        agent: botName,
        channel: "telegram",
        telegram_chat_id: chatId,
        telegram_user: resolvedUser,
        started_at: invokedAt,
        episode_name: null,
        category: null,
        transcript_path: transcriptPath(result.session_id),
      });
    }

    console.log(`[claude] Response for ${botName}:${chatId} — ${result.duration_ms}ms, $${result.total_cost_usd?.toFixed(4)}`);

    const cacheRead = result.usage?.cache_read_input_tokens;
    const context = result.last_call_context_tokens;
    // Ephemeral turns store no session, so there is nothing to evict — and
    // deleting the shared key here would silently clear the owner's live Telegram
    // session because a CRM request happened to run long.
    const verdict = sessionResetAfterTurn({ botName, chatId, ephemeral, cacheRead });
    if (verdict !== "keep") {
      const ceiling = configuredCacheReadResetTokens(botName)!;
      const figures = `cache_read=${cacheRead} context=${context ?? "n/a"} ceiling=${ceiling}`;
      if (verdict === "keep-voice-call") {
        // A call's session dies with the call (voice/session-scope.ts: one
        // chatId per call). Clearing it mid-call made Michael start the next
        // turn cold — "forgetting" mid-conversation — over a figure that is
        // the turn's summed cache reads, not its context.
        console.log(
          `[claude-context-bloat] bot=${botName} chat=${chatId} session=${result.session_id} ` +
          `${figures} — voice call: session kept until the call ends`,
        );
      } else {
        console.warn(
          `[claude-context-bloat] bot=${botName} chat=${chatId} session=${result.session_id} ` +
          `${figures} — clearing session before next turn`,
        );
        sessionMap.delete(chatId, botName);
        await notifyDegraded(
          MICHAEL_CONTEXT_BLOAT_REASON,
          `Cleared ${botName} session ${result.session_id} for chat=${chatId}; cache_read=${cacheRead}, context=${context ?? "n/a"}, ceiling=${ceiling}, cost=$${result.total_cost_usd?.toFixed(4)}`,
        );
      }
    }

    const trimmed = result.result?.trim();
    let response: string;
    if (trimmed) {
      response = result.result;
    } else if (isBudgetExhaustion(result.total_cost_usd, botName)) {
      const ceiling = configuredBudgetUsd(botName);
      console.warn(
        `[claude-budget-exhaustion] bot=${botName} chat=${chatId} session=${result.session_id} ` +
        `cost=$${result.total_cost_usd.toFixed(4)} ceiling=$${ceiling.toFixed(2)} dur=${result.duration_ms}ms`,
      );
      response = budgetExhaustionMessage(result.total_cost_usd, botName);
    } else {
      response = EMPTY_RESULT_FALLBACK;
    }

    recordConversationEvent(principal, botName, "assistant_response_emitted", result.session_id);

    return {
      response,
      sessionId: result.session_id,
      cost: result.total_cost_usd,
      durationMs: result.duration_ms,
      inputTokens: result.usage?.input_tokens,
      outputTokens: result.usage?.output_tokens,
    };
  } catch (err) {
    console.error(`[claude] Error for ${botName}:${chatId}:`, err);

    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("AbortError") || errMsg.includes("aborted by signal")) {
      throw err;
    }

    if (err instanceof GatewayDegradedError) {
      return { response: err.userMessage };
    }

    // SIGTERM / timeout — don't retry, just report
    if (errMsg.includes("SIGTERM") || errMsg.includes("timeout")) {
      await failureGrace();
      return {
        response: "That one cut short — try again.",
      };
    }

    // Retry only a confirmed stale/missing session. All other failures are
    // non-replayable: a fresh retry could duplicate expensive or destructive
    // work and can defeat a human emergency stop.
    if (existingSession?.claudeSessionId && shouldRetryWithoutSessionResume(errMsg)) {
      console.log(`[claude] Retrying without session resume...`);
      const freshArgs = args.filter((a) => a !== "--resume" && a !== existingSession.claudeSessionId);
      const retryStreamId = `${botName}-${chatId}-${Date.now()}-retry`;
      // The retry IS a fresh session, so it is owed the full tail — a resumed
      // turn may have written only the call recap, which a fresh session's
      // tail already includes.
      removeThreadTailFile(tail.path);
      tail.path = prepareThreadTail(opts, retryStreamId, true);
      try {
        const result = await streamClaude(freshArgs, stdinInput, retryStreamId, botName, emit, abortSignal, principal, tailEnv());
        sessionMap.set(chatId, botName, result.session_id);
        if (result.session_id && result.session_id !== previousSessionId) {
          const resolvedUser = telegramUser ?? config.userIdentityMap[chatId] ?? null;
          logSession({
            session_id: result.session_id,
            agent: botName,
            channel: "telegram",
            telegram_chat_id: chatId,
            telegram_user: resolvedUser,
            started_at: invokedAt,
            episode_name: null,
            category: null,
            transcript_path: transcriptPath(result.session_id),
          });
        }
        const trimmedRetry = result.result?.trim();
        let retryResponse: string;
        if (trimmedRetry) {
          retryResponse = result.result;
        } else if (isBudgetExhaustion(result.total_cost_usd, botName)) {
          const ceiling = configuredBudgetUsd(botName);
          console.warn(
            `[claude-budget-exhaustion] bot=${botName} chat=${chatId} session=${result.session_id} ` +
            `cost=$${result.total_cost_usd.toFixed(4)} ceiling=$${ceiling.toFixed(2)} dur=${result.duration_ms}ms (retry)`,
          );
          retryResponse = budgetExhaustionMessage(result.total_cost_usd, botName);
        } else {
          retryResponse = EMPTY_RESULT_FALLBACK;
        }
        recordConversationEvent(principal, botName, "assistant_response_emitted", result.session_id);
        return {
          response: retryResponse,
          sessionId: result.session_id,
          cost: result.total_cost_usd,
          durationMs: result.duration_ms,
          inputTokens: result.usage?.input_tokens,
          outputTokens: result.usage?.output_tokens,
        };
      } catch (retryErr) {
        console.error(`[claude] Retry also failed:`, retryErr);
        if (retryErr instanceof GatewayDegradedError) {
          return { response: retryErr.userMessage };
        }
      }
    }

    // H-046 — surface actual failure mode rather than the misleading "Done."
    // path. errMsg from streamClaude contains "claude exited with code N: <stderr-tail>"
    // for non-zero exits. We log it fully and give the user a short hint.
    const exitMatch = errMsg.match(/claude exited with code (\d+)/);
    if (exitMatch) {
      await failureGrace();
      return {
        response: `⚠️ Claude CLI exited with code ${exitMatch[1]} before finishing the turn. The owner — check \`~/ai/logs/gateway.log\` for stderr.`,
      };
    }

    return {
      response: "I'm having trouble connecting right now. Try again in a moment.",
    };
  }
}

async function streamClaude(
  args: string[],
  stdinInput: string,
  streamId: string,
  botName: string,
  emit: (event: GatewayStreamEvent) => void,
  abortSignal?: AbortSignal,
  userId?: string | null,
  childEnv?: Record<string, string>,
): Promise<ClaudeJsonResult> {
  const snapshot = readFreshDiskSnapshot(2);
  if (snapshot && snapshot.freeGb < 2) {
    const detail = `Free: ${snapshot.freeGb}GB (snapshot age ${snapshot.ageHours.toFixed(1)}h)`;
    await notifyDegraded(LOW_DISK_REASON, detail);
    throw new GatewayDegradedError(LOW_DISK_REASON, lowDiskMessage(snapshot.freeGb), detail);
  }

  // Global spawn-semaphore (protection #2b). This is the ONLY path that
  // spawns `claude -p` in the gateway. Acquiring here means no subprocess
  // can bypass the global cap — including future callsites, direct test
  // harnesses, or anything that forgets to wrap with withBotSlot.
  const slot = await acquireGlobalSpawnSlot(botName);
  const { spawnId, release } = slot;

  return await new Promise<ClaudeJsonResult>((resolvePromise, rejectPromise) => {
    const spawnedAt = Date.now();
    console.log(`[claude-spawn] SPAWN spawn#${spawnId} bot=${botName} streamId=${streamId}`);
    const claude = claudeCommand();
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(claude.command, [...claude.prefix, ...args], {
        stdio: ["pipe", "pipe", "pipe"],
        // Give every turn its own process group. Agent children and shell
        // descendants inherit it, so Stop can terminate the whole turn rather
        // than leaving separately metered work alive behind a dead parent.
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          // AHI_AGENT lets the UserPromptSubmit hook know which agent's corpus
          // to retrieve from. Set in both paths for consistency — it's harmless
          // when the hook isn't wired (env var is just ignored).
          AHI_AGENT: botName,
          // AHI_USER_ID lets the same hook resolve the user's timezone /
          // location / last-message timestamp for the Current Moment block
          // built by src/time-context.ts. Empty string when no user is
          // resolvable (the hook falls back to the userId-less variant).
          AHI_USER_ID: userId ?? "",
          // Claude Code's auto-memory is keyed to the cwd (this gateway dir),
          // i.e. Michael's ops log. Only Michael may load it; for every other
          // agent it leaked Michael's notes into their turns (privacy).
          ...(botName === "michael" ? {} : { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }),
          // Caller-supplied overrides go LAST so a surface can deliberately
          // re-scope AHI_AGENT (see InvokeOptions.childEnv).
          ...(childEnv ?? {}),
        },
      }) as ChildProcessWithoutNullStreams;
      unshieldChild(proc.pid);
    } catch (err) {
      release();
      void (async () => {
        if (isDiskFullError(err)) {
          rejectPromise(await markClaudeDiskDegraded(err instanceof Error ? err.message : String(err)));
          return;
        }
        rejectPromise(new Error(`Failed to spawn claude: ${err instanceof Error ? err.message : String(err)}`));
      })();
      return;
    }

    // Guarantee the global slot is released in every termination path
    // (resolve, reject, error, timeout). Wrap resolve/reject so we cannot
    // forget to call it.
    const resolve = (v: ClaudeJsonResult) => { release(); resolvePromise(v); };
    const reject = (e: Error) => { release(); rejectPromise(e); };

    // Per-bot wall-clock ceiling. Resolved at call time from
    // BOT_MAX_TURN_SECONDS_<UPPER_BOT_NAME> > BOT_MAX_TURN_SECONDS > 300s default.
    // Financial protection is BOT_MAX_BUDGET_USD (H-046); this is the runaway
    // backstop. Avi's render flow needs 600; others stay at 300.
    const ceilingSec = configuredTurnCeilingSeconds(botName);
    const terminateTurn = () => {
      if (process.platform !== "win32" && proc.pid) {
        try {
          process.kill(-proc.pid, "SIGTERM");
          return;
        } catch {
          // The group may already be gone; fall through to the direct child.
        }
      }
      proc.kill("SIGTERM");
    };
    const killTimer = setTimeout(() => {
      console.warn(`[claude] ${streamId} bot=${botName} hit ${ceilingSec}s ceiling — sending SIGTERM`);
      terminateTurn();
    }, ceilingSec * 1000);
    const onAbort = () => {
      console.warn(`[claude] ${streamId} aborted by signal`);
      terminateTurn();
    };
    if (abortSignal?.aborted) {
      onAbort();
    } else {
      abortSignal?.addEventListener("abort", onAbort, { once: true });
    }

    let stdoutBuf = "";
    let stderr = "";
    let finalResult: ClaudeJsonResult | null = null;
    let settled = false;
    let firstChunkAt: number | null = null;
    let hookMarkerSeen: string | null = null;
    let lastCallContextTokens: number | null = null;

    function settle(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      abortSignal?.removeEventListener("abort", onAbort);
      fn();
    }

    proc.stdin.write(stdinInput);
    proc.stdin.end();

    emit({ type: "stream-start", streamId, botName });

    // When --include-partial-messages is on, the CLI sends granular
    // content_block_delta events AND a terminal `assistant` event carrying the
    // same text. Some deltas have no numeric index, so dedupe by message text
    // boundary and keep index as a bonus signal.
    const streamChunkGate = createStreamChunkReemissionGate();

    function processLine(line: string): void {
      const trimmed = line.trim();
      if (!trimmed) return;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return; // non-JSON debug output — ignore
      }

      const evType = event.type as string;

      if (evType === "stream_event") {
        // Partial streaming path — emit chunks the moment they arrive.
        const inner = event.event as
          | { type: string; index?: number; delta?: { type: string; text?: string } }
          | undefined;
        if (!inner) return;
        if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta" && inner.delta.text) {
          if (firstChunkAt === null) firstChunkAt = Date.now();
          emit({ type: "stream-chunk", streamId, botName, chunk: inner.delta.text });
          streamChunkGate.noteDelta(inner.delta.text, inner.index);
        }
        // content_block_start / content_block_stop / message_* are dropped — we
        // only need text deltas + the final `assistant` event (for tool_use +
        // deduped text) + the `result` event (for session/cost metadata).
      } else if (evType === "assistant") {
        const msg = event.message as {
          content: Array<{ type: string; text?: string; name?: string }>;
          usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
        } | undefined;
        // Each assistant message carries ITS call's usage; the last one is
        // the session's real context size (see last_call_context_tokens).
        if (msg?.usage) {
          const u = msg.usage;
          const ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          if (ctx > 0) lastCallContextTokens = ctx;
        }
        if (msg?.content) {
          for (let i = 0; i < msg.content.length; i++) {
            const block = msg.content[i];
            if (block.type === "text" && block.text) {
              // If partial deltas already streamed this assistant message,
              // don't re-emit the terminal copy. This works even when the
              // deltas lacked `index`, which is the root bug.
              if (streamChunkGate.shouldEmitAssistantText(block.text, i)) {
                if (firstChunkAt === null) firstChunkAt = Date.now();
                emit({ type: "stream-chunk", streamId, botName, chunk: block.text });
              }
            } else if (block.type === "tool_use" && block.name) {
              emit({ type: "stream-tool-use", streamId, botName, toolName: block.name });
            }
          }
          streamChunkGate.finishAssistantMessage();
        }
      } else if (evType === "result") {
        finalResult = event as unknown as ClaudeJsonResult;
      } else if (evType === "system") {
        // Ship 1 — hook telemetry. The `hook_response` system event carries
        // the UserPromptSubmit hook's stdout/stderr and exit code. We pull
        // the `[ahi-retrieval]` marker line out of hook stderr so it can be
        // logged with the per-turn cache metrics at result time.
        const subtype = (event as { subtype?: string }).subtype;
        if (subtype === "hook_response") {
          const hookEvent = event as {
            hook_name?: string;
            stderr?: string;
            exit_code?: number;
            outcome?: string;
          };
          if (hookEvent.hook_name === "UserPromptSubmit") {
            const hookStderr = hookEvent.stderr ?? "";
            const m = hookStderr.match(/\[ahi-retrieval\][^\n]*/g);
            if (m && m.length > 0) {
              hookMarkerSeen = m[m.length - 1];
            } else if (hookEvent.outcome) {
              hookMarkerSeen = `outcome=${hookEvent.outcome} exit=${hookEvent.exit_code}`;
            }
          }
        }
      }
      // user/other events are silently dropped — we don't need them
    }

    proc.stdout.on("data", (data: Buffer) => {
      stdoutBuf += data.toString();
      // Split on newlines; keep any incomplete trailing line in the buffer
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      // Hook telemetry: any line starting with `[ahi-retrieval]` is emitted
      // by hooks/ahi-retrieval.mjs via its CLI. We keep the most
      // recent one so it can be logged together with the turn's cache metrics
      // at result time.
      const marker = chunk.match(/\[ahi-retrieval\][^\n]*/g);
      if (marker && marker.length > 0) {
        hookMarkerSeen = marker[marker.length - 1];
      }
    });

    proc.on("close", async (code, signal) => {
      const durMs = Date.now() - spawnedAt;
      console.log(`[claude-spawn] EXIT spawn#${spawnId} bot=${botName} code=${code ?? "n/a"} signal=${signal ?? "n/a"} dur=${durMs}ms`);
      // Drain any remaining buffered output
      if (stdoutBuf.trim()) processLine(stdoutBuf);

      if (signal === "SIGTERM" || code === 143) {
        // Budget-vs-time ordering guard. If by the time SIGTERM landed we'd
        // already received a `result` event AND cost crossed the budget
        // threshold, the financial cap is the truer reason — resolve with
        // the result so invokeAgent's isBudgetExhaustion branch can surface
        // the budget message instead of "That one cut short — try again."
        // In practice the CLI exits before this on budget hits (preemptive
        // check at tool boundaries), but this is the belt-and-braces.
        if (finalResult && isBudgetExhaustion(finalResult.total_cost_usd, botName)) {
          console.warn(
            `[claude] ${streamId} bot=${botName} SIGTERM raced budget — preferring budget message ` +
            `(cost=$${finalResult.total_cost_usd.toFixed(4)}, ceiling=${ceilingSec}s)`,
          );
          settle(() => {
            emit({
              type: "stream-end",
              streamId,
              botName,
              finalText: finalResult!.result?.trim() || undefined,
              cost: finalResult!.total_cost_usd,
              durationMs: finalResult!.duration_ms,
            });
            resolve(finalResult!);
          });
          return;
        }
        settle(() => {
          if (abortSignal?.aborted) {
            const intentionalState = abortSignal.reason === "steered" ? "steered" : "stopped";
            emit({ type: "stream-error", streamId, botName, error: intentionalState });
            reject(new Error("AbortError: claude aborted by signal"));
            return;
          }
          emit({ type: "stream-error", streamId, botName, error: "timeout_sigterm" });
          reject(new Error(`claude timed out after ${ceilingSec}s (SIGTERM)`));
        });
        return;
      }

      if (finalResult) {
        if (finalResult.is_error && !isBudgetExhaustion(finalResult.total_cost_usd, botName)) {
          const detail = claudeResultErrorDetail(finalResult, stderr);
          settle(() => {
            emit({ type: "stream-error", streamId, botName, error: "result_error" });
            reject(new Error(`claude result error: ${detail}`));
          });
          return;
        }

        await notifyRecovered(CLAUDE_ENOSPC_REASON);
        await notifyRecovered(LOW_DISK_REASON);
        // Ship 1 telemetry: TTFT + cache metrics + hook marker. If prompt
        // caching is working, cache_read_input_tokens should be large on
        // turn 2+ within the 5m TTL window.
        const ttft = firstChunkAt !== null ? firstChunkAt - spawnedAt : null;
        const cacheRead = finalResult.usage?.cache_read_input_tokens ?? 0;
        const cacheCreate = finalResult.usage?.cache_creation_input_tokens ?? 0;
        const inputTok = finalResult.usage?.input_tokens ?? 0;
        const outputTok = finalResult.usage?.output_tokens ?? 0;
        if (lastCallContextTokens !== null) finalResult.last_call_context_tokens = lastCallContextTokens;
        // cache_read/cache_create/input are SUMMED over the turn's model
        // calls; `context` is the last call's actual context size.
        console.log(
          `[claude-telemetry] ${streamId} ttft=${ttft === null ? "n/a" : `${ttft}ms`} ` +
          `cache_read=${cacheRead} cache_create=${cacheCreate} ` +
          `input=${inputTok} output=${outputTok} ` +
          `context=${lastCallContextTokens ?? "n/a"} ` +
          `hook=${hookMarkerSeen ?? "none"}`,
        );
        settle(() => {
          emit({
            type: "stream-end",
            streamId,
            botName,
            finalText: finalResult!.result?.trim() || undefined,
            cost: finalResult!.total_cost_usd,
            durationMs: finalResult!.duration_ms,
          });
          resolve(finalResult!);
        });
      } else if (code === 0) {
        settle(() => {
          emit({ type: "stream-error", streamId, botName, error: "no_result_event" });
          reject(new Error("claude exited 0 but produced no result event"));
        });
      } else {
        const stderrTail = stderr.slice(0, 500);
        const enospcExit =
          ((code ?? 0) !== 0 && isDiskFullError(stderr)) ||
          (signal === "SIGPIPE" && isDiskFullError(stderr));
        if (enospcExit) {
          const degradedErr = await markClaudeDiskDegraded(stderrTail || `code=${code ?? "n/a"} signal=${signal ?? "n/a"}`);
          settle(() => {
            emit({ type: "stream-error", streamId, botName, error: "enospc" });
            reject(degradedErr);
          });
          return;
        }
        settle(() => {
          emit({ type: "stream-error", streamId, botName, error: `exit_${code ?? "unknown"}` });
          reject(new Error(`claude exited with code ${code}: ${stderrTail}`));
        });
      }
    });

    proc.on("error", (err) => {
      settle(() => {
        emit({ type: "stream-error", streamId, botName, error: err.message });
        if (isDiskFullError(err)) {
          void (async () => reject(await markClaudeDiskDegraded(err.message)))();
          return;
        }
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      });
    });
  });
}
