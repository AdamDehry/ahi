/**
 * Which build questions a send answers (answer-clears-question).
 *
 * Answer in thread quotes a card's question into the composer and leaves an
 * AnswerLink: the run, the exact needs_operator record and the quoted block. On
 * send, a question's answer is ONLY the text under its quote block, up to the
 * next quote. Text before the first quote never counts, so quoting A then B
 * and typing under B answers B alone. Nothing under a quote means no clear.
 * Past MAX_ANSWERS a quote is simply not linked; that card keeps asking.
 */
import type { AnswerLink } from "./cache";

/** Same cap as the gateway (src/foreman-messages/answer.ts MAX_ANSWERS) — a test holds them equal. */
export const MAX_ANSWERS = 5;

/** What /app/send carries per answered question. */
export interface SentAnswer {
  build: string;
  record: string;
  added: string;
}

const QUOTE_LINE = /^\s*>/;

/** The text under this link's quote (its last copy, if quoted twice), up to the next quoted line. */
export function addedWords(text: string, link: AnswerLink): string {
  const at = text.lastIndexOf(link.quote);
  if (at < 0) return "";
  const under: string[] = [];
  for (const line of text.slice(at + link.quote.length).split("\n")) {
    if (QUOTE_LINE.test(line)) break;
    under.push(line);
  }
  return under.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The answers one send carries: each linked question with words under its quote. Every link is spent by the send. */
export function answersFor(links: AnswerLink[], text: string): SentAnswer[] {
  const out: SentAnswer[] = [];
  for (const link of links.slice(0, MAX_ANSWERS)) {
    const added = addedWords(text, link);
    if (added) out.push({ build: link.build, record: link.record, added });
  }
  return out;
}
