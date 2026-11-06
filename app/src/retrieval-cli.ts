#!/usr/bin/env node
import { AI_ROOT } from "./ai-root.js";
/**
 * retrieval-cli.ts — UserPromptSubmit hook helper for the AHI gateway.
 *
 * Ship 1 architecture:
 *   - The gateway system prompt is kept stable (soul + foundation + core only)
 *     so Anthropic's prompt cache actually hits turn-over-turn.
 *   - Retrieval context moves OUT of the system prompt and INTO the per-turn
 *     user message via the UserPromptSubmit hook protocol.
 *   - This CLI is what the hook shells out to. It reads the hook stdin JSON
 *     (which includes `prompt` = the user's submitted text), reads
 *     AHI_AGENT from env (set by the gateway when spawning `claude`), calls
 *     getRelevantContext(), and prints the hook's JSON output to stdout.
 *
 * Protocol (UserPromptSubmit):
 *   stdin: { session_id, transcript_path, cwd, permission_mode,
 *            hook_event_name: "UserPromptSubmit", prompt }
 *   stdout: { hookSpecificOutput: { hookEventName, additionalContext } }
 *   stderr: "[ahi-retrieval] ..." telemetry marker (shown in transcript /
 *           streamed back to the gateway via subprocess stderr).
 *   exit:   0 on success (including the "no context" case — we just emit an
 *           empty additionalContext). Non-zero on unexpected failure; the
 *           gateway treats that as a soft failure — the turn still runs,
 *           just without retrieval.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

import { getRelevantContext } from "./retrieval.js";
import { buildTurnTimeContext } from "./time-context.js";
// H-034 — pre-pass that translates English keywords on the live turn into
// {shaar, shoresh} coordinates so we can (a) surface those gates to the
// agent as machine-readable hints (it can then call `Skill(memory-fetch)`
// to lazy-load deeper material at that address) and (b) bias scoring
// toward sessions sharing the same address. Address book lives in
// `./shaar-shoresh.ts` — a TS port of the canonical JS module at
// `~/ai/infra/sessions/scripts/shaar_shoresh_address_book.mjs`. Both
// versions intentionally redundant so the gateway build doesn't reach
// outside the source tree, and the enrichment script doesn't depend on
// dist artefacts. They MUST be kept in sync; document if you edit one.
// H-042 extends the same pre-pass: after detecting the gates we open the
// distiller's episode index and inject the top-ranked summaries filed at
// those addresses, so relevant memory arrives IN the turn at zero tool cost.
// Still no spawn — a cached local file read.
import {
  gatesForQuery,
  formatGateHints,
  episodesForGates,
  episodeStats,
  EPISODE_INJECTION_AGENTS,
} from "./shaar-shoresh.js";
// H-046 — the fact layer's error counter. The layer itself is invoked inside
// getRelevantContext, not here, because the detail harness scores that function
// and a layer the ruler cannot see is a layer nobody can justify.
import { factStats } from "./retrieval-facts.js";

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name?: string;
  prompt?: string;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
  });
}

function emitHookOutput(additionalContext: string): void {
  const payload = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(payload));
}

// Michael's voice/style card — prepended to every michael turn's
// additionalContext. Read FRESH from disk each turn (no caching, no rebuild)
// so edits to STYLE.md take effect on the very next message.
const STYLE_CARD_PATH = resolve(AI_ROOT, "agents/memory/michael/STYLE.md");
const STYLE_CARD_HEADER = "## Michael — Voice & Style (always apply)";

function michaelStyleCard(): string {
  try {
    const text = readFileSync(STYLE_CARD_PATH, "utf-8").trim();
    if (!text) return "";
    return `${STYLE_CARD_HEADER}\n\n${text}`;
  } catch {
    // Fail-open: a missing/unreadable card must never block the turn.
    return "";
  }
}

// Every emit path for a known agent goes through here so the style card is
// present even on degraded turns (stdin errors, retrieval failures) — style
// is orthogonal to retrieval. The includes() guard prevents doubling the
// card if the body already carries it (e.g. a retrieved session quoting it,
// or a future move into the system prompt).
function emitForAgent(agent: string, body: string): void {
  if (agent === "michael" && !body.includes(STYLE_CARD_HEADER)) {
    const card = michaelStyleCard();
    if (card) {
      emitHookOutput(`${card}\n\n${body}`);
      return;
    }
  }
  emitHookOutput(body);
}

// Per-turn time context. Legacy "Current Moment" block unless the temporal
// envelope flag (AHI_TEMPORAL_ENVELOPE) covers this agent, in which case the
// event-derived envelope + standing time rules ride along. Every emit path —
// healthy and degraded — goes through here, so time context can never be the
// casualty of a retrieval failure. The stderr marker carries timing facts and
// zone only: no prompt text, no message content.
function timeBlock(userId: string | null, agent: string | null | undefined, input?: HookInput): string {
  const started = Date.now();
  try {
    const ctx = buildTurnTimeContext({
      userId,
      agent: agent ?? null,
      prompt: input?.prompt ?? null,
      sessionId: input?.session_id ?? null,
      transcriptPath: input?.transcript_path ?? null,
    });
    const t = ctx.telemetry;
    process.stderr.write(
      `[ahi-time] ok mode=${ctx.mode} agent=${agent ?? "none"} user=${userId ?? "none"}` +
        (t
          ? ` zone=${t.zone} offset=${t.offsetMinutes} zone_src=${t.zoneSource} continuity=${t.continuity} ` +
            `sources=${t.sources.join(",") || "none"} eta=${t.etaBlock ? 1 : 0} ev_err=${t.eventReadErrors}`
          : "") +
        ` chars=${ctx.text.length} ms=${Date.now() - started}\n`,
    );
    return ctx.text;
  } catch (err) {
    process.stderr.write(`[ahi-time] error agent=${agent ?? "none"} err=${(err as Error).message}\n`);
    return "";
  }
}

// The thread tail (thread-tail.ts): written by the gateway for a turn that
// starts without a resumed Claude session, named by AHI_THREAD_TAIL_FILE.
// Read-only here; absent/empty/unreadable = no tail. The stderr marker carries
// a size only — never message text.
function threadTailBlock(): string {
  const path = process.env.AHI_THREAD_TAIL_FILE?.trim();
  if (!path) return "";
  try {
    const text = readFileSync(path, "utf-8").trim();
    process.stderr.write(`[ahi-thread-tail] ok chars=${text.length}\n`);
    return text;
  } catch (err) {
    process.stderr.write(`[ahi-thread-tail] unreadable err=${(err as NodeJS.ErrnoException).code ?? "?"}\n`);
    return "";
  }
}

// Time block, then the thread tail right after it. Every emit path for a known
// agent — healthy and degraded — goes through here. The agent-less branches
// stay time-only (style-card.test.ts pins their shape); the gateway always
// sets AHI_AGENT, so a gateway turn never takes them.
function momentBlock(userId: string | null, agent: string | null | undefined, input?: HookInput): string {
  return [timeBlock(userId, agent, input), threadTailBlock()].filter(Boolean).join("\n\n");
}

async function main(): Promise<void> {
  const started = Date.now();
  const agent = process.env.AHI_AGENT?.trim();
  const userId = process.env.AHI_USER_ID?.trim() || process.env.AHI_USER?.trim() || null;

  if (!agent) {
    // No agent — we can't do retrieval. Still emit per-turn time context,
    // falling back to the userId-less variant when the gateway did not pass
    // a user id.
    process.stderr.write("[ahi-retrieval] skipped reason=no-AHI_AGENT\n");
    emitHookOutput(timeBlock(userId, null));
    return;
  }

  let raw = "";
  try {
    raw = await readStdin();
  } catch (err) {
    process.stderr.write(
      `[ahi-retrieval] stdin-read-error agent=${agent} err=${(err as Error).message}\n`,
    );
    emitForAgent(agent, momentBlock(userId, agent));
    return;
  }

  let input: HookInput = {};
  try {
    input = raw.trim() ? (JSON.parse(raw) as HookInput) : {};
  } catch (err) {
    process.stderr.write(
      `[ahi-retrieval] stdin-parse-error agent=${agent} err=${(err as Error).message}\n`,
    );
    emitForAgent(agent, momentBlock(userId, agent));
    return;
  }

  const prompt = (input.prompt ?? "").trim();
  if (!prompt) {
    process.stderr.write(
      `[ahi-retrieval] skipped reason=empty-prompt agent=${agent}\n`,
    );
    emitForAgent(agent, momentBlock(userId, agent, input));
    return;
  }

  try {
    // H-034 pre-pass — substring scan against the address book. Cheap (no
    // spawn, no async), runs ahead of the index-scan so we can log the
    // gate hits even if recent-context retrieval finds nothing.
    const prepassStart = Date.now();
    const gateHits = gatesForQuery(prompt);
    // Episode injection is opt-in per bot (v1: michael only). Wrapped so a
    // bad index degrades to gate-hints-only instead of breaking the turn.
    let episodes: ReturnType<typeof episodesForGates> = [];
    if (EPISODE_INJECTION_AGENTS.has(agent)) {
      try {
        episodes = episodesForGates(gateHits, { agent });
      } catch (err) {
        episodeStats.errors++;
        episodeStats.lastError = (err as Error).message;
        episodes = [];
      }
    }
    const prepassMs = Date.now() - prepassStart;
    const gateBlock = formatGateHints(gateHits, episodes);

    // `userId` is the authenticated principal (AHI_USER_ID — resolved by the
    // gateway from the Telegram sender ID, never from message content). It is
    // REQUIRED for principal-scoped categories: without it, retrieval returns
    // no `personal` sessions rather than falling back to the shared pool.
    const ctxRaw = await getRelevantContext(agent, prompt, userId);
    const ctx = (ctxRaw ?? "").trim();
    const sessionCount = ctx
      ? ctx.split("\n").filter((l) => l.startsWith("### ")).length
      : 0;

    const ms = Date.now() - started;
    const gateAddrs = gateHits.map((h) => `${h.shaar}/${h.shoresh}`).join(",") || "none";
    process.stderr.write(
      `[ahi-retrieval] fired agent=${agent} sessions=${sessionCount} ` +
        `chars=${ctx.length} ms=${ms} ` +
        `prepass_ms=${prepassMs} gates=${gateAddrs} ` +
        `episodes=${episodes.length} ` +
        `idx_err=${episodeStats.errors} ` +
        // H-046: the fact layer degrades silently by design (fail-open), so the
        // only way a broken store is ever noticed is this counter.
        `fact_err=${factStats.errors}` +
        (factStats.errors > 0 ? ` fact_last_err=${factStats.lastError}` : "") +
        (episodeStats.errors > 0 ? ` idx_last_err=${episodeStats.lastError}` : "") +
        `\n`,
    );

    // Compose the hook output. Order matters: for michael, emitForAgent
    // prepends the always-on style card ahead of everything; then the
    // dynamic Current Moment block, then gate hints, then the retrieved
    // sessions block. Retrieval sections are XML-tagged so the model can
    // distinguish hook-injected material from the user's actual turn.
    const sections: string[] = [momentBlock(userId, agent, input)];
    if (gateBlock) sections.push(gateBlock);
    if (ctx) {
      sections.push(
        `<retrieved-context source="ahi-retrieval-hook">\n${ctx}\n</retrieved-context>`,
      );
    }
    emitForAgent(agent, sections.join("\n\n"));
  } catch (err) {
    process.stderr.write(
      `[ahi-retrieval] error agent=${agent} err=${(err as Error).message}\n`,
    );
    emitForAgent(agent, momentBlock(userId, agent, input));
  }
}

main().catch((err) => {
  process.stderr.write(
    `[ahi-retrieval] fatal err=${(err as Error).message}\n`,
  );
  // Emit time context rather than crashing the turn.
  const userId = process.env.AHI_USER_ID?.trim() || process.env.AHI_USER?.trim() || null;
  const agent = process.env.AHI_AGENT?.trim();
  if (agent) {
    emitForAgent(agent, momentBlock(userId, agent));
  } else {
    emitHookOutput(timeBlock(userId, null));
  }
  process.exit(0);
});
