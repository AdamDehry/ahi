import { memo, useEffect, useRef, useState } from "react";
import { BOT_LABELS } from "../lib/types";
import type { LocalMessage } from "../lib/types";
import { actions, availableBots, lastMessage, useAppState, type View } from "../store";
import {
  fetchClips,
  fetchCosts,
  fetchFiles,
  fetchMc,
  fetchFileCategories,
  createFileCategory,
  renameFileCategory,
  deleteFileCategory,
  moveFileTo,
  fetchCostCategories,
  createCostCategoryApi,
  renameCostCategoryApi,
  deleteCostCategoryApi,
} from "../lib/api";
import ContextMenu from "./ContextMenu";
import { IconSearch, IconPlus } from "./icons";

export const FILE_DRAG_TYPE = "application/x-ahi-file";

export function previewText(msg: LocalMessage | null): string {
  if (!msg) return "No messages yet";
  // One line of plain text: markdown emphasis/heading markers would show
  // raw here (digest and day-close messages open with **bold**).
  const plain = msg.text.replace(/\*\*|__|^#{1,6}\s+/gm, "").replace(/\s+/g, " ").trim();
  return plain || (msg.media ? `[${msg.media.type}]` : "");
}

/** An agent matches a search by its name or anything in its last message (empty search: every agent). */
export function agentMatches(threads: Record<string, LocalMessage[]>, bot: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || (BOT_LABELS[bot] ?? bot).toLowerCase().includes(q) || previewText(lastMessage(threads, bot)).toLowerCase().includes(q);
}

/** Files are stored with a category prefix ("general/name.png") — always
 *  display the bare filename (3c#8). */
export function displayFileName(name: string): string {
  const i = name.lastIndexOf("/");
  return i >= 0 ? name.slice(i + 1) : name;
}

export function fileCategory(name: string): string {
  const i = name.indexOf("/");
  return i > 0 ? name.slice(0, i) : "uncategorized";
}

export function relativeTime(ts: string | undefined): string {
  if (!ts) return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  const day = 86_400_000;
  if (diff < day && date.getDate() === new Date().getDate()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if (diff < 2 * day) return "YESTERDAY";
  if (diff < 7 * day) return date.toLocaleDateString([], { weekday: "long" }).toUpperCase();
  return date.toLocaleDateString([], { month: "short", day: "numeric" }).toUpperCase();
}

export const AgentRow = memo(function AgentRow({
  bot,
  active,
  last,
  onOpen,
  mobile = false,
}: {
  bot: string;
  active: boolean;
  last: LocalMessage | null;
  onOpen: (bot: string) => void;
  mobile?: boolean;
}) {
  const label = BOT_LABELS[bot] ?? bot;
  return (
    <button
      type="button"
      className={`agent-row${active && !mobile ? " active" : ""}`}
      onClick={() => onOpen(bot)}
    >
      <span className="agent-avatar" data-bot={bot}>
        {label.charAt(0)}
      </span>
      <span className="agent-row-body">
        <span className="agent-row-top">
          <span className="agent-row-name">{label}</span>
          <span className={`agent-row-time${active ? " accent" : ""}`}>{relativeTime(last?.timestamp)}</span>
        </span>
        <span className="agent-row-preview">{previewText(last)}</span>
      </span>
    </button>
  );
});

/** The Messages agent list — desktop sidebar, mobile root screen, and the
 *  collapsed-sidebar peek all render this. */
export function AgentList({
  mobile = false,
  withSearch = true,
  compact = false,
  onNavigate,
}: {
  mobile?: boolean;
  withSearch?: boolean;
  compact?: boolean;
  onNavigate?: () => void;
}) {
  const { threads, user, activeBot } = useAppState();
  const [query, setQuery] = useState("");

  const bots = availableBots(user);
  const ordered = [...bots].sort((a, b) => {
    const ta = lastMessage(threads, a)?.timestamp ?? "";
    const tb = lastMessage(threads, b)?.timestamp ?? "";
    if (ta !== tb) return tb.localeCompare(ta);
    return bots.indexOf(a) - bots.indexOf(b);
  });
  const filtered = ordered.filter((bot) => agentMatches(threads, bot, query));

  const open = (bot: string) => {
    if (mobile) actions.openMobileThread(bot);
    else actions.setActiveBot(bot);
    onNavigate?.();
  };

  if (compact) {
    return (
      <nav className="peek-list">
        {ordered.map((bot) => (
          <button
            key={bot}
            className={`dropdown-item${bot === activeBot ? " active" : ""}`}
            onClick={() => open(bot)}
          >
            <span className="agent-dot" data-bot={bot} />
            {BOT_LABELS[bot] ?? bot}
          </button>
        ))}
      </nav>
    );
  }

  return (
    <>
      {withSearch && (
        <label className="sidebar-search">
          <IconSearch />
          <input
            type="search"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
      <nav className={mobile ? "agent-list mobile" : "agent-list"}>
        {filtered.map((bot) => (
          <AgentRow
            key={bot}
            bot={bot}
            active={bot === activeBot}
            last={lastMessage(threads, bot)}
            onOpen={open}
            mobile={mobile}
          />
        ))}
      </nav>
    </>
  );
}

// ── Editable category list (Files + Costs share this — 3d§1) ─────────

export interface CategoryItem {
  key: string;
  label: string;
  /** No rename/delete/context-menu (All, general, uncategorized, built-ins vary). */
  locked?: boolean;
  /** Rename allowed but delete isn't (costs built-ins). */
  renameOnly?: boolean;
  /** Accepts file drops (Files categories only). */
  droppable?: boolean;
}

function CategoryRow({
  item,
  active,
  editing,
  onSelect,
  onStartEdit,
  onCommitEdit,
  onDelete,
  onDropFile,
}: {
  item: CategoryItem;
  active: boolean;
  editing: boolean;
  onSelect: () => void;
  onStartEdit: () => void;
  onCommitEdit: (label: string) => void;
  onDelete: () => void;
  onDropFile?: (fileName: string) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const dropProps =
    item.droppable && onDropFile
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (e.dataTransfer.types.includes(FILE_DRAG_TYPE)) {
              e.preventDefault();
              setDragOver(true);
            }
          },
          onDragLeave: () => setDragOver(false),
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            setDragOver(false);
            const name = e.dataTransfer.getData(FILE_DRAG_TYPE);
            if (name) onDropFile(name);
          },
        }
      : {};

  if (editing) {
    return (
      <div className="sidebar-filter editing">
        <input
          ref={inputRef}
          className="category-rename"
          defaultValue={item.label}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommitEdit((e.target as HTMLInputElement).value);
            if (e.key === "Escape") onCommitEdit(item.label);
          }}
          onBlur={(e) => onCommitEdit(e.target.value)}
        />
      </div>
    );
  }

  return (
    <>
      <button
        className={`sidebar-filter${active ? " active" : ""}${dragOver ? " drop-over" : ""}`}
        onClick={onSelect}
        onContextMenu={
          item.locked
            ? undefined
            : (e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY });
              }
        }
        {...dropProps}
      >
        {item.label}
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Rename", onSelect: onStartEdit },
            ...(item.renameOnly ? [] : [{ label: "Delete", danger: true, onSelect: onDelete }]),
          ]}
        />
      )}
    </>
  );
}

export function CategoryList({
  items,
  activeKey,
  editingKey,
  onSelect,
  onStartEdit,
  onCommitEdit,
  onDelete,
  onDropFile,
}: {
  items: CategoryItem[];
  activeKey: string;
  editingKey: string | null;
  onSelect: (key: string) => void;
  onStartEdit: (key: string) => void;
  onCommitEdit: (key: string, label: string) => void;
  onDelete: (key: string) => void;
  onDropFile?: (fileName: string, category: string) => void;
}) {
  return (
    <nav className="sidebar-filters">
      {items.map((item) => (
        <CategoryRow
          key={item.key}
          item={item}
          active={activeKey === item.key}
          editing={editingKey === item.key}
          onSelect={() => onSelect(item.key)}
          onStartEdit={() => onStartEdit(item.key)}
          onCommitEdit={(label) => onCommitEdit(item.key, label)}
          onDelete={() => onDelete(item.key)}
          onDropFile={onDropFile ? (name) => onDropFile(name, item.key) : undefined}
        />
      ))}
    </nav>
  );
}

// ── Per-view sidebar content (shared by sidebar + peek) ──────────────

const CLIP_TYPES = [
  { key: "all", label: "All" },
  { key: "text", label: "Text" },
  { key: "links", label: "Links" },
  { key: "code", label: "Code" },
];

function FilterList({
  options,
  onNavigate,
}: {
  options: Array<{ key: string; label: string }>;
  onNavigate?: () => void;
}) {
  const { toolFilter } = useAppState();
  return (
    <nav className="sidebar-filters">
      {options.map((o) => (
        <button
          key={o.key}
          className={`sidebar-filter${toolFilter === o.key ? " active" : ""}`}
          onClick={() => {
            actions.setToolFilter(o.key);
            onNavigate?.();
          }}
        >
          {o.label}
        </button>
      ))}
    </nav>
  );
}

export function sidebarLabel(view: View): string {
  switch (view) {
    case "messages":
      return "MESSAGES";
    case "mission-control":
      return "CARDS";
    case "builds":
    case "review":
    case "whatsapp":
      return "CLOSE-OUT";
    case "bills":
      return "MY BILLS";
    default:
      return "CATEGORIES";
  }
}

function LabelRow({ view, peek, onAdd, more }: { view: View; peek: boolean; onAdd?: () => void; more?: React.ReactNode }) {
  return (
    <div className={`sidebar-label-row${peek ? " peek" : ""}`}>
      <span className="mono-label sidebar-label">{sidebarLabel(view)}</span>
      {onAdd && (
        <button className="label-add" onClick={onAdd} aria-label="Add category" title="Add category">
          <IconPlus />
        </button>
      )}
      {more}
    </div>
  );
}

/** FINAL's "···" after "+" in the cost chip row: the open category's actions (the same Rename / Delete as
 *  right-clicking its chip). "All" has none, so the button is off there. */
function CategoryMoreButton({ item, onRename, onDelete }: { item: CategoryItem | undefined; onRename: () => void; onDelete: () => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const off = !item || item.locked;
  return (
    <>
      <button
        className="label-add label-more"
        disabled={off}
        aria-label={off ? "Category actions (pick a category first)" : `Category actions for ${item.label}`}
        title={off ? "Pick a category first" : "Category actions"}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 6 });
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M5 12h.01M12 12h.01M19 12h.01" />
        </svg>
      </button>
      {menu && item && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[{ label: "Rename", onSelect: onRename }, ...(item.renameOnly ? [] : [{ label: "Delete", danger: true, onSelect: onDelete }])]}
        />
      )}
    </>
  );
}

function refreshFileCategories(): void {
  fetchFileCategories().then(actions.setFileCategories);
}

function refreshCostCategories(): void {
  fetchCostCategories().then(actions.setCostCategories);
}

/** Files categories — full CRUD + drop-to-move (3d§1/§2). */
function FilesCategories({ peek, onNavigate }: { peek: boolean; onNavigate?: () => void }) {
  const { fileCategories, filesList, toolFilter } = useAppState();
  const [editingKey, setEditingKey] = useState<string | null>(null);

  // Derived "uncategorized" for legacy root-level files (not a real dir:
  // not droppable, not editable).
  const hasUncategorized = (filesList ?? []).some((f) => !f.name.includes("/"));

  const items: CategoryItem[] = [
    { key: "all", label: "All", locked: true },
    ...(fileCategories ?? ["general"]).map((c) => ({
      key: c,
      label: c.charAt(0).toUpperCase() + c.slice(1),
      locked: c === "general",
      droppable: true,
    })),
    ...(hasUncategorized ? [{ key: "uncategorized", label: "Uncategorized", locked: true }] : []),
  ];

  async function add() {
    const result = await createFileCategory("New category");
    refreshFileCategories();
    if (result.ok && typeof result.name === "string") setEditingKey(result.name);
  }

  async function commitEdit(key: string, label: string) {
    setEditingKey(null);
    const next = label.trim();
    if (!next || next === key) return;
    await renameFileCategory(key, next);
    refreshFileCategories();
    fetchFiles().then(actions.setFiles);
    if (toolFilter === key) actions.setToolFilter(next.toLowerCase().replace(/[^a-z0-9._-]/g, "-"));
  }

  async function remove(key: string) {
    if (!confirm(`Delete category "${key}"? Its files move to General.`)) return;
    await deleteFileCategory(key);
    refreshFileCategories();
    fetchFiles().then(actions.setFiles);
    if (toolFilter === key) actions.setToolFilter("all");
  }

  async function dropFile(name: string, category: string) {
    if (category === "all" || category === "uncategorized") return;
    const r = await moveFileTo(name, category);
    if (!r.ok && r.error) alert(r.error);
    fetchFiles().then(actions.setFiles);
  }

  return (
    <>
      <LabelRow view="files" peek={peek} onAdd={add} />
      <CategoryList
        items={items}
        activeKey={toolFilter}
        editingKey={editingKey}
        onSelect={(key) => {
          actions.setToolFilter(key);
          onNavigate?.();
        }}
        onStartEdit={setEditingKey}
        onCommitEdit={commitEdit}
        onDelete={remove}
        onDropFile={dropFile}
      />
    </>
  );
}

/** Costs categories — real CRUD (3d§4; replaces the 3c stub). */
function CostsCategories({ peek, onNavigate }: { peek: boolean; onNavigate?: () => void }) {
  const { costCategories, toolFilter } = useAppState();
  const [editingKey, setEditingKey] = useState<string | null>(null);

  const items: CategoryItem[] = [
    { key: "all", label: "All", locked: true },
    ...(costCategories ?? []).map((c) => ({
      key: c.key,
      label: c.label,
      renameOnly: c.builtin, // built-ins rename (label only), never delete
    })),
  ];

  async function add() {
    const result = await createCostCategoryApi("New category");
    refreshCostCategories();
    const cat = result.category as { key?: string } | undefined;
    if (result.ok && cat?.key) setEditingKey(cat.key);
  }

  async function commitEdit(key: string, label: string) {
    setEditingKey(null);
    const next = label.trim();
    if (!next) return;
    await renameCostCategoryApi(key, next);
    refreshCostCategories();
  }

  async function remove(key: string) {
    if (!confirm(`Delete category "${key}"? Its subscriptions move to Personal.`)) return;
    await deleteCostCategoryApi(key);
    refreshCostCategories();
    fetchCosts().then(actions.setCosts);
    if (toolFilter === key) actions.setToolFilter("all");
  }

  return (
    <>
      <LabelRow
        view="costs"
        peek={peek}
        onAdd={add}
        more={<CategoryMoreButton item={items.find((i) => i.key === toolFilter)} onRename={() => setEditingKey(toolFilter)} onDelete={() => remove(toolFilter)} />}
      />
      <CategoryList
        items={items}
        activeKey={toolFilter}
        editingKey={editingKey}
        onSelect={(key) => {
          actions.setToolFilter(key);
          onNavigate?.();
        }}
        onStartEdit={setEditingKey}
        onCommitEdit={commitEdit}
        onDelete={remove}
      />
    </>
  );
}

/**
 * The per-view sidebar contents — ONE component, rendered by the open
 * sidebar AND the collapsed-sidebar hover peek. Lazy-loads its own data
 * so the peek works before a view was ever opened.
 */
/** Builds + Review + WhatsApp side by side (design §7): Builds' badge is warn (questions
 *  and his own steps), Review's is brass (its waiting count), WhatsApp's is warn (people
 *  waiting on a call back) — never one thing twice (C11). */
function CloseOutNav({ view, peek, onNavigate }: { view: View; peek: boolean; onNavigate?: () => void }) {
  const { buildsNeedYou, reviewWaiting, waWaiting } = useAppState();
  const items: Array<{ key: "builds" | "review" | "whatsapp"; label: string; badge: number; tone: string }> = [
    { key: "builds", label: "Builds", badge: buildsNeedYou, tone: "you" },
    { key: "review", label: "Review", badge: reviewWaiting, tone: "" },
    { key: "whatsapp", label: "WhatsApp", badge: waWaiting, tone: "you" },
  ];
  return (
    <>
      <LabelRow view={view} peek={peek} />
      <nav className="sidebar-filters">
        {items.map((it) => (
          <button
            key={it.key}
            className={`sidebar-filter${view === it.key ? " active" : ""}`}
            onClick={() => {
              actions.setView(it.key);
              onNavigate?.();
            }}
          >
            {it.label}
            {it.badge > 0 && <span className={`rv-badge ${it.tone}`}>{it.badge}</span>}
          </button>
        ))}
      </nav>
    </>
  );
}

export function SidebarContent({ view, peek = false, onNavigate }: { view: View; peek?: boolean; onNavigate?: () => void }) {
  const { mcFiles, costEntries, clips, filesList, user, mcL2, fileCategories, costCategories } = useAppState();

  useEffect(() => {
    if (view === "mission-control" && mcFiles === null) fetchMc().then(actions.setMcFiles);
    if (view === "costs" && costEntries === null) fetchCosts().then(actions.setCosts);
    if (view === "costs" && costCategories === null) refreshCostCategories();
    if (view === "clipboard" && clips === null) fetchClips().then(actions.setClips);
    if (view === "files" && filesList === null) fetchFiles().then(actions.setFiles);
    if (view === "files" && fileCategories === null) refreshFileCategories();
  }, [view, mcFiles, costEntries, clips, filesList, fileCategories, costCategories]);

  if (view === "messages") {
    return (
      <>
        <LabelRow view={view} peek={peek} />
        <AgentList compact={peek} withSearch={!peek} onNavigate={onNavigate} />
      </>
    );
  }

  if (view === "builds" || view === "review" || view === "whatsapp") {
    return <CloseOutNav view={view} peek={peek} onNavigate={onNavigate} />;
  }

  if (view === "mission-control") {
    const cards = Object.values(mcFiles ?? {});
    const items = [
      ...(user?.admin ? [{ key: "fitness", label: "Fitness" }] : []),
      ...cards.map((f) => ({ key: f.name, label: f.label })),
    ];
    if (!items.length)
      return (
        <>
          <LabelRow view={view} peek={peek} />
          <div className="dropdown-empty">Loading cards…</div>
        </>
      );
    return (
      <>
        <LabelRow view={view} peek={peek} />
        <nav className="sidebar-filters">
          {items.map((it) => (
            <button
              key={it.key}
              className={`sidebar-filter${mcL2 === it.key ? " active" : ""}`}
              onClick={() => {
                actions.openMcCard(it.key);
                onNavigate?.();
              }}
            >
              {it.label}
            </button>
          ))}
        </nav>
      </>
    );
  }

  if (view === "clipboard") {
    return (
      <>
        <LabelRow view={view} peek={peek} />
        <FilterList options={CLIP_TYPES} onNavigate={onNavigate} />
      </>
    );
  }

  if (view === "files") {
    return <FilesCategories peek={peek} onNavigate={onNavigate} />;
  }

  if (view === "bills") {
    // One private list, no categories to filter.
    return <LabelRow view={view} peek={peek} />;
  }

  // costs
  return <CostsCategories peek={peek} onNavigate={onNavigate} />;
}

/** Context-aware desktop sidebar (288px, surface-alt). */
export default function Sidebar() {
  const { view } = useAppState();
  return (
    <aside className="sidebar">
      <SidebarContent view={view} />
    </aside>
  );
}
