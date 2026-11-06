/**
 * Global search (slice 9; SEARCH is PARTIAL — no federated server index).
 * "In AHI" searches what this session is already allowed to see: messages in
 * every agent thread it holds, builds, review items, documents (uploads,
 * clips, mission-control cards) — each fetched with the user's own session,
 * so a member's search never contains an owner's sources. Results are grouped
 * with counts and jump to the exact source (a message opens its thread at
 * that message). Web and Images run only on request, through the existing
 * search service in a conversation with the lead agent; when that service is
 * off, the tab says so.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { actions, availableBots, getState, useAppState } from "../store";
import { fetchClips, fetchFiles, fetchMc } from "../lib/api";
import { BUILDS_URL, type BuildsView } from "../lib/builds";
import { SCHEDULE_URL, scheduleUi, type ScheduleView } from "../lib/schedule";
import { fetchReview, type ReviewItem } from "../lib/review";
import { runSearch, searchStatus } from "../lib/search";
import SearchCard from "../components/search/SearchCard";
import { BOT_LABELS, BOT_SUBTITLES, isPrivate } from "../lib/types";
import { PURPOSE } from "./Team";
import { goPage } from "./Shell";
import { Icon, type IconName } from "./icons";
import { useEscape } from "../components/FinalDialog";

type Src = "messages" | "work" | "documents" | "calendar" | "team";
interface Hit { key: string; src: Src; title: string; sub: string; snippet: string; open: () => void }
const SRC: Record<Src, { label: string; icon: IconName }> = {
  messages: { label: "Messages", icon: "messages" },
  work: { label: "Your work", icon: "layers" },
  documents: { label: "Documents", icon: "folder" },
  calendar: { label: "Calendar", icon: "calendar" },
  team: { label: "Your team", icon: "people" },
};

function snippet(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return text.slice(0, 160);
  const start = Math.max(0, i - 60);
  return `${start ? "…" : ""}${text.slice(start, i + q.length + 100)}${i + q.length + 100 < text.length ? "…" : ""}`;
}

function Mark({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

export default function GlobalSearch({ onClose }: { onClose: () => void }) {
  const s = useAppState();
  const admin = !!s.user?.admin;
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"ahi" | "web" | "images">("ahi");
  const [src, setSrc] = useState<Src | "all">("all");
  const [builds, setBuilds] = useState<BuildsView | null>(null);
  const [review, setReview] = useState<ReviewItem[]>([]);
  const [sched, setSched] = useState<ScheduleView | null>(null);
  const [webOn, setWebOn] = useState<boolean | null>(null);
  const [sel, setSel] = useState(0);
  // Web / Images run here, in the panel (like the design's search, never a slash
  // command typed into a composer). The server records each search as a card in the lead agent's
  // conversation; the panel shows that same card.
  const [ext, setExt] = useState<{ kind: "web" | "images"; q: string; status: "running" | "done" | "error"; messageId: string | null; error?: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    if (s.filesList === null) void fetchFiles().then(actions.setFiles);
    if (s.clips === null) void fetchClips().then(actions.setClips);
    if (s.mcFiles === null) void fetchMc().then(actions.setMcFiles);
    if (admin) {
      const stillOwner = () => !!getState().user?.admin;
      fetch(BUILDS_URL, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((v) => stillOwner() && setBuilds(v)).catch(() => {});
      void fetchReview(false).then((v) => stillOwner() && setReview(v ? [...v.waiting, ...v.holding] : []));
      fetch(SCHEDULE_URL, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((v) => stillOwner() && setSched(v)).catch(() => {});
    }
    void searchStatus().then((st) => setWebOn(!!st.enabled));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Access dropped while open: forget owner data now, so nothing fetched before (or arriving after)
  // the change can surface if access comes back mid-session (review R2-3).
  useEffect(() => {
    if (admin) return;
    setBuilds(null);
    setReview([]);
    setSched(null);
  }, [admin]);
  useEscape(onClose);

  const needle = q.trim().toLowerCase();
  const hits = useMemo<Hit[]>(() => {
    if (!needle) return [];
    const out: Hit[] = [];
    const bots = availableBots(s.user);
    for (const bot of bots)
      for (const m of s.threads[bot] ?? []) {
        if (isPrivate(m) || !m.text || !m.text.toLowerCase().includes(needle)) continue;
        const id = m.meta?.messageId;
        out.push({
          key: `m:${bot}:${id ?? m.timestamp}`, src: "messages", title: m.direction === "out" ? BOT_LABELS[bot] ?? bot : `You → ${BOT_LABELS[bot] ?? bot}`,
          sub: new Date(m.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
          snippet: snippet(m.text, needle),
          open: () => (id ? actions.revealMessage(bot, id, true) : (actions.setView("messages"), actions.openMobileThread(bot))),
        });
      }
    if (admin && builds)
      for (const sec of Object.values(builds.sections))
        for (const c of sec) {
          const text = [c.title, c.ask, c.now?.text, c.done, c.left].filter(Boolean).join(" · ");
          if (text.toLowerCase().includes(needle)) out.push({ key: `b:${c.id}`, src: "work", title: c.title, sub: "Builds", snippet: snippet(text, needle), open: () => actions.openBuilds(c.id) });
        }
    for (const r of admin ? review : []) {
      const text = `${r.title} · ${r.brief}`;
      if (text.toLowerCase().includes(needle)) out.push({ key: `r:${r.id}`, src: "work", title: r.title, sub: `Review · ${r.lane.toLowerCase()}`, snippet: snippet(r.brief, needle), open: () => actions.openReview(r.id) });
    }
    for (const f of s.filesList ?? []) if (f.name.toLowerCase().includes(needle)) out.push({ key: `f:${f.name}`, src: "documents", title: f.name.split("/").pop() ?? f.name, sub: "Uploads", snippet: "", open: () => actions.setView("files") });
    for (const c of s.clips ?? []) if (c.text.toLowerCase().includes(needle)) out.push({ key: `c:${c.id}`, src: "documents", title: c.text.slice(0, 60), sub: "Clips", snippet: snippet(c.text, needle), open: () => actions.setView("clipboard") });
    for (const m of Object.values(s.mcFiles ?? {})) {
      const text = `${m.label} ${m.blurb ?? ""} ${m.content ?? ""}`;
      if (text.toLowerCase().includes(needle)) out.push({ key: `mc:${m.name}`, src: "documents", title: m.label, sub: `Mission control / ${m.name}`, snippet: snippet(m.content ?? m.blurb ?? "", needle), open: () => actions.openMcCard(m.name) });
    }
    for (const b of admin && sched ? Object.values(sched.blocks) : []) {
      const text = `${b.title} · ${b.detail ?? ""}`;
      if (text.toLowerCase().includes(needle))
        out.push({
          key: `cal:${b.id}`, src: "calendar", title: b.title,
          sub: new Date(b.start).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: sched!.zone }),
          snippet: b.detail ? snippet(b.detail, needle) : "", open: () => scheduleUi.open(b.id),
        });
    }
    for (const bot of availableBots(s.user)) {
      const text = `${BOT_LABELS[bot] ?? bot} · ${BOT_SUBTITLES[bot] ?? ""} · ${PURPOSE[bot] ?? ""}`;
      if (text.toLowerCase().includes(needle)) out.push({ key: `t:${bot}`, src: "team", title: BOT_LABELS[bot] ?? bot, sub: BOT_SUBTITLES[bot] ?? "Your team", snippet: PURPOSE[bot] ?? "", open: () => goPage("team") });
    }
    return out;
  }, [needle, admin, s.threads, s.user, builds, review, sched, s.filesList, s.clips, s.mcFiles]);
  const shown = hits.filter((h) => src === "all" || h.src === src);
  const counts = (Object.keys(SRC) as Src[]).map((k) => [k, hits.filter((h) => h.src === k).length] as const);
  const go = (h: Hit) => {
    onClose();
    h.open();
  };
  const lead = availableBots(s.user).includes("michael") ? "michael" : availableBots(s.user)[0];
  const external = async (kind: "web" | "images") => {
    // Same gate for Enter and the button (review R1-P1): nothing when search is off or still unknown.
    if (webOn !== true || !lead || !q.trim() || ext?.status === "running") return;
    const query = q.trim();
    setExt({ kind, q: query, status: "running", messageId: null });
    const r = await runSearch(lead, kind, query);
    setExt(r.ok ? { kind, q: query, status: "done", messageId: r.messageId } : { kind, q: query, status: "error", messageId: null, error: r.error });
  };
  const extMsg = ext?.messageId && lead ? (s.threads[lead] ?? []).find((m) => m.meta?.messageId === ext.messageId && m.meta?.search) : undefined;

  return (
    <div className="rd-search-layer" role="dialog" aria-label="Search your workspace" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rd-search-panel">
        <div className="rd-search-input">
          <Icon name="search" />
          <input
            ref={input}
            value={q}
            placeholder="Search your world…"
            aria-label="Search your world"
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (tab !== "ahi") {
                if (e.key === "Enter") void external(tab);
                return;
              }
              if (e.key === "ArrowDown") (e.preventDefault(), setSel((n) => Math.min(n + 1, shown.length - 1)));
              if (e.key === "ArrowUp") (e.preventDefault(), setSel((n) => Math.max(n - 1, 0)));
              if (e.key === "Enter" && shown[sel]) go(shown[sel]);
            }}
          />
          {q && (
            <button
              type="button"
              className="rd-search-clear"
              aria-label="Clear search"
              onClick={() => {
                setQ("");
                setSel(0);
                input.current?.focus();
              }}
            >
              <Icon name="x" />
            </button>
          )}
          <button type="button" className="rd-esc-hint" aria-label="Close search" onClick={onClose}>
            Esc
          </button>
        </div>
        <div className="rd-search-tabs" role="tablist">
          {(["ahi", "web", "images"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              <Icon name={t === "ahi" ? "layers" : t === "web" ? "globe" : "image"} /> {t === "ahi" ? "In AHI" : t === "web" ? "Web" : "Images"}
            </button>
          ))}
          <span className="rd-quiet">One search. Your world.</span>
        </div>
        {tab === "ahi" ? (
          <>
            {!!needle && !!hits.length && (
              <div className="rd-chips">
                <button type="button" className={`rd-chip${src === "all" ? " on" : ""}`} onClick={() => setSrc("all")}>
                  All <span className="rd-count">{hits.length}</span>
                </button>
                {counts.filter(([, n]) => n).map(([k, n]) => (
                  <button key={k} type="button" className={`rd-chip${src === k ? " on" : ""}`} onClick={() => setSrc(k)}>
                    {SRC[k].label} <span className="rd-count">{n}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="rd-search-results">
              {!needle && (
                <div className="rd-search-welcome">
                  <span className="rd-search-symbol"><Icon name="search" /></span>
                  <h2>Find the detail. Pick up where it lives.</h2>
                  <p>
                    Search messages, documents, calendar, and your work.
                    <br />
                    Switch to Web or Images to look beyond AHI.
                  </p>
                </div>
              )}
              {!!needle && !hits.length && (
                <div className="rd-search-none">
                  <h2>No matches in AHI</h2>
                  <p>Try another keyword, or look on the web.</p>
                  <div>
                    <button type="button" onClick={() => setTab("web")}>
                      Search Web <Icon name="arrow-right" />
                    </button>
                    <button type="button" onClick={() => setTab("images")}>
                      Find images <Icon name="image" />
                    </button>
                  </div>
                </div>
              )}
              {(Object.keys(SRC) as Src[]).map((k) => {
                const list = shown.filter((h) => h.src === k);
                if (!list.length) return null;
                return (
                  <section key={k}>
                    <h3>
                      <Icon name={SRC[k].icon} /> {SRC[k].label} <span>{list.length} {list.length === 1 ? "match" : "matches"}</span>
                    </h3>
                    {list.map((h) => (
                      <button key={h.key} type="button" className={`rd-hit${shown[sel]?.key === h.key ? " sel" : ""}`} onClick={() => go(h)}>
                        <span className="rd-hit-title"><Mark text={h.title} q={needle} /></span>
                        <span className="rd-hit-sub">{h.sub}</span>
                        {h.snippet && <span className="rd-hit-snip"><Mark text={h.snippet} q={needle} /></span>}
                        <span className="rd-hit-go" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 17 17 7M7 7h10v10" /></svg></span>
                      </button>
                    ))}
                  </section>
                );
              })}
            </div>
            <div className="rd-search-foot rd-quiet">
              <span role="status" aria-live="polite">{needle ? `${hits.length} matching item${hits.length === 1 ? "" : "s"} · Select to jump to source` : "Local workspace search"}</span>
              <span>↵ Open · ↑↓ Navigate</span>
            </div>
          </>
        ) : (
          <div className="rd-search-external">
            {webOn === false ? (
              <p>Web and image search is off on this server, so nothing leaves AHI from here.</p>
            ) : ext && ext.kind === tab && ext.q === q.trim() ? (
              ext.status === "running" ? (
                <p className="rd-quiet">Searching {tab === "web" ? "the web" : "pictures"} for “{ext.q}”…</p>
              ) : ext.status === "error" ? (
                <p role="alert">Search didn’t run: {ext.error}</p>
              ) : extMsg?.meta?.search && ext.messageId ? (
                <div className="rd-ext-results">
                  <SearchCard card={extMsg.meta.search} messageId={ext.messageId} bot={lead ?? "michael"} byLabel={s.user?.name ?? "You"} />
                  <p className="rd-quiet">
                    Saved in your conversation with {BOT_LABELS[lead ?? "michael"]}.{" "}
                    <button type="button" className="rd-link-action" onClick={() => (onClose(), actions.revealMessage(lead ?? "michael", ext.messageId!, true))}>
                      Open it there
                    </button>
                  </p>
                </div>
              ) : (
                <p className="rd-quiet">Loading results…</p>
              )
            ) : (
              <div className="rd-search-welcome">
                <span className="rd-search-symbol"><Icon name={tab === "images" ? "image" : "globe"} /></span>
                <h2>{tab === "images" ? "A reference, without losing your place." : "Look beyond your workspace."}</h2>
                <p>{tab === "images" ? "Preview, save, or attach an image to an agent’s draft." : "Browse a result and bring its source into your conversation."}</p>
                <button type="button" className="rd-search-run" disabled={!q.trim() || webOn !== true} onClick={() => void external(tab)}>
                  {tab === "images" ? "Search images" : "Search the web"} <Icon name="arrow-right" />
                </button>
                <small>Runs only when you ask. Results are saved in your conversation with {BOT_LABELS[lead ?? "michael"]}.</small>
              </div>
            )}
          </div>
        )}
        {tab !== "ahi" && (
          <div className="rd-search-foot rd-quiet">
            <span>{webOn === false ? "Web search is off on this server" : `Saved in your conversation with ${BOT_LABELS[lead ?? "michael"]}`}</span>
            <span>↵ Search</span>
          </div>
        )}
      </div>
    </div>
  );
}
