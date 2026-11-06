/**
 * Working location (FINAL composer "Working location"
 * picker). The owner pins where an agent puts NEW work for one conversation;
 * Automatic (no pin) is today's behaviour, unchanged.
 *
 * Real, not a picture:
 *   - the tree is the host's actual folders under the AHI root
 *     (AHI_WORK_ROOT, else $AHI_HOME/AHI), read one level at a time;
 *   - "Add a subfolder" makes the folder on disk;
 *   - the pin is stored per (user, agent) and every app turn to that agent
 *     carries one line naming the folder (tagDashboardMessageForBot is the one
 *     choke point for typed, voice-note, upload and call turns).
 *
 * Rails: owner only (members get Automatic, as before); AHI_OS, dot-folders,
 * node_modules and symlinks are never listed or accepted; every path is
 * checked segment by segment and by realpath to stay inside the root; a pin
 * whose folder has gone is ignored (Automatic) rather than invented.
 * Earlier messages and files never move.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "fs";
import { join, resolve, sep } from "path";
import type { Context, Hono } from "hono";
import { gatewayStateRoot } from "./multi-user-paths.js";

export interface FolderUser {
  userId: string;
  admin?: boolean;
  agents: string[];
}

export interface FolderEntry {
  /** Path relative to the root, "/"-separated ("" = the root itself). */
  path: string;
  name: string;
  hasChildren: boolean;
}

const HIDDEN = new Set(["node_modules", "__pycache__"]);
const NAME_RX_BAD = /[\\/<>:"|?*\x00-\x1f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const LIST_CAP = 300;

export function workRoot(): string | null {
  const explicit = process.env.AHI_WORK_ROOT?.trim();
  const home = process.env.AHI_HOME?.trim();
  const root = explicit || (home ? join(home, "AHI") : "");
  if (!root) return null;
  try {
    return lstatSync(root).isDirectory() ? realpathSync(root) : null;
  } catch {
    return null;
  }
}

/** "~/AHI" style label for the root (no host home spelled out). */
export function rootLabel(root: string): string {
  const home = process.env.HOME?.trim();
  return home && (root === home || root.startsWith(home + sep)) ? "~" + root.slice(home.length) : root;
}

/** A folder name the owner may create (FINAL setup-store rules). Returns an error or null. */
export function badFolderName(name: string): string | null {
  const clean = name.trim();
  if (!clean || clean.length > 60 || NAME_RX_BAD.test(clean) || /[. ]$/.test(clean) || clean === "." || clean === ".." || RESERVED.test(clean) || clean.startsWith("."))
    return "Use a folder name of 1–60 characters without path separators or reserved characters.";
  return null;
}

function segmentOk(seg: string, depth: number): boolean {
  if (!seg || seg === "." || seg === ".." || seg.startsWith(".") || NAME_RX_BAD.test(seg) || HIDDEN.has(seg)) return false;
  if (depth === 0 && seg.toLowerCase() === "ahi_os") return false;
  return true;
}

/**
 * The absolute directory for a relative path, or null when the path is not an
 * allowed, existing, non-symlink directory inside the root.
 */
export function resolveFolder(root: string, rel: string): string | null {
  const segs = rel.split("/").filter((s) => s.length > 0);
  if (rel && segs.join("/") !== rel.replace(/^\/+|\/+$/g, "")) return null;
  for (let i = 0; i < segs.length; i++) if (!segmentOk(segs[i], i)) return null;
  const abs = resolve(root, ...segs);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  try {
    // Every step must be a real directory, never a link out of the tree.
    let cur = root;
    for (const s of segs) {
      cur = join(cur, s);
      const st = lstatSync(cur);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
    }
    const real = realpathSync(abs);
    if (real !== root && !real.startsWith(root + sep)) return null;
    return real;
  } catch {
    return null;
  }
}

function hasChildDir(abs: string, rel: string): boolean {
  try {
    const depth = rel ? rel.split("/").length : 0;
    return readdirSync(abs, { withFileTypes: true }).some((d) => d.isDirectory() && !d.isSymbolicLink() && segmentOk(d.name, depth));
  } catch {
    return false;
  }
}

/** The folders directly inside `rel` (sorted, capped). Null when `rel` is not allowed. */
export function listFolders(root: string, rel: string): FolderEntry[] | null {
  const abs = resolveFolder(root, rel);
  if (!abs) return null;
  const depth = rel ? rel.split("/").filter(Boolean).length : 0;
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((d) => d.isDirectory() && !d.isSymbolicLink() && segmentOk(d.name, depth))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .slice(0, LIST_CAP)
    .map((name) => {
      const path = rel ? `${rel}/${name}` : name;
      return { path, name, hasChildren: hasChildDir(join(abs, name), path) };
    });
}

/** Make `name` inside `parent`. Returns the new relative path, or an error. */
export function addFolder(root: string, parent: string, name: string): { path: string } | { error: string; status: 400 | 404 | 409 } {
  const bad = badFolderName(name);
  if (bad) return { error: bad, status: 400 };
  const base = resolveFolder(root, parent);
  if (!base) return { error: "That parent folder is not available.", status: 404 };
  const clean = name.trim();
  const depth = parent ? parent.split("/").filter(Boolean).length : 0;
  if (!segmentOk(clean, depth)) return { error: "That folder name is reserved.", status: 400 };
  const target = join(base, clean);
  if (existsSync(target)) return { error: "A folder with that name is already there.", status: 409 };
  mkdirSync(target, { mode: 0o755 });
  return { path: parent ? `${parent}/${clean}` : clean };
}

// --- pins -----------------------------------------------------------------

type PinStore = Record<string, Record<string, string>>; // userId → bot → relative path

function pinFile(): string {
  return process.env.AHI_WORKING_FOLDERS_FILE?.trim() || resolve(gatewayStateRoot(), "working-folders.json");
}

function loadPins(): PinStore {
  try {
    const raw = JSON.parse(readFileSync(pinFile(), "utf-8"));
    return raw && typeof raw === "object" ? (raw as PinStore) : {};
  } catch {
    return {};
  }
}

function savePins(store: PinStore): void {
  const file = pinFile();
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/** The pinned relative path for (user, bot), only while it still resolves. */
export function pinnedFolder(userId: string, bot: string): string | null {
  const rel = loadPins()[userId]?.[bot];
  if (typeof rel !== "string") return null;
  const root = workRoot();
  return root && resolveFolder(root, rel) ? rel : null;
}

export function setPin(userId: string, bot: string, rel: string | null): void {
  const store = loadPins();
  const mine = { ...(store[userId] ?? {}) };
  if (rel === null) delete mine[bot];
  else mine[bot] = rel;
  if (Object.keys(mine).length) store[userId] = mine;
  else delete store[userId];
  savePins(store);
}

/**
 * The line an app turn carries when the conversation has a pin ("" otherwise).
 * Plain and short: where new work goes, and that earlier work stays put.
 */
export function workingFolderLine(userId: string, bot: string): string {
  const rel = pinnedFolder(userId, bot);
  const root = rel === null ? null : workRoot();
  if (rel === null || !root) return "";
  const abs = rel ? join(root, ...rel.split("/")) : root;
  return `[working location: ${abs} — chosen in the app for this conversation; put new files and work for this request there unless told otherwise. Earlier files stay where they are.]`;
}

// --- routes ---------------------------------------------------------------

export interface FolderRouteDeps {
  resolveUser(c: Context): FolderUser | null;
  bots(): string[];
}

/**
 *   GET  /app/folders/status?bot=      { enabled, root, host, pin }
 *   GET  /app/folders?parent=          { folders: FolderEntry[] }
 *   POST /app/folders                  { parent, name } → { path }
 *   POST /app/folders/pin              { bot, path | null } → { pin }
 * Owner only; a member sees enabled=false (Automatic, as before).
 */
export function registerFolderRoutes(app: Hono<any>, deps: FolderRouteDeps): void {
  const owner = (c: Context): FolderUser | null => {
    const u = deps.resolveUser(c);
    return u && u.admin ? u : null;
  };
  const json = (c: Context) => (c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json");
  const botOk = (u: FolderUser, bot: unknown): bot is string => typeof bot === "string" && deps.bots().includes(bot) && (u.admin || u.agents.includes(bot));

  app.get("/app/folders/status", (c) => {
    const u = deps.resolveUser(c);
    if (!u) return c.json({ error: "Unauthorized" }, 401);
    const root = u.admin ? workRoot() : null;
    const bot = c.req.query("bot");
    if (!root) return c.json({ enabled: false, root: null, host: null, pin: null });
    return c.json({ enabled: true, root: rootLabel(root), host: "This server", pin: botOk(u, bot) ? pinnedFolder(u.userId, bot) : null });
  });

  app.get("/app/folders", (c) => {
    const u = owner(c);
    if (!u) return c.json({ error: "Unauthorized" }, deps.resolveUser(c) ? 403 : 401);
    const root = workRoot();
    if (!root) return c.json({ error: "No working root on this host" }, 503);
    const list = listFolders(root, c.req.query("parent") ?? "");
    if (!list) return c.json({ error: "That folder is not available." }, 404);
    return c.json({ folders: list });
  });

  app.post("/app/folders", async (c) => {
    const u = owner(c);
    if (!u) return c.json({ error: "Unauthorized" }, deps.resolveUser(c) ? 403 : 401);
    if (!json(c)) return c.json({ error: "JSON only" }, 415);
    const root = workRoot();
    if (!root) return c.json({ error: "No working root on this host" }, 503);
    const body = await c.req.json<{ parent?: unknown; name?: unknown }>().catch(() => ({}) as { parent?: unknown; name?: unknown });
    const r = addFolder(root, typeof body.parent === "string" ? body.parent : "", typeof body.name === "string" ? body.name : "");
    if ("error" in r) return c.json({ error: r.error }, r.status);
    return c.json(r);
  });

  app.post("/app/folders/pin", async (c) => {
    const u = owner(c);
    if (!u) return c.json({ error: "Unauthorized" }, deps.resolveUser(c) ? 403 : 401);
    if (!json(c)) return c.json({ error: "JSON only" }, 415);
    const body = await c.req.json<{ bot?: unknown; path?: unknown }>().catch(() => ({}) as { bot?: unknown; path?: unknown });
    if (!botOk(u, body.bot)) return c.json({ error: "Unknown agent" }, 404);
    if (body.path === null) {
      setPin(u.userId, body.bot, null);
      return c.json({ pin: null });
    }
    const root = workRoot();
    if (!root) return c.json({ error: "No working root on this host" }, 503);
    if (typeof body.path !== "string" || !resolveFolder(root, body.path)) return c.json({ error: "That folder is not available." }, 404);
    const rel = body.path.replace(/^\/+|\/+$/g, "");
    setPin(u.userId, body.bot, rel);
    return c.json({ pin: rel });
  });
}
