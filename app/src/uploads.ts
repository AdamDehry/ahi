import { ownerUserId } from "./users.js";
import { readdirSync, statSync, unlinkSync, existsSync, mkdirSync, renameSync, rmdirSync } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";
import { ensureDir, multiUserPaths, safeSegment, warnDeprecatedPath } from "./multi-user-paths.js";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

const DEFAULT_CONVERSATION_ID = "general";

export interface FileInfo {
  name: string;
  size: number;
  modified: string;
}

export function listFiles(userId: string): FileInfo[] {
  const paths = multiUserPaths(userId);
  const root = paths.filesRoot;
  const legacy = existsSync(paths.legacy.uploadsUserDir)
    ? paths.legacy.uploadsUserDir
    : userId === ownerUserId() && existsSync(paths.legacy.uploadsRoot)
      ? paths.legacy.uploadsRoot
      : null;
  const source = existsSync(root) ? root : legacy;
  if (!source) return [];
  if (source !== root) warnDeprecatedPath(`uploads:${userId}`, source, root);
  const out: FileInfo[] = [];
  for (const entry of readdirSync(source).filter((f) => !f.startsWith("."))) {
    const full = join(source, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      for (const nested of readdirSync(full).filter((f) => !f.startsWith("."))) {
        const nestedFull = join(full, nested);
        const nestedSt = statSync(nestedFull);
        if (nestedSt.isFile()) {
          out.push({ name: `${entry}/${nested}`, size: nestedSt.size, modified: nestedSt.mtime.toISOString() });
        }
      }
    } else if (st.isFile()) {
      out.push({ name: entry, size: st.size, modified: st.mtime.toISOString() });
    }
  }
  return out
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

export function getFilePath(userId: string, name: string): string | null {
  const safe = name.split(/[\\/]/).filter(Boolean);
  const paths = multiUserPaths(userId);
  const canonical = safe.length > 1
    ? join(paths.filesRoot, ...safe)
    : join(paths.filesDir(DEFAULT_CONVERSATION_ID), safe[0] ?? "");
  if (existsSync(canonical)) return canonical;
  const legacyName = safe[safe.length - 1] ?? "";
  const legacy = join(paths.legacy.uploadsUserDir, legacyName);
  if (existsSync(legacy)) {
    warnDeprecatedPath(`uploads:${userId}:${legacyName}`, legacy, canonical);
    return legacy;
  }
  const flatLegacy = join(paths.legacy.uploadsRoot, legacyName);
  if (userId === ownerUserId() && existsSync(flatLegacy)) {
    warnDeprecatedPath(`uploads:${userId}:flat:${legacyName}`, flatLegacy, canonical);
    return flatLegacy;
  }
  return null;
}

export async function saveFile(
  userId: string,
  name: string,
  data: ArrayBuffer,
  // Step 3d (additive): optional target category. The default preserves
  // pre-3d behavior exactly — existing callers are unaffected.
  category: string = DEFAULT_CONVERSATION_ID,
): Promise<string> {
  if (data.byteLength > MAX_FILE_SIZE) {
    throw new Error("File too large (max 50MB)");
  }
  const safe = name.replace(/[/\\]/g, "");
  const cat = safeSegment(category, DEFAULT_CONVERSATION_ID);
  const dir = multiUserPaths(userId).filesDir(cat);
  ensureDir(dir);
  const full = join(dir, safe);
  await writeFile(full, Buffer.from(data));
  return `${cat}/${safe}`;
}

export function deleteFile(userId: string, name: string): boolean {
  const safe = name.split(/[\\/]/).filter(Boolean);
  const paths = multiUserPaths(userId);
  const full = safe.length > 1
    ? join(paths.filesRoot, ...safe)
    : join(paths.filesDir(DEFAULT_CONVERSATION_ID), safe[0] ?? "");
  if (existsSync(full)) {
    unlinkSync(full);
    return true;
  }
  const legacyName = safe[safe.length - 1] ?? "";
  const legacy = join(paths.legacy.uploadsUserDir, legacyName);
  if (existsSync(legacy)) {
    warnDeprecatedPath(`uploads:${userId}:delete:${legacyName}`, legacy, full);
    unlinkSync(legacy);
    return true;
  }
  const flatLegacy = join(paths.legacy.uploadsRoot, legacyName);
  if (userId === ownerUserId() && existsSync(flatLegacy)) {
    warnDeprecatedPath(`uploads:${userId}:delete-flat:${legacyName}`, flatLegacy, full);
    unlinkSync(flatLegacy);
    return true;
  }
  return false;
}

// ── File categories (Step 3d, additive) ─────────────────────────────
//
// The storage layer already models categories: one-level subdirectories
// of filesRoot (listFiles walks them; getFilePath/deleteFile resolve
// "cat/name"). These operations expose that model. The live public/
// dashboard keeps working untouched: it only calls listFiles /
// getFilePath / deleteFile / saveFile(default) — all unchanged shapes.
//
// Rules: names are sanitized via safeSegment (lowercase a-z0-9._-);
// "general" is the fallback home for files and can't be renamed/deleted.

export function listCategories(userId: string): string[] {
  const root = multiUserPaths(userId).filesRoot;
  const out = new Set<string>([DEFAULT_CONVERSATION_ID]);
  if (existsSync(root)) {
    for (const entry of readdirSync(root).filter((f) => !f.startsWith("."))) {
      if (statSync(join(root, entry)).isDirectory()) out.add(entry);
    }
  }
  return [...out].sort((a, b) => (a === DEFAULT_CONVERSATION_ID ? -1 : b === DEFAULT_CONVERSATION_ID ? 1 : a.localeCompare(b)));
}

export function createCategory(userId: string, name: string): { ok: true; name: string } | { ok: false; error: string } {
  const safe = safeSegment(name, "");
  if (!safe) return { ok: false, error: "Category name required" };
  const dir = multiUserPaths(userId).filesDir(safe);
  if (existsSync(dir)) return { ok: false, error: `Category already exists: ${safe}` };
  mkdirSync(dir, { recursive: true });
  return { ok: true, name: safe };
}

export function renameCategory(userId: string, from: string, to: string): { ok: true; name: string } | { ok: false; error: string } {
  const safeFrom = safeSegment(from, "");
  const safeTo = safeSegment(to, "");
  if (!safeFrom || !safeTo) return { ok: false, error: "Category name required" };
  if (safeFrom === DEFAULT_CONVERSATION_ID) return { ok: false, error: `"${DEFAULT_CONVERSATION_ID}" cannot be renamed` };
  if (safeFrom === safeTo) return { ok: true, name: safeTo };
  const paths = multiUserPaths(userId);
  const fromDir = paths.filesDir(safeFrom);
  const toDir = paths.filesDir(safeTo);
  if (!existsSync(fromDir)) return { ok: false, error: `Category not found: ${safeFrom}` };
  if (existsSync(toDir)) return { ok: false, error: `Category already exists: ${safeTo}` };
  renameSync(fromDir, toDir);
  return { ok: true, name: safeTo };
}

/** Delete a category. Its files are MOVED to "general" — never deleted. */
export function deleteCategory(userId: string, name: string): { ok: true } | { ok: false; error: string } {
  const safe = safeSegment(name, "");
  if (!safe) return { ok: false, error: "Category name required" };
  if (safe === DEFAULT_CONVERSATION_ID) return { ok: false, error: `"${DEFAULT_CONVERSATION_ID}" cannot be deleted` };
  const paths = multiUserPaths(userId);
  const dir = paths.filesDir(safe);
  if (!existsSync(dir)) return { ok: false, error: `Category not found: ${safe}` };
  const fallback = paths.filesDir(DEFAULT_CONVERSATION_ID);
  ensureDir(fallback);
  for (const entry of readdirSync(dir).filter((f) => !f.startsWith("."))) {
    let target = join(fallback, entry);
    if (existsSync(target)) {
      // Collision in general/ — keep both, suffix the incoming file.
      const dot = entry.lastIndexOf(".");
      const stem = dot > 0 ? entry.slice(0, dot) : entry;
      const ext = dot > 0 ? entry.slice(dot) : "";
      let i = 2;
      while (existsSync(target)) target = join(fallback, `${stem}-${i++}${ext}`);
    }
    renameSync(join(dir, entry), target);
  }
  rmdirSync(dir);
  return { ok: true };
}

/** Move one file into another category. `name` is the listFiles shape
 *  ("cat/file" or bare legacy "file"). Refuses to overwrite. */
export function moveFile(userId: string, name: string, toCategory: string): { ok: true; name: string } | { ok: false; error: string } {
  const cat = safeSegment(toCategory, "");
  if (!cat) return { ok: false, error: "Target category required" };
  const current = getFilePath(userId, name);
  if (!current) return { ok: false, error: `File not found: ${name}` };
  const base = name.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const paths = multiUserPaths(userId);
  const targetDir = paths.filesDir(cat);
  ensureDir(targetDir);
  const target = join(targetDir, base);
  if (current === target) return { ok: true, name: `${cat}/${base}` };
  if (existsSync(target)) return { ok: false, error: `A file named "${base}" already exists in ${cat}` };
  renameSync(current, target);
  return { ok: true, name: `${cat}/${base}` };
}
