/**
 * Documents and Finances (slice 7).
 *
 * Documents: FINAL's folder column — All documents, Uploads, Clips, Mission
 * control — over the roots the app already serves (D06). Each folder's own
 * controls are the existing ones (file categories add/rename/delete, clip
 * filters, mission-control cards incl. Fitness), shown nested under the open
 * folder; the right pane is the existing view for that folder. "All
 * documents" is a unified, searchable list of all three, and a row opens its
 * folder. Permission words follow today's operations: uploads and clips can
 * be removed; mission-control cards are view only here.
 *
 * Finances: one scrolling page — a summary from the real costs and bills
 * (monthly equivalent; one-time bills shown separately, nothing inferred),
 * then the tabs and the existing Costs / Bills views with their dialogs.
 */
import { createContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { actions, useAppState, type View } from "../store";
import { fetchBills, fetchClips, fetchCosts, fetchFiles, fetchMc } from "../lib/api";
import type { Bill, CostEntry } from "../lib/types";
import { SidebarContent } from "../components/Sidebar";
import { Icon } from "./icons";
import { renderMarkdown } from "../lib/markdown";
import { PageHeader, PageTabs } from "./pages";
import { AhiFolderView, AhiTreeNav, DocPreviewModal, useAhiTree, type DocEntry } from "./AhiTree";
import { perMonth } from "../views/Bills";
import { money } from "../lib/vault";

const FOLDERS: Array<{ view: View; label: string; admin?: boolean }> = [
  { view: "documents", label: "All documents" },
  { view: "files", label: "Uploads" },
  { view: "clipboard", label: "Clips" },
  { view: "mission-control", label: "Mission control" },
];

function displayName(name: string): string {
  return name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
}

function AllDocuments() {
  const { filesList, clips, mcFiles } = useAppState();
  const [q, setQ] = useState("");
  // One effect per list, so one list arriving doesn't refetch the others still in flight.
  useEffect(() => void (filesList === null && fetchFiles().then(actions.setFiles)), [filesList]);
  useEffect(() => void (clips === null && fetchClips().then(actions.setClips)), [clips]);
  useEffect(() => void (mcFiles === null && fetchMc().then(actions.setMcFiles)), [mcFiles]);
  const items = useMemo(() => {
    const out: Array<{ key: string; title: string; where: string; access: string; open: () => void }> = [];
    for (const f of filesList ?? []) {
      const cat = f.name.includes("/") ? f.name.split("/")[0] : "general";
      out.push({ key: `f:${f.name}`, title: displayName(f.name), where: `Uploads / ${cat}`, access: "Can remove", open: () => (actions.setView("files"), actions.setToolFilter(cat)) });
    }
    for (const c of clips ?? []) out.push({ key: `c:${c.id}`, title: c.text.length > 80 ? `${c.text.slice(0, 80)}…` : c.text, where: "Clips", access: "Can remove", open: () => actions.setView("clipboard") });
    for (const m of Object.values(mcFiles ?? {})) out.push({ key: `m:${m.name}`, title: m.label, where: `Mission control / ${m.name}`, access: "View only", open: () => actions.openMcCard(m.name) });
    const needle = q.trim().toLowerCase();
    return needle ? out.filter((i) => `${i.title} ${i.where}`.toLowerCase().includes(needle)) : out;
  }, [filesList, clips, mcFiles, q]);
  const loading = filesList === null || clips === null || mcFiles === null;
  return (
    <div className="rd-docs-all">
      <div className="rd-docs-bar">
        <span className="rd-quiet">{loading ? "Loading…" : `${items.length} document${items.length === 1 ? "" : "s"}`}</span>
        <label className="rd-find">
          <Icon name="search" />
          <input type="search" placeholder="Find a document…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a document" />
        </label>
      </div>
      {!loading && !items.length && <p className="rd-quiet rd-empty-line">{q ? "Nothing matches that." : "No documents yet. Uploads, clips and mission-control cards show here."}</p>}
      <ul className="rd-doc-list">
        {items.map((i) => (
          <li key={i.key}>
            <button type="button" onClick={i.open}>
              <span className="rd-doc-icon"><Icon name="folder" /></span>
              <span className="rd-doc-text">
                {i.title}
                <small>{i.where}</small>
              </span>
              <span className={`rd-doc-access${i.access === "View only" ? " ro" : ""}`}>{i.access}</span>
              <Icon name="chevron-right" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One open document, full page (FINAL documents reader): back to Documents, where it lives, title, access, content. */
function DocReader({ name, label, content, mtime }: { name: string; label: string; content: string; mtime?: number }) {
  const when = mtime ? new Date(mtime) : null;
  const updated = when && !Number.isNaN(when.getTime()) ? `Updated ${when.toDateString() === new Date().toDateString() ? when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : when.toLocaleDateString([], { month: "short", day: "numeric" })}` : "";
  return (
    <div className="rd-page rd-page-scroll rd-docs rd-doc-reader" data-page="documents">
      <button type="button" className="rd-back-link" onClick={() => (actions.closeMcCard(), actions.setView("documents"))}>
        <Icon name="arrow-left" /> Documents
      </button>
      <div className="rd-eyebrow">MISSION CONTROL / {name}</div>
      <h1 className="rd-title">{label}</h1>
      <p className="rd-sub">{[updated, "Shared with your team", "View only"].filter(Boolean).join(" · ")}</p>
      <article className="rd-doc-card msg-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
    </div>
  );
}

export function DocumentsPage({ phone, body }: { phone: boolean; body: ReactNode }) {
  const { view, filesList, clips, mcFiles, mcL2, user } = useAppState();
  // The real AHI folder system: owner only on the server; absent → the column is as before.
  const tree = useAhiTree(!!user?.admin);
  const [ahiOpen, setAhiOpen] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<string | null>(null);
  // Clicking the folder that is already open closes its controls again.
  const [appClosed, setAppClosed] = useState(false);
  const open = view === "mission-control" && mcL2 && mcL2 !== "fitness" ? mcFiles?.[mcL2] : undefined;
  if (open) return <DocReader name={open.name} label={open.label} content={open.content ?? ""} mtime={open.mtime} />;
  const count = (v: View): number | null =>
    v === "files" ? filesList?.length ?? null : v === "clipboard" ? clips?.length ?? null : v === "mission-control" ? (mcFiles ? Object.keys(mcFiles).length : null) : null;
  const openFolder = (e: Pick<DocEntry, "path">, fromTree: boolean) => {
    if (fromTree && ahiOpen === e.path && expanded.has(e.path)) {
      // The open folder, clicked again: it closes (its children fold away); the pane keeps showing it.
      setExpanded((x) => new Set([...x].filter((p) => p !== e.path && !p.startsWith(e.path + "/"))));
      return;
    }
    const segs = e.path.split("/");
    setExpanded((x) => new Set([...x, ...segs.map((_, i) => segs.slice(0, i + 1).join("/"))]));
    setAhiOpen(e.path);
    void tree.load(e.path);
  };
  return (
    <div className="rd-page rd-docs" data-page="documents">
      <div className="rd-page-top">
        <PageHeader page="documents" />
      </div>
      <div className="rd-page-body rd-docs-body">
        <aside className="rd-folders" aria-label="Workspace folders">
          {tree.available && (
            <>
              <div className="rd-eyebrow">WORKSPACE FOLDERS</div>
              <AhiTreeNav tree={tree} open={ahiOpen} expanded={expanded} onFolder={(e) => openFolder(e, true)} onFile={(e) => setPreview(e.path)} />
            </>
          )}
          <div className="rd-eyebrow rd-folders-app">{tree.available ? "IN THE APP" : "WORKSPACE FOLDERS"}</div>
          <nav>
            {FOLDERS.map((f) => {
              const here = ahiOpen === null && view === f.view;
              return (
                <div key={f.view} className="rd-folder-group">
                  <button
                    type="button"
                    className={`rd-folder${here ? " active" : ""}`}
                    aria-current={here ? "true" : undefined}
                    aria-expanded={f.view !== "documents" ? here && !appClosed : undefined}
                    onClick={() => {
                      if (here && f.view !== "documents") return setAppClosed((c) => !c);
                      setAhiOpen(null);
                      setAppClosed(false);
                      actions.setView(f.view);
                    }}
                  >
                    <Icon name="folder" />
                    <span>{f.label}</span>
                    {count(f.view) !== null && <span className="rd-folder-count">{count(f.view)}</span>}
                  </button>
                  {/* The open folder's own controls: categories (add / rename / delete), clip filters, cards. */}
                  {!phone && here && !appClosed && f.view !== "documents" && (
                    <div className="rd-folder-sub">
                      <SidebarContent view={f.view} />
                    </div>
                  )}
                </div>
              );
            })}
          </nav>
          <p className="rd-folder-note">
            <Icon name="shield" /> {tree.available ? "Your AHI folders, as they are on the server. Hidden and credential files never show; nothing here moves or deletes." : "Only the workspace’s own folders appear here. What you can do follows each document’s access."}
          </p>
        </aside>
        <div className="rd-page-view">
          {ahiOpen !== null ? (
            <AhiFolderView tree={tree} path={ahiOpen} onFolder={(e) => openFolder(e, false)} onFile={(e) => setPreview(e.path)} onAdded={(p) => openFolder({ path: p }, false)} />
          ) : view === "documents" ? (
            <AllDocuments />
          ) : (
            body
          )}
        </div>
      </div>
      {preview && <DocPreviewModal path={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

export function monthlyCost(c: Pick<CostEntry, "active" | "monthly_cost_fixed" | "monthly_cost_estimate">): number {
  return c.active ? c.monthly_cost_fixed ?? c.monthly_cost_estimate ?? 0 : 0;
}
const usd = (n: number) => money(n, 2);

/** Where Costs puts the category chips: under its heading row, above the sections (FINAL order). */
export const FinCatsSlot = createContext<ReactNode>(null);

function Summary() {
  const { costEntries, user } = useAppState();
  const admin = !!user?.admin;
  const [bills, setBills] = useState<Bill[] | null>(null);
  useEffect(() => void (admin && costEntries === null && fetchCosts().then(actions.setCosts)), [admin, costEntries]);
  useEffect(() => void fetchBills().then((r) => setBills(r ? r.bills : [])), [admin, user?.userId]);
  const ops = admin ? (costEntries ?? []).reduce((n, c) => n + monthlyCost(c), 0) : 0;
  const usage = (costEntries ?? []).some((c) => c.active && c.monthly_cost_fixed === null && c.monthly_cost_estimate !== null);
  const home = (bills ?? []).reduce((n, b) => n + perMonth(b), 0);
  const once = (bills ?? []).filter((b) => b.active && b.recurring === "once").reduce((n, b) => n + (b.amount ?? 0), 0);
  const ready = bills !== null && (!admin || costEntries !== null);
  return (
    <section className="rd-fin-summary" aria-label="Monthly summary">
      <div className="rd-fin-figures">
        <div>
          <div className="rd-eyebrow">MONTHLY EQUIVALENT</div>
          <div className="rd-fin-n">{ready ? usd(ops + home) : "—"}</div>
          <small>{admin ? "Recurring costs + recurring bills" : "Your recurring bills"}</small>
        </div>
        {admin && (
          <div>
            <div className="rd-eyebrow">OPERATING COSTS</div>
            <div className="rd-fin-n">{ready ? usd(ops) : "—"}</div>
            <small>Active costs{usage ? " · usage estimated" : ""}</small>
          </div>
        )}
        <div>
          <div className="rd-eyebrow">PERSONAL BILLS</div>
          <div className="rd-fin-n">{ready ? usd(home) : "—"}</div>
          <small>Weekly and yearly normalized</small>
        </div>
      </div>
      <div className="rd-fin-foot">{once > 0 ? `One-time bills: ${usd(once)} separately` : "No one-time bills"} · Figures are what you entered; nothing here confirms a payment.</div>
    </section>
  );
}

export function FinancesPage({ body }: { body: ReactNode }) {
  const { view } = useAppState();
  return (
    <div className="rd-page rd-page-scroll rd-fin" data-page="finances">
      <div className="rd-page-top">
        <header className="rd-page-head">
          <div>
            <div className="rd-eyebrow">THE COST OF WORK AND LIFE</div>
            <h1 className="rd-title">One clear picture.</h1>
            <p className="rd-sub">Operating costs and personal bills, together when you need the whole picture.</p>
          </div>
        </header>
        <Summary />
        <PageTabs page="finances" />
      </div>
      {/* The category chips sit under the "Operating costs." heading (FINAL): Costs places them — on the
          phone too, as the concept (11/04, item 4: the selected "All" must show whole at every width). */}
      <FinCatsSlot.Provider value={view === "costs" ? <div className="rd-fin-cats"><SidebarContent view="costs" /></div> : null}>
        <div className="rd-fin-body">{body}</div>
      </FinCatsSlot.Provider>
    </div>
  );
}
