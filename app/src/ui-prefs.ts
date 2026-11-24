import { readFileSync, statSync } from "fs";
import { resolve } from "path";
import { atomicWriteJson, gatewayStateRoot } from "./multi-user-paths.js";

/**
 * Per-user interface preferences the server keeps (today: the language). Saved
 * in the gateway's state root next to bot-settings.json, read at call time so
 * the per-turn hook process (a new process each turn) sees a change at once.
 */
export type Language = "en" | "he";
export const LANGUAGES: readonly Language[] = ["en", "he"];

interface UserPrefs {
  language?: Language;
}

export const isLanguage = (v: unknown): v is Language => typeof v === "string" && (LANGUAGES as readonly string[]).includes(v);

/** Each language's English name: how the agents' context and the call gate say it. */
export const LANGUAGE_NAMES: Record<Language, string> = { en: "English", he: "Hebrew" };

const prefsFile = (): string => resolve(gatewayStateRoot(), "ui-prefs.json");

// Voice looks the owner's language up several times a second during a call, so the parsed file is kept
// until the file itself changes. Keyed on the file's identity, not a timer: the per-turn hook (its own
// process) and a save from Settings are both seen on the very next lookup.
let cache: { stamp: string; prefs: Record<string, UserPrefs> } | null = null;

function load(): Record<string, UserPrefs> {
  const path = prefsFile();
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return {};
  const stamp = `${path}:${st.ino}:${st.mtimeMs}:${st.size}`;
  if (cache?.stamp === stamp) return cache.prefs;
  let prefs: Record<string, UserPrefs> = {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) prefs = raw;
  } catch {
    /* unreadable or half-written: treat as no choices, like a missing file */
  }
  cache = { stamp, prefs };
  return prefs;
}

/** The language this user chose, or undefined when they never chose (clients then follow the device). */
export function userLanguage(userId: string | null | undefined): Language | undefined {
  if (!userId) return undefined;
  const v = load()[userId]?.language;
  return isLanguage(v) ? v : undefined;
}

export function setUserLanguage(userId: string, language: Language): void {
  const all = { ...load() };
  all[userId] = { ...all[userId], language };
  atomicWriteJson(prefsFile(), all);
  cache = null;
}

/** The English name of the language this user chose, or undefined for English and for no choice (nothing to say). */
export function nonEnglishLanguageName(userId: string | null | undefined): string | undefined {
  const lang = userLanguage(userId);
  return lang && lang !== "en" ? LANGUAGE_NAMES[lang] : undefined;
}
