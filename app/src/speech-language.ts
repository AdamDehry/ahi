import { ownerLanguage } from "./users.js";

/** More than a third Hebrew letters: speak it as Hebrew. */
export function isMostlyHebrew(text: string): boolean {
  return (text.match(/[֐-׿]/g)?.length ?? 0) > text.length * 0.3;
}

/**
 * Cartesia's `language` for one piece of speech. Hebrew text is spoken as Hebrew; a stream whose text
 * isn't known when it opens follows the owner's language. An install that configured a language other
 * than the English default keeps it.
 */
export function cartesiaLanguage(configured: string, text?: string): string {
  if (configured !== "en") return configured;
  if (text !== undefined) return isMostlyHebrew(text) ? "he" : configured;
  return ownerLanguage() === "he" ? "he" : configured;
}
