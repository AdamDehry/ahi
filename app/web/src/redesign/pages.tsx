/**
 * Page frames for the redesign (slice 1). Each rail destination gets the FINAL
 * page header and, where it groups old views, a tab strip; the existing views
 * render underneath unchanged, so nothing they do is lost while later slices
 * restyle them one by one (FEATURE-PARITY.md).
 */
import type { ReactNode } from "react";
import { actions, useAppState, type View } from "../store";
import { TABS, canOpen, type Page } from "./nav";

export const PAGE_COPY: Record<Page, { eyebrow: string; title: string; sub: string }> = {
  home: { eyebrow: "WELCOME BACK", title: "What can I take off your plate?", sub: "One conversation. Your whole world, working together." },
  today: { eyebrow: "TODAY", title: "A little clarity for your day.", sub: "Your time, your next decisions, and the work moving around you." },
  messages: { eyebrow: "", title: "Messages", sub: "" },
  work: { eyebrow: "IDEAS INTO OUTCOMES", title: "Your work.", sub: "See what needs you, what’s moving, and what’s ready to ship." },
  documents: { eyebrow: "YOUR TEAM’S SHARED CONTEXT", title: "Documents.", sub: "Plans, briefs, and the next right step. A familiar place for the work." },
  finances: { eyebrow: "MONEY, KEPT SIMPLE", title: "Finances.", sub: "What the business runs on, and what is due at home." },
  vault: { eyebrow: "YOUR PRIVATE FINANCIAL PICTURE", title: "A clearer financial picture.", sub: "Accounts, assets, and what needs your attention. One private place." },
  whatsapp: { eyebrow: "YOUR CUSTOMERS", title: "WhatsApp.", sub: "Customer conversations." },
  gmail: { eyebrow: "YOUR MAIL", title: "Gmail.", sub: "Every account in one calm inbox." },
  team: { eyebrow: "PEOPLE BEHIND THE WORK", title: "Your team.", sub: "Start with Michael, or go straight to the person you need." },
  connections: { eyebrow: "CONNECTED TO YOUR WORLD", title: "Connections.", sub: "The apps your team can use, and the accounts behind them." },
  settings: { eyebrow: "MAKE YOURSELF AT HOME", title: "Settings.", sub: "Small preferences. A better everyday." },
};

export function PageHeader({ page, actionsSlot }: { page: Page; actionsSlot?: ReactNode }) {
  const c = PAGE_COPY[page];
  return (
    <header className="rd-page-head">
      <div>
        {c.eyebrow && <div className="rd-eyebrow">{c.eyebrow}</div>}
        <h1 className="rd-title">{c.title.replace(/\.$/, "")}{c.title.endsWith(".") && <span className="rd-title-dot">.</span>}</h1>
        {c.sub && <p className="rd-sub">{c.sub}</p>}
      </div>
      {actionsSlot && <div className="rd-page-actions">{actionsSlot}</div>}
    </header>
  );
}

export function PageTabs({ page }: { page: Page }) {
  const { view, user } = useAppState();
  const admin = !!user?.admin;
  const tabs = (TABS[page] ?? []).filter((t) => canOpen(t.view, admin));
  if (tabs.length < 2) return null;
  return (
    <div className="rd-tabs" role="tablist" aria-label={`${page} sections`}>
      {tabs.map((t) => (
        <button
          key={t.view}
          type="button"
          role="tab"
          aria-selected={view === t.view}
          className={`rd-tab${view === t.view ? " active" : ""}`}
          onClick={() => actions.setView(t.view as View)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** A page with a header, optional tabs, and the existing view below (it scrolls itself). */
export function FramedPage({ page, children, sidebar, actionsSlot }: { page: Page; children: ReactNode; sidebar?: ReactNode; actionsSlot?: ReactNode }) {
  return (
    <div className="rd-page" data-page={page}>
      <div className="rd-page-top">
        <PageHeader page={page} actionsSlot={actionsSlot} />
        <PageTabs page={page} />
      </div>
      <div className="rd-page-body">
        {sidebar}
        <div className="rd-page-view">{children}</div>
      </div>
    </div>
  );
}

