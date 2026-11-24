import { getFresh } from "./api";
import type { Lang } from "../i18n";

/** How the configured voice providers handle Hebrew: both ways, only one way, or not at all. */
export type HebrewVoice = "full" | "hears" | "speaks" | "none";

export interface Prefs {
  /** Null until the user chooses; the app then follows the browser's language. */
  language: Lang | null;
  hebrewVoice: HebrewVoice;
}

export const fetchPrefs = (): Promise<Prefs | null> => getFresh<Prefs>("/ui/prefs");

export async function saveLanguage(language: Lang): Promise<boolean> {
  try {
    const res = await fetch("/ui/prefs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
