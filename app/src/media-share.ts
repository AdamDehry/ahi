/**
 * Shareable voice notes.
 *
 * In the app a voice note stays OGG/Opus — that is what the player, Telegram
 * and the retrieval corpus all expect. But the owner shares notes with iPhone
 * people, and Ogg is not something iOS plays reliably outside WhatsApp. So
 * Share and Save in the PWA ask for an AAC .m4a copy instead: converted once
 * per note on first ask, cached beside the user's media, and served only
 * through the authenticated dashboard route.
 */
import { existsSync, readFileSync, renameSync, rmSync, statSync } from "fs";
import { createHash, randomUUID } from "crypto";
import { dirname, join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { ensureDir, multiUserPaths } from "./multi-user-paths.js";
import { resolveMedia, type MediaRecord } from "./media-store.js";

const execFileAsync = promisify(execFile);

export const SHARE_MIME = "audio/mp4";

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN || "ffmpeg";
}

/** One cache file per note. Media ids are generated, but a cache path is
 *  never built from an id that could carry a separator. */
export function shareCachePath(record: Pick<MediaRecord, "userId" | "id">): string {
  const name = /^[A-Za-z0-9._-]{1,120}$/.test(record.id) && !record.id.startsWith(".")
    ? record.id
    : createHash("sha256").update(record.id).digest("hex").slice(0, 40);
  return join(multiUserPaths(record.userId).mediaRoot, "share", `${name}.m4a`);
}

// Two taps (Share, then Save) on a note that isn't cached yet run ONE ffmpeg.
const inflight = new Map<string, Promise<string>>();

/**
 * Path to the note's AAC .m4a copy, converting on first ask. A copy older
 * than its source is rebuilt; a failed conversion leaves nothing behind.
 */
export function shareableVoicePath(record: MediaRecord): Promise<string> {
  const out = shareCachePath(record);
  if (existsSync(out)) {
    try {
      const cached = statSync(out);
      if (cached.size > 0 && cached.mtimeMs >= statSync(record.path).mtimeMs) return Promise.resolve(out);
    } catch {
      // fall through and rebuild
    }
  }
  let job = inflight.get(out);
  if (!job) {
    job = convert(record.path, out).finally(() => inflight.delete(out));
    inflight.set(out, job);
  }
  return job;
}

async function convert(input: string, out: string): Promise<string> {
  ensureDir(dirname(out));
  // Written beside the target and renamed in, so a reader never sees half a file.
  const tmp = `${out}.${randomUUID()}.part`;
  try {
    await execFileAsync(
      ffmpegBin(),
      [
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", input,
        "-vn",
        "-c:a", "aac", "-b:a", "64k", "-ar", "44100", "-ac", "1",
        "-movflags", "+faststart",
        "-f", "mp4",
        tmp,
      ],
      { timeout: 60_000 },
    );
    renameSync(tmp, out);
    return out;
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * GET /ui/media/:id/m4a for an authenticated user. Voice notes only; the
 * caller has already rejected an anonymous request.
 */
export async function voiceShareResponse(userId: string, id: string): Promise<Response> {
  const json = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });
  const record = resolveMedia(userId, id);
  if (!record || !existsSync(record.path)) return json(404, "Not found");
  if (record.type !== "voice") return json(415, "Not a voice note");
  let path: string;
  try {
    path = await shareableVoicePath(record);
  } catch (err) {
    console.warn(`[media] m4a conversion failed for ${record.id}: ${(err as Error).message}`);
    return json(500, "Couldn't convert that voice note");
  }
  const data = readFileSync(path);
  return new Response(data, {
    headers: {
      "Content-Type": SHARE_MIME,
      "Content-Length": String(data.length),
      "Content-Disposition": `attachment; filename="voice-note.m4a"`,
      "Cache-Control": "private, max-age=86400",
    },
  });
}
