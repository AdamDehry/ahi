/**
 * Connections (slice 5, FINAL layout; D13 binding). "Your apps" lists only
 * adapters that really exist in this gateway, each with status read from its
 * own service (WhatsApp health, Vault bank links, Web Push, search provider,
 * phone line). "Discover" lists apps the design shows but AHI has no
 * connector for — honestly "Not available yet"; nothing here fakes an
 * install, an OAuth flow or an account. An app and its accounts stay
 * separate: accounts are managed where their service lives (Vault for bank
 * links, Settings for this device's notifications).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ConnectGmailDialog } from "./GmailPage";
import { actions, availableBots, useAppState } from "../store";
import { Icon, type IconName } from "./icons";
import { goPage } from "./Shell";
import { getFresh } from "../lib/api";
import { t, tn, useLang, useT, type Key } from "../i18n";

type Category = "communication" | "money" | "productivity" | "files";
const CATEGORY_LABEL: Record<Category | "all", Key> = { all: "shell.bell.everything", communication: "connections.cat.communication", money: "connections.cat.money", productivity: "connections.cat.productivity", files: "connections.cat.files" };

interface AppRow {
  key: string;
  name: string;
  blurb: string;
  category: Category;
  mark: { icon?: IconName; img?: string };
  status: string;
  state: "on" | "off" | "managed" | "loading";
  admin?: boolean;
  detail: string[];
  manage?: { label: string; go: () => void };
}

/** Names are brands (never translated); `blurb` is a catalog key, translated where it is matched and shown. */
const DISCOVER: Array<{ key: string; name: string; blurb: Key; category: Category; img?: string; icon?: IconName }> = [
  { key: "gmail", name: "Gmail", blurb: "connections.discover.gmail", category: "communication", img: "/brand/gmail.svg" },
  { key: "gcal", name: "Google Calendar", blurb: "connections.discover.gcal", category: "productivity", img: "/brand/google-calendar.svg" },
  { key: "gdrive", name: "Google Drive", blurb: "connections.discover.gdrive", category: "files", img: "/brand/google-drive.svg" },
  { key: "slack", name: "Slack", blurb: "connections.discover.slack", category: "communication", img: "/brand/slack.svg" },
  { key: "notion", name: "Notion", blurb: "connections.discover.notion", category: "productivity", img: "/brand/notion.svg" },
];


interface Live {
  wa: { configured?: { send?: boolean; appSecret?: boolean } } | null;
  vault: { connections: Array<{ institution: string; status: string; accounts: number }>; provider?: unknown } | null;
  push: { settings?: { deviceCount?: number }; configured?: boolean } | null;
  search: { enabled?: boolean } | null;
  health: Record<string, unknown> | null;
  loaded: boolean;
}

function useLive(admin: boolean): Live {
  const [live, setLive] = useState<Live>({ wa: null, vault: null, push: null, search: null, health: null, loaded: false });
  useEffect(() => {
    let on = true;
    void Promise.all([
      Promise.resolve(null), // WhatsApp: not in this release
      admin ? getFresh<Live["vault"]>("/app/vault") : Promise.resolve(null),
      getFresh<Live["push"]>("/app/push/settings"),
      getFresh<Live["search"]>("/app/search/status"),
      getFresh<Live["health"]>("/health"),
    ]).then(([wa, vault, push, search, health]) => on && setLive({ wa, vault, push, search, health, loaded: true }));
    return () => {
      on = false;
    };
  }, [admin]);
  return live;
}

function rows(live: Live, admin: boolean): AppRow[] {
  const loading = !live.loaded;
  const out: AppRow[] = [];
  if (admin) {
    const banks = live.vault?.connections ?? [];
    out.push({
      key: "banks", name: t("connections.banks.name"), blurb: t("connections.banks.blurb"), category: "money", mark: { icon: "shield" },
      state: loading ? "loading" : banks.length ? "on" : "off",
      status: loading ? t("connections.checking") : banks.length ? `${tn("connections.banks.institutions", banks.length)} · ${t("connections.banks.accounts", { n: banks.reduce((n, b) => n + b.accounts, 0) })}` : t("connections.banks.none"),
      detail: banks.length ? banks.map((b) => `${b.institution} · ${b.status}`) : [t("connections.banks.noneDetail")],
      admin: true, manage: { label: t("connections.banks.manage"), go: () => goPage("vault") },
    });
  }
  const pushOn = !!live.push?.configured;
  const devices = live.push?.settings?.deviceCount ?? 0;
  out.push({
    key: "push", name: t("shell.notifications"), blurb: t("connections.push.blurb"), category: "productivity", mark: { icon: "bell" },
    state: loading ? "loading" : pushOn ? "on" : "off",
    status: loading ? t("connections.checking") : pushOn ? tn("connections.push.devices", devices) : t("connections.push.notConfigured"),
    detail: [t("connections.push.detail")], manage: { label: t("connections.push.manage"), go: () => actions.toggleSettings(true) },
  });
  const searchOn = !!live.search?.enabled;
  out.push({
    key: "search", name: t("connections.search.name"), blurb: t("connections.search.blurb"), category: "productivity", mark: { icon: "search" },
    state: loading ? "loading" : searchOn ? "on" : "off", status: loading ? t("connections.checking") : searchOn ? t("common.on") : t("connections.search.off"),
    detail: [t("connections.search.detail")],
  });
  out.push({
    key: "folders", name: t("home.docs.workspaceFolders"), blurb: t("connections.folders.blurb"), category: "files", mark: { icon: "folder" },
    state: "managed", status: t("connections.folders.status"), detail: [t("connections.folders.detail")],
    manage: { label: t("connections.folders.manage"), go: () => goPage("documents") },
  });
  return out;
}

function Mark({ icon, img }: { icon?: IconName; img?: string }) {
  return <span className="rd-app-mark">{img ? <img src={img} alt="" aria-hidden="true" /> : icon ? <Icon name={icon} /> : null}</span>;
}

export default function Connections() {
  const t = useT();
  const lang = useLang();
  const s = useAppState();
  const admin = !!s.user?.admin;
  const live = useLive(admin);
  const [tab, setTab] = useState<"yours" | "discover">("yours");
  const [cat, setCat] = useState<Category | "all">("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [gmailConnect, setGmailConnect] = useState(false);
  const [gmailReady, setGmailReady] = useState(false);
  useEffect(() => {
    if (gmailConnect) void getFresh<{ configured: boolean }>("/app/gmail/status").then((v) => setGmailReady(!!v?.configured));
  }, [gmailConnect]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const yours = useMemo(() => rows(live, admin), [live, admin, lang]);
  const match = (name: string, blurb: string, c: Category) =>
    (cat === "all" || c === cat) && (!q.trim() || `${name} ${blurb}`.toLowerCase().includes(q.trim().toLowerCase()));
  const shownYours = yours.filter((r) => match(r.name, r.blurb, r.category));
  const shownDiscover = DISCOVER.filter((d) => match(d.name, t(d.blurb), d.category));
  const [menu, setMenu] = useState<string | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as HTMLElement).closest?.(".rd-app-cell")) setMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [menu]);
  const chosen = yours.find((r) => r.key === open) ?? null;
  const canAsk = availableBots(s.user).includes("michael");
  const ask = (what: string) => {
    actions.setDraft("michael", t("connections.askDraft", { what }));
    actions.setView("messages");
    actions.openMobileThread("michael");
  };

  let body: ReactNode;
  if (tab === "yours") {
    body = shownYours.length ? (
      <div className="rd-app-grid">
        {shownYours.map((r) => (
          <div key={r.key} className="rd-app-cell">
            <button type="button" className={`rd-app-card${open === r.key ? " open" : ""}`} onClick={() => setOpen(open === r.key ? null : r.key)} aria-expanded={open === r.key}>
              <Mark {...r.mark} />
              <span className="rd-app-text">
                <span className="rd-app-name">{r.name}</span>
                <span className="rd-app-blurb">{r.blurb}</span>
                <span className={`rd-app-status ${r.state}`} dir="auto">{r.status}</span>
              </span>
            </button>
            {/* FINAL card menu: Manage goes to the app's own place. No Uninstall — removing a server
                integration is not something the app can do (D13). */}
            <button type="button" className="rd-app-more" aria-label={t("connections.options", { name: r.name })} aria-haspopup="menu" aria-expanded={menu === r.key} onClick={() => setMenu(menu === r.key ? null : r.key)}>
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" stroke="none">
                <circle cx="6" cy="12" r="1.4" />
                <circle cx="12" cy="12" r="1.4" />
                <circle cx="18" cy="12" r="1.4" />
              </svg>
            </button>
            {menu === r.key && (
              <div className="rd-app-menu" role="menu" aria-label={t("connections.options", { name: r.name })}>
                <button type="button" role="menuitem" onClick={() => (setMenu(null), setOpen(r.key))}>
                  {t("connections.details")}
                </button>
                {r.manage && (
                  <button type="button" role="menuitem" onClick={() => (setMenu(null), r.manage!.go())}>
                    {r.manage.label}
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    ) : (
      <p className="rd-quiet rd-empty-line">{t("connections.noMatch")}</p>
    );
  } else {
    body = shownDiscover.length ? (
      <div className="rd-app-grid">
        {shownDiscover.map((d) => (
          <div key={d.key} className="rd-app-card discover">
            <Mark img={d.img} icon={d.icon} />
            <span className="rd-app-text">
              <span className="rd-app-name">{d.name}</span>
              <span className="rd-app-blurb">{t(d.blurb)}</span>
              <span className={`rd-app-status ${d.key === "gmail" ? "on" : "off"}`}>{d.key === "gmail" ? t("connections.readyToConnect") : t("connections.notAvailable")}</span>
            </span>
            <span className="rd-app-actions">
              {d.key === "gmail" ? (
                // Gmail connects for real — FINAL's dialog, then Google's own sign-in.
                <button type="button" className="rd-btn rd-btn-accent" onClick={() => setGmailConnect(true)}>{t("connections.connect")}</button>
              ) : (
                <>
                  <button type="button" className="rd-btn" disabled title={t("connections.noConnector")}>{t("common.add")}</button>
                  {canAsk && <button type="button" className="rd-btn" onClick={() => ask(d.name)}>{t("connections.askMichael")}</button>}
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    ) : (
      <p className="rd-quiet rd-empty-line">{t("connections.noMatch")}</p>
    );
  }

  return (
    <div className="rd-page rd-page-scroll rd-connections" data-page="connections">
      <div className="rd-page-top">
        <header className="rd-page-head">
          <div>
            <h1 className="rd-title">{t("shell.nav.connections")}<span className="rd-title-dot">.</span></h1>
            <p className="rd-sub">{t("connections.sub")}</p>
          </div>
          {canAsk && (
            <div className="rd-page-actions">
              <button type="button" className="rd-btn" onClick={() => ask(t("connections.anApp"))}>
                {t("connections.askMichael")} <Icon name="arrow-right" />
              </button>
            </div>
          )}
        </header>
        <div className="rd-conn-bar">
          <div className="rd-tabs" role="tablist" aria-label={t("shell.nav.connections")}>
            <button type="button" role="tab" aria-selected={tab === "yours"} className={`rd-tab${tab === "yours" ? " active" : ""}`} onClick={() => setTab("yours")}>
              {t("connections.yourApps")} <span className="rd-count">{yours.length}</span>
            </button>
            <button type="button" role="tab" aria-selected={tab === "discover"} className={`rd-tab${tab === "discover" ? " active" : ""}`} onClick={() => setTab("discover")}>
              {t("connections.discover")} <span className="rd-count">{DISCOVER.length}</span>
            </button>
          </div>
          <label className="rd-find">
            <Icon name="search" />
            <input type="search" dir="auto" placeholder={t("connections.findPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("connections.find")} />
          </label>
        </div>
        <div className="rd-chips" role="group" aria-label={t("connections.category")}>
          {(Object.keys(CATEGORY_LABEL) as Array<Category | "all">).map((c) => (
            <button key={c} type="button" className={`rd-chip${cat === c ? " on" : ""}`} aria-pressed={cat === c} onClick={() => setCat(c)}>
              {t(CATEGORY_LABEL[c])}
            </button>
          ))}
        </div>
      </div>
      <div className="rd-conn-body">
        {body}
        {tab === "yours" && chosen && (
          <section className="rd-app-detail" aria-label={t("connections.detailsOf", { name: chosen.name })}>
            <div className="rd-card-top">
              <h3>{chosen.name}</h3>
              <button type="button" className="rd-chat-control" aria-label={t("connections.closeDetails")} onClick={() => setOpen(null)}>
                <Icon name="x" />
              </button>
            </div>
            <ul>
              {chosen.detail.map((d) => (
                <li key={d} dir="auto">{d}</li>
              ))}
            </ul>
            {chosen.manage && (
              <button type="button" className="rd-btn" onClick={chosen.manage.go}>
                {chosen.manage.label} <Icon name="arrow-right" />
              </button>
            )}
          </section>
        )}
        <p className="rd-conn-note">
          <Icon name="shield" /> {t("connections.note")}
        </p>
      </div>
      {gmailConnect && <ConnectGmailDialog configured={gmailReady} onClose={() => setGmailConnect(false)} />}
    </div>
  );
}
