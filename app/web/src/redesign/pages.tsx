/**
 * Page frames for the redesign (slice 1). Each rail destination gets the FINAL
 * page header and, where it groups old views, a tab strip; the existing views
 * render underneath unchanged, so nothing they do is lost while later slices
 * restyle them one by one (FEATURE-PARITY.md).
 */
import type { ReactNode } from "react";
import { actions, useAppState, type View } from "../store";
import { PAGE_TITLE, TABS, canOpen, type Page } from "./nav";
import { useLang, useT, type Key } from "../i18n";

/** Catalog keys per page ("" = no line), translated in PageHeader. */
export const PAGE_COPY: Record<Page, { eyebrow: Key | ""; title: Key; sub: Key | "" }> = {
  home: { eyebrow: "shell.page.home.eyebrow", title: "shell.page.home.title", sub: "shell.page.home.sub" },
  today: { eyebrow: "shell.page.today.eyebrow", title: "shell.page.today.title", sub: "shell.page.today.sub" },
  messages: { eyebrow: "", title: "shell.nav.messages", sub: "" },
  work: { eyebrow: "shell.page.work.eyebrow", title: "shell.page.work.title", sub: "shell.page.work.sub" },
  documents: { eyebrow: "shell.page.documents.eyebrow", title: "shell.page.documents.title", sub: "shell.page.documents.sub" },
  finances: { eyebrow: "shell.page.finances.eyebrow", title: "shell.page.finances.title", sub: "shell.page.finances.sub" },
  vault: { eyebrow: "shell.page.vault.eyebrow", title: "shell.page.vault.title", sub: "shell.page.vault.sub" },
  whatsapp: { eyebrow: "shell.page.whatsapp.eyebrow", title: "shell.page.whatsapp.title", sub: "shell.page.whatsapp.sub" },
  gmail: { eyebrow: "shell.page.gmail.eyebrow", title: "shell.page.gmail.title", sub: "shell.page.gmail.sub" },
  team: { eyebrow: "shell.page.team.eyebrow", title: "shell.page.team.title", sub: "shell.page.team.sub" },
  connections: { eyebrow: "shell.page.connections.eyebrow", title: "shell.page.connections.title", sub: "shell.page.connections.sub" },
  settings: { eyebrow: "shell.page.settings.eyebrow", title: "shell.page.settings.title", sub: "shell.page.settings.sub" },
};

export function PageHeader({ page, actionsSlot }: { page: Page; actionsSlot?: ReactNode }) {
  const t = useT();
  const c = PAGE_COPY[page];
  const title = t(c.title);
  return (
    <header className="rd-page-head">
      <div>
        {c.eyebrow && <div className="rd-eyebrow">{t(c.eyebrow)}</div>}
        <h1 className="rd-title">{title.replace(/\.$/, "")}{title.endsWith(".") && <span className="rd-title-dot">.</span>}</h1>
        {c.sub && <p className="rd-sub">{t(c.sub)}</p>}
      </div>
      {actionsSlot && <div className="rd-page-actions">{actionsSlot}</div>}
    </header>
  );
}

export function PageTabs({ page }: { page: Page }) {
  const t = useT();
  const lang = useLang();
  const { view, user } = useAppState();
  const admin = !!user?.admin;
  const tabs = (TABS[page] ?? []).filter((x) => canOpen(x.view, admin));
  if (tabs.length < 2) return null;
  return (
    <div className="rd-tabs" role="tablist" aria-label={t("shell.pageSections", { page: lang === "en" ? page : t(PAGE_TITLE[page]) })}>
      {tabs.map((x) => (
        <button
          key={x.view}
          type="button"
          role="tab"
          aria-selected={view === x.view}
          className={`rd-tab${view === x.view ? " active" : ""}`}
          onClick={() => actions.setView(x.view as View)}
        >
          {t(x.label)}
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

