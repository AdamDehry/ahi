import { existsSync, readFileSync } from "fs";
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

const prefsFile = (): string => resolve(gatewayStateRoot(), "ui-prefs.json");

function load(): Record<string, UserPrefs> {
  const path = prefsFile();
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** The language this user chose, or undefined when they never chose (clients then follow the device). */
export function userLanguage(userId: string | null | undefined): Language | undefined {
  if (!userId) return undefined;
  const v = load()[userId]?.language;
  return isLanguage(v) ? v : undefined;
}

export function setUserLanguage(userId: string, language: Language): void {
  const all = load();
  all[userId] = { ...all[userId], language };
  atomicWriteJson(prefsFile(), all);
}
