/**
 * Documents → the real AHI folder system (lines 26–28).
 *
 * The left column lists the host's actual AHI root (AHI_OS, AI, archive, business, personal … and the
 * loose operating map) from /app/docs/tree, one level at a time. A folder click opens it (its children
 * nest under it and fill the right pane); a click on the folder that is already open collapses it.
 * "Add folder" makes one on disk inside the open folder. A file opens in a preview fitted to the screen.
 * Owner only on the server; nothing here moves, renames or deletes anything.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { renderMarkdown } from "../lib/markdown";
import { Icon } from "./icons";

export interface DocEntry {
  path: string;
  name: string;
  kind: "folder" | "file";
  hasChildren?: boolean;
  size?: number;
  modified?: string;
}
type Preview =
  | { kind: "text"; name: string; path: string; size: number; modified: string; text: string; truncated: boolean }
  | { kind: "image" | "pdf"; name: string; path: string; size: number; modified: string; type: string }
  | { kind: "none"; name: string; path: string; size: number; modified: string; reason: string };

const TREE_URL = "/app/docs/tree";
const q = (p: string) => encodeURIComponent(p);

/** Folder listings, cached per path; `available` is false when the server has no AHI tree (or this user can't see it). */
export function useAhiTree(enabled: boolean) {
  const [lists, setLists] = useState<Record<string, DocEntry[]>>({});
  const [available, setAvailable] = useState<boolean | null>(null);
  const [root, setRoot] = useState("");
  const load = useCallback(async (path: string): Promise<DocEntry[] | null> => {
    try {
      const r = await fetch(`${TREE_URL}?path=${q(path)}`, { cache: "no-store" });
      if (!r.ok) {
        if (path === "") setAvailable(false);
        return null;
      }
      const v = (await r.json()) as { root: string; entries: DocEntry[] };
      if (path === "") (setAvailable(true), setRoot(v.root));
      setLists((m) => ({ ...m, [path]: v.entries }));
      return v.entries;
    } catch {
      if (path === "") setAvailable(false);
      return null;
    }
  }, []);
  useEffect(() => {
    if (enabled) void load("");
  }, [enabled, load]);
  return { lists, available, root, load };
}

/** The tree in the folder column: folders nest under the one that is open; a second click closes it. */
export function AhiTreeNav({
  tree,
  open,
  expanded,
  onFolder,
  onFile,
}: {
  tree: ReturnType<typeof useAhiTree>;
  open: string | null;
  expanded: Set<string>;
  onFolder: (e: DocEntry) => void;
  onFile: (e: DocEntry) => void;
}) {
  const level = (path: string, depth: number) => (
    <ul className="rd-tree" role={depth ? "group" : "tree"} aria-label={depth ? undefined : "AHI folders"}>
      {(tree.lists[path] ?? []).map((e) => {
        const isOpen = e.kind === "folder" && expanded.has(e.path);
        return (
          <li key={e.path} role="treeitem" aria-expanded={e.kind === "folder" && e.hasChildren ? isOpen : undefined} aria-selected={open === e.path}>
            <button
              type="button"
              className={`rd-tree-row${open === e.path ? " active" : ""}${e.kind === "file" ? " file" : ""}`}
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => (e.kind === "folder" ? onFolder(e) : onFile(e))}
              title={e.name}
            >
              {e.kind === "folder" ? (
                <span className={`rd-tree-caret${e.hasChildren ? "" : " none"}${isOpen ? " open" : ""}`} aria-hidden="true">
                  <Icon name="chevron-right" />
                </span>
              ) : (
                <span className="rd-tree-caret none" aria-hidden="true" />
              )}
              <Icon name={e.kind === "folder" ? "folder" : "file"} />
              <span className="rd-tree-name">{e.name}</span>
            </button>
            {isOpen && tree.lists[e.path] && tree.lists[e.path].some((c) => c.kind === "folder") && level(e.path, depth + 1)}
          </li>
        );
      })}
    </ul>
  );
  return level("", 0);
}

const bytes = (n?: number) => (n === undefined ? "" : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const when = (iso?: string) => (iso ? new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "");

/** The open folder in the right pane: where it is, Add folder, then its folders and files. */
export function AhiFolderView({
  tree,
  path,
  onFolder,
  onFile,
  onAdded,
}: {
  tree: ReturnType<typeof useAhiTree>;
  path: string;
  onFolder: (e: DocEntry) => void;
  onFile: (e: DocEntry) => void;
  onAdded: (path: string) => void;
}) {
  const entries = tree.lists[path];
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [find, setFind] = useState("");
  useEffect(() => (setAdding(false), setName(""), setErr(null), setFind("")), [path]);
  const add = async () => {
    setErr(null);
    try {
      const r = await fetch("/app/docs/folders", { method: "POST", headers: { "Content-Type": "application/json", "X-AHI-Review": "1" }, body: JSON.stringify({ parent: path, name }) });
      const v = (await r.json().catch(() => ({}))) as { path?: string; error?: string };
      if (!r.ok || !v.path) return setErr(v.error ?? `Couldn’t add it (HTTP ${r.status}).`);
      setAdding(false);
      setName("");
      await tree.load(path);
      onAdded(v.path);
    } catch {
      setErr("No connection — nothing was added.");
    }
  };
  const crumbs = path.split("/").filter(Boolean);
  const needle = find.trim().toLowerCase();
  const shown = (entries ?? []).filter((e) => !needle || e.name.toLowerCase().includes(needle));
  return (
    <div className="rd-ahi-folder">
      <div className="rd-docs-bar">
        <span className="rd-ahi-crumbs">
          AHI
          {crumbs.map((c, i) => (
            <span key={i}> / {c}</span>
          ))}
        </span>
        <label className="rd-find">
          <Icon name="search" />
          <input type="search" placeholder="Find in this folder…" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find in this folder" />
        </label>
        <button type="button" className="rd-btn" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
          <Icon name="plus" /> Add folder
        </button>
      </div>
      {adding && (
        <form
          className="rd-ahi-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void add();
          }}
        >
          <input autoFocus value={name} maxLength={60} placeholder="New folder name" aria-label="New folder name" onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="rd-btn rd-btn-accent" disabled={!name.trim()}>
            Add
          </button>
          <button type="button" className="rd-btn" onClick={() => setAdding(false)}>
            Cancel
          </button>
          {err && (
            <p className="rd-ahi-err" role="alert">
              {err}
            </p>
          )}
        </form>
      )}
      {!entries && <p className="rd-quiet rd-empty-line">Opening…</p>}
      {entries && !shown.length && <p className="rd-quiet rd-empty-line">{needle ? "Nothing here matches that." : "This folder is empty."}</p>}
      <ul className="rd-doc-list">
        {shown.map((e) => (
          <li key={e.path}>
            <button type="button" onClick={() => (e.kind === "folder" ? onFolder(e) : onFile(e))}>
              <span className="rd-doc-icon">
                <Icon name={e.kind === "folder" ? "folder" : "file"} />
              </span>
              <span className="rd-doc-text">
                {e.name}
                <small>{e.kind === "folder" ? (e.hasChildren ? "Folder" : "Empty folder") : [bytes(e.size), when(e.modified)].filter(Boolean).join(" · ")}</small>
              </span>
              <span className="rd-doc-access ro">{e.kind === "folder" ? "Open" : "Preview"}</span>
              <Icon name="chevron-right" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A document opened from the tree: a modal fitted to the screen — text and markdown read in place, images and PDFs shown. */
export function DocPreviewModal({ path, onClose }: { path: string; onClose: () => void }) {
  const [p, setP] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    setP(null);
    setErr(null);
    fetch(`/app/docs/preview?path=${q(path)}`, { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as Preview) : Promise.reject(new Error(r.status === 404 ? "That file isn’t available." : `HTTP ${r.status}`))))
      .then((v) => live && setP(v))
      .catch((e: Error) => live && setErr(e.message || "Couldn’t open it."));
    return () => {
      live = false;
    };
  }, [path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    box.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const name = path.split("/").pop() ?? path;
  const raw = `/app/docs/raw?path=${q(path)}`;
  const isMd = /\.(md|markdown)$/i.test(name);
  return (
    <div className="rd-docmodal-layer" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rd-docmodal" role="dialog" aria-modal="true" aria-label={name} tabIndex={-1} ref={box}>
        <header>
          <div>
            <div className="rd-eyebrow">{path.split("/").slice(0, -1).join(" / ").toUpperCase() || "AHI"}</div>
            <h2>{name}</h2>
            {p && <small>{[bytes(p.size), when(p.modified), "View only"].filter(Boolean).join(" · ")}</small>}
          </div>
          <span className="rd-docmodal-actions">
            {p && (p.kind === "image" || p.kind === "pdf") && (
              <a className="rd-btn" href={raw} target="_blank" rel="noreferrer">
                Open in a tab
              </a>
            )}
            <button type="button" className="rd-chat-control" aria-label="Close preview" onClick={onClose}>
              <Icon name="x" />
            </button>
          </span>
        </header>
        <div className="rd-docmodal-body">
          {err && <p className="rd-quiet rd-empty-line">{err}</p>}
          {!p && !err && <p className="rd-quiet rd-empty-line">Opening…</p>}
          {p?.kind === "text" &&
            (isMd ? <article className="msg-text rd-docmodal-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(p.text) }} /> : <pre className="rd-docmodal-pre">{p.text}</pre>)}
          {p?.kind === "text" && p.truncated && <p className="rd-quiet">Showing the first 512 KB.</p>}
          {p?.kind === "image" && <img className="rd-docmodal-img" src={raw} alt={name} />}
          {p?.kind === "pdf" && <iframe className="rd-docmodal-pdf" src={raw} title={name} />}
          {p?.kind === "none" && <p className="rd-quiet rd-empty-line">{p.reason}</p>}
        </div>
      </div>
    </div>
  );
}
