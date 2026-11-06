/**
 * answer.ts — the owner's answer in the app clears the build's question.
 *
 * A Builds card asks while the newest record of one of its runs is a
 * needs_operator, and only a LATER record from that run clears it. "Answer in
 * thread" quotes the question into Michael's composer; the message he sends
 * reaches Michael exactly as before. When that send carries the asking run's
 * id, the gateway ALSO runs foreman/bin/build_answered.sh — the same script
 * Michael runs by hand — which posts the one later record ("the owner answered the
 * question.", his answer as `now`) through fm_status.py and /foreman/status,
 * and logs an `answered` event on the build. One record shape, one writer.
 *
 * Clears only on a real answer: the send must carry the run id (the app only
 * attaches it when the quoted question is still in the sent text), the text
 * must hold something beyond the quote, and that run's newest record must
 * still be a needs_operator. A failed post leaves the card asking and is logged;
 * the message to Michael was already delivered.
 *
 * Side effects arrive as injected deps, so this runs in tests with no gateway.
 */
import { spawn } from "node:child_process";
import { BUILD_ID_RE, CAP_LINE, RECORD_ID_RE, railHits } from "./record.js";
import type { TimelineEntry } from "./timeline.js";
import { unshieldChild } from "../lifecycle.js";

/** Default writer: the foreman's own script, from the live checkout. */
export const DEFAULT_ANSWERED_SCRIPT = process.env.FOREMAN_ANSWERED_SCRIPT || `${process.env.AHI_HOME || process.env.HOME || ""}/AHI/AHI_OS/foreman/bin/build_answered.sh`;

/** The `now` line when his words can't ride as one plain line (only a link, a path, code). */
export const ANSWER_FALLBACK = "His answer is in Michael's thread.";

/** Questions one send may answer (one per quoted question; more is not a person typing). Mirrored in web/src/store.ts. */
export const MAX_ANSWERS = 5;

// Whole words that can never pass a rail — dropped, the rest of the sentence stays.
const TOKEN_RAILS = new Set(["url", "path-absolute", "path-relative", "gate-id", "build-id", "hash", "env-var"]);

/**
 * His sent text → one plain line for the record's `now`, or null when there is
 * no answer in it (only the quoted question). Quoted lines go; the rest is
 * folded to one line, rail-breaking characters and words are dropped, and the
 * line is cut at a word under fm_status's 200-character cap. Whatever comes
 * out passes the same rails build_answered.sh checks — or becomes the fallback.
 */
export function answerLine(text: string): string | null {
  const own = String(text ?? "")
    .split(/\r\n|[\r\n\u2028\u2029]/)
    .filter((l) => !/^\s*>/.test(l))
    .join(" ");
  if (!own.trim()) return null;
  let s = own
    .replace(/[\u0000-\u001f\u007f\u0085\u00a0\u2000-\u200b\u202f\u205f\u3000\ufeff]/g, " ")
    .replace(/[()[\]{}<>`*_#|\\]/g, " ");
  s = s
    .split(/\s+/)
    .filter((w) => w && !railHits(w).some((r) => TOKEN_RAILS.has(r)))
    .join(" ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(s)) return ANSWER_FALLBACK;
  s = cut(s, CAP_LINE);
  return railHits(s).length ? ANSWER_FALLBACK : s;
}

/** At most `cap` code points, cut at a word, an ellipsis when cut. */
function cut(s: string, cap: number): string {
  const cps = [...s];
  if (cps.length <= cap) return s;
  const head = cps.slice(0, cap - 1).join("");
  const sp = head.lastIndexOf(" ");
  return `${(sp > cap / 2 ? head.slice(0, sp) : head).replace(/[\s,.;:!?-]+$/, "")}…`;
}

/** The id of the build's newest status record when it is a needs_owner (the card is asking), else null. */
export function openQuestionId(entries: TimelineEntry[]): string | null {
  const recs: Array<{ at: number; i: number; kind: string; id: string }> = [];
  entries.forEach((e, i) => {
    if (e.type === "record" && e.record) recs.push({ at: Date.parse(e.record.at ?? e.ts) || 0, i, kind: e.record.kind, id: e.record.id });
  });
  recs.sort((a, b) => a.at - b.at || a.i - b.i);
  const last = recs[recs.length - 1];
  return last?.kind === "needs_operator" ? last.id : null;
}

/** True while the build's newest status record is a needs_operator — the card is asking. */
export function hasOpenQuestion(entries: TimelineEntry[]): boolean {
  return openQuestionId(entries) !== null;
}

/**
 * One answer a send carries: the run that asked, the exact needs_operator record it
 * answers (P2a — a stale answer must never clear a newer question), and the
 * words he ADDED (P2b — the draft before the quote and the quote itself are
 * not an answer; the app works that out, it knows the draft).
 */
export interface AppAnswer {
  build: string;
  record: string;
  added: string;
}

/** What a send says it answers — well-formed, one per run, at most MAX_ANSWERS; the rest is reported, not hidden. */
export function parseAnswers(input: unknown): { answers: AppAnswer[]; malformed: number; overCap: number } {
  const answers: AppAnswer[] = [];
  let malformed = 0;
  let overCap = 0;
  for (const a of Array.isArray(input) ? input : []) {
    const { build, record, added } = (a ?? {}) as Record<string, unknown>;
    if (typeof build !== "string" || !BUILD_ID_RE.test(build) || typeof record !== "string" || !RECORD_ID_RE.test(record) || typeof added !== "string" || added.length > MAX_ADDED) {
      malformed++;
    } else if (answers.some((x) => x.build === build)) {
      malformed++;
    } else if (answers.length >= MAX_ANSWERS) {
      overCap++;
    } else {
      answers.push({ build, record, added });
    }
  }
  return { answers, malformed, overCap };
}

/** Longest `added` the gateway takes (the line itself is cut to 200 anyway). */
export const MAX_ADDED = 20_000;

/** Every line of `added` must be in what he actually sent — it can only narrow his message, never add to it. */
function sentIn(added: string, text: string): boolean {
  return added
    .split(/\r\n|[\r\n\u2028\u2029]/)
    .map((l) => l.trim())
    .filter(Boolean)
    .every((l) => text.includes(l));
}

/** The fixed `finished` build_answered.sh writes — how the desk knows an incoming record is that answer. */
export const ANSWERED_FINISHED = "the owner answered the question.";

export interface BuildAnswerDeps {
  /** The build's timeline (the desk's). */
  read(build: string): TimelineEntry[];
  /**
   * Hold the desk to this question while the writer runs: the answered record
   * carrying this line is refused at ingest if the question is no longer the
   * newest record (the recheck right before the post). Returns the release.
   */
  guard(build: string, record: string, line: string): () => void;
  /**
   * Run the writer — build_answered.sh <build> <line>. Resolves ok=false on any
   * failure. `gone: false` means part of it may still be running (a timeout
   * whose process group would not die): the guard is then held, not released.
   */
  run(build: string, line: string): Promise<{ ok: boolean; detail: string; gone?: boolean }>;
  log(msg: string): void;
}

export type AnswerOutcome = {
  build: string;
  result: "answered" | "no-answer" | "not-in-message" | "not-asking" | "in-flight" | "failed";
  line: string | null;
  detail?: string;
};

// Questions whose answer is being written right now, by needs_operator record: two sends close
// together (a double tap, an outbox retry) both see the open question, and only the first
// may write. Keyed by the question, so an answer to a NEWER question is never held back.
const inFlight = new Set<string>();

/**
 * Clear each answered question. Never throws: the message to Michael is
 * already on its way, and a miss here means the card keeps asking.
 */
export async function recordBuildAnswers(deps: BuildAnswerDeps, answers: AppAnswer[], text: string): Promise<AnswerOutcome[]> {
  const out: AnswerOutcome[] = [];
  for (const { build, record, added } of answers) {
    if (!sentIn(added, String(text ?? ""))) {
      deps.log(`[foreman-messages] answer for ${build} not recorded: its words are not in the message sent`);
      out.push({ build, result: "not-in-message", line: null });
      continue;
    }
    const line = answerLine(added);
    if (!line) {
      out.push({ build, result: "no-answer", line: null });
      continue;
    }
    const key = `${build}:${record}`;
    if (inFlight.has(key)) {
      out.push({ build, result: "in-flight", line });
      continue;
    }
    inFlight.add(key);
    let release: (() => void) | null = null;
    try {
      const open = openQuestionId(deps.read(build));
      if (open !== record) {
        deps.log(`[foreman-messages] answer for ${build} not recorded: the question it answers is no longer the newest record (${open ? "a newer question" : "answered, or the run moved on"})`);
        out.push({ build, result: "not-asking", line });
        continue;
      }
      release = deps.guard(build, record, line);
      const r = await deps.run(build, line);
      if (r.gone === false) {
        deps.log(`[foreman-messages] answer writer for ${build} did not exit — its guard stays held so a late post can never clear a newer question`);
        release = null;
      }
      if (r.ok) {
        out.push({ build, result: "answered", line, detail: r.detail });
      } else {
        deps.log(`[foreman-messages] answer for ${build} NOT recorded — the card keeps asking: ${r.detail}`);
        out.push({ build, result: "failed", line, detail: r.detail });
      }
    } catch (err) {
      deps.log(`[foreman-messages] answer for ${build} NOT recorded — the card keeps asking: ${String(err)}`);
      out.push({ build, result: "failed", line, detail: String(err) });
    } finally {
      release?.();
      inFlight.delete(key);
    }
  }
  return out;
}

/** Signal a whole process group; false once nothing in it is left. */
function signalGroup(pgid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, sig);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function groupGone(pgid: number, holdMs: number): Promise<boolean> {
  const until = Date.now() + holdMs;
  while (signalGroup(pgid, 0)) {
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

/**
 * Run the writer in its OWN process group. On timeout the whole group is
 * killed — the script and anything it started (its python, its curl-like
 * POST) — and the run settles only once the group is gone, so the guard is
 * never released while a straggler could still post. Anything the writer
 * leaves behind after a normal exit goes the same way. `gone: false` = the
 * group outlived `holdMs` after the kill.
 */
export function runWriter(
  script: string,
  args: string[],
  opts: { timeoutMs: number; env: NodeJS.ProcessEnv; holdMs?: number },
): Promise<{ ok: boolean; detail: string; gone: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let out = "";
    const keep = (d: Buffer) => {
      if (out.length < 2000) out += d.toString();
    };
    const child = spawn(script, args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env: opts.env });
    unshieldChild(child.pid);
    const pgid = child.pid;
    const timer = setTimeout(() => {
      timedOut = true;
      if (pgid) signalGroup(pgid, "SIGKILL");
    }, opts.timeoutMs);
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const finish = async (ok: boolean, why: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let gone = true;
      if (pgid) {
        signalGroup(pgid, "SIGKILL");
        gone = await groupGone(pgid, opts.holdMs ?? 5000);
      }
      resolve({ ok, detail: `${why} ${out.trim()}`.trim().slice(0, 300), gone });
    };
    child.on("error", (err) => void finish(false, err.message));
    child.on("close", (code, signal) =>
      void finish(!timedOut && code === 0, timedOut ? `timed out after ${opts.timeoutMs} ms, process group killed` : code === 0 ? "" : `exit ${code ?? signal}`),
    );
  });
}
