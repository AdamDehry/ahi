import { randomBytes } from "node:crypto";
import { closeSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/* ============================================================
   screen-frame.ts — "look at my screen" on a call (10/13). Read-only.

   While the owner shares a screen, window or tab from the call screen, the app
   sends a downscaled JPEG of it about once a second when it changes. The
   gateway keeps ONLY the latest one, in memory, on the live voice session;
   a call turn takes that frame and hands it to the main model as an image
   on that turn's prompt — inline, the same image content block a pasted
   image is, so the model sees it with no tool round trip.

   PRIVACY. Pixels are never written by the gateway: not to the message
   store, not to a file, not to a log. The one place they do land is the one
   the gateway does not own: the Claude CLI writes each turn, image included,
   to its session transcript under ~/.claude/projects. So the moment the turn
   ends, `scrubScreenFrames` rewrites that transcript with the image replaced
   by a one-line placeholder. The frame lives there only while the turn runs
   (seconds), and the next turn resumes a session that no longer carries it,
   so it is not re-sent and not re-billed either. Each frame carries a random
   nonce so the scrub touches exactly the blocks this path wrote, never an
   image the owner pasted into chat.
   ============================================================ */

export type ScreenFrameMime = "image/jpeg" | "image/webp" | "image/png";

export interface ScreenFrame {
  mime: ScreenFrameMime;
  data: Buffer;
  width: number;
  height: number;
  /** ms epoch the app captured it. */
  capturedAt: number;
  /**
   * What the model is told this image is, when it is not a live screen frame
   * (an image the owner dropped into the call, part six). Absent = screen frame.
   */
  label?: string;
}

/** Upper bound on one frame. A 1280x800 JPEG at q0.7 is ~60-200 kB. */
export const MAX_FRAME_BYTES = 1_500_000;
/** Longest edge the app is asked to send; the model downsizes past 1568 anyway. */
export const MAX_FRAME_EDGE = 1600;

const MIMES = new Set<ScreenFrameMime>(["image/jpeg", "image/webp", "image/png"]);

/** Validate an app-sent frame. Returns null for anything off-shape. */
export function parseScreenFrame(msg: Record<string, unknown>, now = Date.now()): ScreenFrame | null {
  const mime = msg.mime as ScreenFrameMime;
  if (!MIMES.has(mime)) return null;
  if (typeof msg.data !== "string" || msg.data.length === 0) return null;
  // base64 → bytes is ~3/4; reject before decoding anything large.
  if (msg.data.length > Math.ceil((MAX_FRAME_BYTES * 4) / 3) + 4) return null;
  const width = Number(msg.width);
  const height = Number(msg.height);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < 16 || height < 16 || width > MAX_FRAME_EDGE || height > MAX_FRAME_EDGE) return null;
  const data = Buffer.from(msg.data, "base64");
  if (data.length === 0 || data.length > MAX_FRAME_BYTES) return null;
  return { mime, data, width, height, capturedAt: now };
}

/**
 * Approximate input tokens for one image (Anthropic's published rule of
 * thumb: width x height / 750, after the model's own resize to a 1568 px
 * longest edge).
 */
export function estimateImageTokens(width: number, height: number): number {
  const scale = Math.min(1, 1568 / Math.max(width, height));
  return Math.ceil((width * scale * (height * scale)) / 750);
}

/**
 * Does this turn ask to look? Used only when the frame policy is "ask"; by
 * default every turn while sharing carries the frame (see framePolicy).
 */
export function asksToLook(text: string): boolean {
  return /\b(look|looking|see|seeing|screen|tab|tabs|window|showing|on (?:my|the) (?:screen|monitor)|this page|read (?:this|that|it)|what(?:'s| is) (?:this|that|here)|mouse|cursor|pointer|click(?:ing)?)\b/i.test(
    text,
  );
}

/** `every` (default): each turn while sharing. `ask`: only turns that ask to look. */
export function framePolicy(env: NodeJS.ProcessEnv = process.env): "every" | "ask" {
  return (env.CALL_SCREEN_FRAMES ?? "").toLowerCase() === "ask" ? "ask" : "every";
}

/** A random tag that marks this path's image blocks for the scrub. */
export function newFrameNonce(): string {
  return `sf-${randomBytes(6).toString("hex")}`;
}

/** The note the model reads next to the frame. Text only, no pixels. */
export function screenFrameNote(frame: ScreenFrame, nonce: string, now = Date.now(), userName = "the owner"): string {
  const [his] = userName === "the owner" ? ["his"] : ["their"];
  const age = Math.max(0, Math.round((now - frame.capturedAt) / 1000));
  return (
    `[${userName} is sharing ${his} screen with you on this call (screen-frame ${nonce}). ` +
    `The image above is what it shows right now (${frame.width}x${frame.height}, captured ${age}s ago; ` +
    `${his} mouse pointer is drawn in it when the browser includes it). Use it if it helps answer; you can only look, not click.]`
  );
}

/**
 * One stream-json user message for `claude -p --input-format stream-json`:
 * the images first, then the note, then what he said.
 */
export function streamJsonUserMessage(
  text: string,
  images: Array<{ frame: ScreenFrame; nonce: string }>,
  userName = "the owner",
): string {
  const content: Array<Record<string, unknown>> = [];
  for (const { frame, nonce } of images) {
    content.push({ type: "image", source: { type: "base64", media_type: frame.mime, data: frame.data.toString("base64") } });
    content.push({ type: "text", text: frame.label ? `[${frame.label} (image ${nonce})]` : screenFrameNote(frame, nonce, Date.now(), userName) });
  }
  content.push({ type: "text", text });
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

export const SCRUBBED_FRAME_TEXT = "[Screen frame shown on this turn; not kept.]";

/** Where the CLI keeps session transcripts. */
export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

/**
 * Replace every image block this path wrote (found by its nonce) with a text
 * placeholder, in every session transcript that holds one. Looks at the
 * named sessions first, then any transcript touched in the last
 * `recentMs` (a turn that died before reporting its session id still wrote
 * one). Synchronous on purpose: nothing else on the gateway's event loop can
 * start the next turn — and append to the same file — between the read and
 * the rename. Returns how many images it removed.
 */
export function scrubScreenFrames(
  nonces: string[],
  opts: { sessionIds?: Array<string | null | undefined>; projectsDir?: string; recentMs?: number; now?: number } = {},
): { files: number; images: number } {
  const root = opts.projectsDir ?? claudeProjectsDir();
  const now = opts.now ?? Date.now();
  const recentMs = opts.recentMs ?? 15 * 60_000;
  const wanted = new Set((opts.sessionIds ?? []).filter((x): x is string => !!x).map((id) => `${id}.jsonl`));
  const candidates: string[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return { files: 0, images: 0 };
  }
  for (const d of dirs) {
    const dir = join(root, d);
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const n of names) {
      const p = join(dir, n);
      if (wanted.has(n)) {
        candidates.push(p);
        continue;
      }
      try {
        if (now - statSync(p).mtimeMs <= recentMs) candidates.push(p);
      } catch {
        /* vanished */
      }
    }
  }

  let files = 0;
  let images = 0;
  for (const p of candidates) {
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    if (!nonces.some((n) => raw.includes(n))) continue;
    let removed = 0;
    const lines = raw.split("\n").map((line) => {
      if (!line || !nonces.some((n) => line.includes(n))) return line;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const hit = scrubValue(obj, nonces);
        if (hit === 0) return line;
        removed += hit;
        return JSON.stringify(obj);
      } catch {
        return line;
      }
    });
    if (removed === 0) continue;
    const tmp = `${p}.scrub-${process.pid}`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, lines.join("\n"));
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, p);
    files++;
    images += removed;
  }
  return { files, images };
}

/**
 * Walk a transcript entry; in any content array that carries one of our
 * nonces, replace its image blocks with the placeholder. Returns the count.
 */
function scrubValue(v: unknown, nonces: string[]): number {
  if (Array.isArray(v)) {
    const ours = v.some(
      (b) => b && typeof b === "object" && (b as { type?: string }).type === "text" &&
        nonces.some((n) => String((b as { text?: unknown }).text ?? "").includes(n)),
    );
    let count = 0;
    if (ours) {
      for (let i = 0; i < v.length; i++) {
        const b = v[i] as { type?: string } | null;
        if (b && typeof b === "object" && b.type === "image") {
          v[i] = { type: "text", text: SCRUBBED_FRAME_TEXT };
          count++;
        }
      }
    }
    for (const item of v) count += scrubValue(item, nonces);
    return count;
  }
  if (v && typeof v === "object") {
    let count = 0;
    for (const val of Object.values(v as Record<string, unknown>)) count += scrubValue(val, nonces);
    return count;
  }
  return 0;
}
