/**
 * The redesign's page model and URL contract (slice 1).
 *
 * A Page is a rail/dock destination; a View is the existing store's screen.
 * Old views live on as tabs/folders of the new pages, so every existing deep
 * link (#builds/<id>, #whatsapp/<key>, #feed, ?review=, ?settings=) keeps
 * landing, and the new history routes are `#/page[/sub[/id]]`.
 */
import type { View } from "../store";
import type { IconName } from "./icons";

export type Page =
  | "home" | "today" | "messages" | "work" | "documents" | "finances" | "vault"
  | "whatsapp" | "gmail" | "team" | "connections" | "settings";

export const PAGE_OF: Record<View, Page> = {
  home: "home", today: "today", messages: "messages",
  builds: "work", feed: "work", review: "work", live: "work",
  documents: "documents", files: "documents", clipboard: "documents", "mission-control": "documents",
  costs: "finances", bills: "finances",
  vault: "vault", whatsapp: "whatsapp", gmail: "gmail", team: "team", connections: "connections",
};

/** Views only an admin may open (mirrors the current VIEW_META gate and the server's). */
export const ADMIN_VIEWS: ReadonlySet<View> = new Set<View>(["feed", "builds", "review", "live", "whatsapp", "costs", "vault", "today"]);

export function canOpen(view: View, admin: boolean): boolean {
  return admin || !ADMIN_VIEWS.has(view);
}

export interface Dest { page: Page; label: string; icon: IconName; view: View }

/** Rail order, FINAL: primary four, then Your world, then the bottom group. */
export const PRIMARY: Dest[] = [
  { page: "home", label: "Home", icon: "home", view: "home" },
  { page: "today", label: "Today", icon: "today", view: "today" },
  { page: "messages", label: "Messages", icon: "messages", view: "messages" },
  { page: "work", label: "Your work", icon: "layers", view: "builds" },
];
export const WORLD: Dest[] = [
  { page: "documents", label: "Documents", icon: "folder", view: "documents" },
  { page: "finances", label: "Finances", icon: "wallet", view: "costs" },
  { page: "vault", label: "Vault", icon: "shield", view: "vault" },
  { page: "gmail", label: "Gmail", icon: "gmail", view: "gmail" },
];
export const BOTTOM: Dest[] = [
  { page: "team", label: "Your team", icon: "people", view: "team" },
  { page: "connections", label: "Connections", icon: "plug", view: "connections" },
];

/** Tabs inside a page, in FINAL order. */
export const TABS: Partial<Record<Page, Array<{ view: View; label: string }>>> = {
  work: [
    { view: "builds", label: "Builds" }, { view: "feed", label: "Feed" },
    { view: "review", label: "Review" }, { view: "live", label: "Live sessions" },
  ],
  finances: [{ view: "costs", label: "Operating costs" }, { view: "bills", label: "Personal bills" }],
  documents: [
    { view: "documents", label: "All documents" }, { view: "files", label: "Uploads" },
    { view: "clipboard", label: "Clips" }, { view: "mission-control", label: "Mission control" },
  ],
};

/** The view a page opens on for this user: its first tab they may open. */
export function entryView(page: Page, admin: boolean): View | null {
  const tabs = TABS[page];
  if (tabs) return tabs.find((t) => canOpen(t.view, admin))?.view ?? null;
  const d = [...PRIMARY, ...WORLD, ...BOTTOM].find((x) => x.page === page);
  return d && canOpen(d.view, admin) ? d.view : null;
}

export function pageVisible(page: Page, admin: boolean): boolean {
  return page === "settings" || entryView(page, admin) !== null;
}

export const PAGE_TITLE: Record<Page, string> = {
  home: "Home", today: "Today", messages: "Messages", work: "Your work", documents: "Documents",
  finances: "Finances", vault: "Vault", whatsapp: "WhatsApp", gmail: "Gmail", team: "Your team",
  connections: "Connections", settings: "Settings",
};

/* ── URL contract ──────────────────────────────────────────────────────── */

export interface RouteState {
  view: View;
  settingsOpen: boolean;
  activeBot: string | null;
  buildsItem: string | null;
  reviewItem: string | null;
  waKey: string | null;
}

const VIEW_SLUG: Record<View, string> = {
  home: "home", today: "today", messages: "messages",
  builds: "work/builds", feed: "work/feed", review: "work/review", live: "work/live",
  documents: "documents", files: "documents/uploads", clipboard: "documents/clips", "mission-control": "documents/mission-control",
  costs: "finances/costs", bills: "finances/bills",
  vault: "vault", whatsapp: "whatsapp", gmail: "gmail", team: "team", connections: "connections",
};
const SLUG_VIEW = new Map<string, View>(Object.entries(VIEW_SLUG).map(([v, s]) => [s, v as View]));

/** State → `#/…`. Item ids ride the URL only where they already do today (build, review, WhatsApp HMAC key). */
export function routeToHash(r: RouteState): string {
  if (r.settingsOpen) return "#/settings";
  const base = `#/${VIEW_SLUG[r.view]}`;
  if (r.view === "messages" && r.activeBot) return `${base}/${encodeURIComponent(r.activeBot)}`;
  if (r.view === "builds" && r.buildsItem) return `${base}/${encodeURIComponent(r.buildsItem)}`;
  if (r.view === "review" && r.reviewItem) return `${base}/${encodeURIComponent(r.reviewItem)}`;
  if (r.view === "whatsapp" && r.waKey) return `${base}/${r.waKey}`;
  return base;
}

export interface ParsedRoute { view: View | null; page: Page | null; settings: boolean; id: string | null }

/** `#/…` → route, or null when the hash is not a redesign route (old deep links stay with App.tsx). */
export function hashToRoute(hash: string): ParsedRoute | null {
  if (!hash.startsWith("#/")) return null;
  const parts = hash.slice(2).split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "settings") return { view: null, page: "settings", settings: true, id: null };
  for (const take of [2, 1]) {
    const view = SLUG_VIEW.get(parts.slice(0, take).join("/"));
    if (view) return { view, page: PAGE_OF[view], settings: false, id: parts[take] ?? null };
  }
  // A page slug with no sub (#/work, #/finances): the page's entry decides the view.
  const page = (parts[0] && Object.prototype.hasOwnProperty.call(PAGE_TITLE, parts[0]) ? parts[0] : null) as Page | null;
  return page ? { view: null, page, settings: false, id: null } : null;
}

/** An old deep link (#builds/<id>, #whatsapp/<key>, #feed) that App.tsx routes, not the redesign router. */
export function isHashRoute(hash: string): boolean {
  return /^#(builds|whatsapp|feed)(?:\/|$)/.test(hash);
}
