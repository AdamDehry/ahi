/**
 * Working location (FINAL composer picker, made real).
 *
 * The tree is the host's real folders under the AHI root, read from the gateway a level at a
 * time (/app/folders); "Add a subfolder" makes the folder on disk; choosing a folder stores a pin
 * for this agent and every later turn to it carries the location (src/working-folders.ts).
 * Automatic (no pin) is today's routing, unchanged. AHI_OS never appears. A member (no host
 * access) sees Automatic only. Changing the location while a reply or call is running waits; with
 * a draft or attachments waiting, it asks first. Earlier messages and files never move.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "./icons";
import { getFresh } from "../lib/api";

interface Entry { path: string; name: string; hasChildren: boolean }
interface Status { enabled: boolean; root: string | null; host: string | null; pin: string | null }

const J = { "Content-Type": "application/json" };
const leaf = (p: string) => (p ? p.split("/").pop()! : "AHI");
const where = (p: string | null) => (p ? `AHI/${p}` : "AHI");


export default function FolderControl({ bot, agentLabel, busy = false, hasDraft = false }: { bot: string; agentLabel: string; busy?: boolean; hasDraft?: boolean }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [tree, setTree] = useState<Record<string, Entry[]>>({});
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<string | null | undefined>(undefined); // undefined = nothing to confirm
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [parent, setParent] = useState("");
  const [name, setName] = useState("");
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number; maxHeight: number } | null>(null);

  const pin = status?.enabled ? status.pin : null;

  const loadStatus = useCallback(async () => {
    setStatus(await getFresh<Status>(`/app/folders/status?bot=${encodeURIComponent(bot)}`));
  }, [bot]);
  useEffect(() => {
    setStatus(null);
    setTree({});
    void loadStatus();
  }, [loadStatus]);

  const loadLevel = useCallback(async (p: string) => {
    const v = await getFresh<{ folders: Entry[] }>(`/app/folders?parent=${encodeURIComponent(p)}`);
    if (v) setTree((t) => ({ ...t, [p]: v.folders }));
    return v?.folders ?? [];
  }, []);

  // Open: the root level and, for a pinned folder, every level down to it (so it shows selected).
  useEffect(() => {
    if (!open || !status?.enabled) return;
    void (async () => {
      await loadLevel("");
      const segs = (status.pin ?? "").split("/").filter(Boolean);
      for (let i = 1; i < segs.length; i++) await loadLevel(segs.slice(0, i).join("/"));
    })();
  }, [open, status, loadLevel]);

  // FINAL positionWorkingFolder: 24px in from the chat pane, 9px above the composer, never under the header.
  const place = useCallback(() => {
    const b = btn.current;
    const pane = b?.closest(".rd-chat-pane, .view-area") as HTMLElement | null;
    const composer = b?.closest(".composer") as HTMLElement | null;
    if (!b || !composer) return;
    const pr = (pane ?? composer).getBoundingClientRect();
    const cr = composer.getBoundingClientRect();
    const head = pane?.querySelector(".rd-chat-head, .chat-header, header") as HTMLElement | null;
    const top = head ? head.getBoundingClientRect().bottom + 9 : pr.top + 9;
    const phone = window.innerWidth <= 650;
    setPos({ left: phone ? 12 : pr.left + 24, bottom: window.innerHeight - cr.top + 9, maxHeight: Math.max(220, cr.top - 9 - top) });
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || btn.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
      btn.current?.focus();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const apply = async (path: string | null) => {
    if (busy) return;
    setError("");
    try {
      const r = await fetch("/app/folders/pin", { method: "POST", headers: J, body: JSON.stringify({ bot, path }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error || "That folder is not available.");
      const v = (await r.json()) as { pin: string | null };
      setStatus((s) => (s ? { ...s, pin: v.pin } : s));
      setPending(undefined);
      setOpen(false);
      setToast(v.pin === null ? "Automatic placement restored." : `${agentLabel} will work in ${where(v.pin)}`);
      btn.current?.focus();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const request = (path: string | null) => {
    if (busy) return;
    if (hasDraft) setPending(path);
    else void apply(path);
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError("");
    try {
      const r = await fetch("/app/folders", { method: "POST", headers: J, body: JSON.stringify({ parent, name }) });
      const v = (await r.json().catch(() => null)) as { path?: string; error?: string } | null;
      if (!r.ok || !v?.path) throw new Error(v?.error || "That folder could not be made.");
      setName("");
      await loadLevel(parent);
      if (parent) setClosed((c) => new Set([...c].filter((x) => x !== parent)));
      request(v.path);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const allKnown = (): string[] => {
    const out: string[] = [];
    const walk = (p: string) => (tree[p] ?? []).forEach((f) => (out.push(f.path), walk(f.path)));
    walk("");
    return out;
  };

  const rows = (p: string) => (
    <>
      {(tree[p] ?? []).map((f) => {
        const isClosed = !tree[f.path] || closed.has(f.path);
        const chosen = pin === f.path;
        return (
          <li key={f.path}>
            <div className="rd-wf-row">
              {f.hasChildren ? (
                <button
                  type="button"
                  className="rd-wf-toggle"
                  aria-label={`${isClosed ? "Expand" : "Collapse"} ${f.name}`}
                  aria-expanded={!isClosed}
                  onClick={() => {
                    if (!tree[f.path]) void loadLevel(f.path);
                    setClosed((c) => {
                      const n = new Set(c);
                      if (tree[f.path] && !n.has(f.path)) n.add(f.path);
                      else n.delete(f.path);
                      return n;
                    });
                  }}
                >
                  <Icon name="chevron" />
                </button>
              ) : (
                <span className="rd-wf-spacer" />
              )}
              <button type="button" className="rd-wf-pick" aria-pressed={chosen} disabled={busy} onClick={() => request(f.path)}>
                <Icon name="folder" />
                <span>{f.name}</span>
                {chosen && <Icon name="check" />}
              </button>
            </div>
            {f.hasChildren && !isClosed && <ul>{rows(f.path)}</ul>}
          </li>
        );
      })}
    </>
  );

  const label = pin === null ? "Automatic · AHI" : where(pin);
  return (
    <div className="rd-folder-ctl">
      <button
        ref={btn}
        type="button"
        className={`composer-icon folder rd-wf-button${pin !== null ? " chosen" : ""}`}
        aria-label={`Working folder: ${label}. Choose location`}
        aria-expanded={open}
        title={`Working folder: ${label}`}
        onClick={() => {
          if (!open) void loadStatus();
          setPending(undefined);
          setError("");
          setOpen(!open);
        }}
      >
        <Icon name="folder" />
        {pin !== null && <span>{leaf(pin)}</span>}
      </button>
      {open && (
        <section
          ref={pop}
          className="rd-wf-picker"
          role="dialog"
          aria-modal="false"
          aria-label="Working location"
          style={pos ? { left: pos.left, bottom: pos.bottom, maxHeight: pos.maxHeight } : { visibility: "hidden" }}
        >
          <header>
            <div>
              <strong>Working location</strong>
              <p>{status?.enabled ? `${status.host ?? "This server"} · AHI` : agentLabel}</p>
            </div>
            <button type="button" className="rd-chat-control" aria-label="Close working location" onClick={() => (setOpen(false), btn.current?.focus())}>
              <Icon name="x" />
            </button>
          </header>
          <button type="button" className="rd-wf-auto" aria-pressed={pin === null} disabled={busy} onClick={() => request(null)}>
            <Icon name="spark" />
            <span>
              <strong>Automatic</strong>
              <small>Let your agent choose the best location</small>
            </span>
            {pin === null && <Icon name="check" />}
          </button>
          {status?.enabled ? (
            <>
              <div className="rd-wf-root">
                <button type="button" className="rd-wf-pick" aria-pressed={pin === ""} disabled={busy} onClick={() => request("")}>
                  <Icon name="folder" />
                  <strong>AHI</strong>
                  {pin === "" && <Icon name="check" />}
                </button>
                <code>{status.root}</code>
              </div>
              <ul className="rd-wf-tree" aria-label="AHI folder tree">
                {tree[""] ? rows("") : <li className="rd-wf-loading">Reading folders…</li>}
              </ul>
              <p className="rd-wf-hint">
                {busy
                  ? "The current reply or voice session keeps its working context. Finish it before changing location."
                  : "Automatic is the default. A chosen folder pins new work here; existing messages and files stay where they are."}
              </p>
              {pending !== undefined && (
                <div className="rd-wf-confirm" role="group" aria-label="Confirm location">
                  <p>{pending === null ? "Let the agent place this draft and its attachments automatically?" : `Use ${where(pending)} for this draft and its attachments?`}</p>
                  <button type="button" className="rd-wf-btn" onClick={() => setPending(undefined)}>
                    Keep current location
                  </button>
                  <button type="button" className="rd-wf-btn primary" onClick={() => void apply(pending)}>
                    Use selected location
                  </button>
                </div>
              )}
              <details>
                <summary>Add a subfolder</summary>
                <form onSubmit={(e) => void create(e)}>
                  <label>
                    Inside
                    <select aria-label="Parent folder" value={parent} onChange={(e) => setParent(e.target.value)}>
                      <option value="">AHI</option>
                      {allKnown().map((p) => (
                        <option key={p} value={p}>
                          AHI/{p}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Folder name
                    <input name="name" maxLength={60} required placeholder="For example, Client portal" value={name} onChange={(e) => setName(e.target.value)} />
                  </label>
                  <button type="submit" className="rd-wf-btn" disabled={busy}>
                    Create &amp; use folder
                  </button>
                </form>
              </details>
              {error && (
                <p className="rd-wf-error" role="alert">
                  {error}
                </p>
              )}
              <footer>Your real AHI folders on this server. AHI_OS stays outside normal browsing.</footer>
            </>
          ) : (
            <p className="rd-wf-hint">{agentLabel} places new work where it belongs, the way it does today. Choosing a folder is for the owner of this workspace.</p>
          )}
        </section>
      )}
      {toast && (
        <div className="rd-wf-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
