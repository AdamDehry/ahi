import type { Language } from "./ui-prefs.js";

/** More than a third Hebrew letters: speak it as Hebrew. */
export function isMostlyHebrew(text: string): boolean {
  return (text.match(/[\u0590-\u05FF]/g)?.length ?? 0) > text.length * 0.3;
}

/**
 * The language a piece of text is written in: any Hebrew letter makes it Hebrew (a Hebrew sentence with
 * "David Cohen" in it is still Hebrew), Latin letters alone English, no letters at all null.
 */
export function textLanguage(text: string): Language | null {
  if (/[\u0590-\u05FF]/.test(text)) return "he";
  return /[A-Za-z]/.test(text) ? "en" : null;
}

/**
 * Cartesia's `language` for one piece of speech: the language the text is written in, so a Hebrew owner who
 * switches to English is spoken to in English; `fallback` (the caller's Settings language) only when the text
 * has no letters to go by. An install that configured a language other than the English default keeps it.
 */
export function cartesiaLanguage(configured: string, text = "", fallback: Language = "en"): string {
  if (configured !== "en") return configured;
  return textLanguage(text) ?? fallback;
}
