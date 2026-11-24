/**
 * The app's language: one string catalog (English is the source, every other
 * language a full translation — the type system and a test refuse a missing
 * key), the current language, and the root `lang`/`dir` that turn the whole
 * layout right to left for Hebrew.
 *
 * The owner's choice is saved on the server (/ui/prefs) and arrives with the
 * session; this module caches it in localStorage so the next load (and the
 * sign-in screen) opens in the right language before the session answers.
 */
import { useSyncExternalStore } from "react";
import { EN, CATALOGS, type Key } from "./catalog";

export type { Key } from "./catalog";
export type Lang = "en" | "he";
export const LANGS: readonly Lang[] = ["en", "he"];
/** Each language's name in its own script — the picker shows these, never translated. */
export const LANG_NAMES: Record<Lang, string> = { en: "English", he: "עברית" };

const RTL = new Set<Lang>(["he"]);
const LOCALES: Record<Lang, string> = { en: "en-US", he: "he-IL" };
const STORE_KEY = "ahi-lang";

export function isLang(v: unknown): v is Lang {
  return typeof v === "string" && (LANGS as readonly string[]).includes(v);
}

/** The browser's own language when it is one we have, else English. */
export function browserLang(): Lang {
  const langs = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const l of langs) {
    const base = (l || "").toLowerCase().split("-")[0];
    if (base === "iw") return "he"; // the old code some systems still report
    if (isLang(base)) return base;
  }
  return "en";
}

function readStored(): Lang | null {
  try {
    const v = globalThis.localStorage?.getItem(STORE_KEY);
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}

let current: Lang = readStored() ?? browserLang();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}
export const isRtl = (lang: Lang = current): boolean => RTL.has(lang);
/** BCP-47 locale for Intl formatting (dates, numbers) in the current language. */
export const locale = (lang: Lang = current): string => LOCALES[lang];

/** Root attributes: `lang` for fonts, screen readers and hyphenation; `dir` flips the layout. */
function applyRoot(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.lang = current;
  root.dir = isRtl() ? "rtl" : "ltr";
}

/** Switch language now (no reload). `remember` keeps it for the next load. */
export function setLang(lang: Lang, remember = true): void {
  if (remember) {
    try {
      globalThis.localStorage?.setItem(STORE_KEY, lang);
    } catch {
      /* private mode: this session still switches */
    }
  }
  if (lang === current) return applyRoot();
  current = lang;
  applyRoot();
  for (const l of listeners) l();
}

/** Boot-time: before the first render, so the first paint is already in the right direction. */
export function initLang(): void {
  applyRoot();
}

export function onLangChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export type Params = Record<string, string | number>;

/** First-strong isolate … pop: keeps a Latin name, number or path inside a Hebrew sentence in its own direction. */
const isolate = (v: string): string => `⁨${v}⁩`;

function format(template: string, params: Params | undefined, lang: Lang): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!(name in params)) return whole;
    const raw = params[name];
    const v = typeof raw === "number" ? raw.toLocaleString(LOCALES[lang]) : raw;
    return RTL.has(lang) && v ? isolate(v) : v;
  });
}

/** Translate `key` in the current language; `{name}` placeholders take `params`. */
export function t(key: Key, params?: Params): string {
  return format(CATALOGS[current][key] ?? EN[key] ?? key, params, current);
}

/** Keys that come in `_one` / `_other` pairs, named without the suffix. */
export type PluralKey = Key extends infer K ? (K extends `${infer B}_other` ? (`${B}_one` extends Key ? B : never) : never) : never;

/** Count-dependent text: `key_one` when n is 1, `key_other` otherwise; `{n}` is the count. */
export function tn(key: PluralKey, n: number, params?: Params): string {
  return t(`${key}_${n === 1 ? "one" : "other"}` as Key, { n, ...params });
}

const subscribe = (fn: () => void) => onLangChange(fn);

/** Re-render when the language changes. Returns the current language. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

/**
 * The hook a component uses: `const t = useT()` then `t("chat.send")`.
 * Subscribing is the point — the component re-renders when the owner switches
 * language, with no reload.
 */
export function useT(): typeof t {
  useLang();
  return t;
}
