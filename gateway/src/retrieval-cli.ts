#!/usr/bin/env node
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

import { getRelevantContext } from "./retrieval.js";
// H-034 — pre-pass that translates English keywords on the live turn into
// {shaar, shoresh} coordinates so we can (a) surface those gates to the
// agent as machine-readable hints (it can then call `Skill(memory-fetch)`
// to lazy-load deeper material at that address) and (b) bias scoring
// toward sessions sharing the same address. Address book lives in
// `./shaar-shoresh.ts` — a TS port of the canonical JS module at
// `$AHI_HOME/gateway/src/shaar-shoresh.ts`. Both
// versions intentionally redundant so the gateway build doesn't reach
// outside the source tree, and the enrichment script doesn't depend on
// dist artefacts. They MUST be kept in sync; document if you edit one.
import { gatesForQuery, formatGateHints } from "./shaar-shoresh.js";

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

async function main(): Promise<void> {
  const started = Date.now();
  const agent = process.env.AHI_AGENT?.trim();

  if (!agent) {
    // No agent — we can't do retrieval. Don't fail the turn; just emit empty
    // context and a stderr marker so we can see it in the transcript.
    process.stderr.write("[ahi-retrieval] skipped reason=no-AHI_AGENT\n");
    emitHookOutput("");
    return;
  }

  let raw = "";
  try {
    raw = await readStdin();
  } catch (err) {
    process.stderr.write(
      `[ahi-retrieval] stdin-read-error agent=${agent} err=${(err as Error).message}\n`,
    );
    emitHookOutput("");
    return;
  }

  let input: HookInput = {};
  try {
    input = raw.trim() ? (JSON.parse(raw) as HookInput) : {};
  } catch (err) {
    process.stderr.write(
      `[ahi-retrieval] stdin-parse-error agent=${agent} err=${(err as Error).message}\n`,
    );
    emitHookOutput("");
    return;
  }

  const prompt = (input.prompt ?? "").trim();
  if (!prompt) {
    process.stderr.write(
      `[ahi-retrieval] skipped reason=empty-prompt agent=${agent}\n`,
    );
    emitHookOutput("");
    return;
  }

  try {
    // H-034 pre-pass — substring scan against the address book. Cheap (no
    // spawn, no async), runs ahead of the index-scan so we can log the
    // gate hits even if recent-context retrieval finds nothing.
    const prepassStart = Date.now();
    const gateHits = gatesForQuery(prompt);
    const prepassMs = Date.now() - prepassStart;
    const gateBlock = formatGateHints(gateHits);

    const ctxRaw = await getRelevantContext(agent, prompt);
    const ctx = (ctxRaw ?? "").trim();
    const sessionCount = ctx
      ? ctx.split("\n").filter((l) => l.startsWith("### ")).length
      : 0;

    const ms = Date.now() - started;
    const gateAddrs = gateHits.map((h) => `${h.shaar}/${h.shoresh}`).join(",") || "none";
    process.stderr.write(
      `[ahi-retrieval] fired agent=${agent} sessions=${sessionCount} ` +
        `chars=${ctx.length} ms=${ms} ` +
        `prepass_ms=${prepassMs} gates=${gateAddrs}\n`,
    );

    // Compose the hook output. Order matters: gate hints come first
    // (they're tiny and tell the agent what to ask for next), then the
    // retrieved sessions block. Each section is XML-tagged so the model
    // can distinguish hook-injected material from the user's actual turn.
    const sections: string[] = [];
    if (gateBlock) sections.push(gateBlock);
    if (ctx) {
      sections.push(
        `<retrieved-context source="ahi-retrieval-hook">\n${ctx}\n</retrieved-context>`,
      );
    }
    emitHookOutput(sections.join("\n\n"));
  } catch (err) {
    process.stderr.write(
      `[ahi-retrieval] error agent=${agent} err=${(err as Error).message}\n`,
    );
    emitHookOutput("");
  }
}

main().catch((err) => {
  process.stderr.write(
    `[ahi-retrieval] fatal err=${(err as Error).message}\n`,
  );
  // Emit empty context rather than crashing the turn.
  emitHookOutput("");
  process.exit(0);
});
