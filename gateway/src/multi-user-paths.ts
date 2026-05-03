import { existsSync, mkdirSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

export interface MultiUserDataPaths {
  userId: string;
  businessRoot: string;
  sessionsDir: string;
  sessionsIndex: string;
  messageThreadsDir: string;
  filesRoot: string;
  filesDir: (conversationId?: string) => string;
  mediaRoot: string;
  mediaDir: (timeline?: string) => string;
  agentsJson: string;
  clipboardJson: string;
  legacy: {
    sessionsIndex: string;
    clipboardJson: string;
    clipboardUserJson: string;
    messagesRoot: string;
    messageThreadsDir: string;
    uploadsRoot: string;
    uploadsUserDir: string;
    photosRoot: string;
  };
}

const warnKeys = new Set<string>();

export function warnDeprecatedPath(key: string, legacyPath: string, canonicalPath: string): void {
  if (warnKeys.has(key)) return;
  warnKeys.add(key);
  console.warn(
    `[multi-user-paths] deprecated legacy path in use: ${legacyPath} -> canonical ${canonicalPath}`,
  );
}

export function safeSegment(value: string | undefined | null, fallback: string): string {
  const raw = (value ?? "").trim().toLowerCase();
  const safe = raw.replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return safe || fallback;
}

export function timelineDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Resolves per-user storage paths under $AHI_HOME (default ~/ahi).
 * The single-user shell uses "primary" as its only userId; the multi-slot
 * shape is preserved so future multi-user setups can plug in additional
 * userIds without restructuring the call sites.
 */
function ahiHome(): string {
  return process.env.AHI_HOME || resolve(homedir(), "ahi");
}

export function multiUserPaths(userId: string): MultiUserDataPaths {
  const safeUserId = safeSegment(userId, "primary");
  const root = ahiHome();
  const userRoot = join(root, "state", safeUserId);
  const sessionsDir = join(userRoot, "sessions");
  const filesRoot = join(userRoot, "files");
  const mediaRoot = join(userRoot, "media");
  return {
    userId: safeUserId,
    businessRoot: userRoot,
    sessionsDir,
    sessionsIndex: join(sessionsDir, "index.json"),
    messageThreadsDir: join(sessionsDir, "messages"),
    filesRoot,
    filesDir: (conversationId = "general") => join(filesRoot, safeSegment(conversationId, "general")),
    mediaRoot,
    mediaDir: (timeline = timelineDay()) => join(mediaRoot, safeSegment(timeline, timelineDay())),
    agentsJson: join(userRoot, "agents.json"),
    clipboardJson: join(userRoot, "clipboard.json"),
    legacy: {
      // Legacy fields retained for backwards-compat readers but pointed at
      // the canonical layout; nothing in the shipped shell writes here.
      sessionsIndex: join(sessionsDir, "index.json"),
      clipboardJson: join(userRoot, "clipboard.json"),
      clipboardUserJson: join(userRoot, "clipboard.json"),
      messagesRoot: join(sessionsDir, "messages"),
      messageThreadsDir: join(sessionsDir, "messages"),
      uploadsRoot: filesRoot,
      uploadsUserDir: filesRoot,
      photosRoot: mediaRoot,
    },
  };
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function atomicWriteFile(path: string, data: string | Buffer): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function atomicWriteJson(path: string, value: unknown): void {
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
