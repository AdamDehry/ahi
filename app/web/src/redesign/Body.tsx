/** What the canvas shows for the current view: each page's FINAL frame over the existing views. */
import { useEffect, useRef, type ReactNode } from "react";
import { actions, availableBots, useAppState, type View } from "../store";
import { SidebarContent } from "../components/Sidebar";
import MediaPanel from "../components/MediaPanel";
import MissionControl from "../views/MissionControl";
import Clipboard from "../views/Clipboard";
import FilesView from "../views/FilesView";
import Costs from "../views/Costs";
import Bills from "../views/Bills";
import VaultPage, { VaultLockButton } from "./VaultPage";
import SettingsPage from "./SettingsPage";
import CalendarPage from "./CalendarPage";
import { scheduleUi, useScheduleUi } from "../lib/schedule";
import Review, { ReviewList } from "../views/Review";
import BuildsBoard from "./BuildsBoard";
import Feed from "../views/Feed";
import { PAGE_OF, canOpen } from "./nav";
import { FramedPage } from "./pages";
import AgentRail from "./AgentRail";
import Home from "./Home";
import Connections from "./Connections";
import { Gmail } from "./Business";
import { DocumentsPage, FinancesPage } from "./World";
import { SettingsNav, TeamPage } from "./Team";
import Today from "./Today";
import LiveSessions from "./LiveSessions";
import ChatHeader from "./ChatHeader";

/** Views whose old per-view sidebar carries real function (agent list, categories, card list). */
const SIDEBAR_VIEWS: ReadonlySet<View> = new Set<View>(["mission-control", "clipboard", "files", "costs"]);

function ViewOnly({ view, phone }: { view: View; phone: boolean }): ReactNode {
  // Phone: list screens push their detail over the page (App.tsx MobileApp), so the root shows the list.
  if (phone) {
    if (view === "review") return <ReviewList />;
    if (view === "builds") return <BuildsBoard phone />;
    if (view === "files") return <SidebarContent view="files" onNavigate={actions.pushMobileFiles} />;
  }
  switch (view) {
    case "mission-control": return <MissionControl />;
    case "clipboard": return <Clipboard />;
    case "files": return <FilesView />;
    case "costs": return <Costs />;
    case "bills": return <Bills />;
    case "vault": return <VaultPage />;
    case "review": return <Review />;
    case "builds": return <BuildsBoard />;
    case "feed": return <Feed />;
    case "live": return <LiveSessions />;
    default: return null;
  }
}

export default function RedesignBody({ activeBot, chat, phone = false }: { activeBot: string | null; chat: (bot: string) => ReactNode; phone?: boolean }) {
  const s = useAppState();
  // Settings lies OVER the current page, which stays mounted underneath (as the old overlay did):
  // a voice note being recorded, the thread's scroll and composer state all survive opening it
  // (review R1-C1).
  const cal = useScheduleUi();
  // The calendar lies over the page like Settings; going anywhere closes it, and Settings wins.
  const lastView = useRef(s.view);
  useEffect(() => {
    if (lastView.current !== s.view && cal.open) scheduleUi.close();
    lastView.current = s.view;
  }, [s.view, cal.open]);
  useEffect(() => {
    if (s.settingsOpen && cal.open) scheduleUi.close();
  }, [s.settingsOpen, cal.open]);
  const calendarShown = cal.open && !s.settingsOpen;
  return (
    <>
      <div className="rd-under" style={{ display: s.settingsOpen || calendarShown ? "none" : "contents" }}>
        <PageBody activeBot={activeBot} chat={chat} phone={phone} />
      </div>
      {calendarShown && <CalendarPage phone={phone} />}
      {s.settingsOpen && (
        <FramedPage page="settings" sidebar={phone ? undefined : <SettingsNav />}>
          {phone && <SettingsNav />}
          <SettingsPage />
        </FramedPage>
      )}
    </>
  );
}

function PageBody({ activeBot, chat, phone }: { activeBot: string | null; chat: (bot: string) => ReactNode; phone: boolean }) {
  const s = useAppState();
  // Never render a view this session may not open, whatever put it in the store (a role change on
  // reconnect, a stale snapshot): history.ts moves the store back to Home on the same change.
  const view = canOpen(s.view, !!s.user?.admin) ? s.view : "home";
  const page = PAGE_OF[view];
  switch (page) {
    case "messages":
      return (
        <div className="app-body rd-messages">
          {/* The gallery takes the whole Messages workspace, rail included (as the concept). */}
          {!(s.mediaPanelOpen && activeBot) && <AgentRail activeBot={activeBot} />}
          {/* Gallery replaces the conversation (FINAL); the thread stays mounted underneath so
              its scroll and any draft are exactly as left, and Go to message lands in it. */}
          <main className="view-area rd-chat-pane" hidden={s.mediaPanelOpen && !!activeBot}>
            {activeBot ? (
              <>
                <ChatHeader bot={activeBot} />
                {chat(activeBot)}
              </>
            ) : (
              <div className="tool-empty mono-label">NO AGENTS AVAILABLE</div>
            )}
          </main>
          {s.mediaPanelOpen && activeBot && <MediaPanel bot={activeBot} mobile={false} page />}
        </div>
      );
    case "home":
      return <Home />;
    case "today":
      return <Today />;
    case "gmail":
      return <Gmail />;
    case "team":
      return <TeamPage />;
    case "connections":
      return <Connections />;
    default: {
      const sidebar = !phone && SIDEBAR_VIEWS.has(view) ? (
        <aside className="sidebar rd-subnav">
          <SidebarContent view={view} />
        </aside>
      ) : undefined;
      if (page === "documents") return <DocumentsPage phone={phone} body={<ViewOnly view={view} phone={phone} />} />;
      if (page === "finances") return <FinancesPage body={<ViewOnly view={view} phone={phone} />} />;
      return (
        <FramedPage page={page} sidebar={sidebar} actionsSlot={page === "work" && availableBots(s.user).includes("michael") ? <TalkItThrough /> : page === "vault" ? <VaultLockButton /> : undefined}>
          <ViewOnly view={view} phone={phone} />
        </FramedPage>
      );
    }
  }
}

/** Your work's header action (FINAL "Talk it through"): opens Michael with a starter, never sends. */
function TalkItThrough() {
  return (
    <button
      type="button"
      className="rd-btn rd-btn-accent"
      onClick={() => {
        actions.setDraft("michael", "Let’s talk through my work: ");
        actions.setView("messages");
        actions.openMobileThread("michael");
      }}
    >
      Talk it through
    </button>
  );
}
