/* ============================================================
   work-gate.ts — a remark does not abort work (ALWAYS-ON-VOICE.md §4, 1a–1d).

   Today's turn gate has one rule: a new real utterance supersedes the running
   turn. Right for a chat box, wrong for a worker: "how's it going?" two
   minutes into a build aborted the build. While a turn is in flight (the
   liveness beat says so), an addressed utterance is classified HERE before it
   touches the gate:

     ack       → silence                     (ack-gate.ts, before this)
     status    → answered from the beat and the last work line, no model call
     addition  → queued; delivered to the running turn's session when it
                 finishes, as the next turn
     talk      → a question or conversation, not an instruction for the job
                 ("how does a tap work?", "tell me about…"). On an ElevenLabs
                 call it is answered AT ONCE by a tool-free companion turn
                 while the work runs on (the talk lane, eleven/brain.ts);
                 everywhere else (native calls, ELEVEN_TALK_LANE=off) it
                 queues exactly like an addition.
     ask       → the same as addition (10/23): he is never asked back.
     stop      → supersede, as today: the one way to abort ("stop", "hold on").

   A queued remark gets a listener's sound, not a sentence: "Mm-hm.",
   "Uh-huh.", "Okay.", "Right." — rotated, never the same twice in a row
   (backchannel). The canned "Want me to stop what I'm doing for that?"
   played word for word every time, and the owner hated it.

   THE FALSE-STOP RISK, and the choice made. "stop" is the one verdict that
   destroys work, so it is the narrowest: the utterance must be SHORT and made
   of stop phrases and nothing else ("stop", "hold on", "never mind", "Michael
   stop"). "Stop by the store on the way" is not a stop; it is an addition or
   an ask. A status question is the widest, because a wrong "status" costs one
   calm line; a wrong "stop" costs a build.

   Pure functions over text; index.ts wires the verdicts to the gate.
   ============================================================ */

import { normalizeWords, wakeNameAt } from "./floor.js";

export type WorkVerdict = "status" | "addition" | "talk" | "stop" | "ask";

const STOP_PHRASES = [
  "stop", "stop stop", "stop it", "stop that", "stop there", "hold on", "hold up", "hang on", "wait", "wait wait", "wait a second", "wait a sec", "one second", "one sec",
  "never mind", "nevermind", "forget it", "forget that", "cancel", "cancel that", "cancel it", "abort", "scrap that", "drop it", "leave it", "stop working", "stop what youre doing", "stop what you are doing", "pause",
];
/** Words that carry nothing around a stop ("okay Michael, stop."). */
const STOP_PADDING = new Set(["ok", "okay", "michael", "hey", "um", "uh", "please", "now", "just", "actually", "no"]);

const STATUS = [
  /\b(how'?s|how is|hows) (it|that|this|everything|the \w+) (going|coming|looking|doing)\b/,
  /\bhow (are you|is it|are we|we) (doing|going|getting on|coming along)\b/,
  /\b(you|are you) (still )?(there|with me|on it|working|alive|around)\b/,
  /\bhow (long|much longer|far)( is (it|that|this))?( going to| gonna)?( take| be| left)?\b/,
  /\b(are you|you) (done|finished|almost done|nearly done|close)\b/,
  /\b(what'?s|what is|whats) (the status|the holdup|taking so long|happening|going on|the eta)\b/,
  /\b(where are (we|you)( at| on (it|this|that))?|status|status update|progress|eta|any update|update me)\b/,
  /\b(did (you|it) (finish|work|go through)|is it (done|working|ready))\b/,
  /\bstill (there|working|on it|going|alive)\b/,
];

const ADDITION = [
  /^(and |oh |um |uh |also |plus )?(also|and also|one more thing|another thing|while you'?re at it|when you'?re done|when that'?s done|after that|then also|plus|on top of that|dont forget|don'?t forget|remember to|make sure|add|include|as well)\b/,
  /\b(also|as well|too|when you'?re done|after that|while you'?re at it)\s*[.!]?$/,
];


/*
 * TALK. A question or conversation, as opposed to something for the job to
 * do. Read from the raw text (Hebrew included: normalizeWords keeps a-z only).
 * A request in question form ("can you price…", "could you send…") is an
 * instruction, not talk — unless what it asks for is talk itself ("can you
 * tell me…", "could you explain…"). A wrong `talk` costs little: the companion
 * turn has no hands, and anything that needs them is handed back to the job.
 */
const TALK_ASKS = /\b(tell me|explain|walk me through|remind me|describe|talk me through|help me understand)\b/;
const QUESTION_START =
  /^(what|whats|what's|how|hows|how's|why|whys|when|where|who|whos|who's|which|whose|is|isn'?t|are|aren'?t|do|does|doesn'?t|did|didn'?t|was|were|have|has|had|should|shouldn'?t|would|wouldn'?t|could|can|will|wont|won'?t|am|any idea|you think|do you think|whaddya|wanna know|i wonder|i'?m curious|curious)\b/;
const REQUEST_OPENER =
  /^(can|could|would|will|wont|won'?t) (you|we|u|ya)( please| just| quickly| maybe)? (?!tell\b|explain\b|walk\b|remind\b|describe\b|talk\b|help me understand\b|think\b|believe\b|imagine\b|see why\b|guess\b|hear\b)\w+/;
const REQUEST_ANYWHERE = /\b(please|go ahead and|i need you to|i want you to|make sure|lets|let'?s|go and)\b/;
const CHAT_OPENER =
  /^(by the way|btw|you know what|you know|honestly|funny|i think|i feel|i was thinking|i wonder|i love|i like|i hate|thats|that'?s|its|it'?s|this is|so i|oh man|wow|interesting|cool)\b/;
/** Hebrew question words and asks ("מה", "איך", "למה", "תגיד לי", "תסביר"). */
const HEBREW_TALK = /(^|[\s,.!?])(מה|מהו|מהי|איך|למה|מדוע|מתי|איפה|היכן|מי|כמה|האם|תגיד לי|תסביר|תספר לי|ספר לי)(?=$|[\s,.!?])/;

/** Lowercased, wake name and fillers off the front; Hebrew and punctuation kept. */
function talkBody(text: string): string {
  let t = text.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
  for (;;) {
    const next = t.replace(/^(hey|so|and|but|ok|okay|um|uh|oh|yeah|yes|no|well|michael|mike|listen|quick question|question)\b[\s,.!?-]*/, "");
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * A question or conversation for him and me, not an instruction for the job.
 * Called after the stop, status and addition checks (an "also …" stays an addition).
 */
export function isTalk(text: string): boolean {
  const body = talkBody(text);
  if (!body) return false;
  const latin = body.replace(/[^a-z0-9' ?]+/g, " ").replace(/\s+/g, " ").trim();
  if (REQUEST_ANYWHERE.test(latin)) return false;
  if (TALK_ASKS.test(latin)) return true;
  if (REQUEST_OPENER.test(latin)) return false;
  if (HEBREW_TALK.test(body)) return true;
  if (/\?\s*$/.test(body) || /\?/.test(body)) return true;
  if (QUESTION_START.test(latin)) return true;
  return CHAT_OPENER.test(latin);
}

/** The utterance is a stop and nothing else. */
export function isStop(text: string): boolean {
  const words = normalizeWords(text).filter((w) => !STOP_PADDING.has(w));
  if (words.length === 0 || words.length > 4) return false;
  const joined = words.join(" ");
  if (STOP_PHRASES.includes(joined)) return true;
  // Two stop phrases back to back ("wait, stop").
  for (const a of STOP_PHRASES) {
    if (joined.startsWith(`${a} `) && STOP_PHRASES.includes(joined.slice(a.length + 1))) return true;
  }
  return false;
}

/** A question about the work itself, not a new request. */
export function isStatusQuestion(text: string): boolean {
  const norm = normalizeWords(text).join(" ");
  if (!norm || norm.split(" ").length > 14) return false;
  const body = wakeNameAt(text) >= 0 ? norm.split(" ").slice(wakeNameAt(text) + 1).join(" ") : norm;
  return STATUS.some((re) => re.test(body));
}

/** Something to do after this: it starts like an addition, or ends like one. */
export function isAddition(text: string): boolean {
  const norm = normalizeWords(text).join(" ");
  if (!norm) return false;
  const body = wakeNameAt(text) >= 0 ? norm.split(" ").slice(wakeNameAt(text) + 1).join(" ") : norm;
  return ADDITION.some((re) => re.test(body));
}

/**
 * Classify an addressed utterance heard while a turn runs. The ack gate has
 * already said it is not an acknowledgement.
 */
export function classifyWhileWorking(text: string): WorkVerdict {
  if (isStop(text)) return "stop";
  if (isStatusQuestion(text)) return "status";
  if (isAddition(text)) return "addition";
  if (isTalk(text)) return "talk";
  return "ask";
}

/**
 * The verdicts that queue the remark and keep working (everything but stop
 * and status). `talk` queues too wherever there is no talk lane to take it.
 */
export function queuesWhileWorking(verdict: WorkVerdict): boolean {
  return verdict === "addition" || verdict === "ask" || verdict === "talk";
}

/* ── The lines ──────────────────────────────────────────────────────────── */

/** A listener's sound, low energy: more sound than words. */
export const BACKCHANNELS = ["Mm-hm.", "Uh-huh.", "Okay.", "Right."] as const;

/** One backchannel, never `last` (the one this call said before). */
export function backchannel(last: string | null, rand: () => number = Math.random): string {
  const pool = BACKCHANNELS.filter((b) => b !== last);
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}

function spokenDuration(sec: number): string {
  if (sec < 45) return "under a minute";
  const m = Math.round(sec / 60);
  if (m <= 1) return "about a minute";
  return `about ${m} minutes`;
}

/**
 * The spoken answer to a status question, from the beat — never a promise
 * about when it will be done. `lastWork` is the latest work line, trimmed to
 * a clause; absent, the line stays with the numbers.
 */
export function statusLine(beat: { sinceMs: number; tools: number; lastWork?: string | null }): string {
  const parts = [`Still on it, ${spokenDuration(beat.sinceMs / 1000)} in`];
  if (beat.tools > 0) parts.push(`${beat.tools} step${beat.tools === 1 ? "" : "s"} so far`);
  let line = parts.join(", ") + ".";
  const work = cleanWorkLine(beat.lastWork);
  if (work) line += ` Last: ${work}.`;
  return line;
}

/** A work line as something sayable: no markers, no paths, one clause, short. */
export function cleanWorkLine(text: string | null | undefined): string {
  if (!text) return "";
  let t = text.replace(/^[»>*\-\s]+/, "").replace(/`[^`]*`/g, "").replace(/\S*[\\/]\S*/g, "").replace(/\s+/g, " ").trim();
  t = (t.split(/(?<=[.!?;:])\s+/)[0] ?? t).trim();
  t = t.replace(/[.!?;:,]+$/, "").trim();
  if (t.length > 90) t = t.slice(0, 87).replace(/\s+\S*$/, "") + "…";
  return t;
}
