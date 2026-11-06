import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { actions, availableBots, useAppState } from "../store";
import { BOT_LABELS, type MediaRef } from "../lib/types";
import { fetchPanelPage, asMediaRef, shortDate, showInChat, type PanelItem, type PanelTab } from "../lib/mediaPanel";
import { downloadUrl, formatDuration, formatSize, mediaUrl, sharpenOnLoad, thumbSrc } from "../lib/mediaFormat";
import { showToast } from "../lib/toast";
import ExpandedMedia from "./ExpandedMedia";
import AudioFile from "./AudioFile";
import { IconClose, IconDownload, IconFiles, IconLink, IconPlay, IconShowInChat } from "./icons";
import { Icon } from "../redesign/icons";
import { railOrder } from "../redesign/agents";

/* ============================================================
   MediaPanel — the chat's Media / Files / Links (10/13; brings back the
   old dashboard's media manager, lost in the July rebuild).

   Sheet on the phone, side panel on desktop. Both directions, scoped to
   the open agent (or every agent). Pages by cursor through the whole
   thread, newest first. Every item: open it (viewer / player / browser),
   save the original file, or Show in chat.
   ============================================================ */

const TABS: Array<{ key: PanelTab; label: string; name: string }> = [
  { key: "media", label: "MEDIA", name: "Media" },
  { key: "files", label: "FILES", name: "Files" },
  { key: "links", label: "LINKS", name: "Links" },
];

const EMPTY: Record<PanelTab, string> = {
  media: "NO PHOTOS OR VIDEOS YET",
  files: "NO FILES YET",
  links: "NO LINKS YET",
};

interface TabState {
  items: PanelItem[];
  cursor: string | null;
  done: boolean;
  loading: boolean;
  error: boolean;
}

const fresh = (): TabState => ({ items: [], cursor: null, done: false, loading: false, error: false });

/**
 * `page` (redesign, FINAL Gallery): the panel fills the Messages workspace —
 * Back to chat, a title, tabs, the agent scope. Media is a thumbnail grid:
 * a tap opens the viewer, which swipes through the gallery and
 * has Save and Show in chat. Files and Links stay lists.
 */
export default function MediaPanel({ bot, mobile, page = false }: { bot: string; mobile: boolean; page?: boolean }) {
  const { user } = useAppState();
  const multiAgent = (user?.agents.length ?? 0) > 1;
  const [tab, setTab] = useState<PanelTab>("media");
  // The agent scope: the open conversation's agent until another (or "all") is picked.
  const [picked, setPicked] = useState<string | null>(null);
  const scope = picked ?? bot;
  const allAgents = scope === "all";
  const [data, setData] = useState<Record<PanelTab, TabState>>({ media: fresh(), files: fresh(), links: fresh() });
  const [viewerAt, setViewerAt] = useState<number | null>(null);
  // Search shared content (A6; FINAL's search bar): titles, captions, links, file names.
  const [query, setQuery] = useState("");
  // A response for an old scope must never land in the new one.
  const generation = useRef(0);

  useEffect(() => {
    generation.current++;
    setData({ media: fresh(), files: fresh(), links: fresh() });
    setViewerAt(null);
  }, [scope]);

  const loaded = data[tab];
  const needle = query.trim().toLowerCase();
  const current = useMemo(
    () =>
      needle
        ? { ...loaded, items: loaded.items.filter((i) => [i.media?.originalName, i.title, i.snippet, i.url, i.sender].some((t) => !!t && t.toLowerCase().includes(needle))) }
        : loaded,
    [loaded, needle],
  );

  const loadMore = useCallback(async () => {
    const t = tab;
    const s = data[t];
    if (s.loading || s.done) return;
    const gen = generation.current;
    setData((d) => ({ ...d, [t]: { ...d[t], loading: true, error: false } }));
    try {
      const page = await fetchPanelPage(t, scope, s.cursor);
      if (gen !== generation.current) return;
      setData((d) => ({
        ...d,
        [t]: {
          items: [...d[t].items, ...page.items.filter((i) => !d[t].items.some((x) => x.key === i.key))],
          cursor: page.nextCursor,
          done: !page.nextCursor,
          loading: false,
          error: false,
        },
      }));
    } catch {
      if (gen !== generation.current) return;
      setData((d) => ({ ...d, [t]: { ...d[t], loading: false, error: true } }));
    }
  }, [tab, data, scope]);

  // First page of a tab on first visit.
  useEffect(() => {
    if (!loaded.items.length && !loaded.done && !loaded.loading && !loaded.error) void loadMore();
  }, [loaded, loadMore]);

  // Infinite scroll: the sentinel at the end of the list asks for the next page.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || current.done || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [current.done, current.items.length, loadMore]);

  // Esc closes (the viewer handles its own Esc first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && viewerAt === null) actions.toggleMediaPanel(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewerAt]);

  const reveal = useCallback(
    async (item: PanelItem) => {
      setViewerAt(null);
      const ok = await showInChat(item, mobile || page);
      if (!ok) showToast("That message isn't in the chat history anymore");
    },
    [mobile],
  );

  const viewerItems = useMemo(
    () => (tab === "media" ? current.items.map(asMediaRef).filter((m): m is MediaRef => !!m) : []),
    [tab, current.items],
  );

  const label = BOT_LABELS[bot] ?? bot;

  return (
    <>
      {mobile && !page && <div className="mp-scrim" onClick={() => actions.toggleMediaPanel(false)} />}
      <aside className={`media-panel${page ? " is-page" : mobile ? " is-sheet" : ""}`} role="dialog" aria-label="Media, files and links">
        {page && (
          <div className="mp-page-head">
            <button type="button" className="mp-back" onClick={() => actions.toggleMediaPanel(false)}>
              <span aria-hidden="true">←</span> Back to chat
            </button>
            <h1 className="rd-title">Shared with your team<span className="rd-title-dot">.</span></h1>
            <p className="rd-sub">Everything you’ve exchanged, with the conversation close by.</p>
          </div>
        )}
        {page ? (
          <PageToolbar tab={tab} setTab={setTab} scope={scope} setScope={setPicked} agents={multiAgent ? railOrder(availableBots(user)) : []} query={query} setQuery={setQuery} />
        ) : (
        <header className="mp-head">
          {mobile && <span className="mp-grabber" aria-hidden="true" />}
          <div className="mp-title-row">
            <span className="mp-title">{allAgents ? "All agents" : label}</span>
            {multiAgent && (
              <div className="mp-scope" role="group" aria-label="Scope">
                <button type="button" className={!allAgents ? "on" : ""} aria-pressed={!allAgents} onClick={() => setPicked(null)}>
                  {label}
                </button>
                <button type="button" className={allAgents ? "on" : ""} aria-pressed={allAgents} onClick={() => setPicked("all")}>
                  All agents
                </button>
              </div>
            )}
            <button type="button" className="topbar-btn mp-close" aria-label="Close media" onClick={() => actions.toggleMediaPanel(false)}>
              <IconClose />
            </button>
          </div>
          <nav className="mp-tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                className={`mp-tab mono-label${tab === t.key ? " on" : ""}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </header>
        )}

        {page && (
          <div className="mp-summary" aria-live="polite">
            {/* Never "0 items" while the first page is still on its way. */}
            <span>
              {!current.items.length && !current.done ? (
                "Loading…"
              ) : (
                <>
                  {current.items.length} {current.items.length === 1 ? "item" : "items"}
                  {current.done ? "" : " so far"}
                  {allAgents ? " across your team" : ` with ${BOT_LABELS[scope] ?? scope}`}
                </>
              )}
            </span>
            <small>In your conversations</small>
          </div>
        )}
        <div className="mp-body" role="tabpanel" data-tab={tab}>
          {tab === "media" && current.items.length > 0 && (
            <div className="mp-grid">
              {current.items.map((item, i) => (
                <MediaTile key={item.key} item={item} onOpen={() => setViewerAt(i)} />
              ))}
            </div>
          )}
          {tab === "files" &&
            current.items.map((item) => <FileRow key={item.key} item={item} allAgents={allAgents} onReveal={() => void reveal(item)} />)}
          {tab === "links" &&
            current.items.map((item) => <LinkRow key={item.key} item={item} allAgents={allAgents} onReveal={() => void reveal(item)} />)}

          {current.done && current.items.length === 0 && <div className="mp-empty mono-label">{needle ? `Nothing shared matches “${query.trim()}”.` : EMPTY[tab]}</div>}
          {current.error && (
            <button type="button" className="mp-more mono-label" onClick={() => void loadMore()}>
              COULDN'T LOAD — TAP TO RETRY
            </button>
          )}
          {!current.done && !current.error && (
            <div ref={sentinel} className="mp-more mono-label">
              {current.loading ? "LOADING…" : (
                <button type="button" onClick={() => void loadMore()}>LOAD MORE</button>
              )}
            </div>
          )}
        </div>
      </aside>

      {viewerAt !== null && viewerItems.length > 0 && (
        <ExpandedMedia
          items={viewerItems}
          startIndex={Math.min(viewerAt, viewerItems.length - 1)}
          onClose={() => setViewerAt(null)}
          onShowInChat={(i) => {
            const item = current.items[i];
            if (item) void reveal(item);
          }}
        />
      )}
    </>
  );
}

function who(item: PanelItem, allAgents: boolean): string {
  const date = shortDate(item.timestamp);
  const agent = BOT_LABELS[item.bot] ?? item.bot;
  // In "All agents", an item from the owner says which chat it went to.
  const sender = item.direction === "in" && allAgents ? `${item.sender} → ${agent}` : item.sender;
  return [sender, date].filter(Boolean).join(" · ");
}

function MediaTile({ item, onOpen }: { item: PanelItem; onOpen: () => void }) {
  const m = item.media;
  if (!m) return null;
  const thumb = m.thumbnail || item.kind === "image" ? thumbSrc(m) : null;
  return (
    <button type="button" className="mp-tile" onClick={onOpen} aria-label={`${m.originalName}, from ${item.sender}`} title={m.originalName} data-key={item.key}>
      {thumb ? <img src={thumb} alt="" loading="lazy" onLoad={item.kind === "image" ? (e) => sharpenOnLoad(e, m.id) : undefined} /> : <span className="mp-tile-blank mono-label">VIDEO</span>}
      {item.kind === "video" && (
        <span className="mp-tile-badge mono-label">
          <IconPlay />
          {formatDuration(m.durationSec)}
        </span>
      )}
      {item.direction === "out" && <span className="mp-tile-dot" data-bot={item.bot} aria-hidden="true" />}
    </button>
  );
}

function RowActions({ item, onReveal, save = true }: { item: PanelItem; onReveal: () => void; save?: boolean }) {
  return (
    <div className="mp-actions">
      {save && item.media && (
        <a
          className="mp-act"
          href={downloadUrl(item.media.id)}
          download={item.media.originalName}
          aria-label={`Save ${item.media.originalName}`}
          title="Save"
        >
          <IconDownload />
        </a>
      )}
      {item.messageId && (
        <button type="button" className="mp-act" onClick={onReveal} aria-label="Show in chat" title="Show in chat">
          <IconShowInChat />
        </button>
      )}
    </div>
  );
}

function FileRow({ item, allAgents, onReveal }: { item: PanelItem; allAgents: boolean; onReveal: () => void }) {
  const m = item.media;
  if (!m) return null;
  if (item.kind === "audio") {
    return (
      <div className="mp-row mp-row-audio" data-key={item.key}>
        <AudioFile media={{ path: "", ...m } as MediaRef} />
        <div className="mp-row-foot">
          <span className="mp-row-meta">{who(item, allAgents)}</span>
          {/* the card already carries Save */}
          <RowActions item={item} onReveal={onReveal} save={false} />
        </div>
      </div>
    );
  }
  const ext = m.originalName.includes(".") ? m.originalName.split(".").pop()!.toUpperCase().slice(0, 4) : "FILE";
  return (
    <div className="mp-row" data-key={item.key}>
      <a className="mp-row-main" href={mediaUrl(m.id)} target="_blank" rel="noopener noreferrer">
        <span className="mp-glyph">
          <IconFiles />
          <span className="tool-chip">{ext}</span>
        </span>
        <span className="mp-row-text">
          <span className="mp-row-name">{m.originalName}</span>
          <span className="mp-row-meta">
            {formatSize(m.size)} · {who(item, allAgents)}
          </span>
        </span>
      </a>
      <RowActions item={item} onReveal={onReveal} />
    </div>
  );
}

function LinkRow({ item, allAgents, onReveal }: { item: PanelItem; allAgents: boolean; onReveal: () => void }) {
  if (!item.url) return null;
  return (
    <div className="mp-row" data-key={item.key}>
      <a className="mp-row-main" href={item.url} target="_blank" rel="noopener noreferrer">
        <span className="mp-glyph">
          <IconLink />
        </span>
        <span className="mp-row-text">
          <span className="mp-row-name">{item.title ?? item.url}</span>
          {item.snippet && item.snippet !== item.url && <span className="mp-row-snippet">{item.snippet}</span>}
          <span className="mp-row-meta">{who(item, allAgents)}</span>
        </span>
      </a>
      <RowActions item={item} onReveal={onReveal} />
    </div>
  );
}

/**
 * The Shared page toolbar, as the concept (recording 2): Media / Files / Links on the left; on the
 * right an agent drop-down (All agents or one agent) and a search wide enough to type in. When the page
 * narrows, the drop-down and search wrap to their own line and the search stretches the full width.
 */
function PageToolbar(p: {
  tab: PanelTab;
  setTab: (t: PanelTab) => void;
  scope: string;
  setScope: (s: string) => void;
  agents: string[];
  query: string;
  setQuery: (q: string) => void;
}) {
  return (
    <header className="mp-toolbar">
      <nav className="mp-tabs" role="tablist" aria-label="Shared content type">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={p.tab === t.key} className={`mp-tab${p.tab === t.key ? " on" : ""}`} onClick={() => p.setTab(t.key)}>
            {t.name}
          </button>
        ))}
      </nav>
      <div className="mp-controls">
        {p.agents.length > 1 && (
          <label className="mp-agent-filter">
            <Icon name="people" />
            <select value={p.scope} onChange={(e) => p.setScope(e.target.value)} aria-label="Filter shared content by agent">
              <option value="all">All agents</option>
              {p.agents.map((b) => (
                <option key={b} value={b}>{BOT_LABELS[b] ?? b}</option>
              ))}
            </select>
          </label>
        )}
        <label className="mp-search">
          <Icon name="search" />
          <input type="search" value={p.query} onChange={(e) => p.setQuery(e.target.value)} placeholder="Search shared content…" aria-label="Search shared content" />
        </label>
      </div>
    </header>
  );
}
