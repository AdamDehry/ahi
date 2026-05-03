import { readdirSync, statSync, unlinkSync, existsSync } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";
import { ensureDir, multiUserPaths, warnDeprecatedPath } from "./multi-user-paths.js";

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
    : userId === "primary" && existsSync(paths.legacy.uploadsRoot)
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
  if (userId === "primary" && existsSync(flatLegacy)) {
    warnDeprecatedPath(`uploads:${userId}:flat:${legacyName}`, flatLegacy, canonical);
    return flatLegacy;
  }
  return null;
}

export async function saveFile(userId: string, name: string, data: ArrayBuffer): Promise<string> {
  if (data.byteLength > MAX_FILE_SIZE) {
    throw new Error("File too large (max 50MB)");
  }
  const safe = name.replace(/[/\\]/g, "");
  const dir = multiUserPaths(userId).filesDir(DEFAULT_CONVERSATION_ID);
  ensureDir(dir);
  const full = join(dir, safe);
  await writeFile(full, Buffer.from(data));
  return `${DEFAULT_CONVERSATION_ID}/${safe}`;
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
  if (userId === "primary" && existsSync(flatLegacy)) {
    warnDeprecatedPath(`uploads:${userId}:delete-flat:${legacyName}`, flatLegacy, full);
    unlinkSync(flatLegacy);
    return true;
  }
  return false;
}
