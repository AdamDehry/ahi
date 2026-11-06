/**
 * Agent → chat files: Michael can send the owner a file in the app.
 *
 * One call = ONE outbound message from the agent, carrying every file plus an
 * optional caption — the same "words and cargo are one message" rule the owner's
 * own sends follow (design lock v4). It is delivered by ONE broadcast, so it
 * is persisted once, reaches every open app once and pushes once
 * (websocket.ts → storeMessage + sendPushForMessage).
 *
 * The files land in the user's own media root and are registered like any
 * other media (source "agent"), so the existing authenticated /ui/media/:id
 * route serves them with the same per-user access check. An audio file is a
 * FILE (type "audio"): it never touches the voice-note / transcript path.
 *
 * Runs in the gateway process only. Message state is cached and rewritten
 * whole by this process, so a writer outside it would be silently erased —
 * the CLI (scripts/send-file.mjs) therefore goes through the HTTP route.
 */
import { writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import { basename, join } from "path";
import { ensureDir, multiUserPaths } from "../multi-user-paths.js";
import {
  inferMime,
  isAllowedUploadMime,
  mediaRef,
  registerMedia,
  typeFromUpload,
  type MediaRef,
} from "../media-store.js";
import type { MessageEvent } from "../websocket.js";

/** Same per-file ceiling as an upload from the app. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Same per-message cap as the composer (design lock v4). */
export const MAX_FILES = 10;
/** One message never carries more than this in total. */
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_CAPTION_CHARS = 4000;

export interface ChatFilesUser {
  userId: string;
  name: string;
  agents: string[];
  telegramChatId: number | null;
}

export interface ChatFilesDeps {
  /** Registered user by id, or null. */
  user(userId: string): ChatFilesUser | null;
  /** Agents this gateway is running. */
  bots(): string[];
  /** Persist + deliver + push (production: websocket broadcast). */
  broadcast(event: MessageEvent): void;
  now?: () => Date;
}

export interface IncomingFile {
  name: string;
  /** What the sender claimed; the extension wins when it is known. */
  mime?: string;
  data: Uint8Array;
}

export interface SendRequest {
  to: string;
  bot: string;
  caption?: string;
  files: IncomingFile[];
}

export type SendResult =
  | { ok: true; event: MessageEvent; media: MediaRef[] }
  | { ok: false; status: 400 | 403 | 413 | 415 | 500 | 507; error: string };

/** The name a file is stored and offered under: no directories, no control
 *  characters, no leading dots, bounded. The extension is kept. */
export function cleanFileName(name: string): string {
  const base = basename(String(name || "").replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  if (!base) return "file";
  if (base.length <= 160) return base;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : "";
  return base.slice(0, 160 - ext.length) + ext;
}

/** Mime by extension when the extension is one we know; else the claim. */
export function resolveMime(name: string, claimed?: string): string {
  const byExt = inferMime(name);
  if (byExt !== "application/octet-stream") return byExt;
  const c = (claimed || "").split(";")[0].trim().toLowerCase();
  return c || byExt;
}

/** Who may post where. Separate so the route can answer 403 before reading
 *  a single file byte into the media root. */
export function checkRecipient(
  deps: Pick<ChatFilesDeps, "user" | "bots">,
  to: string,
  bot: string,
): { ok: true; user: ChatFilesUser } | { ok: false; status: 400 | 403; error: string } {
  if (!to || !/^[a-z0-9._-]{1,60}$/i.test(to)) return { ok: false, status: 400, error: "`to` (a user id) is required" };
  if (!bot || !/^[a-z0-9._-]{1,60}$/i.test(bot)) return { ok: false, status: 400, error: "`bot` is required" };
  const user = deps.user(to.toLowerCase());
  if (!user) return { ok: false, status: 403, error: `No such user: ${to}` };
  if (!deps.bots().includes(bot)) return { ok: false, status: 403, error: `Unknown agent: ${bot}` };
  // An agent may only post into the chats of users who have that agent.
  if (!user.agents.includes(bot)) return { ok: false, status: 403, error: `${user.name} does not have ${bot}` };
  return { ok: true, user };
}

function isDiskFull(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "ENOSPC" || code === "EDQUOT";
}

export async function sendAgentFiles(deps: ChatFilesDeps, req: SendRequest): Promise<SendResult> {
  const who = checkRecipient(deps, req.to, req.bot);
  if (!who.ok) return who;
  const user = who.user;

  const files = req.files ?? [];
  if (!files.length) return { ok: false, status: 400, error: "At least one file is required" };
  if (files.length > MAX_FILES) return { ok: false, status: 400, error: `At most ${MAX_FILES} files per message` };
  const caption = typeof req.caption === "string" ? req.caption.trim() : "";
  if (caption.length > MAX_CAPTION_CHARS) return { ok: false, status: 400, error: `Caption over ${MAX_CAPTION_CHARS} characters` };

  // Validate everything before writing anything: a refused message leaves
  // nothing behind in the media root.
  let total = 0;
  const planned = files.map((f) => {
    const name = cleanFileName(f.name);
    return { name, mime: resolveMime(name, f.mime), data: f.data };
  });
  for (const f of planned) {
    if (!f.data.byteLength) return { ok: false, status: 400, error: `${f.name} is empty` };
    if (f.data.byteLength > MAX_FILE_BYTES) return { ok: false, status: 413, error: `${f.name} is over 50 MB` };
    total += f.data.byteLength;
    if (!isAllowedUploadMime(f.mime, f.name)) {
      return { ok: false, status: 415, error: `${f.name}: unsupported type (${f.mime})` };
    }
  }
  if (total > MAX_TOTAL_BYTES) return { ok: false, status: 413, error: "Files total over 100 MB" };

  const now = (deps.now ?? (() => new Date()))();
  const dir = join(multiUserPaths(user.userId).mediaDir(now.toISOString().slice(0, 10)), "from-agents");
  const refs: MediaRef[] = [];
  try {
    ensureDir(dir);
    for (const f of planned) {
      // Unique on disk; the ORIGINAL name is what the record keeps and what
      // every download is offered as.
      const stored = join(dir, `${now.getTime().toString(36)}-${randomUUID().slice(0, 6)}-${f.name}`);
      await writeFile(stored, f.data);
      const record = await registerMedia({
        userId: user.userId,
        bot: req.bot,
        source: "agent",
        type: typeFromUpload(f.mime, f.name),
        filePath: stored,
        originalName: f.name,
        mime: f.mime,
      });
      refs.push(mediaRef(record));
    }
  } catch (err) {
    if (isDiskFull(err)) return { ok: false, status: 507, error: "Disk full; couldn't save the files" };
    console.error("[chat-files] save failed:", err);
    return { ok: false, status: 500, error: "Couldn't save the files" };
  }

  const event: MessageEvent = {
    type: "message",
    bot: req.bot,
    direction: "out",
    contentType: refs.some((m) => m.type === "image") ? "photo" : "document",
    text: caption,
    timestamp: now.toISOString(),
    chatId: user.telegramChatId ?? 0,
    userId: user.userId,
    senderName: user.name,
    source: "app",
    meta: { agentFiles: { by: req.bot } },
    // `media` = the first file, so every single-media reader still works;
    // `mediaList` only when there is more than one (same shape as /app/send).
    media: refs[0],
    ...(refs.length > 1 ? { mediaList: refs } : {}),
  };
  deps.broadcast(event);
  return { ok: true, event, media: refs };
}
