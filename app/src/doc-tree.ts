/**
 * Documents → the real AHI folder system.
 *
 * The Documents page shows the host's actual tree under the AHI root (the same root the Working
 * location picker uses: AHI_WORK_ROOT, else $AHI_HOME/AHI): AHI_OS, ai, archive, business, personal …
 * and the loose files beside them (the operating map). Folders open one level at a time, a folder can
 * be added, and a file opens in a preview.
 *
 * Rails — owner only; read-only except "add a folder":
 *   - never listed, never opened: dot-entries (.env, .git, .secrets …), node_modules, symlinks, and any
 *     file whose name looks like a credential (env, secret, token, key, pem, credentials, id_rsa …);
 *   - every path is checked segment by segment AND by realpath to stay inside the root;
 *   - previews are bounded (text 512 KB; images and PDFs 25 MB) and never cached;
 *   - nothing here moves, renames or deletes anything.
 */
import { closeSync, constants as FS, createReadStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, statSync } from "fs";
import { extname, join, sep } from "path";
import { Readable } from "stream";
import type { Context, Hono } from "hono";
import { badFolderName, rootLabel, workRoot } from "./working-folders.js";

export interface DocEntry {
  /** Path relative to the root, "/"-separated. */
  path: string;
  name: string;
  kind: "folder" | "file";
  /** Folders: whether anything visible is inside. */
  hasChildren?: boolean;
  size?: number;
  modified?: string;
}

const HIDDEN_DIRS = new Set(["node_modules", "__pycache__", "dist", ".git"]);
const SECRET_FILE = /(^|[._-])(env|secrets?|tokens?|credentials?|passwords?|passphrase|private[-_]?key|id_rsa|id_ed25519|keychain)([._-]|$)|\.(pem|key|p12|pfx|keystore|jks|kdbx|gpg|asc)$/i;
const BAD_SEG = /[\\/<>:"|?*\x00-\x1f]/;
const LIST_CAP = 400;
const TEXT_MAX = 512 * 1024;
const BLOB_MAX = 25 * 1024 * 1024;
const TEXT_EXT = new Set([".md", ".markdown", ".txt", ".json", ".csv", ".tsv", ".yml", ".yaml", ".toml", ".ini", ".log", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".sh", ".html", ".css", ".xml", ".sql"]);
const BLOB_TYPE: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf" };

function segOk(seg: string): boolean {
  return !!seg && seg !== "." && seg !== ".." && !seg.startsWith(".") && !BAD_SEG.test(seg) && !HIDDEN_DIRS.has(seg);
}
export const secretLooking = (name: string): boolean => SECRET_FILE.test(name);

/** The absolute path for a relative one, or null when it is not an allowed, existing, non-symlink entry inside the root. */
export function resolveDoc(root: string, rel: string, want: "folder" | "file" | "any" = "any"): string | null {
  const segs = rel.split("/").filter((s) => s.length > 0);
  if (!segs.every(segOk)) return null;
  if (want !== "folder" && segs.length && secretLooking(segs[segs.length - 1])) return null;
  let cur = root;
  for (const seg of segs) {
    cur = join(cur, seg);
    try {
      if (lstatSync(cur).isSymbolicLink()) return null;
    } catch {
      return null;
    }
  }
  try {
    const real = realpathSync(cur);
    if (real !== root && !real.startsWith(root + sep)) return null;
    const st = statSync(real);
    if (want === "folder" && !st.isDirectory()) return null;
    if (want === "file" && !st.isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

function visible(dir: string, name: string): { kind: "folder" | "file"; abs: string } | null {
  if (!segOk(name)) return null;
  const abs = join(dir, name);
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return null;
    if (st.isDirectory()) return { kind: "folder", abs };
    if (st.isFile() && !secretLooking(name)) return { kind: "file", abs };
  } catch {
    /* gone */
  }
  return null;
}

/** One level of the tree: folders first, then files, each A→Z (case-insensitive). Null when the folder isn't allowed. */
export function listDocs(root: string, rel: string): DocEntry[] | null {
  const dir = resolveDoc(root, rel, "folder");
  if (!dir) return null;
  const base = rel.split("/").filter(Boolean).join("/");
  const out: DocEntry[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    const v = visible(dir, name);
    if (!v) continue;
    const path = base ? `${base}/${name}` : name;
    if (v.kind === "folder") {
      let hasChildren = false;
      try {
        hasChildren = readdirSync(v.abs).some((n) => !!visible(v.abs, n));
      } catch {
        hasChildren = false;
      }
      out.push({ path, name, kind: "folder", hasChildren });
    } else {
      const st = statSync(v.abs);
      out.push({ path, name, kind: "file", size: st.size, modified: st.mtime.toISOString() });
    }
    if (out.length >= LIST_CAP) break;
  }
  const key = (e: DocEntry) => `${e.kind === "folder" ? 0 : 1}${e.name.toLowerCase()}`;
  return out.sort((a, b) => key(a).localeCompare(key(b)));
}


/**
 * Open a resolved file for reading WITHOUT following a symlink (O_NOFOLLOW), then re-check the opened
 * descriptor itself (Codex r6): it must be a regular file and its real path still inside the root — so a
 * file swapped for a symlink between the check and the read is refused, not followed.
 */
export function openInside(root: string, abs: string): number | null {
  let fd: number;
  try {
    fd = openSync(abs, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const real = descriptorPath(fd, abs);
    if (!real || !fstatSync(fd).isFile() || (real !== root && !real.startsWith(root + sep))) throw new Error("outside");
    return fd;
  } catch {
    closeSync(fd);
    return null;
  }
}

/**
 * The real path of the file an open descriptor refers to. Linux asks the kernel (/proc/self/fd). macOS and Windows
 * have no /proc: resolve the path, then prove the descriptor IS that file (same device and inode), so a file
 * swapped after opening still cannot be read through an in-root path.
 */
export function descriptorPath(fd: number, abs: string, platform: string = process.platform): string | null {
  if (platform === "linux") {
    try {
      return realpathSync(`/proc/self/fd/${fd}`);
    } catch {}
  }
  try {
    const real = realpathSync(abs);
    const open = fstatSync(fd, { bigint: true }), named = statSync(real, { bigint: true });
    return open.ino !== 0n && open.dev === named.dev && open.ino === named.ino ? real : null;
  } catch {
    return null;
  }
}

function readHead(fd: number, max: number): Buffer {
  const buf = Buffer.alloc(max);
  let n = 0;
  while (n < max) {
    const got = readSync(fd, buf, n, max - n, n);
    if (!got) break;
    n += got;
  }
  return buf.subarray(0, n);
}

export type DocPreview =
  | { kind: "text"; name: string; path: string; size: number; modified: string; text: string; truncated: boolean }
  | { kind: "image" | "pdf"; name: string; path: string; size: number; modified: string; type: string }
  | { kind: "none"; name: string; path: string; size: number; modified: string; reason: string };

export function previewDoc(root: string, rel: string): DocPreview | null {
  const abs = resolveDoc(root, rel, "file");
  if (!abs) return null;
  const st = statSync(abs);
  const name = rel.split("/").pop() ?? rel;
  const base = { name, path: rel, size: st.size, modified: st.mtime.toISOString() };
  const ext = extname(name).toLowerCase();
  if (TEXT_EXT.has(ext) || (!ext && st.size < TEXT_MAX)) {
    const fd = openInside(root, abs);
    if (fd === null) return null;
    let buf: Buffer;
    try {
      buf = readHead(fd, TEXT_MAX); // bounded: never more than 512 KB in memory (Codex r6)
    } finally {
      closeSync(fd);
    }
    if (buf.includes(0)) return { ...base, kind: "none", reason: "This file isn't text." };
    return { ...base, kind: "text", text: buf.toString("utf8"), truncated: st.size > TEXT_MAX };
  }
  const type = BLOB_TYPE[ext];
  if (type) {
    if (st.size > BLOB_MAX) return { ...base, kind: "none", reason: "Too large to preview here." };
    return { ...base, kind: type === "application/pdf" ? "pdf" : "image", type };
  }
  return { ...base, kind: "none", reason: "No preview for this kind of file." };
}

export function addDocFolder(root: string, parent: string, name: string): { path: string } | { error: string; status: 400 | 404 | 409 } {
  const bad = badFolderName(name);
  if (bad) return { error: bad, status: 400 };
  const clean = name.trim();
  if (!segOk(clean)) return { error: "That name isn't allowed here.", status: 400 };
  const dir = resolveDoc(root, parent, "folder");
  if (!dir) return { error: "That folder isn't available.", status: 404 };
  const target = join(dir, clean);
  if (existsSync(target)) return { error: "A folder with that name is already there.", status: 409 };
  mkdirSync(target);
  // The parent was swapped between the check and mkdir (Codex r6): the new folder must still be inside the root.
  const made = realpathSync(target);
  if (!made.startsWith(root + sep)) return { error: "That folder isn't available.", status: 404 };
  const base = parent.split("/").filter(Boolean).join("/");
  return { path: base ? `${base}/${clean}` : clean };
}

interface DocUser {
  userId: string;
  admin?: boolean;
}

export function registerDocTreeRoutes(app: Hono<any>, deps: { resolveUser: (c: Context) => DocUser | null; root?: () => string | null }): void {
  const rootOf = deps.root ?? workRoot;
  app.use("/app/docs/*", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "no-store");
  });
  const gate = (c: Context): { root: string } | Response => {
    const u = deps.resolveUser(c);
    if (!u) return c.json({ error: "Unauthorized" }, 401);
    if (!u.admin) return c.json({ error: "Forbidden" }, 403);
    const root = rootOf();
    if (!root) return c.json({ error: "No AHI folder on this server." }, 404);
    return { root };
  };

  app.get("/app/docs/tree", (c) => {
    const g = gate(c);
    if (g instanceof Response) return g;
    const rel = c.req.query("path") ?? "";
    const entries = listDocs(g.root, rel);
    if (!entries) return c.json({ error: "Not found" }, 404);
    return c.json({ root: rootLabel(g.root), path: rel.split("/").filter(Boolean).join("/"), entries });
  });

  app.get("/app/docs/preview", (c) => {
    const g = gate(c);
    if (g instanceof Response) return g;
    const p = previewDoc(g.root, c.req.query("path") ?? "");
    return p ? c.json(p) : c.json({ error: "Not found" }, 404);
  });

  app.get("/app/docs/raw", (c) => {
    const g = gate(c);
    if (g instanceof Response) return g;
    const rel = c.req.query("path") ?? "";
    const p = previewDoc(g.root, rel);
    if (!p || (p.kind !== "image" && p.kind !== "pdf")) return c.json({ error: "Not found" }, 404);
    const fd = openInside(g.root, resolveDoc(g.root, rel, "file") ?? "");
    if (fd === null) return c.json({ error: "Not found" }, 404);
    return new Response(Readable.toWeb(createReadStream("", { fd })) as ReadableStream, {
      headers: { "Content-Type": p.type, "Content-Length": String(p.size), "Content-Disposition": "inline", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" },
    });
  });

  app.post("/app/docs/folders", async (c) => {
    const g = gate(c);
    if (g instanceof Response) return g;
    if (c.req.header("x-ahi-review") !== "1") return c.json({ error: "missing X-AHI-Review header" }, 403);
    let body: Record<string, unknown> | null = null;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    const parent = typeof body?.parent === "string" ? body.parent : "";
    const name = typeof body?.name === "string" ? body.name : "";
    const r = addDocFolder(g.root, parent, name);
    return "error" in r ? c.json({ error: r.error }, r.status) : c.json({ ok: true, path: r.path });
  });
}
