/**
 * The redesign's shared frame (slice 1): one rounded content canvas inside a
 * continuous outer chrome — the rail on the left, the top bar across, no seam
 * between them (FINAL 13-DESIGN). On a phone the rail becomes a full menu and
 * the four primary destinations sit in a bottom dock, menu bottom-right.
 *
 * Navigation goes through the existing store actions only, so a destination
 * change never touches drafts, the open thread or the live call (CallHost is
 * mounted above this frame in App.tsx).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { actions, availableBots, getState, subscribe, useAppState, type View } from "../store";
import { applyThemeMode, getThemeMode, onThemeModeChange } from "../theme";
import { scheduleUi, useScheduleUi, badgeText } from "../lib/schedule";
import { BOT_LABELS } from "../lib/types";
import { Icon } from "./icons";
import GlobalSearch from "./Search";
import BellInbox, { bellCount, useBellSources } from "./Bell";
import { playTone } from "../lib/tones";

/** Shortcuts per platform — ⌘J / ⌘K on a Mac (and iPad), Ctrl J / Ctrl K on Windows and Linux. */
const IS_MAC = (() => {
  const nav = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  return /mac|iphone|ipad|ipod/i.test(nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || "");
})();
export const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl";
const modDown = (e: KeyboardEvent): boolean => (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
import { BOTTOM, PAGE_OF, PRIMARY, WORLD, canOpen, entryView, pageVisible, type Dest, type Page } from "./nav";

const WORLD_KEY = "ahi-rail-world-open";

export function currentPage(view: View, settingsOpen: boolean): Page {
  return settingsOpen ? "settings" : PAGE_OF[view];
}

/** Last tab per tabbed page this session: Work and Finances reopen "with their current tab" (register: action:work, action:finances). */
const lastTab: Partial<Record<Page, View>> = {};
subscribe(() => {
  const st = getState();
  if (!st.settingsOpen) lastTab[PAGE_OF[st.view]] = st.view;
});

/**
 * Navigate to a page's entry view. Authorization comes from the current
 * session, never from the caller (review R1-A1: a hard-coded `true` let a
 * member reach Today from the bell).
 */
export function goPage(page: Page): void {
  const admin = !!getState().user?.admin;
  if (page === "settings") {
    actions.toggleSettings(true);
    return;
  }
  const remembered = lastTab[page];
  const v = remembered && canOpen(remembered, admin) ? remembered : entryView(page, admin);
  if (!v) return;
  actions.setView(v);
  // Messages opens the lead agent's continuous chat (register: action:messages).
  // On a phone it opens straight into that conversation (FINAL: no agent list first).
  if (page === "messages") {
    const bots = availableBots(getState().user);
    const current = getState().activeBot;
    const bot = current && bots.includes(current) ? current : bots.includes("michael") ? "michael" : bots[0];
    if (bot) actions.openMobileThread(bot);
  }
}

function useResolvedTheme(): "light" | "dark" {
  const read = (): "light" | "dark" => (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
  const [t, setT] = useState<"light" | "dark">(read);
  useEffect(() => onThemeModeChange(() => setT(read())), []);
  return t;
}

function initials(name: string | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "·";
}

/** Count chip per page (admin badges that exist today, FP-013). */
function useCounts(): Partial<Record<Page, number>> {
  const s = useAppState();
  const admin = !!s.user?.admin;
  if (!admin) return {};
  return { work: s.buildsNeedYou + s.reviewWaiting, whatsapp: s.waWaiting };
}

function NavItem({ d, active, count, onGo, collapsed, extra }: { d: Dest; active: boolean; count?: number; onGo: () => void; collapsed?: boolean; extra?: ReactNode }) {
  return (
    <button
      type="button"
      className={`rd-nav-item${active ? " active" : ""}`}
      aria-current={active ? "page" : undefined}
      title={collapsed ? d.label : undefined}
      onClick={onGo}
    >
      <Icon name={d.icon} />
      <span className="rd-nav-label">{d.label}</span>
      {!!count && <span className="rd-nav-count" aria-label={`${count} need you`}>{count}</span>}
      {extra}
    </button>
  );
}

/** The rail (desktop) and the full menu (phone): one component, same destinations. */
export function Rail({ onNavigate, phone = false }: { onNavigate?: () => void; phone?: boolean }) {
  const s = useAppState();
  const admin = !!s.user?.admin;
  const page = currentPage(s.view, s.settingsOpen);
  const counts = useCounts();
  const collapsed = !phone && s.sidebarCollapsed;
  const [worldOpen, setWorldOpen] = useState(() => localStorage.getItem(WORLD_KEY) !== "0");
  const bots = availableBots(s.user);
  const lead = bots.includes("michael") ? "michael" : bots[0];
  const go = (p: Page) => {
    goPage(p);
    onNavigate?.();
  };
  const show = (d: Dest) => pageVisible(d.page, admin);
  return (
    <aside className={`rd-rail${collapsed ? " collapsed" : ""}${phone ? " phone" : ""}`} aria-label="Workspace navigation">
      {lead && (
        <button
          type="button"
          className="rd-new-chat"
          title={collapsed ? `Message ${BOT_LABELS[lead] ?? lead}` : undefined}
          onClick={() => {
            actions.setView("messages");
            actions.setActiveBot(lead);
            onNavigate?.();
          }}
        >
          <Icon name="messages" />
          <span className="rd-nav-label">Message {BOT_LABELS[lead] ?? lead}</span>
          {!phone && <span className="rd-key">{MOD_LABEL} J</span>}
        </button>
      )}
      <nav className="rd-main-nav" aria-label="Main">
        {PRIMARY.filter(show).map((d) => (
          <NavItem key={d.page} d={d} active={page === d.page} count={counts[d.page]} collapsed={collapsed} onGo={() => go(d.page)} />
        ))}
      </nav>
      {WORLD.some(show) && (
        <div className={`rd-world${worldOpen || collapsed ? " open" : ""}`}>
          {!collapsed && (
            <button
              type="button"
              className="rd-world-toggle"
              aria-expanded={worldOpen}
              onClick={() => {
                localStorage.setItem(WORLD_KEY, worldOpen ? "0" : "1");
                setWorldOpen(!worldOpen);
              }}
            >
              <span>YOUR WORLD</span>
              <Icon name="chevron" />
            </button>
          )}
          {(worldOpen || collapsed) && (
            <nav aria-label="Your world">
              {WORLD.filter(show).map((d) => (
                <NavItem key={d.page} d={d} active={page === d.page} count={counts[d.page]} collapsed={collapsed} onGo={() => go(d.page)} />
              ))}
            </nav>
          )}
        </div>
      )}
      <div className="rd-rail-bottom">
        {BOTTOM.filter(show).map((d) => (
          <NavItem
            key={d.page}
            d={d}
            active={page === d.page}
            collapsed={collapsed}
            onGo={() => go(d.page)}
            extra={
              d.page === "team" ? (
                <span className="rd-mini-team" aria-hidden="true">
                  {bots.slice(0, 2).map((b) => <i key={b}>{(BOT_LABELS[b] ?? b)[0]}</i>)}
                  {bots.length > 2 && <i>+{bots.length - 2}</i>}
                </span>
              ) : d.page === "connections" ? (
                <span className={`rd-conn-dot ${s.connection}`} title={s.connection === "open" ? "Connected" : "Reconnecting"} />
              ) : undefined
            }
          />
        ))}
        <button
          type="button"
          className={`rd-profile${page === "settings" ? " active" : ""}`}
          aria-label={`${s.user?.name ?? "Profile"} — settings`}
          title={collapsed ? "Settings" : undefined}
          onClick={() => go("settings")}
        >
          <span className="rd-profile-avatar">{initials(s.user?.name)}</span>
          <span className="rd-profile-text">
            {s.user?.name}
            <small>{admin ? "Personal workspace" : "Member"}</small>
          </span>
          <Icon name="chevrons" />
        </button>
      </div>
    </aside>
  );
}

function ThemeToggle() {
  const theme = useResolvedTheme();
  const [, force] = useState(0);
  useEffect(() => onThemeModeChange(() => force((n) => n + 1)), []);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="rd-icon-btn rd-theme"
      aria-label={`Switch to ${next} mode`}
      title={getThemeMode() === "system" ? "Following your device — tap to choose" : undefined}
      onClick={() => applyThemeMode(next)}
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} />
    </button>
  );
}

function CalendarButton() {
  const { open, unread } = useScheduleUi();
  const badge = badgeText(unread);
  return (
    <button
      type="button"
      className={`rd-icon-btn${open ? " on" : ""}`}
      aria-label={badge ? `Calendar, ${unread} new` : "Calendar"}
      onClick={() => (open ? scheduleUi.close() : scheduleUi.open())}
    >
      <Icon name="calendar" />
      {badge && <i className="rd-dot" aria-hidden="true" />}
    </button>
  );
}

/** Top chrome actions — search, calendar, bell, theme (FINAL header order). */
function ChromeActions({ phone = false }: { phone?: boolean }) {
  const s = useAppState();
  const admin = !!s.user?.admin;
  const [searching, setSearching] = useState(false);
  const [bell, setBell] = useState(false);
  const sessionKey = `${s.user?.userId ?? ""}:${admin ? 1 : 0}`;
  const bellRows = useBellSources(bell);
  const count = bellCount(bellRows.rows);
  // The chosen in-app cue when new activity reaches the inbox while the app is open (never on first load).
  const lastCount = useRef<number | null>(null);
  const mountedAt = useRef(Date.now());
  useEffect(() => {
    const prev = lastCount.current;
    lastCount.current = count;
    const p = bellRows.prefs;
    if (prev === null || count <= prev || Date.now() - mountedAt.current < 4000) return;
    if (p && p.inApp !== false && p.sound) playTone(p.tone);
  }, [count, bellRows.prefs]);
  // ⌘K / Ctrl+K opens search from anywhere (FINAL); it never touches drafts or the call.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modDown(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setBell(false);
        setSearching((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="rd-actions">
      <button
        type="button"
        className={phone ? "rd-icon-btn" : "rd-search"}
        aria-label="Search your workspace"
        aria-expanded={searching}
        onClick={() => (setBell(false), setSearching(true))}
      >
        <Icon name="search" />
        {!phone && <span>Search anything</span>}
        {!phone && <kbd>{MOD_LABEL} K</kbd>}
      </button>
      {admin && <CalendarButton />}
      {admin && (
      <button
        type="button"
        className={`rd-icon-btn rd-bell-btn${bell ? " on" : ""}`}
        aria-label={count ? `Notifications, ${count} new` : "Notifications"}
        aria-expanded={bell}
        onClick={() => (setSearching(false), setBell(!bell))}
      >
        <Icon name="bell" />
        {count > 0 && <i className="rd-dot" aria-hidden="true" />}
      </button>
      )}
      <ThemeToggle />
      {/* Keyed to the session (identity + role): a session change remounts them, dropping their
          cached results and any response still in flight from the previous session (review R3-2). */}
      {searching && <GlobalSearch key={sessionKey} onClose={() => setSearching(false)} />}
      {admin && bell && <BellInbox key={sessionKey} rows={bellRows.rows} refresh={bellRows.refresh} onClose={() => setBell(false)} />}
    </div>
  );
}

/** Back/Forward dim when there is nowhere to go (prototype window-back/forward), via the Navigation
 * API where the browser has it; elsewhere both stay enabled, as before. */
type NavApi = { canGoBack: boolean; canGoForward: boolean; addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void };
function readCanGo(): { back: boolean; forward: boolean } {
  const nav = (window as unknown as { navigation?: NavApi }).navigation;
  return nav && typeof nav.canGoBack === "boolean" ? { back: nav.canGoBack, forward: nav.canGoForward } : { back: true, forward: true };
}
function useCanGo(): { back: boolean; forward: boolean } {
  const [v, setV] = useState(readCanGo);
  useEffect(() => {
    const nav = (window as unknown as { navigation?: NavApi }).navigation;
    if (!nav) return;
    const on = () => setV(readCanGo());
    nav.addEventListener("currententrychange", on);
    window.addEventListener("popstate", on);
    return () => {
      nav.removeEventListener("currententrychange", on);
      window.removeEventListener("popstate", on);
    };
  }, []);
  return v;
}

/** Desktop frame. */
export function DesktopShell({ children }: { children: ReactNode }) {
  const s = useAppState();
  const canGo = useCanGo();
  const page = currentPage(s.view, s.settingsOpen);
  // ⌘J / Ctrl+J → message the lead agent (FINAL shortcut on the rail button).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modDown(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        (document.querySelector(".rd-new-chat") as HTMLButtonElement | null)?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className={`rd-app${s.sidebarCollapsed ? " rail-collapsed" : ""}`} data-page={page}>
      <header className="rd-top">
        <div className="rd-tools">
          <span className="rd-tool-nav">
            <button type="button" className="rd-tool" aria-label="Back" title="Go back" disabled={!canGo.back} onClick={() => window.history.back()}>
              <Icon name="arrow-left" />
            </button>
            <button type="button" className="rd-tool" aria-label="Forward" title="Go forward" disabled={!canGo.forward} onClick={() => window.history.forward()}>
              <Icon name="arrow-right" />
            </button>
          </span>
          <button
            type="button"
            className="rd-tool"
            aria-label={s.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!s.sidebarCollapsed}
            onClick={() => actions.toggleSidebar()}
          >
            <svg className="rd-icon rd-panel-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <rect x="3" y="4.5" width="18" height="15" rx="4" />
              <path className="rd-panel-divider" d="M9 5v14" />
            </svg>
          </button>
        </div>
        <button type="button" className="rd-brand" aria-label="AHI home" onClick={() => goPage("home")}>
          ahi<span className="rd-brand-dot">.</span>
        </button>
        <ChromeActions />
      </header>
      {/* The rail opens on a click of the collapse button only — no hover/focus peek overlay,
          so the collapsed icons stay put and clickable. */}
      <Rail />
      <main className="rd-canvas" id="main">
        {children}
      </main>
    </div>
  );
}

/** Phone frame: top chrome, the canvas, the bottom dock; the menu is the rail full-screen. */
export function PhoneShell({ children, menuOpen, setMenuOpen }: { children: ReactNode; menuOpen: boolean; setMenuOpen: (o: boolean) => void }) {
  const s = useAppState();
  const admin = !!s.user?.admin;
  const page = currentPage(s.view, s.settingsOpen);
  return (
    <div className={`rd-app phone${menuOpen ? " menu-open" : ""}`} data-page={page}>
      <header className="rd-top">
        <button type="button" className="rd-brand" aria-label="AHI home" onClick={() => (setMenuOpen(false), goPage("home"))}>
          ahi<span className="rd-brand-dot">.</span>
        </button>
        <ChromeActions phone />
      </header>
      <main className="rd-canvas" id="main">
        {children}
      </main>
      {menuOpen && (
        <div className="rd-phone-menu" role="dialog" aria-label="All destinations">
          <Rail phone onNavigate={() => setMenuOpen(false)} />
        </div>
      )}
      <nav className="rd-dock" aria-label="Primary">
        <div className="rd-dock-dest">
          {PRIMARY.filter((d) => pageVisible(d.page, admin)).map((d) => (
            <button
              key={d.page}
              type="button"
              className={`rd-dock-item${!menuOpen && page === d.page ? " active" : ""}`}
              aria-current={!menuOpen && page === d.page ? "page" : undefined}
              onClick={() => {
                setMenuOpen(false);
                goPage(d.page);
              }}
            >
              <Icon name={d.icon} />
              <span>{d.label}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`rd-dock-menu${menuOpen ? " on" : ""}`}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <Icon name={menuOpen ? "x" : "panel"} />
        </button>
      </nav>
    </div>
  );
}
