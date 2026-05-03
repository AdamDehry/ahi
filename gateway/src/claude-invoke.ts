import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import type { SessionMap } from "./session-map.js";
import type { GatewayConfig } from "./config.js";
import { logSession, transcriptPath } from "./session-logger.js";
import { getRelevantContext } from "./retrieval.js";
import { acquireGlobalSpawnSlot } from "./concurrency.js";
import { assembleStableSystemPrompt } from "./prompt-assembly.js";

export interface InvokeOptions {
  chatId: number;
  botName: string;
  message: string;
  sessionMap: SessionMap;
  config: GatewayConfig;
  model?: string;
  onStreamEvent?: (event: GatewayStreamEvent) => void;
  /** Resolved friendly name for the sender ("primary" or another configured user; "unknown" if no match). */
  telegramUser?: string;
  /** Optional external cancellation hook for H-040 speculative voice turns. */
  abortSignal?: AbortSignal;
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

interface ClaudeJsonResult {
  type: string;
  subtype: string;
  is_error: boolean;
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
}

const SOUL_DIR = resolve(process.env.AHI_HOME || resolve(homedir(), "ahi"), "agents/soul");

function loadSharedAHICore(): string {
  const corePath = resolve(process.env.AHI_HOME || resolve(homedir(), "ahi"), "agents/soul/NESHAMA.md");
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
  const foundationPath = resolve(process.env.AHI_HOME || resolve(homedir(), "ahi"), "agents/soul/AHI-FOUNDATION.md");
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

// H-046 — When the Claude CLI hits `--max-budget-usd` mid-turn it exits
// code=1 with an empty `result` field but still emits a terminal `result`
// event carrying total_cost_usd. Without this branch the empty result trips
// EMPTY_RESULT_FALLBACK and Telegram shows "Done." for what was actually a
// silent kill. We detect the case by checking cost vs the configured ceiling
// (95% threshold absorbs the small overshoot the CLI rounds in) and surface
// a clear message instead.
const BUDGET_EXHAUSTION_THRESHOLD = 0.95;
function configuredBudgetUsd(): number {
  const raw = process.env.BOT_MAX_BUDGET_USD ?? "1.50";
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 1.5;
}
function isBudgetExhaustion(cost: number | undefined): boolean {
  if (typeof cost !== "number" || !Number.isFinite(cost)) return false;
  return cost >= configuredBudgetUsd() * BUDGET_EXHAUSTION_THRESHOLD;
}
function budgetExhaustionMessage(cost: number): string {
  return (
    `⚠️ Hit the per-turn budget ceiling at $${cost.toFixed(2)} before finishing. ` +
    `Heads up — the turn was cut short by the per-turn budget ceiling. Bump \`BOT_MAX_BUDGET_USD\` in your .env if this is recurring.`
  );
}

// Per-bot wall-clock ceiling. The 300s default is the runaway-detector put in
// during the 2026-04-24 crash hardening. Avi's room-redesign render flow
// legitimately exceeds 300s (read 12 input photos → reason → fal.ai gpt-image-2
// at 30–60s → compose commentary), so the ceiling is now per-bot-overridable.
//
// Pattern (read at call time so a value change doesn't need a rebuild):
//   1. BOT_MAX_TURN_SECONDS_<UPPER_BOT_NAME> if set (e.g. BOT_MAX_TURN_SECONDS_AVI=600)
//   2. else BOT_MAX_TURN_SECONDS (global default override)
//   3. else 300
//
// The financial safety floor is the BOT_MAX_BUDGET_USD ceiling (H-046); this
// time wall is just an extra "definitely runaway" backstop. Eliyahu/Miriam/
// Michael at 300s remains correct — anything over 5min from those is suspicious.
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
  const bots = ["michael", "tzali", "avi", "eliyahu", "miriam"];
  const resolved = bots.map((b) => `${b}=${configuredTurnCeilingSeconds(b)}s`).join(" ");
  console.log(`[claude-invoke] turn-ceilings (default=${DEFAULT_TURN_CEILING_SECONDS}s): ${resolved}`);
})();

function loadSoulContent(botName: string): string {
  const soulFile = resolve(SOUL_DIR, `${botName.toUpperCase()}.md`);
  if (!existsSync(soulFile)) {
    console.warn(`[claude] No soul file found at ${soulFile}, using minimal prompt`);
    return `You are ${botName}, an AI assistant for ${process.env.AHI_USER_NAME || "the user"}.`;
  }
  return readFileSync(soulFile, "utf-8");
}

const RETRIEVAL_ENABLED = process.env.GATEWAY_RETRIEVAL_ENABLED === "true";

// H-029 Ship 1 — per-bot allowed-tools allowlist.
// Replaces the prior unified list. Each bot now sees only the tools its
// kavana actually requires. Eliyahu loses Write/Edit/Bash/Skill/Agent
// (read-only Torah companion). Avi/Miriam lose Bash + Agent
// (no recursive claude -p fan-out from those bots). Michael/Tzali keep
// the full builder set. Lookup is by `botName` lowercase; falls back to
// the conservative Michael/Tzali set if a bot is added without an entry.
const PER_BOT_ALLOWED_TOOLS: Record<string, string[]> = {
  michael:  ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch", "Agent", "Skill", "TodoWrite"],
  tzali:    ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch", "Agent", "Skill", "TodoWrite"],
  avi:      ["Read", "Write",         "Glob", "Grep",         "WebFetch", "WebSearch",          "Skill", "TodoWrite"],
  eliyahu:  ["Read",                  "Glob", "Grep",         "WebFetch", "WebSearch",                   "TodoWrite"],
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
// remain available to any bot whose allowlist includes Skill (Miriam,
// (kept available for future restricted-bot file handling).
const HEAVY_SKILLS = ["avi-video-pipeline", "video-prompt-builder", "youtube-lessons"] as const;
const PER_BOT_ALLOWED_SKILLS: Record<string, ReadonlyArray<string>> = {
  michael: ["youtube-lessons"],
  tzali:   [],
  avi:     ["avi-video-pipeline", "video-prompt-builder"],
  eliyahu: [],
  miriam:  [],
};

function disallowedToolsFor(botName: string): string {
  const key = botName.toLowerCase();
  const allowed = PER_BOT_ALLOWED_SKILLS[key] ?? [];
  const blocked = HEAVY_SKILLS.filter((s) => !allowed.includes(s));
  // CLI pattern syntax: "Skill(name1) Skill(name2)" — space-separated tokens.
  return blocked.map((s) => `Skill(${s})`).join(" ");
}

// Ship 1 — when true, retrieval moves to the UserPromptSubmit hook so the
// system prompt stays stable turn-over-turn and Anthropic's prompt cache can
// actually hit. The hook is wired via $AHI_HOME/.claude/settings.json →
// $AHI_HOME/gateway/hooks/ahi-retrieval.sh → dist/retrieval-cli.js. Setting this
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

async function assembleSystemPrompt(botName: string, message: string): Promise<string> {
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
    getRelevantContext(botName, message).catch((err) => {
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

export async function invokeAgent(opts: InvokeOptions): Promise<InvokeResult> {
  const { chatId, botName, message, sessionMap, config, model = "sonnet", onStreamEvent, telegramUser, abortSignal } = opts;

  const systemPrompt = await assembleSystemPrompt(botName, message);
  const existingSession = sessionMap.get(chatId, botName);
  const previousSessionId = existingSession?.claudeSessionId ?? null;
  const streamId = `${botName}-${chatId}-${Date.now()}`;
  const invokedAt = new Date().toISOString();

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
    "--allowed-tools", allowedToolsFor(botName),
    // Per-invocation dollar ceiling. `--max-budget-usd` is the only CLI-native
    // ceiling that bounds subagent/child fan-out (no --max-children flag).
    // A single Michael/Tzali turn with modest tool use is $0.10–0.40. $1.50
    // tolerates heavier skill runs while still stopping a runaway tree.
    "--max-budget-usd", process.env.BOT_MAX_BUDGET_USD ?? "1.50",
    // Grant cross-directory read/write access for shared AHI resources outside
    // the gateway project root. Bots need the skills dir for generation
    // scripts (gen_pdf.py, gen_excel.py, gen_booklet.py, vision/ocr.py) and
    // the docs dir as the output destination for generated files.
    // Applied globally — all bots in this gateway are trusted, and the dirs
    // are AHI-internal (not user data outside the ecosystem).
    //
    // Paths are resolved from $AHI_HOME (set by the install wizard, defaults
    // to ~/ahi). Override with AHI_SKILLS_DIR / AHI_DOCS_DIR if needed.
    "--add-dir", process.env.AHI_SKILLS_DIR || resolve(process.env.AHI_HOME || resolve(homedir(), "ahi"), "skills"),
    "--add-dir", process.env.AHI_DOCS_DIR || resolve(process.env.AHI_HOME || resolve(homedir(), "ahi"), "docs"),
  ];

  // H-029 Ship 2 — gate heavy user-scope skills per-bot (only emit if
  // there's something to disallow; empty string would be a CLI parse error).
  const disallowed = disallowedToolsFor(botName);
  if (disallowed) {
    args.push("--disallowed-tools", disallowed);
  }

  // Resume existing session if we have one
  if (existingSession?.claudeSessionId) {
    args.push("--resume", existingSession.claudeSessionId);
  }

  console.log(`[claude] Invoking for ${botName}:${chatId} (session: ${existingSession?.claudeSessionId || "new"}, streamId: ${streamId})`);

  const emit = onStreamEvent ?? (() => {});

  try {
    const result = await streamClaude(args, message, streamId, botName, emit, abortSignal);

    // Update session map with the session ID for continuity
    sessionMap.set(chatId, botName, result.session_id);

    // Log new sessions only (not resumes — same session_id means it's a continuation)
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

    console.log(`[claude] Response for ${botName}:${chatId} — ${result.duration_ms}ms, $${result.total_cost_usd?.toFixed(4)}`);

    const trimmed = result.result?.trim();
    let response: string;
    if (trimmed) {
      response = result.result;
    } else if (isBudgetExhaustion(result.total_cost_usd)) {
      const ceiling = configuredBudgetUsd();
      console.warn(
        `[claude-budget-exhaustion] bot=${botName} chat=${chatId} session=${result.session_id} ` +
        `cost=$${result.total_cost_usd.toFixed(4)} ceiling=$${ceiling.toFixed(2)} dur=${result.duration_ms}ms`,
      );
      response = budgetExhaustionMessage(result.total_cost_usd);
    } else {
      response = EMPTY_RESULT_FALLBACK;
    }

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

    // SIGTERM / timeout — don't retry, just report
    if (errMsg.includes("SIGTERM") || errMsg.includes("timeout")) {
      return {
        response: "That one cut short — try again.",
      };
    }

    // If session resume failed, try fresh
    if (existingSession?.claudeSessionId) {
      console.log(`[claude] Retrying without session resume...`);
      const freshArgs = args.filter((a) => a !== "--resume" && a !== existingSession.claudeSessionId);
      const retryStreamId = `${botName}-${chatId}-${Date.now()}-retry`;
      try {
        const result = await streamClaude(freshArgs, message, retryStreamId, botName, emit, abortSignal);
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
        } else if (isBudgetExhaustion(result.total_cost_usd)) {
          const ceiling = configuredBudgetUsd();
          console.warn(
            `[claude-budget-exhaustion] bot=${botName} chat=${chatId} session=${result.session_id} ` +
            `cost=$${result.total_cost_usd.toFixed(4)} ceiling=$${ceiling.toFixed(2)} dur=${result.duration_ms}ms (retry)`,
          );
          retryResponse = budgetExhaustionMessage(result.total_cost_usd);
        } else {
          retryResponse = EMPTY_RESULT_FALLBACK;
        }
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
      }
    }

    // H-046 — surface actual failure mode rather than the misleading "Done."
    // path. errMsg from streamClaude contains "claude exited with code N: <stderr-tail>"
    // for non-zero exits. We log it fully and give the user a short hint.
    const exitMatch = errMsg.match(/claude exited with code (\d+)/);
    if (exitMatch) {
      return {
        response: `⚠️ Claude CLI exited with code ${exitMatch[1]} before finishing the turn. Check \`$AHI_HOME/logs/gateway.log\` for stderr.`,
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
): Promise<ClaudeJsonResult> {
  // Global spawn-semaphore (protection #2b). This is the ONLY path that
  // spawns `claude -p` in the gateway. Acquiring here means no subprocess
  // can bypass the global cap — including future callsites, direct test
  // harnesses, or anything that forgets to wrap with withBotSlot.
  const slot = await acquireGlobalSpawnSlot(botName);
  const { spawnId, release } = slot;

  return await new Promise<ClaudeJsonResult>((resolvePromise, rejectPromise) => {
    const spawnedAt = Date.now();
    console.log(`[claude-spawn] SPAWN spawn#${spawnId} bot=${botName} streamId=${streamId}`);
    const proc = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // AHI_AGENT lets the UserPromptSubmit hook know which agent's corpus
        // to retrieve from. Set in both paths for consistency — it's harmless
        // when the hook isn't wired (env var is just ignored).
        AHI_AGENT: botName,
      },
    });

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
    const killTimer = setTimeout(() => {
      console.warn(`[claude] ${streamId} bot=${botName} hit ${ceilingSec}s ceiling — sending SIGTERM`);
      proc.kill("SIGTERM");
    }, ceilingSec * 1000);
    const onAbort = () => {
      console.warn(`[claude] ${streamId} aborted by signal`);
      proc.kill("SIGTERM");
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

    // Track which content-block indices we've emitted via partial deltas.
    // When --include-partial-messages is on, the CLI sends granular
    // content_block_delta events AND a terminal `assistant` event that
    // contains the fully-assembled block. We forward the deltas live and
    // suppress the matching text on the terminal `assistant` event so
    // clients don't see the full reply a second time. Tool uses still come
    // through the `assistant` event — only text is deduped.
    const streamedTextBlockSeen = new Set<number>();

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
          if (typeof inner.index === "number") streamedTextBlockSeen.add(inner.index);
        }
        // content_block_start / content_block_stop / message_* are dropped — we
        // only need text deltas + the final `assistant` event (for tool_use +
        // deduped text) + the `result` event (for session/cost metadata).
      } else if (evType === "assistant") {
        const msg = event.message as {
          content: Array<{ type: string; text?: string; name?: string }>;
        } | undefined;
        if (msg?.content) {
          for (let i = 0; i < msg.content.length; i++) {
            const block = msg.content[i];
            if (block.type === "text" && block.text) {
              // If we already streamed this block via partial deltas, don't
              // re-emit it here. Only emit when partial-mode didn't cover
              // this index (shouldn't happen with --include-partial-messages,
              // but guard so we never silently drop text).
              if (!streamedTextBlockSeen.has(i)) {
                if (firstChunkAt === null) firstChunkAt = Date.now();
                emit({ type: "stream-chunk", streamId, botName, chunk: block.text });
              }
            } else if (block.type === "tool_use" && block.name) {
              emit({ type: "stream-tool-use", streamId, botName, toolName: block.name });
            }
          }
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
      // by $AHI_HOME/gateway/hooks/ahi-retrieval.sh via its CLI. We keep the most
      // recent one so it can be logged together with the turn's cache metrics
      // at result time.
      const marker = chunk.match(/\[ahi-retrieval\][^\n]*/g);
      if (marker && marker.length > 0) {
        hookMarkerSeen = marker[marker.length - 1];
      }
    });

    proc.on("close", (code, signal) => {
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
        if (finalResult && isBudgetExhaustion(finalResult.total_cost_usd)) {
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
          emit({ type: "stream-error", streamId, botName, error: "timeout_sigterm" });
          if (abortSignal?.aborted) {
            reject(new Error("AbortError: claude aborted by signal"));
            return;
          }
          reject(new Error(`claude timed out after ${ceilingSec}s (SIGTERM)`));
        });
        return;
      }

      if (finalResult) {
        // Ship 1 telemetry: TTFT + cache metrics + hook marker. If prompt
        // caching is working, cache_read_input_tokens should be large on
        // turn 2+ within the 5m TTL window.
        const ttft = firstChunkAt !== null ? firstChunkAt - spawnedAt : null;
        const cacheRead = finalResult.usage?.cache_read_input_tokens ?? 0;
        const cacheCreate = finalResult.usage?.cache_creation_input_tokens ?? 0;
        const inputTok = finalResult.usage?.input_tokens ?? 0;
        const outputTok = finalResult.usage?.output_tokens ?? 0;
        console.log(
          `[claude-telemetry] ${streamId} ttft=${ttft === null ? "n/a" : `${ttft}ms`} ` +
          `cache_read=${cacheRead} cache_create=${cacheCreate} ` +
          `input=${inputTok} output=${outputTok} ` +
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
        settle(() => {
          emit({ type: "stream-error", streamId, botName, error: `exit_${code ?? "unknown"}` });
          reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`));
        });
      }
    });

    proc.on("error", (err) => {
      settle(() => {
        emit({ type: "stream-error", streamId, botName, error: err.message });
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      });
    });
  });
}
