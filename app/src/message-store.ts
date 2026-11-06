import { ownerUserId } from "./users.js";
import {
  appendFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
} from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import type { MessageEvent } from "./websocket.js";
import { loadUsers, lookupByChatId } from "./users.js";
import {
  atomicWriteJson,
  gatewayStateRoot,
  multiUserPaths,
  warnDeprecatedPath,
} from "./multi-user-paths.js";

const LEGACY_MESSAGES_DIR = resolve(gatewayStateRoot(), "messages");

function canonicalMessagesDir(userId: string): string {
  return multiUserPaths(userId).messageThreadsDir;
}

/** Per-bot user-scoped storage: <bot>/<userId>.json */
function botDir(bot: string, userId: string): string {
  return resolve(canonicalMessagesDir(userId), bot);
}

function legacyBotDir(bot: string): string {
  return resolve(LEGACY_MESSAGES_DIR, bot);
}

function userFile(bot: string, userId: string): string {
  return resolve(botDir(bot, userId), `${userId}.json`);
}

/**
 * Messages that age out of the live 500-message window, appended in order
 * (one JSON per line). The live thread stays the fast, cached read path; the
 * archive is what lets the media panel and "Show in chat" reach further back.
 * Written only by this process, append-only, never rewritten — so it cannot
 * race the thread cache.
 */
function archiveFile(bot: string, userId: string): string {
  return resolve(botDir(bot, userId), `${userId}.archive.jsonl`);
}

function legacyBotFile(bot: string): string {
  return resolve(LEGACY_MESSAGES_DIR, `${bot}.json`);
}

function legacyUserFile(bot: string, userId: string): string {
  return resolve(legacyBotDir(bot), `${userId}.json`);
}

function ensureBotDir(bot: string, userId: string): void {
  const dir = botDir(bot, userId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function knownUserIds(): string[] {
  try {
    return [...new Set([...loadUsers().map((u) => u.userId), "unknown"])];
  } catch {
    return [ownerUserId(), "unknown"];
  }
}

/**
 * One-time migration: pre-multi-user layout was `messages/<bot>.json` with
 * mixed conversations keyed only by `chatId`. We migrate each legacy file
 * by grouping records by resolved `chatId → userId` and writing per-user
 * files. Records whose chatId doesn't map to a known user are kept in a
 * preserved `<bot>.json.legacy-unmapped` so nothing is ever silently lost.
 *
 * Idempotent: runs once on startup and is a no-op when no legacy file exists.
 */
function migrateLegacyBotFileIfNeeded(bot: string): void {
  const legacy = legacyBotFile(bot);
  if (!existsSync(legacy)) return;
  // Refuse to migrate if target is a directory — bail so we don't overwrite
  // already-migrated state.
  try {
    const st = statSync(legacy);
    if (!st.isFile()) return;
  } catch {
    return;
  }

  let parsed: MessageEvent[];
  try {
    parsed = JSON.parse(readFileSync(legacy, "utf-8"));
  } catch (err) {
    console.warn(
      `[message-store] migration: could not parse ${legacy}: ${(err as Error).message}`,
    );
    return;
  }
  if (!Array.isArray(parsed)) return;

  const byUser: Record<string, MessageEvent[]> = {};
  const unmapped: MessageEvent[] = [];
  for (const msg of parsed) {
    const user = lookupByChatId(msg.chatId);
    if (user) {
      (byUser[user.userId] ||= []).push(msg);
    } else {
      unmapped.push(msg);
    }
  }

  for (const [userId, msgs] of Object.entries(byUser)) {
    ensureBotDir(bot, userId);
    const target = userFile(bot, userId);
    // If a per-user file already exists, merge by timestamp rather than
    // blow it away — prior partial runs shouldn't dedupe silently.
    const existing = existsSync(target)
      ? (JSON.parse(readFileSync(target, "utf-8")) as MessageEvent[])
      : [];
    const merged = [...existing, ...msgs]
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .slice(-500);
    atomicWriteJson(target, merged);
  }

  if (unmapped.length > 0) {
    const preserve = `${legacy}.legacy-unmapped`;
    atomicWriteJson(preserve, unmapped);
    console.warn(
      `[message-store] migration: ${bot} had ${unmapped.length} messages with unmapped chatIds — preserved at ${preserve}`,
    );
  }

  // Rename the legacy file out of the way so we don't re-process it next
  // boot. Keep it (with a .migrated suffix) instead of deleting — if the
  // migration missed something, the evidence is still on disk.
  try {
    renameSync(legacy, `${legacy}.migrated`);
    console.log(
      `[message-store] migrated ${bot}: ${Object.keys(byUser).length} users, ${unmapped.length} unmapped`,
    );
  } catch (err) {
    console.warn(`[message-store] migration: rename failed: ${(err as Error).message}`);
  }
}

/** Run migration for every bot folder we see a legacy file for. */
function runMigrationsOnce(): void {
  if (!existsSync(LEGACY_MESSAGES_DIR)) return;
  // Touch users.json so migration can resolve chatId → userId.
  loadUsers();
  const entries = readdirSync(LEGACY_MESSAGES_DIR);
  const legacyBots = entries
    .filter((f) => f.endsWith(".json") && !f.endsWith(".bak") && !f.includes(".migrated"))
    .map((f) => f.replace(/\.json$/, ""));
  for (const bot of legacyBots) {
    migrateLegacyBotFileIfNeeded(bot);
  }
}

// H-040: keep migration helpers opt-in. Do not mutate the owner's legacy state
// during ordinary gateway import/startup.

/**
 * Pass 2 — sender-attribution backfill on already-migrated per-user files.
 *
 * The W2 migration split legacy records into per-user threads but did not
 * populate `senderName` / `userId` on individual MessageEvent records.
 * That left the feed rendering "unknown" for every pre-migration message.
 *
 * For each record missing `senderName`, resolve via stored `chatId` →
 * user, fill in `senderName` + `userId`. Records with no chatId or an
 * unresolvable chatId keep `senderName: "unknown"` (stamped explicitly
 * so we don't revisit them on every boot).
 *
 * Idempotent: skips records that already have `senderName` set.
 */
function backfillSenderAttribution(): { bot: string; filled: number; unknown: number }[] {
  const results: { bot: string; filled: number; unknown: number }[] = [];
  if (!existsSync(LEGACY_MESSAGES_DIR)) return results;

  const botDirs = readdirSync(LEGACY_MESSAGES_DIR).filter((name) => {
    const full = resolve(LEGACY_MESSAGES_DIR, name);
    try {
      return statSync(full).isDirectory();
    } catch {
      return false;
    }
  });

  for (const bot of botDirs) {
    const dir = botDir(bot, ownerUserId());
    let totalFilled = 0;
    let totalUnknown = 0;
    let totalChecked = 0;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const p = resolve(dir, f);
      let arr: MessageEvent[];
      try {
        arr = JSON.parse(readFileSync(p, "utf-8"));
      } catch {
        continue;
      }
      if (!Array.isArray(arr)) continue;
      let touched = false;
      for (const msg of arr) {
        totalChecked++;
        if (msg.senderName) continue;
        const user = lookupByChatId(msg.chatId);
        if (user) {
          msg.senderName = user.name;
          msg.userId = user.userId;
          totalFilled++;
        } else {
          msg.senderName = "unknown";
          totalUnknown++;
        }
        touched = true;
      }
      if (touched) {
        atomicWriteJson(p, arr);
      }
    }
    if (totalFilled > 0 || totalUnknown > 0) {
      results.push({ bot, filled: totalFilled, unknown: totalUnknown });
      console.log(
        `[message-store] backfill ${bot}: checked=${totalChecked} filled=${totalFilled} unknown-stamped=${totalUnknown}`,
      );
    }
  }
  return results;
}

/**
 * Pass 3 — recover `.legacy-unmapped` records whose chatId is now known.
 *
 * A message whose chatId was not yet in users.json when the per-user migration
 * ran lands in `<bot>.json.legacy-unmapped`. Once that chatId is
 * registered, walk each `.legacy-unmapped` file and migrate
 * newly-resolvable records into the correct per-user thread. Records
 * that still don't resolve are left in place for a future pass.
 *
 * Idempotent: if a `.legacy-unmapped` file is empty (or vanishes) after
 * a run, subsequent runs are no-ops.
 */
function recoverUnmappedLegacy(): { bot: string; recovered: number; left: number }[] {
  const results: { bot: string; recovered: number; left: number }[] = [];
  if (!existsSync(LEGACY_MESSAGES_DIR)) return results;
  const entries = readdirSync(LEGACY_MESSAGES_DIR).filter((f) => f.endsWith(".legacy-unmapped"));
  for (const entry of entries) {
    const bot = entry.replace(/\.json\.legacy-unmapped$/, "");
    const path = resolve(LEGACY_MESSAGES_DIR, entry);
    let arr: MessageEvent[];
    try {
      arr = JSON.parse(readFileSync(path, "utf-8"));
    } catch (err) {
      console.warn(
        `[message-store] recover: could not parse ${entry}: ${(err as Error).message}`,
      );
      continue;
    }
    if (!Array.isArray(arr)) continue;

    const byUser: Record<string, MessageEvent[]> = {};
    const leftover: MessageEvent[] = [];
    for (const msg of arr) {
      const user = lookupByChatId(msg.chatId);
      if (user) {
        // Stamp identity while we have it.
        msg.senderName = user.name;
        msg.userId = user.userId;
        (byUser[user.userId] ||= []).push(msg);
      } else {
        leftover.push(msg);
      }
    }

    let recovered = 0;
    for (const [userId, msgs] of Object.entries(byUser)) {
      ensureBotDir(bot, userId);
      const target = userFile(bot, userId);
      const existing = existsSync(target)
        ? (JSON.parse(readFileSync(target, "utf-8")) as MessageEvent[])
        : [];
      const merged = [...existing, ...msgs]
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        .slice(-500);
      atomicWriteJson(target, merged);
      recovered += msgs.length;
    }

    // Write remaining unmapped back (or remove file if empty).
    if (leftover.length === 0) {
      try {
        // Keep evidence: rename rather than delete.
        renameSync(path, `${path}.drained`);
      } catch {
        /* ignore */
      }
    } else {
      atomicWriteJson(path, leftover);
    }

    if (recovered > 0 || leftover.length > 0) {
      results.push({ bot, recovered, left: leftover.length });
      console.log(
        `[message-store] recover ${bot}: recovered=${recovered} still-unmapped=${leftover.length}`,
      );
    }
  }
  return results;
}

// Run pass 3 BEFORE pass 2 only from an explicit migration script so records
// moved out of .legacy-unmapped get attribution stamped in the same run.

// ── In-memory thread cache (P1 — read-through / write-through) ───────────────
//
// Disk JSON stays the durable source of truth. This cache only avoids
// re-reading + re-parsing the same per-user thread on every /ui/messages
// request and every WS (re)connect — the architectural hot path the audit
// flagged. Consistency is safe because, within a running gateway, EVERY
// write goes through saveUserThread() below (storeMessage / upsert), which
// updates the cache and the disk file atomically. The deprecated cross-user
// readers (getMessages / getAllMessages) read disk directly, which stays
// current because each write flushes synchronously.
//
// NOTE: the opt-in migration helpers above mutate disk out-of-band, but they
// are never run during ordinary gateway startup/operation (see the H-040
// note), so they cannot desync a live cache.
const threadCache = new Map<string, MessageEvent[]>();

function threadCacheKey(bot: string, userId: string): string {
  return `${bot}::${userId}`;
}

function readUserThreadFromDisk(bot: string, userId: string): MessageEvent[] {
  const file = userFile(bot, userId);
  if (!existsSync(file)) {
    const legacy = legacyUserFile(bot, userId);
    if (!existsSync(legacy)) return [];
    warnDeprecatedPath(`messages:${bot}:${userId}`, legacy, file);
    try {
      const parsed = JSON.parse(readFileSync(legacy, "utf-8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Returns the cached, mutable thread array for a bot+user. The returned
 * reference is the cache's own array — internal writers (storeMessage,
 * upsertMessageById) mutate it in place and then saveUserThread() to flush.
 * External readers MUST copy (slice/filter) before exposing it; all current
 * callers do.
 */
function loadUserThread(bot: string, userId: string): MessageEvent[] {
  const key = threadCacheKey(bot, userId);
  const cached = threadCache.get(key);
  if (cached) return cached;
  const arr = readUserThreadFromDisk(bot, userId);
  threadCache.set(key, arr);
  return arr;
}

function saveUserThread(bot: string, userId: string, messages: MessageEvent[]): void {
  threadCache.set(threadCacheKey(bot, userId), messages);
  ensureBotDir(bot, userId);
  atomicWriteJson(userFile(bot, userId), messages);
}

/**
 * Append a message to the correct per-user thread and persist to disk.
 *
 * The full MessageEvent shape is serialized as-is — including the `source`
 * field ("telegram" | "ui-send" | "app" | "private-edge") and the
 * resolved `senderName`. Retrieval uses `source` to exclude /ui/send test
 * injections from the scoring corpus; do not strip it.
 *
 * We require every MessageEvent to carry a `userId` at write time — see
 * the MessageEvent type. Callers that couldn't resolve a user (unknown
 * telegram sender) write to the `unknown` bucket so nothing is lost but
 * it stays clearly separated.
 */
export function storeMessage(msg: MessageEvent): void {
  ensureMessageId(msg);
  const userId = msg.userId || "unknown";
  const messages = loadUserThread(msg.bot, userId);
  messages.push(msg);
  // Keep last 500 per user thread on disk; the overflow goes to the archive.
  if (messages.length > LIVE_THREAD_CAP) {
    const aged = messages.splice(0, messages.length - LIVE_THREAD_CAP);
    archiveMessages(msg.bot, userId, aged);
  }
  saveUserThread(msg.bot, userId, messages);
}

export const LIVE_THREAD_CAP = 500;

function archiveMessages(bot: string, userId: string, aged: MessageEvent[]): void {
  if (!aged.length) return;
  try {
    ensureBotDir(bot, userId);
    appendFileSync(archiveFile(bot, userId), aged.map((m) => JSON.stringify(m)).join("\n") + "\n");
  } catch (err) {
    // Never fail a live message over the archive; say so loudly instead.
    console.error(`[message-store] archive append failed for ${bot}/${userId}:`, err);
  }
}

// Parsed once per change (append-only file: size is the version).
const archiveCache = new Map<string, { size: number; mtimeMs: number; messages: MessageEvent[] }>();

/** Archived (aged-out) messages for a bot+user, oldest first. Read-only copy. */
export function getArchivedMessagesForUser(bot: string, userId: string): MessageEvent[] {
  const file = archiveFile(bot, userId);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(file);
  } catch {
    return [];
  }
  const hit = archiveCache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.messages.slice();
  const messages: MessageEvent[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line) as MessageEvent);
    } catch {
      // a torn last line (crash mid-append) costs that line only
    }
  }
  archiveCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, messages });
  return messages.slice();
}

/**
 * The whole known thread: archive + live window, oldest first. For the media
 * catalog and "Show in chat" — NOT for prompts (those read the live window).
 */
export function getFullThreadForUser(bot: string, userId: string): MessageEvent[] {
  const live = loadUserThread(bot, userId).slice();
  const archived = getArchivedMessagesForUser(bot, userId);
  if (!archived.length) return live;
  // A message is never in both, but be defensive about ids across a crash
  // between append and rewrite.
  const liveIds = new Set(live.map((m) => m.meta?.messageId).filter(Boolean));
  return [...archived.filter((m) => !m.meta?.messageId || !liveIds.has(m.meta.messageId)), ...live];
}

/**
 * Stamp a stable `meta.messageId` on a message if it doesn't already have
 * one, and return it. Additive only — legacy records without ids keep
 * parsing fine; the id is the client-side dedupe/upsert key (P0). Mutates
 * the passed object so the same id is used for delivery and persistence.
 */
export function ensureMessageId(msg: MessageEvent): string {
  if (!msg.meta) msg.meta = {};
  if (!msg.meta.messageId) {
    msg.meta.messageId = `msg-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  }
  return msg.meta.messageId;
}

/**
 * Update an existing persisted message in place, matched by `meta.messageId`
 * (preferred) or `meta.turnId` + direction. Used by the voice-reply upsert
 * (P0): a fast text out-message is persisted first, then upgraded to a voice
 * message (contentType "voice" + media) once TTS finishes — same record, so
 * reconnect/delta shows voice instead of stale text. Returns the merged
 * record, or null if no matching record was found (caller may then append).
 */
export function upsertMessageById(patch: MessageEvent): MessageEvent | null {
  const userId = patch.userId || "unknown";
  const messages = loadUserThread(patch.bot, userId);
  const messageId = patch.meta?.messageId;
  const turnId = patch.meta?.turnId;
  let idx = -1;
  if (messageId) {
    idx = messages.findIndex((m) => m.meta?.messageId === messageId);
  }
  if (idx < 0 && turnId) {
    idx = messages.findIndex((m) => m.meta?.turnId === turnId && m.direction === patch.direction);
  }
  if (idx < 0) return null;
  const existing = messages[idx];
  const merged: MessageEvent = {
    ...existing,
    ...patch,
    // Preserve original ordering timestamp so the upgraded message doesn't
    // jump position in the thread.
    timestamp: existing.timestamp,
    meta: { ...existing.meta, ...patch.meta },
  };
  messages[idx] = merged;
  saveUserThread(patch.bot, userId, messages);
  return merged;
}

/**
 * Messages for a specific bot+user pair. This is the main read path once
 * auth is in place: the dashboard/PWA shows each authenticated user only
 * their own conversation with each agent.
 */
export function getMessagesForUser(bot: string, userId: string, limit = 100): MessageEvent[] {
  return loadUserThread(bot, userId).slice(-limit);
}

/**
 * DEPRECATED shape preserved for backward compatibility — read all
 * messages for a bot across every user. Used by the cross-user feed
 * (the owner's dashboard aggregates everything he has access to). New code
 * should prefer `getMessagesForUser`.
 */
export function getMessages(bot: string, limit = 100): MessageEvent[] {
  const all: MessageEvent[] = [];
  let sawCanonical = false;
  for (const userId of knownUserIds()) {
    const dir = botDir(bot, userId);
    if (!existsSync(dir)) continue;
    sawCanonical = true;
    for (const f of readdirSync(dir).filter((file) => file.endsWith(".json"))) {
      try {
        all.push(...JSON.parse(readFileSync(resolve(dir, f), "utf-8")));
      } catch {
        /* skip corrupt file */
      }
    }
  }
  if (!sawCanonical) {
    const readDir = legacyBotDir(bot);
    if (!existsSync(readDir)) return [];
    warnDeprecatedPath(`messages:${bot}:all`, readDir, botDir(bot, ownerUserId()));
    for (const f of readdirSync(readDir).filter((file) => file.endsWith(".json"))) {
      try {
        all.push(...JSON.parse(readFileSync(resolve(readDir, f), "utf-8")));
      } catch {
        /* skip corrupt file */
      }
    }
  }
  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return all.slice(-limit);
}

/** Get messages for all bots, merged and sorted by timestamp. */
export function getAllMessages(limit = 100): MessageEvent[] {
  const all: MessageEvent[] = [];
  let sawCanonical = false;
  for (const userId of knownUserIds()) {
    const root = canonicalMessagesDir(userId);
    if (!existsSync(root)) continue;
    sawCanonical = true;
    const botDirs = readdirSync(root).filter((name) => {
      const full = resolve(root, name);
      try {
        return statSync(full).isDirectory();
      } catch {
        return false;
      }
    });
    for (const bot of botDirs) {
      const dir = botDir(bot, userId);
      for (const f of readdirSync(dir).filter((file) => file.endsWith(".json"))) {
        try {
          all.push(...JSON.parse(readFileSync(resolve(dir, f), "utf-8")));
        } catch {
          /* skip corrupt */
        }
      }
    }
  }
  if (!sawCanonical) {
    if (!existsSync(LEGACY_MESSAGES_DIR)) return [];
    warnDeprecatedPath("messages:all", LEGACY_MESSAGES_DIR, canonicalMessagesDir(ownerUserId()));
    const botDirs = readdirSync(LEGACY_MESSAGES_DIR).filter((name) => {
      const full = resolve(LEGACY_MESSAGES_DIR, name);
      try {
        return statSync(full).isDirectory();
      } catch {
        return false;
      }
    });
    for (const bot of botDirs) {
      const dir = legacyBotDir(bot);
      for (const f of readdirSync(dir).filter((file) => file.endsWith(".json"))) {
        try {
          all.push(...JSON.parse(readFileSync(resolve(dir, f), "utf-8")));
        } catch {
          /* skip corrupt */
        }
      }
    }
  }
  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return all.slice(-limit);
}

/**
 * Retrieval-safe view of a bot+user thread: excludes `source: "ui-send"`
 * records (and `private-edge`).
 *
 * Use this (NOT `getMessagesForUser`/`getAllMessages`) any time the
 * messages feed into a scoring, indexing, or LLM-context pipeline.
 * Dashboard Quick Send forges the last-known chatId and writes test
 * injections into the store — those look identical to real turns except
 * for the `source` tag, and they will skew retrieval if included. Legacy
 * records without a `source` field (older installs) are treated as
 * Telegram for backward compat.
 */
export function getMessagesForRetrieval(
  bot: string,
  userId: string,
  limit = 100,
): MessageEvent[] {
  return loadUserThread(bot, userId)
    .filter((m) => m.source !== "ui-send" && m.source !== "private-edge")
    .slice(-limit);
}
