/**
 * Theme management — Light / Dark / System (design spec: respect system
 * default on first load; persist an explicit choice; toggle lives in
 * Settings, not the chrome). The browser theme-color meta tracks the
 * computed --bg so even the window chrome follows the token file.
 */
export type ThemeMode = "light" | "dark" | "system";

const KEY = "ahi-theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export function getThemeMode(): ThemeMode {
  const raw = localStorage.getItem(KEY);
  return raw === "light" || raw === "dark" ? raw : "system";
}

function resolved(mode: ThemeMode): "light" | "dark" {
  return mode === "system" ? (media.matches ? "dark" : "light") : mode;
}

function syncMetaThemeColor(): void {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (!bg) return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = bg;
}

export function applyThemeMode(mode: ThemeMode): void {
  if (mode === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, mode);
  document.documentElement.setAttribute("data-theme", resolved(mode));
  syncMetaThemeColor();
  for (const l of listeners) l(mode);
}

/** Follow OS theme changes while in system mode. */
media.addEventListener("change", () => {
  if (getThemeMode() === "system") applyThemeMode("system");
});

const listeners = new Set<(mode: ThemeMode) => void>();
export function onThemeModeChange(fn: (mode: ThemeMode) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Boot-time init — call before first render. */
export function initTheme(): void {
  document.documentElement.setAttribute("data-theme", resolved(getThemeMode()));
  syncMetaThemeColor();
}
