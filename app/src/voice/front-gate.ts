import { AI_ROOT } from "../ai-root.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  checkBridgeLine,
  checkWorkLine,
  cleanFrontLine,
  frontVoicePrompt,
  frontVoiceSystemPrompt,
  recentFrontLines,
  WarmFrontVoice,
  FRONT_VOICE_RECYCLE_AFTER,
  FRONT_VOICE_RETRY_WITHIN_MS,
  MICHAEL_DEFAULT,
  type FrontVoicePersona,
} from "./front-voice.js";

/* ============================================================
   front-gate.ts — fast OR slow, never both (10/22).

   On the ElevenLabs call the fast voice used to say a holding line while the
   main brain worked, and the main brain then answered. The owner: "if the
   immediate response sufficed, you don't have to go and respond again." So
   every turn now passes ONE gate, here, and gets exactly one of:

     full    a BARE greeting, yes or no, or thanks — nothing else (narrowed
             10/23, call b57db8: a real question got the fast line alone and
             the main turn was cancelled) — and the fast voice's reply IS the
             answer. The main brain's turn is cancelled (the
             caller does that); nothing more is said or printed for it.
     ack     anything that needs work: a lookup, a tool, a file, memory, the
             time, a number, a fact, a decision, a judgment call, an
             instruction. The fast voice may only buy a second ("Checking.",
             or one of its own short lines) and the main brain answers.
     silent  no line at all; the main brain answers. (An ack line that failed
             its checker, a model that did not come back, a gate that is off.)

   When unsure: ack. Two locks enforce it, not the prompt alone:
     · a rule pass first (`needsWork`): a turn that names work, a fact, a
       time or a number, asks a question, makes a request, runs past five
       words, or is anything but a greeting, a yes or no, or thanks (`bareBeat`)
       is never allowed a full answer, whatever the model says — the fast
       line is then only ever the warm-up;
     · the model's full reply is checked (`checkFullLine`): it may not state a
       number, claim an action, promise one, or stall — a stall is an ack.
   An ack line goes through the front voice's own checker and do-not-repeat
   list (front-voice.ts), unchanged.

   One place, one log line per turn: `[front-gate] <vsid> full|ack|silent
   reason=…` (written by the caller, which knows the call).

   Same person: the full reply is written with Michael's own style card
   (~/ai/agents/memory/michael/STYLE.md, the one every slow turn carries),
   read fresh when the call opens.

   ── Voice step 4 (10/27, after his test call): the answer ladder ───
   On his test call the gate's full answer fired on 0 of 18 turns and its
   line was rejected on 13 — so he mostly heard a bare "One sec." the owner ruled:
   the instant answer wins; a contextual line only when the main answer is
   10 s+ away; otherwise "One sec." at 1.4 s; never two holding sounds. So
   the gate now writes one of THREE tags:
     FULL: <reply>  he can be answered now, in a sentence or two, with no
                    lookup, tool, memory or fact about his world — a presence
                    check ("you there?", "can you hear me?"), how are you, a
                    sign-off, an acknowledgement of something he reports.
                    Allowed by `fastMayAnswer` (wider than `needsWork`, which
                    still decides whether a turn needs work at all).
     WORK: <line>   the main brain has real work (a lookup, a tool, a file,
                    a system, a build): its answer is 10 s+ away. The line is
                    the one thing he hears until then; it may answer the
                    conversational part and say Michael is on it
                    (front-voice.ts checkWorkLine). Verdict kind "ack", long.
     QUICK          the main brain answers from what it knows in a few
                    seconds. No line: "One sec." covers it if it is needed.
                    Verdict kind "silent", reason "…,quick".
   ACK: is still read (as WORK), for an old process mid-call.
   The tag is the gate's first word, streamed: `onClaim` hears it long before
   the line is finished, so the arbiter (answer-ladder.ts) can hold off the
   1.4 s "One sec." for a gate that is about to speak.

   ── Voice step 5 (the owner's step-4 test calls, 10/27) ───────────────────────
   "What time is it?" got "checking the time for you now" and a main turn:
   the gate had no clock. And any sentence over 16 words was barred from a
   FULL answer by count alone. Now:
     · THE GATE HAS THE CLOCK. Each turn's message carries "Now: <his day,
       date and time>" (index.ts, his zone). A question only about the time,
       the day or the date may be answered FULL, and a FULL reply may state
       them as given — its numbers must be the clock's own (`checkFullLine`).
       CALL_GATE_CLOCK=off. His calendar is NOT given: the week file is his
       routine, not his appointments, so "what's on tomorrow" stays work.
     · NO WORD CAP. Length alone no longer bars a FULL answer; the model
       judges, and every other rule stays (no number, his world, a request,
       a question about anything else…). CALL_FAST_WORDS=16 restores the cap.

   ── Voice step 6 (the owner's phone call, 10/28 morning) ──────────────────────
   "One sec." still beat the real filler almost every time, and he barely
   heard a filler at all: QUICK had no line, so every quick turn was "One
   sec." and then the answer. Now QUICK carries a BRIDGE:
     QUICK: <line>  a short WORK line (three to eight words, every WORK rule)
                    that names what he raised in his own words and says
                    Michael is thinking it through ("The phone lag. Thinking
                    it through."); the main brain's answer follows straight
                    on it (answer-ladder.ts holds the bridge for the answer).
                    Checked by checkBridgeLine (front-voice.ts). A first cut
                    asked for any short reaction; the fast model wrote the
                    answer itself ("Worth it if the quality holds up."), so
                    the bridge is a WORK line, never the answer.
   A bare QUICK is still read. The QUICK tag claims "bridge" (the hold waits
   for its line); a bridge that fails its checker leaves the turn QUICK with
   no line, and no retry. Native calls only (FrontGate's `bridge`); the
   ElevenLabs call's gate is unchanged. CALL_BRIDGE=off.
   ============================================================ */

export type GateKind = "full" | "ack" | "silent";

export interface GateVerdict {
  kind: GateKind;
  line: string | null;
  reason: string;
  ms: number;
  /** An ack that is a WORK line: the main answer is 10 s+ away (voice step 4). */
  long?: boolean;
  /** Silent because the gate judged the main brain quick (QUICK), not because a line failed. */
  quick?: boolean;
  /** A QUICK verdict's bridge (voice step 6): the reply's first words, the answer right behind. */
  bridge?: string;
}

/**
 * One request to the gate's model: content in, raw text out. `onPartial`
 * (optional): the text so far, as it is written — the tag comes first.
 */
export type GateAsk = (content: string, signal: AbortSignal, onPartial?: (text: string) => void) => Promise<string>;

/**
 * What the gate's first word claims for the turn (answer-ladder.ts): its
 * instant answer, a WORK line, a bridge (QUICK with a line, voice step 6), or
 * nothing (a bare QUICK).
 */
export type GateClaim = "answer" | "filler" | "bridge" | "pass";

/** A line of the call so far, for context. */
export interface CallLine {
  role: "user" | "agent";
  text: string;
}

const STYLE_CARD_PATH = resolve(AI_ROOT, "agents/memory/michael/STYLE.md");
const MAX_FULL_WORDS = 40;
const MAX_FULL_CHARS = 280;
const RECENT_CALL_LINES = 6;

/**
 * Words that mean the turn needs the main brain: work to do, a fact to fetch,
 * a time, a number, a person or a thing in the business. Matched on his words;
 * the first hit is the logged reason. Deliberately broad — a false "work" costs
 * one holding line, a false "chit-chat" costs a made-up answer.
 */
const WORK = new RegExp(
  "\\b(" +
    [
      // doing
      "look(?:ing)? (?:up|into|at)", "lookup", "check", "search", "find", "pull (?:up|in)", "open", "send", "text", "email", "e-mail",
      "call (?:him|her|them)", "schedule", "remind", "book", "cancel", "build", "brief", "write", "draft", "fix", "ship", "deploy",
      "restart", "run", "start", "stop", "make", "create", "update", "change", "delete", "remove", "add", "set", "move", "save",
      "price", "quote", "order", "buy", "pay", "sign", "approve", "reply", "respond", "forward", "share", "show", "tell (?:him|her|them)",
      "remember", "recall", "summar(?:ize|ise)", "read", "listen", "watch", "plan", "figure", "work out", "research", "compare",
      // facts and the world
      "weather", "news", "forecast", "calendar", "meeting", "appointment", "deal", "lead", "customer", "client", "invoice",
      "lease", "payment", "car", "vin", "dealer", "inventory", "file", "folder", "code", "log", "logs", "build", "status",
      "transcript", "recording", "message", "messages", "inbox", "mail", "chat", "thread",
      // time and quantity
      "time", "date", "today", "tomorrow", "yesterday", "week", "month", "year",
      "o'clock", "hour", "hours", "minute", "minutes", "how much", "how many", "how long", "when", "where", "why", "which",
      "what time", "what's the", "what is the", "who is", "who's", "cost", "number", "percent", "dollars?",
      // judgment
      "should (?:i|we)", "do you think", "what do you think", "opinion", "recommend", "advice", "better", "worse", "decide",
      "accurate", "true", "right now", "last call", "earlier",
      // the team
      "zali", "avi", "miriam", "elevenlabs", "cartesia", "openai", "claude",
    ].join("|") +
    ")\\b",
  "i",
);

/**
 * Does the turn need work at all (the hold line's arming, the ElevenLabs
 * call)? A reason when it does, null for a bare social beat. The
 * full answer's own rule pass is `fastMayAnswer` below.
 */
export function needsWork(heard: string): string | null {
  const t = heard.trim();
  if (!t) return "empty";
  if (/[0-9]/.test(t)) return "number";
  const m = t.match(WORK);
  if (m) return `names:${m[1].toLowerCase().replace(/\s+/g, "-")}`;
  return bareBeat(t);
}

/** Words that make a line a greeting, a yes or no, or thanks — one of them must be there. */
const BEAT_CORE = new Set([
  "hi", "hey", "hello", "heya", "hiya", "yo", "morning", "afternoon", "evening", "night", "bye", "goodbye",
  "yes", "yeah", "yep", "yup", "sure", "no", "nope", "nah", "okay", "ok", "alright", "correct", "exactly", "absolutely",
  "thanks", "thank", "cheers", "appreciate",
]);
/** What may sit around them: names, warmth, "so much". Nothing that asks or tells. */
const BEAT_AROUND = new Set([
  "good", "great", "perfect", "awesome", "cool", "nice", "lovely", "fine", "right", "all", "of", "course", "totally", "definitely",
  "oh", "ah", "well", "you", "it", "that", "so", "much", "very", "a", "lot", "again", "there", "man", "buddy", "bro", "dude",
  "sir", "michael", "mike", "too", "as", "always",
]);
/** A request in his words, however short. */
const REQUEST = /\b(can you|could you|would you|will you|please|let's|let us|i need|i want|i'd like|tell me|give me|go ahead|do it|help)\b/i;

/**
 * Null only for a bare social beat — a greeting, a yes or no, thanks — in at
 * most five words with no question mark and no request;
 * otherwise why the main turn must answer. Anything else the fast voice says
 * is only the warm-up.
 */
export function bareBeat(heard: string): string | null {
  const t = heard.trim();
  if (!t) return "empty";
  if (/\?/.test(t)) return "question";
  const words = t.toLowerCase().replace(/[^a-z' ]+/g, " ").split(/\s+/).map((w) => w.replace(/^'+|'+$/g, "")).filter(Boolean);
  if (words.length > 5) return "words";
  if (REQUEST.test(t)) return "request";
  if (!words.some((w) => BEAT_CORE.has(w)) || !words.every((w) => BEAT_CORE.has(w) || BEAT_AROUND.has(w))) return "not-a-beat";
  return null;
}

/* ── Who may answer instantly (voice step 4) ──────────────────────────── */

/** "You there?", "can you hear me?", "how about now?" — answerable by anyone on the line. */
const PRESENCE = /\b(you (still )?(there|around|with me|back)|can you (still )?hear me|do you hear me|hear me( now)?|are you (still )?(there|listening|with me|back|around)|how about now|testing)\b/i;
/** About Michael himself, no facts: "how are you?" */
const SMALLTALK = /\b(how are you|how're you|how's it going|how you doing|how are things|what's up|how have you been|how's your day)\b/i;
/** Asking the main brain to pick up its own thread: work, however it is worded. */
const CONTINUE = /\b(continue|go on|keep going|carry on|resume|pick (it )?(back )?up|finish (what|your|that))\b/i;
/** Asking for something to be DONE, at the start of a clause ("Check…", "please send…", "go quiet"). */
const IMPERATIVE = new RegExp(
  "(?:^|[.!?,;]\\s*|\\b(?:and|so|then|now|just|please)\\s+)(?:please\\s+)?(" +
    [
      "look", "check", "search", "find", "pull", "open", "send", "text", "email", "call", "schedule", "remind", "book", "cancel",
      "build", "write", "draft", "fix", "ship", "deploy", "restart", "run", "start", "make", "create", "update", "change",
      "delete", "remove", "add", "set", "move", "save", "price", "quote", "order", "buy", "pay", "sign", "approve", "reply",
      "forward", "share", "show", "tell", "remember", "read", "plan", "figure", "research", "compare", "go quiet", "mute",
      "unmute", "hang up", "end the call", "wake", "sleep", "repeat", "say", "explain", "summarize", "summarise", "give",
    ].join("|") +
    ")\\b",
  "i",
);
/** Things in his world the fast layer knows nothing about. */
const WORLD = /\b(zali|avi|miriam|elevenlabs|cartesia|openai|claude|calendar|meeting|deal|lead|customer|client|invoice|lease|payment|dealer|inventory|file|folder|code|log|logs|build|builds|deploy|transcript|recording|message|messages|inbox|email|mail|weather|news|price|quote|order|today|tonight|tomorrow|yesterday|week|weekend|plan|plans|schedule|earlier|last time)\b/i;
/** Openers stripped before reading whether a clause asks something ("Good, so where were we"). */
const OPENERS = /^(?:(?:okay|ok|so|and|but|good|great|well|hey|alright|right|um|uh|oh|yeah|now|then|michael)[,.!]?\s+)+/i;
/** Asking Michael to decide, judge or tell him something — the main brain's job, however casual. */
const ASKS_FOR = /\b(let me know|which (?:is|one)|what do you think|your (?:take|opinion|thoughts|call)|recommend|should (?:i|we)|any (?:idea|thoughts))\b/i;
const YES_WORDS = /\b(yes|yeah|yep|yup|sure|ok|okay|alright|go|do it|please|sounds good|perfect|great)\b/i;
const QUESTION_START = /^(what|when|where|why|who|whom|whose|which|how|is|are|was|were|do|does|did|can|could|would|will|should|shall|may|might|have|has|had)\b/i;

/** CALL_FAST_WORDS: a word cap on who may get a FULL answer (step 4: 16). Unset = none, the model judges. */
export function fastWordCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.CALL_FAST_WORDS ?? "").trim();
  if (!raw) return Number.POSITIVE_INFINITY;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY;
}

/** CALL_BRIDGE=off: QUICK is bare again, and "One sec." covers the quick turns (step 5). */
export function bridgeOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CALL_BRIDGE ?? "on").trim().toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

/** The rules for a bridge (voice step 6); the checker (front-voice.ts checkBridgeLine) enforces them. */
export function bridgeRules(persona: FrontVoicePersona = MICHAEL_DEFAULT): string {
  const { agent: A, user: U } = persona;
  const he = "they";
  const his = "their";
  return [
    `A QUICK line is a WORK line, only shorter: three to eight words, said the moment ${U} stops, with the main`,
    `brain's answer straight after it. Name the thing ${he} raised in ${his} own words, then a brief beat that you are`,
    "thinking it through ('The phone lag. Thinking it through.', 'Ah, the closing line. Mulling that.', 'Cost",
    "against quality, weighing it.'). It is NEVER the answer, a hint of it, an opinion or a decision: the main brain",
    "says that. All the WORK line HARD RULES apply, and more: never about yourself ('I'll…', 'my side'), never",
    "approval or agreement ('Agreed', 'Good, …', 'makes sense', 'worth it', 'sounds like…').",
  ].join(" ");
}

/** CALL_GATE_CLOCK=off: the gate is not told the time, and a time question is work again (step 4). */
export function gateClockOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CALL_GATE_CLOCK ?? "on").trim().toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

/** A clause that asks only the time, the day or the date, here and now ("What time is it?", "what's today's date"). */
const TIME_ASK =
  /^(?:(?:so|and|hey|okay|ok|quick question|real quick|michael)[,.!]?\s+)*(?:what(?:'s| is)? (?:the )?time(?: is it)?|what time is it|do you (?:know|have) (?:what )?the time(?: it is)?|what(?:'s| is) (?:the date|today's date|the day|today)|what (?:day|date) is (?:it|today)|what day of the week is it|what(?:'s| is) the date today)(?: (?:today|now|right now|there|again))?\s*[?.!]*$/i;

/** The gate's "Now:" line in his zone: "Now: Tuesday, October 27, 2026, 6:28 PM EDT." Pure (Intl only). */
export function gateClockLine(now: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(now);
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(now);
  return `Now: ${day}, ${time}.`;
}

/** His words without the clauses that only ask the time or date ("" when that is all he asked). */
export function withoutTimeAsks(heard: string): string {
  return heard
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((c) => !TIME_ASK.test(c.trim()))
    .join(" ")
    .trim();
}

/**
 * The full answer's rule pass (voice step 4): null when the fast layer may
 * answer the turn itself — the model still decides, and its reply still goes
 * through `checkFullLine`. Wider than the earlier `bareBeat`: a presence check,
 * how are you, a sign-off, a short report he only needs acknowledged. Never:
 * a number, his world (people, business, systems), a request or an
 * imperative, a question about anything but presence or how Michael is,
 * picking up Michael's own thread, a yes to an offer or question Michael just
 * made (that yes is an instruction), or more than 16 words.
 */
export function fastMayAnswer(
  heard: string,
  lastAgentLine: string | null = null,
  opts: { clock?: boolean; maxWords?: number } = {},
): string | null {
  let t = heard.trim();
  if (!t) return "empty";
  // The gate has the clock (voice step 5): a clause asking only the time or date is answerable; the rest is judged alone.
  if (opts.clock) {
    const rest = withoutTimeAsks(t);
    if (!rest) return null;
    t = rest;
  }
  if (bareBeat(t) === null) {
    // A bare yes after Michael offered or asked is a go-ahead: the main brain acts on it.
    if (lastAgentLine && /\?\s*$/.test(lastAgentLine.trim()) && YES_WORDS.test(t)) return "answers-offer";
    return null;
  }
  if (/[0-9]/.test(t)) return "number";
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words > (opts.maxWords ?? fastWordCap())) return "words";
  const world = t.match(WORLD);
  if (world) return `names:${world[1].toLowerCase()}`;
  // A presence check or "how are you" excuses only its own clause: "Can you hear me? Delete it." still asks for work (Codex, step 4).
  const isPresence = (c: string): boolean => PRESENCE.test(c) || SMALLTALK.test(c);
  // Clauses, commas included: "Can you hear me, delete it" keeps "delete it" (Codex r2).
  const rest = t
    .split(/(?<=[.!?,;])\s+/)
    .filter((c) => !isPresence(c))
    .join(" ");
  if (ASKS_FOR.test(t)) return "asks-for";
  // A name mid-sentence ("Steve and Nivea from Coconut Creek") is information for the main brain, often an answer it asked for.
  const proper = t
    .split(/(?<=[.!?])\s+/)
    .flatMap((c) => c.replace(OPENERS, "").split(/\s+/).slice(1))
    .map((w) => w.replace(/[^A-Za-z']/g, ""))
    .find((w) => /^[A-Z]/.test(w) && w !== "I" && !w.startsWith("I'") && !/^(Michael|the owner|Okay|OK)$/.test(w));
  if (proper) return "proper-noun";
  if (CONTINUE.test(t)) return "continue";
  if (REQUEST.test(rest)) return "request";
  const imp = rest.match(IMPERATIVE);
  if (imp) return `imperative:${imp[1].toLowerCase().replace(/\s+/g, "-")}`;
  const asks = /\?/.test(rest) || rest.split(/(?<=[.!?])\s+/).some((c) => QUESTION_START.test(c.trim().replace(OPENERS, "")));
  if (asks) return "question";
  if (lastAgentLine && /\?\s*$/.test(lastAgentLine.trim()) && YES_WORDS.test(rest)) return "answers-offer";
  return null;
}

export function fastAnswerNarrow(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CALL_FAST_ANSWER ?? "").trim().toLowerCase() === "narrow";
}

/** Stalling: buys time instead of answering — that is an ack, not a full reply. */
const STALLS = /\b(let me|give me|one sec(?:ond)?|a sec(?:ond)?|a moment|checking|looking (?:into|at)|pulling (?:it )?up|hang on|hold on|bear with)\b/i;
/** Claims or promises an action, or a status. */
const ACTION_CLAIMS = /\b(i'll|i will|i'm going to|i am going to|i've|i have (?:sent|done|made|fixed|booked|written|started)|done|sent|scheduled|booked|fixed|shipped|deployed|restarted|on it|right away|will do)\b/i;
const QUANTITY = /\b(hundred|thousand|million|billion|percent|dollars?|bucks|degrees|o'clock|am|pm)\b/i;

export interface FullCheck {
  ok: boolean;
  line: string;
  reason?: string;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const SPOKEN_HOUR = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|o'clock|oh|thirty|fifteen|forty|fifty|twenty|ten|five";

/**
 * Does a FULL reply state the time and date only as the clock gives them
 * (voice step 5)? Each fact by its role, not a bag of the clock's numbers
 * (Codex): a time "h:mm" is the clock's; am/pm after a time is the clock's;
 * a weekday or month named is the clock's; any other number is the clock's
 * day or year. A spelled-out time cannot be checked (accepted, REPORT).
 */
export function clockSaysOnly(line: string, clock: string): boolean {
  const c = clock.toLowerCase();
  const now = c.match(/\b(\d{1,2}):(\d{2})\s*([ap])\.?m\b/);
  const date = c.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december) (\d{1,2}), (\d{4})\b/);
  const weekday = WEEKDAYS.find((w) => c.includes(w));
  if (!now || !date) return false;
  const [, hour, minute, half] = now;
  const [, month, day, year] = date;
  let l = line.toLowerCase();
  // Times with digits, consumed first so their numbers are never read as a day ("7 PM" is not "the 7th"; Codex r2).
  const timeRe = /\b(\d{1,2})(?::(\d{2}))?(?:\s*([ap])\.?\s?m\b\.?|\s*o'clock\b)|\b(\d{1,2}):(\d{2})\b/g;
  for (const m of l.matchAll(timeRe)) {
    const h = m[1] ?? m[4];
    const mm = m[2] ?? m[5];
    if (Number(h) !== Number(hour)) return false;
    if (mm !== undefined && mm !== minute) return false;
    if (m[3] && m[3] !== half) return false;
  }
  l = l.replace(timeRe, " ");
  // A half-day after a spoken hour ("six twenty-eight pm").
  const spoken = new RegExp(`\\b(?:${SPOKEN_HOUR})(?:-\\w+)?\\s*([ap])\\.?\\s?m\\b`, "g");
  for (const m of l.matchAll(spoken)) if (m[1] !== half) return false;
  // Days and months, by name; "may" is a month only beside a number ("May 27", "the 27th of May").
  for (const w of WEEKDAYS) if (new RegExp(`\\b${w}\\b`).test(l) && w !== weekday) return false;
  for (const m of MONTHS) {
    const named = m === "may" ? /\bmay\s+\d|\d(?:st|nd|rd|th)?\s+(?:of\s+)?may\b/.test(l) : new RegExp(`\\b${m}\\b`).test(l);
    if (named && m !== month) return false;
  }
  // Any other number: the day of the month or the year.
  for (const d of l.match(/\d+/g) ?? []) if (Number(d) !== Number(day) && d !== year) return false;
  return true;
}

/**
 * A full reply the fast voice may say as THE answer. `clock` (voice step 5):
 * the "Now:" line the gate was given — a number in the reply must be one of
 * its own, and the time words (am, pm, o'clock) may be said.
 */
export function checkFullLine(raw: string, clock?: string): FullCheck {
  const line = cleanFrontLine(raw).replace(/^["“]|["”]$/g, "").trim();
  const fail = (reason: string): FullCheck => ({ ok: false, line, reason });
  if (!line) return fail("empty");
  if (line.length > MAX_FULL_CHARS) return fail("too-long");
  if (line.split(/\s+/).length > MAX_FULL_WORDS) return fail("too-many-words");
  if (/[0-9]/.test(line) && !(clock && clockSaysOnly(line, clock))) return fail("digit");
  if (clock && !clockSaysOnly(line, clock)) return fail("clock");
  if (/[»`*#[\]{}<>|\\]/.test(line)) return fail("markup");
  if (STALLS.test(line)) return fail("stalls");
  const claim = line.match(ACTION_CLAIMS);
  if (claim) return fail(`claims:${claim[1].toLowerCase()}`);
  const q = line.match(QUANTITY);
  if (q && !(clock && /^(?:am|pm|o'clock)$/i.test(q[1]))) return fail(`quantity:${q[1].toLowerCase()}`);
  return { ok: true, line };
}

/** Michael's style card, read fresh (the call opens a gate); empty for anyone else or if unreadable. */
export function readStyleCard(persona: FrontVoicePersona, path = process.env.FRONT_GATE_STYLE_PATH || STYLE_CARD_PATH): string {
  if (persona.agent !== "Michael") return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * The rules for a WORK line (voice step 4): the earlier front-voice register,
 * with what the owner's later ruling allows — answer the conversational part, say
 * Michael is on it. The checker (front-voice.ts checkWorkLine) enforces the rest.
 */
export function workLineRules(persona: FrontVoicePersona = MICHAEL_DEFAULT): string {
  const { agent: A, user: U } = persona;
  const he = "they";
  const his = "their";
  return [
    `A WORK line is ONE short spoken line, 4 to 14 words, in ${A}'s own register, said the instant ${U} stops talking.`,
    `Build it from what ${he} said: name the thing ${he} asked about in a few plain words, then say you're on it`,
    "or what you are doing to look into it ('The Buick renders. Digging in.', 'On it, I'll tell you when I have it.').",
    `If ${his} line also had a conversational part you can answer, answer it first ('Here. Pulling up the calendar.').`,
    "Vary the shape and the opening word every turn; never lean on 'Ah', 'Hm' or 'give me a second'.",
    "HARD RULES: never answer, hint at or guess the answer to the work itself. State no facts about anything.",
    "No numbers of any kind. Never say yes, yeah, sure, okay or done, and never agree to or refuse anything.",
    "Never claim anything is done, sent, booked, fixed or ready. Never promise a time ('soon', 'later'). No",
    `questions. No exclamation marks. Never act out ${his} request ('Sending...', 'Calling...'). Use only plain`,
    `words: no names of people, companies or products unless ${U} just said them. Rarely use ${U}'s name.`,
    "Never repeat or closely echo any line in the do-not-repeat list, never open the way one of them opens, and",
    "never reuse an image or metaphor from your recent lines.",
  ].join(" ");
}

/** The gate's system prompt: the decision, the full-reply voice, then the WORK line's (and the bridge's) rules. */
export function frontGateSystemPrompt(persona: FrontVoicePersona = MICHAEL_DEFAULT, styleCard = "", opts: { bridge?: boolean } = {}): string {
  const { agent: A, user: U } = persona;
  return [
    `You are the fast voice of ${A} on a live voice call with ${U}. ${A}'s main brain — slower, with tools, memory`,
    `and files — is already working on what ${U} just said. You see ${U}'s line and the last lines of the call.`,
    "The instant answer wins: if you can truly answer, you answer and the main brain stops. Decide, then output",
    "EXACTLY ONE line, starting with its tag:",
    "",
    `FULL: <reply> — when ${U} can be answered right now, completely, in one or two short spoken sentences, with no`,
    `lookup, tool, memory or fact about ${U}'s world: a greeting or sign-off, thanks, a presence check ('you there?',`,
    `'can you hear me?' → 'Here.', 'Loud and clear.'), how are you, a short remark or report from ${U} that only`,
    `needs acknowledging ('I'm back in the app' → 'Welcome back.'). Your reply is then the WHOLE answer: the main`,
    `brain is stopped and says nothing. In ${A}'s own voice, natural, no lists. A FULL reply never states a fact,`,
    "a number, a time, a date or a status — except the current time, day and date exactly as the message's 'Now:'",
    `line gives them, when ${U} asks for them ('What time is it?' → 'Twenty past six.'); never says something was done; never promises or agrees to do anything;`,
    "never stalls ('let me check' is not an answer); never ends the call unless he is saying goodbye.",
    "",
    "WORK: <line> — the main brain must DO something that takes a while: look something up, read a file, check a",
    "system or the business, remember something from before, build, send, research. Its answer is ten seconds or",
    "more away and your line is the one thing he hears until then (rules below).",
    "",
    ...(opts.bridge
      ? [
          "QUICK: <line> — the main brain can answer from what is already in this conversation or what it knows, in",
          "a few seconds, with no lookup (an opinion, a follow-up on what was just said, a short explanation). The",
          "main brain gives that answer, NOT you: your line is only a SHORT WORK line (three to eight words, every WORK",
          "line rule applies) that names what he raised and says you are thinking it through, and the answer follows",
          "straight on it ('The phone lag. Thinking it through.'). If no such line fits, output the bare word QUICK.",
        ]
      : [
          "QUICK — the main brain can answer from what is already in this conversation or what it knows, in a few",
          "seconds, with no lookup (an opinion, a follow-up on what was just said, a short explanation). Output the bare",
          "word QUICK and nothing else.",
        ]),
    "",
    "If the message says 'Allowed: WORK or QUICK', you may not answer FULL. Unsure between FULL and the others:",
    "not FULL. Unsure between WORK and QUICK: WORK if any lookup, file, system or memory could be involved.",
    "",
    ...(styleCard ? [`How ${A} talks (for a FULL reply):`, styleCard, ""] : []),
    "WORK line rules:",
    workLineRules(persona),
    "",
    ...(opts.bridge ? ["QUICK line rules:", bridgeRules(persona), ""] : []),
    "Output only the tagged line.",
  ].join("\n");
}

/** The per-turn message: what is allowed, the call so far, then the front voice's own prompt. */
export function frontGatePrompt(
  heard: string,
  allowFull: boolean,
  recentCall: readonly CallLine[],
  recentAcks: readonly string[],
  rejected: string | undefined,
  persona: FrontVoicePersona = MICHAEL_DEFAULT,
  /** "Now: Tuesday, October 27, 2026, 6:28 PM EDT" in his zone (voice step 5); absent = not told. */
  clock?: string,
): string {
  const call = recentCall
    .slice(-RECENT_CALL_LINES)
    .map((l) => `${l.role === "user" ? persona.user : persona.agent}: ${l.text.replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
  return [
    `Allowed: ${allowFull ? "FULL, WORK or QUICK" : "WORK or QUICK"}`,
    ...(clock ? [clock] : []),
    call ? `The call so far (oldest first):\n${call}` : "The call just started.",
    frontVoicePrompt(heard, recentAcks, rejected, persona),
  ].join("\n");
}

export type GateTag = "FULL" | "ACK" | "QUICK";

/** Split a tagged line. WORK is read as ACK (the verdict kind); QUICK may carry a bridge (step 6); an untagged line is read as an ack. */
export function parseGateLine(raw: string): { tag: GateTag; text: string } {
  const t = raw.trim();
  const quick = t.match(/^\**\s*QUICK\b\s*\**\s*(?:[:\-—]\s*([\s\S]*))?$/i);
  if (quick) return { tag: "QUICK", text: (quick[1] ?? "").trim() };
  if (/^\**\s*QUICK\b/i.test(t)) return { tag: "QUICK", text: "" };
  const m = t.match(/^\**\s*(FULL|ACK|WORK)\s*\**\s*[:\-—]\s*([\s\S]*)$/i);
  if (!m) return { tag: "ACK", text: t };
  return { tag: m[1].toUpperCase() === "FULL" ? "FULL" : "ACK", text: m[2].trim() };
}

/** The tag at the start of a line still being written, once it is certain; null until then. */
export function tagSoFar(partial: string): GateTag | null {
  const m = partial.trimStart().replace(/^\*+\s*/, "").match(/^(FULL|ACK|WORK|QUICK)\b/i);
  if (!m) return null;
  const tag = m[1].toUpperCase();
  return tag === "FULL" ? "FULL" : tag === "QUICK" ? "QUICK" : "ACK";
}

/** Each lane's answer to one request, separately (FrontGate.askEach). */
export type GateAskEach = (content: string, signal: AbortSignal, onPartial?: (lane: number, text: string) => void) => Promise<string>[];

/** frontGateFor's optional extras (voice step 4). */
export interface GateTurnOptions {
  /**
   * The gate's first word, the moment it is certain (the first lane to write
   * one): "answer" (FULL, allowed), "filler" (a WORK line is coming) or
   * "pass" (QUICK: no line). At most once per turn, never after the verdict.
   */
  onClaim?: (claim: GateClaim) => void;
  /** The "Now:" line (voice step 5): the time, day and date in his zone. Absent = the gate has no clock. */
  clock?: string;
  /**
   * QUICK may carry a bridge (voice step 6): its tag claims "bridge", and a
   * bridge that passes checkBridgeLine comes back on the verdict. Set where
   * the gate was built with the bridge rules (FrontGate.bridge).
   */
  bridge?: boolean;
}

/**
 * One turn through the gate. Never throws. `userKey` names the do-not-repeat
 * list (the front voice's, shared). One retry for a rejected line, inside the
 * front voice's own retry budget; a rejected FULL retries without FULL.
 *
 * `askEach` (voice-speed): every request already goes to both warm
 * lanes. With it, the first lane's line that PASSES the checks is used, and a
 * rejected one waits for the other lane's answer — already in flight — instead
 * of paying a fresh round trip. Half the native turns had no line at all
 * because the first answer failed its checker.
 *
 * Voice step 4: FULL is allowed by `fastMayAnswer` (it was `needsWork`), a
 * WORK line is checked by `checkWorkLine`, QUICK is a silent verdict that is
 * not a failure, and `onClaim` hears the tag as soon as it is written.
 */
export async function frontGateFor(
  ask: GateAsk,
  userKey: string,
  heard: string,
  recentCall: readonly CallLine[],
  signal: AbortSignal,
  now: () => number = Date.now,
  persona: FrontVoicePersona = MICHAEL_DEFAULT,
  askEach?: GateAskEach,
  opts: GateTurnOptions = {},
): Promise<GateVerdict> {
  const t0 = now();
  const lastAgent = [...recentCall].reverse().find((l) => l.role === "agent")?.text ?? null;
  // CALL_FAST_ANSWER=narrow: the earlier rule (a bare greeting, yes/no or thanks only).
  const clock = opts.clock && gateClockOn() ? opts.clock : undefined;
  const work = fastAnswerNarrow() ? needsWork(heard) : fastMayAnswer(heard, lastAgent, { clock: !!clock });
  let allowFull = work === null;
  const recentAcks = recentFrontLines(userKey);
  let rejected: string | undefined;
  let why = work ? `rule:${work}` : "model";
  const tag = (): string => `${why}${rejected ? `,retried:${rejected}` : ""}`;
  let claimed = false;
  let settled = false;
  /** The first certain tag of this turn claims it (once). A FULL that is not allowed claims nothing: it will be refused. */
  const hearPartial = (text: string): void => {
    if (claimed || settled || !opts.onClaim) return;
    const t = tagSoFar(text);
    if (!t || (t === "FULL" && !allowFull)) return;
    claimed = true;
    opts.onClaim(t === "FULL" ? "answer" : t === "QUICK" ? (opts.bridge ? "bridge" : "pass") : "filler");
  };
  const done = (v: GateVerdict): GateVerdict => {
    settled = true;
    return v;
  };
  /** A lane said QUICK but its bridge failed the checker (voice step 6): why, for the verdict. */
  let bridgeRejected: string | null = null;
  /** Judge one raw answer: a verdict, or null (and `rejected` says why). */
  const judge = (raw: string): GateVerdict | null => {
    const { tag: kind, text } = parseGateLine(raw);
    if (kind === "QUICK") {
      const quick: GateVerdict = { kind: "silent", line: null, reason: `${tag()},quick`, ms: now() - t0, quick: true };
      if (!opts.bridge || !text) return quick;
      const b = checkBridgeLine(text, heard, recentAcks, persona);
      if (b.ok) return { ...quick, bridge: b.line };
      // The other lane may have a bridge that passes; if none does, the turn is still QUICK, with no line.
      bridgeRejected = b.reason ?? "bridge";
      return null;
    }
    if (kind === "FULL") {
      if (!allowFull) {
        rejected = "full-not-allowed";
        return null;
      }
      const full = checkFullLine(text, clock);
      if (full.ok) return { kind: "full", line: full.line, reason: tag(), ms: now() - t0 };
      rejected = `full-${full.reason}`;
      // A failed full answer is a sign the turn wanted more than chit-chat.
      allowFull = false;
      why = "model-full-rejected";
      return null;
    }
    const verdict = checkWorkLine(text, heard, recentAcks, persona);
    if (verdict.ok) return { kind: "ack", line: verdict.line, reason: tag(), ms: now() - t0, long: true };
    rejected = verdict.reason;
    return null;
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = frontGatePrompt(heard, allowFull, recentCall, recentAcks, rejected, persona, clock);
    const answers = askEach
      ? askEach(content, signal, (_lane, text) => hearPartial(text))
      : [ask(content, signal, hearPartial)];
    // In the order they come back; the first that passes wins.
    const pending = new Map(
      answers.map((p, i) => [i, p.then((raw): { i: number; raw: string } => ({ i, raw }), (err: Error): { i: number; err: Error } => ({ i, err }))] as const),
    );
    let lastErr: Error | null = null;
    let judged = 0;
    while (pending.size) {
      const settledLane = await Promise.race(pending.values());
      pending.delete(settledLane.i);
      if ("err" in settledLane) {
        lastErr = settledLane.err;
        continue;
      }
      judged++;
      const v = judge(settledLane.raw);
      if (v) {
        if (judged > 1) v.reason = `${v.reason},other-lane`;
        return done(v);
      }
      if (signal.aborted) break;
    }
    if (!judged) return done({ kind: "silent", line: null, reason: `${why},generator:${lastErr?.message ?? "none"}`.slice(0, 120), ms: now() - t0 });
    // QUICK with no bridge that passes: the answer is seconds away, too soon for a retry to help.
    if (bridgeRejected) return done({ kind: "silent", line: null, reason: `${tag()},quick,bridge-rejected:${bridgeRejected}`, ms: now() - t0, quick: true });
    if (signal.aborted || now() - t0 > FRONT_VOICE_RETRY_WITHIN_MS) break;
    // The retry is a new line: a claim made by the rejected one is still standing (the arbiter releases on the verdict).
  }
  return done({ kind: "silent", line: null, reason: `${why},rejected:${rejected}`, ms: now() - t0 });
}

/** What a gate lane needs (a WarmFrontVoice; a fake in tests). */
export interface GateLane {
  readonly uses: number;
  warm(): void;
  ask(content: string, signal: AbortSignal, onPartial?: (text: string) => void): Promise<string>;
  close(): void;
}

/**
 * The gate's model for one call: two warm fast-model processes raced, as the
 * front voice does (a process's latency is sticky; two make the budget), with
 * the gate's own system prompt. Replaces the front voice's lanes on the calls
 * that use it, so a call holds no more processes than before.
 */
export class FrontGate {
  private readonly lanes: GateLane[];
  readonly persona: FrontVoicePersona;
  private readonly makeLane: () => GateLane;

  /** Its prompt asks for a bridge with QUICK (voice step 6): the native calls' gate. */
  readonly bridge: boolean;

  constructor(model: string, persona: FrontVoicePersona = MICHAEL_DEFAULT, lanes = 2, makeLane?: () => GateLane, opts: { bridge?: boolean } = {}) {
    this.persona = persona;
    this.bridge = opts.bridge === true;
    const system = frontGateSystemPrompt(persona, readStyleCard(persona), { bridge: this.bridge });
    const prime = frontGatePrompt(`Hey ${persona.agent}, you there?`, true, [], [], undefined, persona);
    // Partials on: the tag is read off the first streamed words (voice step 4).
    this.makeLane = makeLane ?? (() => new WarmFrontVoice(model, "low", system, prime, persona, true));
    this.lanes = Array.from({ length: Math.max(1, lanes) }, () => this.makeLane());
  }

  /** Set by close(): no lane is warmed or replaced after the call is over. */
  private closed = false;

  warm(): void {
    if (this.closed) return;
    for (const l of this.lanes) l.warm();
  }

  readonly ask: GateAsk = (content, signal, onPartial) => {
    const race = Promise.any(this.lanes.map((l) => l.ask(content, signal, onPartial))).catch((err: AggregateError) => {
      throw err.errors?.[0] ?? err;
    });
    void race.then(
      () => this.recycle(),
      () => this.recycle(),
    );
    return race;
  };

  /**
   * The same request to every lane, each answer on its own (frontGateFor's
   * `askEach`): a line one lane got wrong can be taken from the other. The
   * same processes and requests as `ask` — only the waiting differs.
   */
  readonly askEach: GateAskEach = (content, signal, onPartial) => {
    const each = this.lanes.map((l, i) => l.ask(content, signal, onPartial ? (text) => onPartial(i, text) : undefined));
    void Promise.allSettled(each).then(() => this.recycle());
    return each;
  };

  /**
   * A speculative request on ONE lane (voice step 6): a draft on his partial
   * words, at a pause. A lane answers its requests in order, so a guess sent
   * to both lanes made the turn's real ask (his whole thought, 0.3–0.6 s
   * later) wait behind it on both — its first word came 1.3 s+ after it was
   * asked, and "One sec." went first. The guess now takes the first
   * lane only; the other is free for the real ask. CALL_DRAFT_ONE_LANE=off.
   */
  readonly askOne: GateAskEach = (content, signal, onPartial) => {
    const lane = this.lanes[0];
    const one = lane.ask(content, signal, onPartial ? (text) => onPartial(0, text) : undefined);
    void one.then(
      () => this.recycle(),
      () => this.recycle(),
    );
    return [one];
  };

  /** One lane at a time is replaced after a few turns, as the front voice does (its context drifts). */
  private recycle(): void {
    // An ask that settles after close() must not start a replacement process
    // that nothing will ever close.
    if (this.closed || this.lanes.length < 2) return;
    const i = this.lanes.findIndex((l) => l.uses >= FRONT_VOICE_RECYCLE_AFTER);
    if (i < 0 || this.lanes.some((l, j) => j !== i && l.uses < 2)) return;
    this.lanes[i].close();
    this.lanes[i] = this.makeLane();
    this.lanes[i].warm();
  }

  close(): void {
    this.closed = true;
    for (const l of this.lanes) l.close();
  }
}

/* ── The native call's use of the gate (voice-speed) ─────────────────
   The app call and the phone run the same gate as the ElevenLabs call:
   index.ts asks it at the start of every turn, beside the main brain. */

/** The gate's verdict as a line for the turn's downlink (turn-audio.ts runFrontVoiceTurn). */
export interface GateLine {
  line: string | null;
  reason?: string;
  /** A FULL reply: it is the whole answer. */
  answer?: boolean;
  /** A QUICK verdict's bridge (voice step 6): the answer follows straight on it. */
  bridge?: boolean;
  /** The verdict itself, for the turn log. */
  verdict?: GateVerdict;
}

/**
 * Map a verdict to what the downlink plays. `mayAnswer` false (a turn whose
 * answer is already complete — a committed speculative turn): a FULL reply is
 * not used at all, since the real answer is about to play.
 */
export async function gateLine(verdict: Promise<GateVerdict>, mayAnswer: boolean): Promise<GateLine> {
  const g = await verdict;
  if (g.quick && g.bridge) return { line: g.bridge, bridge: true, verdict: g };
  if (!g.line || g.kind === "silent") return { line: null, reason: `gate-silent:${g.reason}`.slice(0, 120), verdict: g };
  if (g.kind === "full") {
    if (!mayAnswer) return { line: null, reason: "gate-full-unused", verdict: g };
    return { line: g.line, answer: true, verdict: g };
  }
  return { line: g.line, verdict: g };
}

/** What the fast voice settled alone, said to the main brain on its next turn (as the ElevenLabs call does). */
export function fastAnswersNote(fast: readonly { heard: string; said: string }[]): string {
  if (!fast.length) return "";
  return `(Earlier on this call your fast voice answered these itself, without you: ${fast
    .map((f) => `he said "${f.heard.slice(0, 200)}", you said "${f.said.slice(0, 200)}"`)
    .join("; ")}.)\n\n`;
}
