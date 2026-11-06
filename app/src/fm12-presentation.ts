/**
 * FM-12 build-message presentation — Gateway renderer and validator.
 *
 * Spec: foreman/specs/fm12-presentation-patch-spec.md, §§1-5.
 * Golden bytes: foreman/fixtures/fm12/*.golden.md — NORMATIVE, not illustrations.
 *
 * This is the second, independent implementation of the same contract. The first
 * is foreman/bin/fm_brief.py. Both are tested against the SAME fixture bytes, and
 * where a violation string is asserted by the shared fixture index the two
 * wordings are deliberately identical — that parity is the point: it is what
 * makes a drift between the two implementations a test failure rather than a
 * surprise on the owner's screen.
 *
 * BOUNDED BY CONSTRUCTION:
 *  - Self-contained. No gateway module is imported and none is modified. The only
 *    dependencies are node builtins, and only for the optional failure log.
 *  - Pure apart from that log. It renders strings and returns strings.
 *  - It binds ONLY the three declared formats (§6). An ordinary message never
 *    reaches it and is never bulleted, bolded or capped. Nothing here touches
 *    origin, routing, threading, authorship, retrieval or voice.
 *  - It writes no gateway state. The failure log path is explicit or injected;
 *    there is no default inside the gateway tree.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Fm12Format = "checkin" | "progress" | "decision";

export const FM12_FORMATS: readonly Fm12Format[] = ["checkin", "progress", "decision"];

/** §1 headers, byte-exact including the em dash. */
export const FM12_HEADER_TEXT: Record<"checkin" | "progress", string> = {
  checkin: "FOREMAN CHECK-IN — no reply needed",
  progress: "BUILD PROGRESS — no reply needed",
};

export const FM12_DECISION_HEADER_PREFIX = "DECISION REQUIRED — ";

/** Closed set, same as fm_brief.CATEGORIES. */
export const FM12_CATEGORIES: readonly string[] = ["authority", "scope", "tradeoff", "blocked"];

/** §2(4) fixed, complete field order. Labels carry no colon; the renderer puts
 *  the colon INSIDE the bold span. */
export const FM12_FIELDS: Record<Fm12Format, readonly string[]> = {
  checkin: [
    "Executor finished",
    "Executor stopped at",
    "Michael needs to inspect",
    "Next expected action",
  ],
  progress: ["Finished", "Now", "Michael's steer", "Acceptance"],
  decision: ["Why this stopped", "My recommendation", "Why you might choose differently"],
};

/** §2 field-name correction. Accepted on INBOUND PARSING ONLY, never emitted. */
export const FM12_LEGACY_INBOUND_LABELS: Record<string, string> = {
  "Why you might not": "Why you might choose differently",
};

/** §4 caps, in visible characters. A field's visible length is `Label: value`. */
export const FM12_CAP_FIELD_DEFAULT = 200;
export const FM12_CAP_FIELD: Record<string, number> = {
  "Why this stopped": 400,
  "My recommendation": 200,
  "Why you might choose differently": 200,
};
export const FM12_CAP_QUESTION = 120;
export const FM12_CAP_TOTAL = 900;

/** §2(8) sentence budget: exactly one, except `Why this stopped:`. */
const SENTENCE_BUDGET: Record<string, [number, number]> = { "Why this stopped": [1, 3] };
const SENTENCE_BUDGET_DEFAULT: [number, number] = [1, 1];

/** §5 the only thing the owner ever sees when rendering fails. */
export const FM12_SAFE_FALLBACK =
  "A build message came in that I could not render cleanly. " +
  "I have kept the full detail and will summarise it myself.";

const BULLET_RE = /^- \*\*([^*]+):\*\* (\S.*)$/;
const HEADER_RE = /^\*\*(.+)\*\*$/;
const EXACT_CHECKIN_HEADER_RE = /^\*\*FOREMAN CHECK-IN — no reply needed\*\*$/;
const EXACT_PROGRESS_HEADER_RE = /^\*\*BUILD PROGRESS — no reply needed\*\*$/;
const EXACT_DECISION_HEADER_RE = /^\*\*DECISION REQUIRED — ([^:*\n]+)\*\*$/;
const SENTENCE_END_RE = /[.!?](?=\s|$)/g;

export class Fm12PresentationError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(violations.join("; ") || "presentation rejected");
    this.name = "Fm12PresentationError";
    this.violations = violations;
  }
}

/* ── §3 content-exclusion rails ───────────────────────────────────────────────
 * Applied to FIELD VALUES and the DECISION QUESTION only — never the header,
 * which is fixed normative text. Rail ids and order mirror fm_brief.py exactly.
 * No rail may fire on the golden bytes: "format", "renders" and "wake-proof"
 * appear there and are therefore not bannable words. Only the specific
 * technical constructions are. */
export const FM12_CONTENT_RAILS: ReadonlyArray<{ id: string; re: RegExp; note: string }> = [
  { id: "path-absolute", re: /(?:^|[\s(\["'])~?\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]*)+/, note: "filesystem path" },
  {
    id: "path-relative",
    re: /(?<![A-Za-z0-9._-])(?!(?:and|or)\/(?:and|or)\b)[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/i,
    note: "relative filesystem path",
  },
  {
    id: "filename-extension",
    re: /\b[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9]{0,15}\b/,
    note: "bare filename with an extension",
  },
  {
    id: "timestamp-date",
    re: /\b\d{4}-\d{2}-\d{2}\b|\b\d{8}T\d{6}Z?\b|\b(?:mon|tue|wed|thu|fri|sat|sun)day\b\s*\d|\bUTC\b/i,
    note: "date or ISO timestamp",
  },
  { id: "clock-time", re: /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm|z)?\b/i, note: "clock time" },
  {
    id: "duration",
    re: /\b\d+(?:\.\d+)?\s*(?:s|ms|us|ns|sec|secs|second|seconds|min|mins|minute|minutes|h|hr|hrs|hour|hours|day|days|week|weeks)\b/i,
    note: "duration or elapsed counter",
  },
  {
    id: "hash-digest",
    re: /\b[0-9a-f]{7,64}\b/i,
    note: "hash, sha, digest or commit id",
  },
  {
    id: "internal-identifier",
    re: /\b\d{8}-\d{6}-[A-Za-z0-9-]+\b|\b[0-9a-f]{4,}-[0-9a-f]{4,}\b|\b(?:FM|F|R|G|S)-\d+\b|\bgate[- ]set\b|\b(?:item|ticket|gate|issue|job)\s*#?\s*\d+\b|\btmux\b|\b(?:session|pane|window|socket)\s+[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\b/i,
    note: "internal gate, build, item, ticket or session identifier",
  },
  {
    id: "internal-agent-name",
    re: /\b(?:(?:[Aa]gent|[Ee]xecutor|[Ss]ubagent|[Ff]oreman)\s+(?:(?:called|named)\s+)?[A-Z][a-z]+|Tzali|Miriam)\b/,
    note: "internal agent or session persona name",
  },
  { id: "marker-token", re: /\b[A-Z][A-Z0-9]+(?:[-_][A-Z0-9]+)+\b/, note: "internal marker or screaming-caps token" },
  {
    id: "diagnostics",
    re: /\b(?:traceback|stack ?trace|exit code|exit status|errno|stderr|stdout|segfault|core dump|byte|bytes|kib|mib|gib|kb|mb|gb|token|tokens|char|chars|characters|line count|loc|warnings?\b\s*:|assertion)\b/i,
    note: "diagnostics, counters or byte/token/line counts",
  },
  {
    id: "technical-evidence",
    re: /\b[A-Z]{2,8}\s+(?:OK|PASS(?:ED)?|FAIL(?:ED)?|ERROR|UP|DOWN|HEALTHY|UNHEALTHY)\b|\b(?:[Ss]tatus|[Hh]ealth|[Rr]esponse)\s*(?:code|=|:)\s*\d{3}\b/,
    note: "protocol, health or machine-status evidence",
  },
  {
    id: "usage-quota",
    re: /\b(?:usage|quota|weekly limit|rate ?limit|billing|billed|invoice|resets|budget|allowance)\b/i,
    note: "usage, quota, limit or billing line",
  },
  { id: "model-tier", re: /\b(?:opus|sonnet|haiku|gpt-?\d|claude|model tier|tier \d)\b/i, note: "model tier" },
  {
    id: "correction-history",
    re: /\b(?:correct(?:ed|ing|ion)|amend(?:ed|ing|ment)|retract(?:ed|ing|ion)|revis(?:e|ed|ing|ion)|as I said|as noted earlier|previously I|earlier I|I was wrong|to correct|restating|my mistake|prior (?:account|claim|statement|message|report)|earlier (?:account|claim|statement|message|report)|apologies|apologise|apologize)\b/i,
    note: "correction history",
  },
  {
    id: "process-narration",
    re: /\b(?:I will now|I am now going to|as instructed above|per my instructions|my context|this turn|my previous message|I re-?read|my own output|my earlier)\b/i,
    note: "self-referential process narration",
  },
  {
    id: "formatter-instruction",
    re: /\b(?:formatter|envelope|classifier|validator|ledger|briefing contract|golden fixture|fixture|rail)\b/i,
    note: "formatter, envelope or wake instruction",
  },
  {
    id: "raw-wake-text",
    re: /\(foreman wake|\(provenance:|\(FM-\d+:|full payload|Executor report\s+—|wake payload|foreman wake|went idle/i,
    note: "raw wake text",
  },
  {
    id: "command-or-flag",
    re: /(?:^|\s)--?[A-Za-z][\w-]*\b|\b(?:npm|npx|tsc|git|systemctl|journalctl|crontab|sudo|chmod|chown|grep|sed|awk|curl|wget|bash|python3?|node|pip|pkill|kill|mkdir|rmdir)\b(?![\w-])/,
    note: "command, flag or shell invocation",
  },
  { id: "env-var", re: /\$[A-Za-z_]\w*|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b[A-Z]{2,}=\S/, note: "environment variable" },
  {
    id: "code-literal",
    re: /`|<\/?[A-Za-z][^>]*>|\{\{|\b[a-z_][\w]*\(\)|::|=>|\{\}|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/,
    note: "code, markup, snake_case identifier or technical literal",
  },
];

/** §3: verified counts are permitted only in `Acceptance:`, and only as a plain count. */
const COUNT_FIELD = "Acceptance";
const DIGIT_RE = /\d/;
const PLAIN_COUNT_RE = /\d+\s*(?:%|\/)|\b\d+\s*(?:x|×)\b/;

/** Ids of every §3 rail this text trips. Empty array == clean. */
export function contentRailHits(text: string, field = ""): string[] {
  const hits: string[] = [];
  for (const rail of FM12_CONTENT_RAILS) {
    if (rail.re.test(text)) hits.push(rail.id);
  }
  if (DIGIT_RE.test(text)) {
    if (field !== COUNT_FIELD) hits.push("count-outside-acceptance");
    else if (PLAIN_COUNT_RE.test(text)) hits.push("count-not-plain");
  }
  return hits;
}

/* ── visible length (§4) ─────────────────────────────────────────────────────*/

export function visibleText(s: string): string {
  return s.split("**").join("");
}

/** R-A: "character" means Unicode code point, never UTF-16 code unit. */
export function codePointLength(s: string): number {
  return Array.from(s).length;
}

export function visibleFieldLen(label: string, value: string): number {
  // R-A: field caps use Unicode code points.
  return codePointLength(`${label}: ${value}`);
}

export function visibleMessage(msg: string): string {
  const lines = msg.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  return lines
    .map((ln) => {
      const v = visibleText(ln);
      return v.startsWith("- ") ? v.slice(2) : v;
    })
    .join("\n");
}

export function visibleMessageLen(msg: string): number {
  // R-A: the total-message cap uses the same Unicode-code-point definition.
  return codePointLength(visibleMessage(msg));
}

export function sentenceCount(value: string): number {
  const m = value.match(SENTENCE_END_RE);
  return m ? m.length : 0;
}

/* ── render (§1, §2) ─────────────────────────────────────────────────────────*/

export interface Fm12RenderInput {
  format: Fm12Format;
  fields: Record<string, string>;
  category?: string;
  question?: string;
  buildId?: string;
}

/**
 * Render one of the three binding formats and validate the bytes before
 * returning them. Output carries a single trailing newline, matching the golden
 * fixtures. Throws Fm12PresentationError rather than surfacing a malformed
 * message.
 */
export function renderPresentation(input: Fm12RenderInput): string {
  const { format, fields } = input;
  if (!FM12_FORMATS.includes(format)) {
    throw new Fm12PresentationError([`unknown format '${String(format)}'`]);
  }
  const labels = FM12_FIELDS[format];
  const missing = labels.filter((lb) => !String(fields?.[lb] ?? "").trim());
  if (missing.length) {
    throw new Fm12PresentationError(missing.map((lb) => `missing field '${lb}'`));
  }

  let header: string;
  if (format === "decision") {
    const cat = (input.category ?? "").trim();
    if (!FM12_CATEGORIES.includes(cat)) {
      throw new Fm12PresentationError([
        `category '${cat}' outside closed set ${FM12_CATEGORIES.join("|")}`,
      ]);
    }
    header = FM12_DECISION_HEADER_PREFIX + cat;
  } else {
    header = FM12_HEADER_TEXT[format];
  }

  const lines: string[] = [`**${header}**`, ""];
  for (const lb of labels) lines.push(`- **${lb}:** ${String(fields[lb]).trim()}`);

  if (format === "decision") {
    const q = (input.question ?? "").trim();
    if (!q) throw new Fm12PresentationError(["DECISION carries no question"]);
    lines.push("", q);
  }

  const msg = lines.join("\n") + "\n";
  const bad = validatePresentation(msg, format);
  if (bad.length) throw new Fm12PresentationError(bad);
  return msg;
}

/* ── validate (§2, §3, §4) ───────────────────────────────────────────────────*/

/** Which of the three formats this message declares itself to be, or null. */
export function detectPresentationFormat(msg: string): Fm12Format | null {
  let first = "";
  for (const ln of msg.replace(/\r\n/g, "\n").split("\n")) {
    if (ln.trim()) {
      first = ln;
      break;
    }
  }
  if (EXACT_CHECKIN_HEADER_RE.test(first)) return "checkin";
  if (EXACT_PROGRESS_HEADER_RE.test(first)) return "progress";
  if (EXACT_DECISION_HEADER_RE.test(first)) return "decision";
  return null;
}

/** True when the message is written in the §1 bold-bullet presentation form. */
export function isPresentationForm(msg: string): boolean {
  return detectPresentationFormat(msg) !== null;
}

/**
 * Every violation of §2, §3 and §4, in order. Empty array == ACCEPTED.
 * The list is diagnostic only: §5(1) forbids surfacing it.
 */
export function validatePresentation(msg: string, format?: Fm12Format | null): string[] {
  const bad: string[] = [];
  if (typeof msg !== "string" || !msg.trim()) return ["empty message"];

  const text = msg.replace(/\r\n/g, "\n");
  let body: string;
  if (!text.endsWith("\n")) {
    bad.push("message must end with exactly one newline");
    body = text;
  } else {
    body = text.slice(0, -1);
    if (body.endsWith("\n")) {
      bad.push("message must end with exactly one newline");
      body = body.replace(/\n+$/, "");
    }
  }

  const lines = body.split("\n");
  if (lines.length && lines[0] !== lines[0].trim()) bad.push("nothing may precede the header");
  if (lines.length && lines[0].trim() === "") bad.push("nothing may precede the header");
  if (lines.length && lines[lines.length - 1].trim() === "") {
    bad.push("nothing may follow the last field");
  }
  lines.forEach((ln, i) => {
    if (ln !== ln.replace(/\s+$/, "")) bad.push(`line ${i + 1} carries trailing whitespace`);
  });

  const detected = detectPresentationFormat(body);
  const fmt: Fm12Format | null = format ?? detected;
  if (!fmt || !FM12_FORMATS.includes(fmt)) {
    return [...bad, "message is not one of the three binding formats"];
  }
  if (detected !== null && detected !== fmt) {
    bad.push(`header declares '${detected}' but '${fmt}' was expected`);
  }

  const labels = FM12_FIELDS[fmt];

  // §2(1) header is bold, on its own line, byte-exact including the em dash.
  const headerLine = lines.length ? lines[0] : "";
  const hm = HEADER_RE.exec(headerLine);
  let inner = headerLine;
  if (!hm) bad.push("header must be bold on its own line: '**…**'");
  else inner = hm[1];

  if (fmt === "decision") {
    if (!inner.startsWith(FM12_DECISION_HEADER_PREFIX)) {
      bad.push(`header must be '**${FM12_DECISION_HEADER_PREFIX}<category>**'`);
    } else {
      const cat = inner.slice(FM12_DECISION_HEADER_PREFIX.length);
      if (!FM12_CATEGORIES.includes(cat)) {
        bad.push(`category '${cat}' outside closed set ${FM12_CATEGORIES.join("|")}`);
      }
    }
  } else {
    const want = FM12_HEADER_TEXT[fmt];
    if (inner !== want) bad.push(`header must be exactly '${want}', found '${inner}'`);
    // §2(5) CHECK-IN and PROGRESS carry no category, ever.
    if (inner.startsWith(want.split(" — ")[0]) && inner !== want) {
      bad.push("this format carries no category; category belongs to DECISION alone");
    }
  }

  // §2(2) one blank line after the header, one before a Decision's question.
  // §2(9) nothing else, anywhere.
  const expectLen = 2 + labels.length + (fmt === "decision" ? 2 : 0);
  if (lines.length !== expectLen) {
    bad.push(`expected exactly ${expectLen} lines, found ${lines.length}`);
  }
  if (lines.length > 1 && lines[1] !== "") {
    bad.push("exactly one blank line must follow the header");
  }

  // §2(3)(4) bullets, bold label, colon inside the bold span, fixed order.
  const values = new Map<string, string>();
  labels.forEach((lb, i) => {
    const idx = 2 + i;
    if (idx >= lines.length) {
      bad.push(`missing field '${lb}'`);
      return;
    }
    const ln = lines[idx];
    const bm = BULLET_RE.exec(ln);
    if (!bm) {
      const legacy = Object.keys(FM12_LEGACY_INBOUND_LABELS).find(
        (k) => ln.includes(`**${k}:**`) || ln.startsWith(`- ${k}:`),
      );
      if (legacy) {
        bad.push(
          `field '${legacy}' is the legacy inbound spelling; the binding name is ` +
            `'${FM12_LEGACY_INBOUND_LABELS[legacy]}'`,
        );
      } else {
        bad.push(`field ${i + 1} must read '- **${lb}:** <text>', found '${ln.slice(0, 48)}'`);
      }
      return;
    }
    const got = bm[1];
    const value = bm[2];
    if (got in FM12_LEGACY_INBOUND_LABELS) {
      bad.push(
        `field '${got}' is the legacy inbound spelling; the binding name is ` +
          `'${FM12_LEGACY_INBOUND_LABELS[got]}'`,
      );
      return;
    }
    if (got !== lb) {
      bad.push(`field ${i + 1} must be '${lb}', found '${got}'`);
      return;
    }
    values.set(lb, value);
  });

  let question = "";
  if (fmt === "decision" && lines.length === expectLen) {
    if (lines[lines.length - 2] !== "") {
      bad.push("exactly one blank line must precede the question");
    }
    question = lines[lines.length - 1];
    if (question !== question.trim() || !question.trim()) {
      bad.push("the question must be a single plain line");
    }
  }

  // §2(6)(7) the '?' rails.
  const nQ = (body.match(/\?/g) ?? []).length;
  if (fmt === "decision") {
    if (nQ !== 1) bad.push(`DECISION must contain exactly one '?', found ${nQ}`);
    else if (!lines[lines.length - 1].endsWith("?")) {
      bad.push("the single '?' must terminate the final line");
    }
    for (const [lb, v] of values) {
      if (v.includes("?")) {
        bad.push(`field '${lb}' asks a question; the question is its own final line`);
      }
    }
  } else if (nQ) {
    bad.push(`${fmt} must contain zero '?' characters, found ${nQ}`);
  }

  // §2(8) sentence budget, §4 caps, §3 content rails.
  for (const lb of labels) {
    const v = values.get(lb);
    if (v === undefined) continue;
    const [lo, hi] = SENTENCE_BUDGET[lb] ?? SENTENCE_BUDGET_DEFAULT;
    const nS = sentenceCount(v);
    if (nS < lo || nS > hi) {
      const want = lo === hi ? `${lo}` : `${lo} to ${hi}`;
      bad.push(`field '${lb}' must be ${want} sentence(s), found ${nS}`);
    }
    if (!v.endsWith(".") && !v.endsWith("!")) {
      bad.push(`field '${lb}' must end in a full stop`);
    }
    const cap = FM12_CAP_FIELD[lb] ?? FM12_CAP_FIELD_DEFAULT;
    // R-A: every field cap counts Unicode code points.
    const nV = visibleFieldLen(lb, v);
    if (nV > cap) bad.push(`field '${lb}' is ${nV} visible chars, cap is ${cap}`);
    for (const rail of contentRailHits(v, lb)) {
      bad.push(`field '${lb}' trips content rail ${rail}`);
    }
  }

  if (fmt === "decision" && question) {
    // R-A: question cap counts Unicode code points, not UTF-16 units.
    const questionLength = codePointLength(question);
    if (questionLength > FM12_CAP_QUESTION) {
      bad.push(`question is ${questionLength} visible chars, cap is ${FM12_CAP_QUESTION}`);
    }
    for (const rail of contentRailHits(question)) {
      bad.push(`question trips content rail ${rail}`);
    }
  }

  const total = visibleMessageLen(text);
  if (total > FM12_CAP_TOTAL) {
    bad.push(`total visible message is ${total} chars, cap is ${FM12_CAP_TOTAL}`);
  }

  const seen = new Set<string>();
  return bad.filter((b) => (seen.has(b) ? false : (seen.add(b), true)));
}

/* ── §5 failure behaviour ────────────────────────────────────────────────────*/

export interface Fm12FailureRecord {
  ts: string;
  build_id: string;
  event: "fm12-presentation-rejected";
  format_declared?: Fm12Format | null;
  format_detected?: Fm12Format | null;
  fields?: Record<string, string>;
  category?: string;
  question?: string;
  raw?: string;
  violations: string[];
  tool: string;
}

export type Fm12LogSink = (record: Fm12FailureRecord) => void;

export const FM12_TOOL = "fm12-presentation/1.0 (gateway)";

/**
 * Default failure sink. Writes one JSON line to `FM12_PRESENTATION_LOG` if that
 * is set, otherwise to the OS temp directory.
 *
 * It deliberately has NO default inside the gateway tree: gateway state files
 * are cached and whole-file-rewritten by the service and must never be written
 * from outside it (spec §6). Wire the real log path in via the env var or pass
 * your own sink.
 */
function durableAppend(path: string, record: Fm12FailureRecord): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch {
    /* directory already exists, or the open below will report the failure */
  }
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, JSON.stringify(record) + "\n", undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function defaultFm12Sink(record: Fm12FailureRecord): void {
  const path = process.env.FM12_PRESENTATION_LOG || join(tmpdir(), "fm12-presentation.jsonl");
  durableAppend(path, record);
}

/** Separate durable journal for a failed primary sink (D5). */
export function defaultFm12EmergencySink(record: Fm12FailureRecord): void {
  const path =
    process.env.FM12_PRESENTATION_EMERGENCY_LOG ||
    join("/var/tmp", "ahi-fm12-presentation-emergency.jsonl");
  // Deliberately do not call durableAppend(): the secondary must not share the
  // primary's implementation failure mode.  It owns its open/write/fsync/close
  // path as well as a separate default directory.
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch {
    /* directory already exists, or the independent open reports the failure */
  }
  const fd = openSync(path, "a", 0o600);
  try {
    const line = Buffer.from(JSON.stringify(record) + "\n", "utf8");
    writeSync(fd, line, 0, line.length);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function retainFailure(
  record: Fm12FailureRecord,
  primary: Fm12LogSink,
  emergency: Fm12LogSink,
): void {
  try {
    primary(record);
    return;
  } catch {
    /* the independent durable sink owns the retry */
  }
  try {
    emergency(record);
  } catch {
    /* §5(4): even two failed sinks may not crash the caller */
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Render, or return the §5 safe fallback. NEVER throws and never leaks: the raw
 * payload, the offending text and the violation list go to the internal log
 * only, and the owner sees one plain line saying detail was kept.
 */
export function safePresent(
  input: Fm12RenderInput,
  sink: Fm12LogSink = defaultFm12Sink,
  emergencySink: Fm12LogSink = defaultFm12EmergencySink,
): string {
  try {
    return renderPresentation(input);
  } catch (err) {
    const violations =
      err instanceof Fm12PresentationError ? err.violations : [String(err)];
    const record: Fm12FailureRecord = {
      ts: nowIso(),
      build_id: input.buildId || "unattributed",
      event: "fm12-presentation-rejected",
      format_declared: input.format ?? null,
      fields: input.fields ?? {},
      category: input.category ?? "",
      question: input.question ?? "",
      violations,
      tool: FM12_TOOL,
    };
    retainFailure(record, sink, emergencySink);
    return FM12_SAFE_FALLBACK;
  }
}

export interface Fm12GateResult {
  text: string;
  accepted: boolean;
  violations: string[];
}

/**
 * Gate an already-rendered message on its way to the surface.
 * Accepted → the bytes unchanged. Rejected → the §5 fallback, record logged.
 */
export function safeValidate(
  msg: string,
  format?: Fm12Format | null,
  opts: { buildId?: string; sink?: Fm12LogSink; emergencySink?: Fm12LogSink } = {},
): Fm12GateResult {
  const detected = detectPresentationFormat(msg);
  // R-B: only a detected FM-12 format is normalised. Ordinary prose remains
  // byte-identical and never reaches this function through gateBuildMessage.
  const candidate = detected === null ? msg : msg.replace(/\r\n/g, "\n");
  let violations: string[];
  try {
    violations = validatePresentation(candidate, format);
  } catch (err) {
    violations = [String(err)];
  }
  if (!violations.length) return { text: candidate, accepted: true, violations: [] };
  const record: Fm12FailureRecord = {
    ts: nowIso(),
    build_id: opts.buildId || "unattributed",
    event: "fm12-presentation-rejected",
    format_declared: format ?? null,
    format_detected: detected,
    raw: msg,
    violations,
    tool: FM12_TOOL,
  };
  retainFailure(
    record,
    opts.sink ?? defaultFm12Sink,
    opts.emergencySink ?? defaultFm12EmergencySink,
  );
  return { text: FM12_SAFE_FALLBACK, accepted: false, violations };
}

/* ── inbound (§3) ────────────────────────────────────────────────────────────
 * "Everything in it that is not plain English must be stripped before the owner sees
 * anything." Line-level chrome first, then SENTENCE-level filtering: a sentence
 * that trips any §3 rail is withheld whole. Withholding is not destruction —
 * the raw payload is already in the foreman ledger, byte-identical. */

const INBOUND_NOISE_LINE_RE =
  /^\s*(?:\(foreman wake\b|\(provenance:|\(FM-\d+:|full payload:|Executor report\s+—|The \S+ build session|You'?ve used \d|#FMBRIEF|\[FM-12 )/i;

const GATE_STANDARD_RE = /^\s*\(gate-reconcile[^)]*\)\s*$/gim;

export interface Fm12Inbound {
  format: Fm12Format | null;
  category: string;
  fields: Record<string, string>;
  question: string;
}

/**
 * Parse an inbound message in either the presentation or the legacy plain form,
 * tolerating the legacy `Why you might not:` spelling. Returned field keys are
 * CANONICAL — the legacy spelling is normalised here and never emitted again.
 */
export function parseInbound(msg: string): Fm12Inbound {
  let format = detectPresentationFormat(msg);
  let category = "";
  const fields: Record<string, string> = {};
  let question = "";

  const nonblank = msg
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((ln) => ln.replace(/\s+$/, ""))
    .filter((ln) => ln.trim() !== "");

  // Legacy plain headers are an inbound-parser compatibility only. They do
  // not broaden the wire detector, whose exact bold grammar is binding (D2).
  if (format === null && nonblank.length) {
    const head = nonblank[0].trim();
    if (head === FM12_HEADER_TEXT.checkin) format = "checkin";
    else if (head === FM12_HEADER_TEXT.progress) format = "progress";
    else if (/^DECISION REQUIRED — [^:*\n]+$/.test(head)) format = "decision";
  }

  if (nonblank.length) {
    const head = nonblank[0].trim();
    const hm = HEADER_RE.exec(head);
    const inner = hm ? hm[1].trim() : head;
    if (inner.startsWith(FM12_DECISION_HEADER_PREFIX)) {
      category = inner.slice(FM12_DECISION_HEADER_PREFIX.length).trim();
    }
  }

  const known = [
    ...(format ? FM12_FIELDS[format] : []),
    ...Object.keys(FM12_LEGACY_INBOUND_LABELS),
  ];

  for (const raw of nonblank.slice(1)) {
    const s = raw.trim();
    let label: string | undefined;
    let value = "";
    const bm = BULLET_RE.exec(s);
    if (bm) {
      label = bm[1];
      value = bm[2];
    } else {
      const s2 = visibleText(s.startsWith("- ") ? s.slice(2).trim() : s);
      const hit = known.find((k) => s2.startsWith(k + ":"));
      if (!hit) {
        if (s.endsWith("?")) question = s;
        continue;
      }
      label = hit;
      value = s2.slice(hit.length + 1).trim();
    }
    label = FM12_LEGACY_INBOUND_LABELS[label] ?? label;
    fields[label] = value;
  }

  if (!question) {
    for (let i = nonblank.length - 1; i >= 0; i -= 1) {
      if (nonblank[i].trim().endsWith("?")) {
        question = nonblank[i].trim();
        break;
      }
    }
  }
  return { format, category, fields, question };
}

/**
 * Reduce a raw wake payload to clean plain English, or "" if nothing surfaceable
 * survives. The result is guaranteed to trip zero §3 rails.
 */
export function stripInbound(raw: string): string {
  const text = raw.replace(/\r\n/g, "\n").replace(GATE_STANDARD_RE, "");
  const kept: string[] = [];
  let depth = 0; // a noise parenthetical may wrap onto following lines
  for (const ln of text.split("\n")) {
    const s = ln.trim();
    if (!s) continue;
    if (depth > 0) {
      depth += (s.match(/\(/g) ?? []).length - (s.match(/\)/g) ?? []).length;
      continue;
    }
    if (INBOUND_NOISE_LINE_RE.test(s)) {
      if (s.startsWith("(")) {
        depth = Math.max(0, (s.match(/\(/g) ?? []).length - (s.match(/\)/g) ?? []).length);
      }
      continue;
    }
    kept.push(s);
  }
  const paragraph = kept.join(" ").replace(/\s+/g, " ").trim();
  if (!paragraph) return "";

  const out: string[] = [];
  for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
    const s = sentence.trim();
    if (!s) continue;
    if (s.startsWith("…") || s.startsWith("...")) continue; // truncated fragment
    if (!s.endsWith(".") && !s.endsWith("!")) continue; // no terminator: fragment
    if (contentRailHits(s).length) continue; // withheld, not destroyed
    out.push(s);
  }
  return out.join(" ");
}
