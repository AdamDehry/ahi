import { FRONT_VOICE_MODEL_DEFAULT, WarmFrontVoice } from "./front-voice.js";

/* ============================================================
   ack-gate.ts — silent acknowledgements on a call (10/13 1:18 PM).

   When the owner's turn only acknowledges what Michael just said — "okay",
   "got it", "cool", "amazing", "thanks" — with no question and no new
   instruction, the call says nothing and spends no TTS and no model turn.

   ── Two checks, both must say ACK ────────────────────────────────────────
   1. Lexical (instant, here): the WHOLE utterance is made of acknowledgement
      phrases and nothing else — no question mark, no other word. And if
      Michael's last line offered something or asked something, a plain
      "yes / okay / sure / sounds good" is his ANSWER, not an ack. Directive
      phrases ("go ahead", "do it", "go for it", "send it") are never acks:
      after an offer they are an instruction, and without one they are
      unclear — both are real turns.
   2. The fast front voice's model (Haiku, a warm process of its own) reads
      Michael's last line and the owner's words and answers ACK or TURN.

   Anything else — a timeout, an error, a model that says something other
   than ACK — is a real turn. False silence is worse than a short line.

   ── Never through the turn gate ──────────────────────────────────────────
   An ack is decided BEFORE the turn gate and never submitted to it, so an
   "okay" said while Michael is working (writing a brief, running a build)
   does not supersede and abort that work.
   ============================================================ */

/** Phrases that, alone or chained, only acknowledge. Lowercase, punctuation stripped. */
const ACK_PHRASES = [
  "ok", "okay", "kay", "k", "okey dokey", "alright", "all right", "right", "right on",
  "got it", "gotcha", "i got it", "understood", "makes sense", "fair enough", "fair", "noted",
  "cool", "very cool", "amazing", "awesome", "great", "perfect", "nice", "very nice", "good", "very good",
  "excellent", "fantastic", "wonderful", "beautiful", "love it", "love that", "lovely", "brilliant", "sweet",
  "thanks", "thank you", "thanks a lot", "thank you so much", "thanks so much", "appreciate it", "much appreciated",
  "cheers", "sounds good", "sounds great", "that works", "works for me", "good stuff", "nice one",
  "yeah", "yep", "yup", "yes", "sure", "mhm", "mm hmm", "mmhmm", "uh huh", "copy", "copy that", "roger", "roger that",
  "interesting", "wow", "oh wow", "i see", "ah i see", "okay cool", "cool cool", "bet", "word",
];

/** Words that carry no content of their own around an ack ("oh okay, thanks Michael"). */
const PADDING = new Set(["oh", "ah", "um", "uh", "hm", "hmm", "so", "well", "michael", "miriam", "man", "buddy", "bro", "and", "then"]);

/**
 * Could be an ANSWER to something Michael offered or asked. After an offer,
 * these are a real turn ("Want me to send it?" → "Yes").
 */
const ASSENT = new Set(["ok", "okay", "kay", "k", "alright", "all right", "yeah", "yep", "yup", "yes", "sure", "sounds good", "sounds great", "that works", "works for me", "perfect", "great", "cool", "right", "love it", "copy", "copy that", "roger", "bet"]);

/** Never an ack: an instruction after an offer, unclear without one. */
const DIRECTIVE = /\b(go ahead|go for it|do it|do that|let'?s do|let'?s go|send it|ship it|proceed|carry on|keep going|continue|start|launch|run it|please|yes please)\b/;

/** Michael's last line offered an action or asked something. */
const OFFER = /\?|\b(want me to|should i|shall i|would you like|do you want|if you want|if you'?d like|i can\b|i could\b|say the word|your call|let me know|happy to)\b/i;

export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9?' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PHRASES = [...new Set(ACK_PHRASES)]
  .map((p) => p.split(" "))
  .sort((a, b) => b.length - a.length);

/** Covers `tokens` entirely with ack phrases (and padding); returns the phrases used, or null. */
function coverWithAcks(tokens: string[]): string[] | null {
  const used: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (PADDING.has(tokens[i])) {
      i++;
      continue;
    }
    const hit = PHRASES.find((p) => p.every((w, k) => tokens[i + k] === w));
    if (!hit) return null;
    used.push(hit.join(" "));
    i += hit.length;
  }
  return used.length ? used : null;
}

/** Every phrase only acknowledges and none could be an answer ("yes", "okay", "sure"). */
export function strongAck(phrases: string[]): boolean {
  return phrases.length > 0 && phrases.every((p) => !ASSENT.has(p));
}

/** Starts a question even when the recognizer left off the question mark. */
const QUESTION_LEAD = /^(what|whats|what's|why|how|hows|how's|when|where|who|whose|which|is|isn't|are|aren't|was|were|do|does|did|don't|can|can't|could|would|will|won't|should|shall|have|has|am)\b/;

/** The last sentence of what the agent said — the thing the caller is answering. */
function lastSentence(line: string): string {
  const parts = line.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * Why an utterance can never be thrown away as echo, or null when nothing
 * protects it (B2). A question, a directive, or anything said after
 * Michael's last sentence offered or asked something is the caller's turn,
 * whatever words it shares with what he said: "I can send the file to your
 * email." → "Send the file." is an instruction, not his own voice.
 */
export function echoProtection(heard: string, lastAgentLine: string | null): string | null {
  if (heard.includes("?")) return "question";
  const norm = normalizeUtterance(heard).replace(/\?/g, "");
  if (QUESTION_LEAD.test(norm)) return "question";
  if (DIRECTIVE.test(norm)) return "directive";
  if (lastAgentLine && OFFER.test(lastSentence(lastAgentLine))) return "answers-offer";
  return null;
}

/** Longest common subsequence length — word ORDER counts, not just membership. */
function orderedOverlap(a: string[], b: string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

/** What the server knows about WHEN the caller spoke, relative to the agent's audio. */
export interface EchoEvidence {
  /** The utterance began while the agent's last reply was audible (voice/echo-window.ts). */
  duringPlayout: boolean;
}

/**
 * Michael's own reply coming back through the owner's mic and committed as if
 * The owner said it. All of these must hold, so a real turn is never dropped:
 *   - timing: the utterance STARTED while that reply was playing (an echo
 *     cannot begin after the speaker went quiet);
 *   - nothing protects it (`echoProtection`: no question, no directive, not
 *     an answer to an offer);
 *   - at least three words, and 80% of them appear IN ORDER in what Michael
 *     just said — reordered words that merely share a vocabulary are speech.
 * Originally this was vocabulary overlap alone, at any time after the
 * reply, and "Send the file." after "I can send the file to your email." was
 * dropped as echo (B2).
 */
export function looksLikeEcho(heard: string, lastAgentLine: string | null, evidence: EchoEvidence = { duringPlayout: false }): boolean {
  if (!evidence.duringPlayout || !lastAgentLine) return false;
  const h = normalizeUtterance(heard).replace(/\?/g, "").split(" ").filter(Boolean);
  if (h.length < 3) return false;
  if (echoProtection(heard, lastAgentLine)) return false;
  const said = normalizeUtterance(lastAgentLine).replace(/\?/g, "").split(" ").filter(Boolean);
  return orderedOverlap(h, said) / h.length >= 0.8;
}

export type AckVerdict = { ack: true; phrases: string[] } | { ack: false; reason: string };

/** The instant lexical check. `lastAgentLine` is what Michael said just before. */
export function lexicalAck(heard: string, lastAgentLine: string | null): AckVerdict {
  const raw = heard.trim();
  if (!raw) return { ack: false, reason: "empty" };
  if (raw.includes("?")) return { ack: false, reason: "question" };
  const norm = normalizeUtterance(raw).replace(/\?/g, "");
  const tokens = norm.split(" ").filter(Boolean);
  if (tokens.length > 8) return { ack: false, reason: "long" };
  if (DIRECTIVE.test(norm)) return { ack: false, reason: "directive" };
  const phrases = coverWithAcks(tokens);
  if (!phrases) return { ack: false, reason: "content" };
  if (lastAgentLine && OFFER.test(lastAgentLine) && phrases.some((p) => ASSENT.has(p))) {
    return { ack: false, reason: "answers-offer" };
  }
  return { ack: true, phrases };
}

/** Who is on the call: the agent and the caller, by display name. */
export interface AckNames {
  agent: string;
  user: string;
}
const MICHAEL_DEFAULT: AckNames = { agent: "Michael", user: "the owner" };

export function ackGateSystemPrompt(n: AckNames = MICHAEL_DEFAULT): string {
  const { agent: A, user: U } = n;
  const his = A === "Michael" && U === "the owner" ? "his" : "their";
  return [
    `You classify ONE turn of a live phone call between ${U} and ${his} assistant ${A}.`,
    `You see what ${A} just said and what ${U} said back.`,
    "Answer with exactly one word.",
    `ACK — ${U}'s words ONLY acknowledge what ${A} said: thanks, okay, got it, cool, amazing. No question, no request, no new information, and not an approval of something ${A} offered to do.`,
    `TURN — anything else: a question, a request, new information, an answer to something ${A} asked, approval of an offered action, or anything you are unsure about.`,
    "If in doubt, TURN.",
  ].join("\n");
}

export const ACK_GATE_SYSTEM_PROMPT = ackGateSystemPrompt();

export function ackGatePrompt(heard: string, lastAgentLine: string | null, n: AckNames = MICHAEL_DEFAULT): string {
  const said = (lastAgentLine ?? "").replace(/\s+/g, " ").trim().slice(-400) || "(nothing yet)";
  return `${n.agent} just said: «${said}»\n${n.user}: «${heard.trim().slice(0, 200)}»\nACK or TURN?`;
}

/** The model's answer → ACK only on an unambiguous ACK. */
export function parseAckAnswer(text: string): boolean {
  return /^["'«]?ack["'»]?\.?$/i.test(text.trim());
}

/** What the gate asks the model; a warm Haiku process in production, a fake in tests. */
export type AckAsker = (content: string, signal: AbortSignal) => Promise<string>;

export interface AckDecision {
  silent: boolean;
  /** Why it was or wasn't silent — for the log and telemetry. */
  reason: string;
  ms: number;
}

/**
 * Decide one utterance. Resolves quickly for anything that is plainly a real
 * turn (no model call at all); otherwise waits for the model, bounded.
 */
export async function decideAck(opts: {
  heard: string;
  lastAgentLine: string | null;
  ask: AckAsker | null;
  timeoutMs?: number;
  now?: () => number;
  names?: AckNames;
  /** Aborts the model call — the call hung up (turn-intake.ts). */
  signal?: AbortSignal;
}): Promise<AckDecision> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  // Nothing said yet: an opening "okay" starts the conversation, it doesn't end one.
  if (!opts.lastAgentLine?.trim()) return { silent: false, reason: "nothing-to-ack", ms: now() - t0 };
  const lex = lexicalAck(opts.heard, opts.lastAgentLine);
  if (!lex.ack) return { silent: false, reason: `lexical:${lex.reason}`, ms: now() - t0 };
  if (!opts.ask) return { silent: false, reason: "no-model", ms: now() - t0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 1_200);
  const onAbort = (): void => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const answer = await opts.ask(ackGatePrompt(opts.heard, opts.lastAgentLine, opts.names), controller.signal);
    const ack = parseAckAnswer(answer);
    return { silent: ack, reason: ack ? "model:ack" : `model:${answer.trim().slice(0, 20) || "empty"}`, ms: now() - t0 };
  } catch (err) {
    // Part seven (18:33Z): a lone "Awesome." over a reply fell through here
    // when the model timed out, became a turn, and was answered. A pure
    // acknowledgement that cannot be an answer to anything ("awesome",
    // "thanks", "got it" — nothing from ASSENT) is silent on the lexical
    // check alone; anything that could be an answer still fails open.
    const why = (err as Error).message.slice(0, 40);
    if (strongAck(lex.phrases)) return { silent: true, reason: `lexical-strong (model-failed:${why})`, ms: now() - t0 };
    return { silent: false, reason: `model-failed:${why}`, ms: now() - t0 };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

export function silentAcksEnabled(botName: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[`${botName.toUpperCase()}_SILENT_ACKS`] ?? env.SILENT_ACKS ?? "on").toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

/** One warm Haiku process per call, for the ack gate only. */
export function createAckClassifier(
  model = process.env.FRONT_VOICE_MODEL || FRONT_VOICE_MODEL_DEFAULT,
  names: AckNames = MICHAEL_DEFAULT,
): {
  ask: AckAsker;
  warm(): void;
  close(): void;
} {
  const proc = new WarmFrontVoice(model, "low", ackGateSystemPrompt(names), ackGatePrompt("Okay.", "Calling you now.", names));
  return { ask: (c, s) => proc.ask(c, s), warm: () => proc.warm(), close: () => proc.close() };
}
