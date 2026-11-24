import { useState } from "react";
import { actions, useAppState, type View } from "../store";
import { BOT_LABELS } from "../lib/types";
import { connectionDisplay } from "../lib/connection";
import Dropdown from "./Dropdown";
import ScheduleButton from "./schedule/ScheduleButton";
import { SidebarContent } from "./Sidebar";
import {
  IconSidebar,
  IconMenu,
  IconGear,
  IconMessages,
  IconGrid,
  IconClipboard,
  IconFiles,
  IconCosts,
  IconReview,
  IconTracks,
  IconWhatsApp,
  IconMedia, IconFeed } from "./icons";
import { t, useT, type Key } from "../i18n";

export const VIEW_META: Array<{ key: View; label: Key; icon: () => JSX.Element; adminOnly?: boolean }> = [
  { key: "messages", label: "chat.viewMessages", icon: IconMessages },
  { key: "feed", label: "chat.viewFeed", icon: IconFeed, adminOnly: true },
  { key: "builds", label: "chat.builds", icon: IconTracks, adminOnly: true },
  { key: "review", label: "chat.review", icon: IconReview, adminOnly: true },
  { key: "whatsapp", label: "chat.viewWhatsApp", icon: IconWhatsApp, adminOnly: true },
  { key: "mission-control", label: "chat.viewMissionControl", icon: IconGrid },
  { key: "clipboard", label: "chat.viewClipboard", icon: IconClipboard },
  { key: "files", label: "chat.viewFiles", icon: IconFiles },
  { key: "costs", label: "chat.viewCosts", icon: IconCosts, adminOnly: true },
  // Everyone's OWN bills (a family member's are hers alone; the owner's Costs stay admin-only).
  { key: "bills", label: "chat.viewBills", icon: IconCosts },
  // Vault (finance-vault): the owner's whole picture. adminOnly hides the entry; the gateway 404s the routes for everyone else.
  { key: "vault", label: "chat.viewVault", icon: IconCosts, adminOnly: true },
];

export function viewTitle(view: View): string {
  const label = VIEW_META.find((v) => v.key === view)?.label;
  return label ? t(label) : view;
}

export default function Topbar({ activeBot }: { activeBot: string | null }) {
  const t = useT();
  const state = useAppState();
  const [menuOpen, setMenuOpen] = useState(false);
  const [peekOpen, setPeekOpen] = useState(false);
  const { view, sidebarCollapsed, connection, restartingAt, user, settingsOpen, reviewWaiting, buildsNeedYou, waWaiting } = state;

  const { label: statusLabel, dot: statusDot } = connectionDisplay(connection, restartingAt);
  const isMessages = view === "messages";
  const botLabel = activeBot ? BOT_LABELS[activeBot] ?? activeBot : "";

  const sidebarToggleBtn = (
    <button
      className="topbar-btn"
      aria-label={sidebarCollapsed ? t("chat.expandSidebar") : t("chat.collapseSidebar")}
      onClick={() => {
        setPeekOpen(false);
        actions.toggleSidebar();
      }}
    >
      <IconSidebar />
    </button>
  );

  return (
    <header className="topbar">
      {/* Collapsed: hovering the toggle opens the context-aware peek —
          the REAL sidebar contents for this view (fix 3c#7); click restores. */}
      {sidebarCollapsed ? (
        <Dropdown trigger={sidebarToggleBtn} open={peekOpen} onOpenChange={setPeekOpen} hover>
          <SidebarContent view={view} peek onNavigate={() => setPeekOpen(false)} />
        </Dropdown>
      ) : (
        sidebarToggleBtn
      )}

      <Dropdown
        trigger={
          <button
            className={`topbar-btn${menuOpen ? " active" : ""}`}
            aria-label={t("chat.goTo")}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <IconMenu />
          </button>
        }
        open={menuOpen}
        onOpenChange={setMenuOpen}
      >
        {VIEW_META.filter((v) => !v.adminOnly || user?.admin).map((v) => (
          <button
            key={v.key}
            className={`dropdown-item${view === v.key && !settingsOpen ? " active" : ""}`}
            onClick={() => {
              actions.setView(v.key);
              actions.toggleSettings(false);
              setMenuOpen(false);
            }}
          >
            <v.icon />
            {t(v.label)}
            {v.key === "review" && reviewWaiting > 0 && <span className="rv-badge">{reviewWaiting}</span>}
            {v.key === "builds" && buildsNeedYou > 0 && <span className="rv-badge you">{buildsNeedYou}</span>}
            {v.key === "whatsapp" && waWaiting > 0 && <span className="rv-badge you">{waWaiting}</span>}
          </button>
        ))}
        <div className="dropdown-divider" />
        <button
          className={`dropdown-item${settingsOpen ? " active" : ""}`}
          onClick={() => {
            actions.toggleSettings(true);
            setMenuOpen(false);
          }}
        >
          <IconGear />
          {t("common.settings")}
        </button>
      </Dropdown>

      {isMessages && activeBot ? (
        <div className="topbar-context">
          <span className="topbar-agent">{botLabel}</span>
          <span className="status-chip">
            <span className={`status-dot ${statusDot}`} />
            <span className="mono-label">{statusLabel}</span>
          </span>
        </div>
      ) : (
        <div className="topbar-title">{viewTitle(view)}</div>
      )}

      <div className="topbar-spacer" />

      {/* Media / Files / Links of the open chat. */}
      {isMessages && activeBot && (
        <button
          className={`topbar-btn${state.mediaPanelOpen ? " active" : ""}`}
          aria-label={t("media.panelLabel")}
          aria-pressed={state.mediaPanelOpen}
          title={t("media.panelLabel")}
          onClick={() => actions.toggleMediaPanel()}
        >
          <IconMedia />
        </button>
      )}

      {/* Schedule: the owner's week, live — always visible, beside the gallery icon. */}
      {user?.admin && <ScheduleButton />}

      {/* Gear TOGGLES the Settings overlay (fix 3c#2) — the view underneath
          stays mounted, so closing restores scroll + sidebar state exactly. */}
      <button
        className={`topbar-btn${settingsOpen ? " active" : ""}`}
        aria-label={t("common.settings")}
        aria-pressed={settingsOpen}
        onClick={() => actions.toggleSettings()}
      >
        <IconGear />
      </button>
    </header>
  );
}
