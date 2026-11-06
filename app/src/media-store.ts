import { existsSync, readFileSync, statSync } from "fs";
import { writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import { basename, dirname, extname, join, resolve } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { atomicWriteJson, ensureDir, multiUserPaths } from "./multi-user-paths.js";

const execFileAsync = promisify(execFile);

/**
 * "voice" is a voice NOTE (recorded in the app, transcribed, played by the
 * note player). "audio" and "video" are FILES — an mp3 Michael sends, a song
 * The owner drops in — shown as a file card with its real name, never run through
 * the voice-note / transcript path. Readers that predate them fall back to
 * the document chip, which still downloads the file.
 */
export type MediaType = "image" | "voice" | "document" | "audio" | "video";

export interface MediaRef {
  id: string;
  type: MediaType;
  fileId?: string;
  path: string;
  originalName: string;
  mime: string;
  size: number;
  durationSec?: number;
  transcript?: string;
  thumbnail?: boolean;
}

export interface MediaRecord extends MediaRef {
  userId: string;
  bot?: string;
  createdAt: string;
  /** "agent" = a file an agent sent INTO the chat (src/chat-files.ts). */
  source: "telegram" | "ui-upload" | "agent";
  thumbPath?: string;
}

interface RegisterMediaInput {
  userId: string;
  bot?: string;
  source: MediaRecord["source"];
  type: MediaType;
  filePath: string;
  fileId?: string;
  originalName?: string;
  mime?: string;
  durationSec?: number;
  transcript?: string;
}

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"]);
const DOC_MIMES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

/** Audio files (not voice notes): mp3, m4a, ogg, wav — both directions. */
const AUDIO_MIMES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
  "audio/aac",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/webm",
]);
const AUDIO_EXTS = [".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav"];
/** Video: what a phone records or plays inline — mp4, mov, webm. */
const VIDEO_MIMES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const VIDEO_EXTS = [".mp4", ".m4v", ".mov", ".webm"];

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".opus": "audio/ogg",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function mediaIndexPath(userId: string): string {
  return join(multiUserPaths(userId).mediaRoot, "media-index.json");
}

/**
 * How many records the index keeps. It was 2000, and voice notes are ~80% of
 * it, so a photo or a file fell out of the index after a few months and its
 * thumbnail and download quietly 404'd — the media panel scrolls back that
 * far now, so the cap moved. Records are small (~400 bytes).
 */
export const MEDIA_INDEX_CAP = 20_000;

// Every thumbnail and download resolves through the index, so it is parsed
// once per change rather than once per request. Keyed on mtime + size: the
// index is only ever replaced whole (atomicWriteJson), never edited in place.
const indexCache = new Map<string, { mtimeMs: number; size: number; records: MediaRecord[] }>();

function loadIndex(userId: string): MediaRecord[] {
  const p = mediaIndexPath(userId);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(p);
  } catch {
    indexCache.delete(p);
    return [];
  }
  const hit = indexCache.get(p);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.records.slice();
  let records: MediaRecord[] = [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as MediaRecord[];
    records = Array.isArray(parsed) ? parsed : [];
  } catch {
    records = [];
  }
  indexCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, records });
  return records.slice();
}

function saveIndex(userId: string, records: MediaRecord[]): void {
  const kept = records.slice(-MEDIA_INDEX_CAP);
  const p = mediaIndexPath(userId);
  atomicWriteJson(p, kept);
  try {
    const st = statSync(p);
    indexCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, records: kept });
  } catch {
    indexCache.delete(p);
  }
}

export function inferMime(filePath: string, fallback?: string): string {
  if (fallback && fallback !== "application/octet-stream") return fallback;
  return MIME_BY_EXT[extname(filePath).toLowerCase()] || fallback || "application/octet-stream";
}

function publicRef(record: MediaRecord): MediaRef {
  return {
    id: record.id,
    type: record.type,
    fileId: record.fileId,
    path: record.path,
    originalName: record.originalName,
    mime: record.mime,
    size: record.size,
    durationSec: record.durationSec,
    transcript: record.transcript,
    thumbnail: record.thumbnail,
  };
}

async function createThumbnail(userId: string, id: string, filePath: string): Promise<string | null> {
  const thumbDir = join(multiUserPaths(userId).mediaRoot, "thumbs");
  const thumbPath = join(thumbDir, `${id}.jpg`);
  ensureDir(thumbDir);
  try {
    // Optional dependency in some gateway installs; ffmpeg below is the fallback.
    // @ts-ignore - sharp may not have local type metadata in the live node_modules.
    const sharp = (await import("sharp")).default;
    await sharp(filePath)
      .rotate()
      .resize({ width: 320, height: 320, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 78, mozjpeg: true })
      .toFile(thumbPath);
    return thumbPath;
  } catch (err) {
    try {
      await execFileAsync("ffmpeg", [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        filePath,
        "-vf",
        "scale=320:320:force_original_aspect_ratio=decrease",
        "-frames:v",
        "1",
        thumbPath,
      ]);
      return thumbPath;
    } catch (ffmpegErr) {
      console.warn(
        `[media] thumbnail failed for ${filePath}: sharp=${(err as Error).message}; ffmpeg=${(ffmpegErr as Error).message}`,
      );
    }
    return null;
  }
}

function baseMime(mime: string): string {
  return (mime || "").split(";")[0].trim().toLowerCase();
}

function isAudioFile(mime: string, ext: string): boolean {
  return AUDIO_MIMES.has(mime) || (AUDIO_EXTS.includes(ext) && (!mime || mime === "application/octet-stream" || mime.startsWith("audio/")));
}

function isVideoFile(mime: string, ext: string): boolean {
  return VIDEO_MIMES.has(mime) || (VIDEO_EXTS.includes(ext) && (!mime || mime === "application/octet-stream" || mime.startsWith("video/")));
}

export function isAllowedUploadMime(mime: string, name: string): boolean {
  const normalized = baseMime(mime) || baseMime(inferMime(name));
  const ext = extname(name).toLowerCase();
  if (normalized.startsWith("image/")) return true;
  // Audio and video are FILES now: mp3/m4a/ogg/wav, mp4/mov/webm.
  // Anything else under audio/ or video/ stays refused.
  if (normalized.startsWith("audio/") || normalized.startsWith("video/")) {
    return isAudioFile(normalized, ext) || isVideoFile(normalized, ext);
  }
  if (DOC_MIMES.has(normalized)) return true;
  if (isAudioFile(normalized, ext) || isVideoFile(normalized, ext)) return true;
  return [".pdf", ".txt", ".md", ".csv", ".json", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"].includes(ext);
}

/** The media type of an uploaded or agent-sent FILE. Never "voice": a voice
 *  note only comes from the recorder (voice-send) or Telegram's voice type. */
export function typeFromUpload(mime: string, name: string): MediaType {
  const normalized = baseMime(mime) || baseMime(inferMime(name));
  const ext = extname(name).toLowerCase();
  if (normalized.startsWith("image/") || IMAGE_MIMES.has(normalized)) return "image";
  if (isAudioFile(normalized, ext)) return "audio";
  if (isVideoFile(normalized, ext)) return "video";
  return "document";
}

/** Seconds of playable audio/video, via ffprobe; undefined when unknown. */
export async function probeDurationSec(filePath: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync(
      process.env.FFPROBE_BIN || "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
      { timeout: 10_000 },
    );
    const n = Number.parseFloat(String(stdout).trim());
    return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : undefined;
  } catch {
    return undefined;
  }
}

export async function registerMedia(input: RegisterMediaInput): Promise<MediaRecord> {
  const fullPath = resolve(input.filePath);
  const st = statSync(fullPath);
  if (!st.isFile()) throw new Error("Media path is not a file");

  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const mime = inferMime(fullPath, input.mime);
  const originalName = input.originalName || basename(fullPath);
  // Video gets a poster frame for the media grid (createThumbnail's ffmpeg
  // path reads the first frame); sharp simply fails on it first.
  const thumbPath = input.type === "image" || input.type === "video"
    ? await createThumbnail(input.userId, id, fullPath)
    : null;
  const durationSec = input.durationSec ?? (input.type === "audio" || input.type === "video"
    ? await probeDurationSec(fullPath)
    : undefined);

  const record: MediaRecord = {
    id,
    userId: input.userId,
    bot: input.bot,
    source: input.source,
    type: input.type,
    fileId: input.fileId,
    path: fullPath,
    originalName,
    mime,
    size: st.size,
    durationSec,
    transcript: input.transcript,
    thumbnail: Boolean(thumbPath),
    thumbPath: thumbPath || undefined,
    createdAt: new Date().toISOString(),
  };

  const records = loadIndex(input.userId);
  records.push(record);
  saveIndex(input.userId, records);
  return record;
}

export function mediaRef(record: MediaRecord): MediaRef {
  return publicRef(record);
}

export function resolveMedia(userId: string, id: string): MediaRecord | null {
  const record = loadIndex(userId).find((r) => r.id === id) || null;
  if (!record) return null;

  const resolvedPath = resolveStoredMediaPath(record.userId, record.path);
  if (!resolvedPath) return null;

  return { ...record, path: resolvedPath };
}

function isAllowedMediaPath(userId: string, filePath: string): boolean {
  const fullPath = resolve(filePath);
  const paths = multiUserPaths(userId);
  const allowedRoots = [paths.mediaRoot, paths.filesRoot].map((p) => resolve(p));
  return allowedRoots.some((root) => fullPath === root || fullPath.startsWith(root + "/"));
}

function resolveStoredMediaPath(userId: string, storedPath: string): string | null {
  const fullPath = resolve(storedPath);
  if (isAllowedMediaPath(userId, fullPath) && existsSync(fullPath)) return fullPath;

  const paths = multiUserPaths(userId);
  const escapedUser = userId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const legacyMatch = fullPath.match(new RegExp(`/business/${escapedUser}/(media|files)/(.+)$`));
  if (legacyMatch) {
    const [, bucket, rest] = legacyMatch;
    const root = bucket === "media" ? paths.mediaRoot : paths.filesRoot;
    const translated = resolve(root, ...rest.split(/[\\/]+/).filter(Boolean));
    if (isAllowedMediaPath(userId, translated) && existsSync(translated)) return translated;
  }

  console.warn(`[media] blocked or missing media path: ${fullPath}`);
  return null;
}

export async function saveTelegramMediaFile(
  userId: string,
  filename: string,
  data: Buffer,
  date = new Date(),
): Promise<string> {
  const dir = multiUserPaths(userId).mediaDir(date.toISOString().slice(0, 10));
  ensureDir(dir);
  const safeName = filename.replace(/[/\\]/g, "").replace(/^\.+/, "") || `${Date.now()}-${randomUUID()}`;
  const fullPath = join(dir, safeName);
  await writeFile(fullPath, data);
  return fullPath;
}

export function mediaDownloadName(record: MediaRecord): string {
  return basename(record.originalName || record.path).replace(/["\r\n]/g, "");
}

/**
 * A Content-Disposition that keeps the ORIGINAL filename and extension on
 * every browser: an ASCII `filename=` for old readers plus the RFC 5987
 * `filename*=` (UTF-8) that Chrome on Android uses to name the file in
 * Downloads. A raw non-Latin-1 name in a header is not just ugly — the
 * Response constructor throws on it.
 */
export function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const clean = basename(name || "file").replace(/[\r\n"\\/]/g, "").trim() || "file";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function mediaThumbPath(record: MediaRecord): string | null {
  if (!record.thumbPath) return null;
  const fullPath = resolve(record.thumbPath);
  const thumbRoot = resolve(join(dirname(mediaIndexPath(record.userId)), "thumbs"));
  if (fullPath !== thumbRoot && !fullPath.startsWith(thumbRoot + "/")) return null;
  return existsSync(fullPath) ? fullPath : null;
}
