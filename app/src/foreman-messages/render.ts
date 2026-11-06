/**
 * render.ts — the owner's two-and-a-half message kinds, rendered in code.
 *
 *   needs_operator → **I need you — <build>**      + the one question
 *   closed     → **Build closed — <build>**    + Finished / Result
 *   failed     → **Build failed — <build>**    + one plain sentence
 *                (went dark / stopped unexpectedly / stopped share the kind)
 *   progress   → nothing. It goes to the build's timeline, never the chat.
 *
 * Pure: no clock, no I/O, no randomness, no LLM. The same record yields the
 * same bytes — the golden tests pin that. No brackets, gate ids or paths can
 * appear: every prose field has passed record.ts's rails, and any field that
 * did not is replaced by a fixed fallback line rather than shown.
 *
 * There is no "no reply needed" anywhere in this file, and the reply-label rail
 * keeps an executor from smuggling one in. A needs_operator record has exactly one
 * rendering and it opens "I need you".
 */
import type { ParseResult, StatusRecord } from "./record.js";

export const FALLBACK = {
  question: "A question came in that only you can answer. Michael has the details and will bring it to you.",
  finished: "The details are with Michael.",
  failed: "It stopped before finishing. Michael has the details.",
} as const;

const FAILED_HEADER: Record<NonNullable<StatusRecord["cause"]>, string> = {
  error: "Build failed",
  abandoned: "Build stopped",
  dark: "Build went dark",
  died: "Build stopped unexpectedly",
};

/** "20261007-074552-foreman-messages" (or title "foreman-messages") → "foreman messages". */
export function displayName(rec: Pick<StatusRecord, "build" | "title">): string {
  const base = rec.title ?? rec.build.replace(/^\d{8}-\d{6}-/, "");
  const name = base.replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim();
  return name || "a build";
}

function sentence(s: string): string {
  return /[.!?…]$/.test(s) ? s : `${s}.`;
}

export function resultLine(checks: StatusRecord["checks"]): string {
  if (!checks) return "No check count was reported.";
  if (checks.total === 0) return "No checks were run.";
  if (checks.passed === checks.total) return `All ${checks.total} checks passed.`;
  return `${checks.passed} of ${checks.total} checks passed.`;
}

/**
 * The chat message for a parsed record, or null when the kind does not go to
 * chat. Takes the whole ParseResult so a field that failed its rails is never
 * rendered — the fallback line is used instead.
 */
export function renderForOperator(parsed: ParseResult): string | null {
  const rec = parsed.record;
  if (!parsed.ok || !rec) return null;
  const bad = parsed.textErrors;
  const name = displayName(rec);

  switch (rec.kind) {
    case "needs_operator": {
      const q = rec.question && !bad.question ? rec.question : FALLBACK.question;
      return `**I need you — ${name}**\n${q}`;
    }
    case "closed": {
      const finished = bad.finished ? FALLBACK.finished : sentence(rec.finished);
      return `**Build closed — ${name}**\nFinished: ${finished}\nResult: ${resultLine(rec.checks)}`;
    }
    case "failed": {
      const header = FAILED_HEADER[rec.cause ?? "error"];
      const body = bad.now ? FALLBACK.failed : sentence(rec.now);
      return `**${header} — ${name}**\n${body}`;
    }
    case "progress":
      return null;
  }
}

/**
 * Dedupe key for the chat message, or null when the kind does not go to chat.
 * "One close, once": a build's close renders once whichever path — the
 * executor's own closed record or the foreman's build_done — arrives first.
 * Failures split in two families so "went dark" and a later real failure are
 * each said once, and a repeated dark alarm is said once in total.
 */
export function chatKey(rec: StatusRecord): string | null {
  switch (rec.kind) {
    case "closed":
      return `closed:${rec.build}`;
    case "failed":
      return `failed:${rec.build}:${rec.cause === "dark" ? "dark" : "end"}`;
    case "needs_operator":
      return `ask:${rec.build}:${(rec.question ?? "").toLowerCase().replace(/\s+/g, " ")}`;
    case "progress":
      return null;
  }
}
