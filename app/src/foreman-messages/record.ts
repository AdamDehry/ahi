/**
 * record.ts — the structured build-status record (build-order #3).
 *
 * An executor no longer reports in prose that an LLM re-renders. It writes one
 * small record; the foreman forwards it; this module validates it and
 * render.ts turns it into the owner's message in code. Same record in, same bytes out.
 *
 *   kind       progress | needs_operator | closed | failed
 *   finished   one line — what is actually done
 *   now        one line — what is happening / where it stands
 *   checks     { passed, total } as MEASURED by the executor, or null
 *   question   exactly one question — needs_operator only, and required there
 *   cause      failed only: error | dark | died | abandoned (default error)
 *
 * Twin implementation: foreman/bin/fm_status.py validates the same contract at
 * write time, so a bad line is refused while the executor can still fix it.
 * Both run the shared fixture test/fixtures/foreman-messages/rails.json — a
 * drift between them is a test failure, not a surprise in the owner's chat.
 *
 * Two classes of error, deliberately:
 *  - STRUCTURAL (bad kind, build id, record id, checks shape): the record cannot
 *    be rendered at all and is refused (HTTP 422). The forwarder still wakes
 *    Michael with the raw record, so nothing goes dark.
 *  - TEXT (a prose field trips a rail or a length cap): the record is kept and
 *    the field is replaced by a fixed fallback line at render time. A messy
 *    question can cost wording; it can never cost the "I need you".
 */

export const RECORD_VERSION = 1;

export const KINDS = ["progress", "needs_operator", "closed", "failed"] as const;
export type StatusKind = (typeof KINDS)[number];

export const CAUSES = ["error", "dark", "died", "abandoned"] as const;
export type FailCause = (typeof CAUSES)[number];

export const SOURCES = ["executor", "foreman", "michael"] as const;
export type RecordSource = (typeof SOURCES)[number];

/** Kinds that reach the owner's chat. progress never does. */
export const CHAT_KINDS: ReadonlySet<StatusKind> = new Set(["needs_operator", "closed", "failed"]);

export interface StatusRecord {
  v: 1;
  id: string;
  build: string;
  title: string | null;
  kind: StatusKind;
  finished: string;
  now: string;
  checks: { passed: number; total: number } | null;
  question: string | null;
  cause: FailCause | null;
  source: RecordSource;
  at: string | null;
}

export type TextField = "finished" | "now" | "question" | "title";

export interface ParseResult {
  ok: boolean;
  record: StatusRecord | null;
  /** Structural problems — non-empty means ok=false and record=null. */
  errors: string[];
  /** Prose problems per field — the record survives, the field falls back. */
  textErrors: Partial<Record<TextField, string[]>>;
}

export const BUILD_ID_RE = /^\d{8}-\d{6}-[a-z0-9][a-z0-9._-]{0,80}$/;
export const RECORD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,120}$/;

export const CAP_LINE = 200;
export const CAP_QUESTION = 300;
export const CAP_TITLE = 60;
export const CAP_CHECKS = 100_000;

/**
 * Text rails. Narrow on purpose: they ban what the brief bans (brackets, gate
 * ids, paths) plus the plumbing that rides with them, and nothing a plain
 * sentence needs. Order and ids are mirrored in fm_status.py.
 */
export const TEXT_RAILS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "newline", re: /[\r\n\u2028\u2029]/ },
  { id: "control-char", re: /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ },
  { id: "bracket", re: /[()[\]{}<>]/ },
  { id: "markup", re: /[`*_#|\\]/ },
  { id: "url", re: /[a-z][a-z0-9+.-]*:\/\//i },
  { id: "path-absolute", re: /(?:^|[\s"'=:,;])~?\/[A-Za-z0-9._-]+/ },
  { id: "path-relative", re: /[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/|\b[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9]{0,5}\b/ },
  { id: "gate-id", re: /\b(?:FM|F|R|G|D|S|RA|SR|MC)-\d+[A-Za-z]?\b|\bgate[- ]?set\b|\bG\d\b/i },
  { id: "build-id", re: /\b\d{8}-\d{6}\b/ },
  { id: "hash", re: /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/i },
  { id: "env-var", re: /\$[A-Za-z_{]/ },
  { id: "reply-label", re: /\bno reply needed\b|\bno reply required\b|\breply in this format\b/i },
];

/** Rail ids this text trips, in rail order. Empty == clean. */
export function railHits(text: string): string[] {
  return TEXT_RAILS.filter((r) => r.re.test(text)).map((r) => r.id);
}

/** Collapse runs of spaces/tabs and trim. Newlines are NOT collapsed — they are a rail hit. */
export function normalizeLine(s: string): string {
  return s.replace(/[ \t ]+/g, " ").trim();
}

function codePoints(s: string): number {
  return [...s].length;
}

function lineErrors(value: string, cap: number): string[] {
  const errs: string[] = [];
  if (!value) errs.push("empty");
  if (codePoints(value) > cap) errs.push(`longer than ${cap} characters`);
  for (const id of railHits(value)) errs.push(`rail:${id}`);
  return errs;
}

export function questionErrors(q: string): string[] {
  const errs = lineErrors(q, CAP_QUESTION);
  const marks = (q.match(/\?/g) ?? []).length;
  if (q && !q.endsWith("?")) errs.push("must end with ?");
  if (marks > 1) errs.push("more than one question");
  return errs;
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

const KNOWN_FIELDS = new Set([
  "v", "id", "build", "title", "kind", "finished", "now", "checks", "question", "cause", "source", "at",
]);

/**
 * Validate an incoming record. Never throws. Unknown fields are a structural
 * error: a field nobody validates is a field somebody will start trusting.
 */
export function parseRecord(input: unknown): ParseResult {
  const errors: string[] = [];
  const textErrors: Partial<Record<TextField, string[]>> = {};
  if (!isObj(input)) return { ok: false, record: null, errors: ["record must be a JSON object"], textErrors };

  for (const k of Object.keys(input)) if (!KNOWN_FIELDS.has(k)) errors.push(`unknown field: ${k}`);
  if (input.v !== RECORD_VERSION) errors.push(`v must be ${RECORD_VERSION}`);

  const id = input.id;
  if (typeof id !== "string" || !RECORD_ID_RE.test(id)) errors.push("id missing or malformed");
  const build = input.build;
  if (typeof build !== "string" || !BUILD_ID_RE.test(build)) errors.push("build id missing or malformed");
  const kind = input.kind;
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
    errors.push(`kind must be one of ${KINDS.join(", ")}`);
  }
  const source = input.source ?? "executor";
  if (typeof source !== "string" || !(SOURCES as readonly string[]).includes(source)) {
    errors.push(`source must be one of ${SOURCES.join(", ")}`);
  }

  let checks: StatusRecord["checks"] = null;
  if (input.checks !== undefined && input.checks !== null) {
    const c = input.checks;
    if (
      isObj(c) &&
      Object.keys(c).every((k) => k === "passed" || k === "total") &&
      Number.isInteger(c.passed) &&
      Number.isInteger(c.total) &&
      (c.passed as number) >= 0 &&
      (c.total as number) >= 0 &&
      (c.passed as number) <= (c.total as number) &&
      (c.total as number) <= CAP_CHECKS
    ) {
      checks = { passed: c.passed as number, total: c.total as number };
    } else {
      errors.push("checks must be {passed, total} integers with 0 <= passed <= total");
    }
  }

  let cause: FailCause | null = null;
  if (input.cause !== undefined && input.cause !== null) {
    if (kind !== "failed") errors.push("cause is only allowed on kind failed");
    else if (typeof input.cause === "string" && (CAUSES as readonly string[]).includes(input.cause)) cause = input.cause as FailCause;
    else errors.push(`cause must be one of ${CAUSES.join(", ")}`);
  } else if (kind === "failed") {
    cause = "error";
  }

  const str = (k: string): string | null => {
    const v = input[k];
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") {
      errors.push(`${k} must be a string`);
      return null;
    }
    return normalizeLine(v);
  };

  const finished = str("finished") ?? "";
  const now = str("now") ?? "";
  const question = str("question");
  const titleRaw = str("title");
  const at = str("at");

  // The question belongs to needs_operator and to nothing else. A question on a
  // progress record would be a reply request rendered nowhere; refusing it
  // makes the executor pick the kind that reaches the owner.
  if (kind === "needs_operator" && !question) errors.push("needs_operator requires a question");
  if (kind !== "needs_operator" && question) errors.push("question is only allowed on kind needs_operator");

  const fe = lineErrors(finished, CAP_LINE);
  if (fe.length) textErrors.finished = fe;
  const ne = lineErrors(now, CAP_LINE);
  if (ne.length) textErrors.now = ne;
  if (question) {
    const qe = questionErrors(question);
    if (qe.length) textErrors.question = qe;
  }
  let title: string | null = titleRaw || null;
  if (title) {
    const te = lineErrors(title, CAP_TITLE);
    if (te.length) {
      textErrors.title = te;
      title = null; // display name falls back to the build id's slug
    }
  }

  if (errors.length) return { ok: false, record: null, errors, textErrors };
  return {
    ok: true,
    errors,
    textErrors,
    record: {
      v: 1,
      id: id as string,
      build: build as string,
      title,
      kind: kind as StatusKind,
      finished,
      now,
      checks,
      question: question ?? null,
      cause,
      source: source as RecordSource,
      at: at ?? null,
    },
  };
}
