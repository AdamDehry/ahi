/**
 * thread-tail.ts — the last few messages of THIS thread, verbatim, for a turn
 * that starts without a resumed Claude session.
 *
 * Mid-session, `--resume` gives the agent the whole thread. After a session
 * reset (the cache-read ceiling in claude-invoke.ts, /reset) or a turn resumed
 * after a gateway restart (turn-resume.ts), the agent starts with memory
 * summaries only — and can answer "yes, do it" without knowing what "it" is.
 * So a fresh turn gets the tail of the thread, read from the gateway's own
 * message store (in-process — never a second writer), handed to the
 * UserPromptSubmit hook as a 0600 file named by AHI_THREAD_TAIL_FILE, and
 * placed right after the time block.
 *
 * Only fresh turns pay for it: a resumed session already carries the thread.
 * Rollback: AHI_THREAD_TAIL=false.
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { MessageEvent } from "./websocket.js";
import { DEFAULT_TIMEZONE, formatClock, formatShortDay, isValidTimeZone, localDateKey } from "./local-time.js";
import { gatewayStateRoot, safeSegment } from "./multi-user-paths.js";

export const THREAD_TAIL_PER_SIDE = 2;
export const THREAD_TAIL_CAP_CHARS = 1500;
export const THREAD_TAIL_TRUNCATED = "[truncated]";
/** How far back to look for the four messages before giving up. */
const SCAN_LIMIT = 60;

export function threadTailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AHI_THREAD_TAIL !== "false";
}

export interface ThreadTailOptions {
  /** Display name of the person ("the owner"). */
  userName: string;
  /** Display name of the agent ("Michael"). */
  agentName: string;
  timeZone?: string | null;
  now?: Date;
  /**
   * The message this turn answers — it is the prompt itself, so it never
   * appears in the tail. When absent, the newest inbound message is taken to
   * be the one being answered (every surface persists it before invoking).
   */
  excludeMessageId?: string | null;
  perSide?: number;
  capChars?: number;
  /**
   * False when the prompt being answered is NOT a message in this thread — a
   * voice call's spoken turn. Then nothing is excluded as "the newest inbound
   * message", and the note says what the prompt actually is. Default true.
   */
  promptInThread?: boolean;
}

/** How much of one call's transcript rides into a tail or recap. */
export const CALL_TRANSCRIPT_CAP_CHARS = 3000;
/** At most this many call cards in one tail or recap. */
const MAX_CALL_CARDS = 2;
const EARLIER_TURNS_OMITTED = "[earlier turns omitted]";

type CallRecord = NonNullable<NonNullable<MessageEvent["meta"]>["voiceSession"]>;

function callRecord(m: MessageEvent): CallRecord | null {
  const r = m.meta?.voiceSession;
  return r && Array.isArray(r.transcript) ? r : null;
}

function callDuration(sec: number): string {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * One call's transcript as spoken lines, oldest first. When it is too long the
 * OLDEST turns go — the end of a call is what the next turn picks up from.
 */
export function renderCallTranscript(record: CallRecord, userName: string, agentName: string, max = CALL_TRANSCRIPT_CAP_CHARS): string {
  const lines = record.transcript
    .filter((t) => t && typeof t.text === "string" && t.text.trim())
    .map((t) => `${t.role === "agent" ? agentName : userName}: ${t.text.trim().replace(/\s+/g, " ")}`);
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].length > max ? cap(lines[i], max) : lines[i];
    if (used + line.length + 1 > max && kept.length) {
      kept.unshift(EARLIER_TURNS_OMITTED);
      break;
    }
    kept.unshift(line);
    used += line.length + 1;
  }
  return kept.join("\n");
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()} ${THREAD_TAIL_TRUNCATED}`;
}

function stamp(at: Date, now: Date, tz: string): string {
  const clock = formatClock(at, tz);
  return localDateKey(at, tz) === localDateKey(now, tz) ? clock : `${formatShortDay(at, tz)}, ${clock}`;
}

/**
 * Pick the last `perSide` messages from each side (oldest first) and render
 * them. Returns "" when the thread has nothing to show. Pure.
 */
export function buildThreadTail(messages: MessageEvent[], opts: ThreadTailOptions): string {
  const perSide = opts.perSide ?? THREAD_TAIL_PER_SIDE;
  const max = opts.capChars ?? THREAD_TAIL_CAP_CHARS;
  const tz = isValidTimeZone(opts.timeZone) ? opts.timeZone : DEFAULT_TIMEZONE;
  const now = opts.now ?? new Date();

  // A file an agent sent with no caption still counts: the line names the files.
  let pool = messages.filter((m) => (typeof m.text === "string" && m.text.trim()) || sentFiles(m));
  if (opts.promptInThread === false) {
    // The prompt is spoken, not stored: nothing in the thread is "it".
  } else if (opts.excludeMessageId) {
    pool = pool.filter((m) => m.meta?.messageId !== opts.excludeMessageId);
  } else {
    let newestIn = -1;
    for (let i = pool.length - 1; i >= 0; i--) {
      if (pool[i].direction === "in") {
        newestIn = i;
        break;
      }
    }
    if (newestIn !== -1) pool = pool.filter((_, i) => i !== newestIn);
  }

  const picked: MessageEvent[] = [];
  let ins = 0;
  let outs = 0;
  let calls = 0;
  for (let i = pool.length - 1; i >= 0 && (ins < perSide || outs < perSide); i--) {
    const m = pool[i];
    // A call card is a whole conversation, not one side's message: it rides
    // along when it falls inside the window and takes neither side's slot.
    if (callRecord(m)) {
      if (calls < MAX_CALL_CARDS) {
        calls++;
        picked.push(m);
      }
      continue;
    }
    if (m.direction === "in" && ins < perSide) {
      ins++;
      picked.push(m);
    } else if (m.direction === "out" && outs < perSide) {
      outs++;
      picked.push(m);
    }
  }
  if (!picked.length) return "";
  picked.reverse();

  const lines = picked.map((m) => {
    const call = callRecord(m);
    if (call) return renderCallCard(m, call, opts, now, tz);
    const who = m.direction === "in" ? m.senderName && m.senderName !== "unknown" ? m.senderName : opts.userName : opts.agentName;
    const at = new Date(m.timestamp);
    const when = Number.isNaN(at.getTime()) ? "?" : stamp(at, now, tz);
    const kind = m.contentType === "voice" ? " (voice note)" : m.meta?.foreman ? " (build status)" : sentFiles(m);
    const body = cap((m.text ?? "").trim(), max);
    return body ? `[${who}${kind} · ${when}]\n${body}` : `[${who}${kind} · ${when}]`;
  });
  const newest =
    opts.promptInThread === false
      ? `You are now on a voice call with ${opts.userName}; what he just said is the prompt.`
      : "The newest message — the one you are answering — is the prompt itself, not repeated here.";
  return [
    `<thread-tail note="The last messages of this thread with ${opts.userName}, verbatim, oldest first (${tz}). ${newest}">`,
    lines.join("\n\n"),
    `</thread-tail>`,
  ].join("\n");
}

function renderCallCard(m: MessageEvent, call: CallRecord, opts: ThreadTailOptions, now: Date, tz: string): string {
  const at = new Date(m.timestamp);
  const when = Number.isNaN(at.getTime()) ? "?" : stamp(at, now, tz);
  const body = renderCallTranscript(call, opts.userName, opts.agentName);
  return `[Voice call with ${opts.userName} · ended ${when} · ${callDuration(call.durationSec)}]\n${body}`;
}

/**
 * The voice calls a RESUMED chat session has not seen (one
 * Michael — a call must carry into the next chat turn).
 *
 * A call runs in its own Claude session, so the chat session that resumes
 * afterwards never heard it, and a resumed turn gets no thread tail. This is
 * the gap: every call card newer than the agent's latest ordinary reply in
 * the thread. Once the agent answers in chat, that reply is newer than the
 * card and the recap stops — it is one-shot without any state of its own, so
 * it also survives a restart. Build-status messages and other cards are not
 * "the agent's reply" (the chat session never produced them). Pure.
 */
export function buildCallRecap(messages: MessageEvent[], opts: ThreadTailOptions): string {
  const tz = isValidTimeZone(opts.timeZone) ? opts.timeZone : DEFAULT_TIMEZONE;
  const now = opts.now ?? new Date();
  const unseen: Array<{ m: MessageEvent; call: CallRecord }> = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const call = callRecord(m);
    if (call) {
      if (call.transcript.length) unseen.unshift({ m, call });
      continue;
    }
    if (m.direction === "out" && !m.meta?.foreman) break;
  }
  if (!unseen.length) return "";
  const cards = unseen.slice(-MAX_CALL_CARDS).map(({ m, call }) => renderCallCard(m, call, opts, now, tz));
  return [
    `<voice-call-recap note="Your voice call with ${opts.userName} since your last chat reply. You said and heard this aloud in a separate session; this chat session did not see it until now. Oldest first (${tz}).">`,
    cards.join("\n\n"),
    `</voice-call-recap>`,
  ].join("\n");
}

/** " (sent files: a.mp3, b.pdf)" on a message an agent posted with files —
 *  so the agent remembers what it sent, by name, even with no caption. */
function sentFiles(m: MessageEvent): string {
  if (!m.meta?.agentFiles) return "";
  const files = m.mediaList?.length ? m.mediaList : m.media ? [m.media] : [];
  return files.length ? ` (sent files: ${files.map((f) => f.originalName).join(", ")})` : "";
}

/** Read the store's thread for (bot, user) — the caller supplies the reader. */
export function threadTailFor(
  read: (bot: string, userId: string, limit: number) => MessageEvent[],
  bot: string,
  userId: string,
  opts: ThreadTailOptions,
): string {
  return buildThreadTail(read(bot, userId, SCAN_LIMIT), opts);
}

/** Read the store's thread for (bot, user) and build the call recap. */
export function callRecapFor(
  read: (bot: string, userId: string, limit: number) => MessageEvent[],
  bot: string,
  userId: string,
  opts: ThreadTailOptions,
): string {
  return buildCallRecap(read(bot, userId, SCAN_LIMIT), opts);
}

function tailDir(): string {
  return resolve(gatewayStateRoot(), "thread-tail");
}

/** Write the tail for one spawn; returns the path, or null on failure (fail-open). */
export function writeThreadTailFile(streamId: string, tail: string): string | null {
  try {
    const dir = tailDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = resolve(dir, `${safeSegment(streamId, "turn")}.txt`);
    writeFileSync(path, tail, { mode: 0o600 });
    return path;
  } catch (err) {
    console.warn(`[thread-tail] could not write tail file: ${(err as Error).message}`);
    return null;
  }
}

export function removeThreadTailFile(path: string | null): void {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone — nothing to do.
  }
}
