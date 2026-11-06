import { sendVoiceControl } from "./voicebus";

/* ============================================================
   screenshare.ts — "look at my screen" on a call (desktop). Read-only.

   the owner taps SHARE on the call screen; the browser's own picker asks which
   screen, window or tab. While sharing, a frame is grabbed about once a
   second, downscaled to at most MAX_EDGE on its long side, and sent to the
   gateway as a JPEG — but only when the picture changed (a 32x18 thumbnail
   is compared), plus a heartbeat every HEARTBEAT_MS, so a still screen costs
   almost nothing on the wire. The gateway keeps only the latest frame, in
   memory, and hands it to the model with each call turn.

   Nothing is captured unless sharing is on. Nothing is stored here: one
   canvas, reused, overwritten each grab. Stopping (the app's STOP, the
   browser's own "Stop sharing", or the call ending) stops the capture track,
   tells the gateway, and the gateway drops the frame. No clicking or control
   of any kind exists on this path.

   SCREEN WATCH (10/30, src/voice/screen-watch.ts). Michael now sees the
   frames through what the owner says, not one at the end, so this side sends the
   moments that matter: a 48x27 thumbnail is checked every 250 ms against the
   last frame SENT; a big change (a click, a page change: 6%+ of the screen)
   goes out within ~300 ms, any smaller change (the pointer moving onto
   something, a hover) at most once a second, a still screen once per
   heartbeat. Each frame says how much changed and where (a box), how long
   ago it was grabbed, and carries a coarse 16x9 signature the gateway uses to
   drop near-duplicates. Clicks in other apps are invisible to a web page;
   the change they make on screen is what is caught.

   B5 (10/14): every share attempt carries a generation. Stopping — the STOP
   button, hang-up, unmount — bumps it even while the browser's picker is
   still open, so a picker accepted AFTER the call ended stops the tracks it
   was handed and installs nothing. Each control and frame also names the
   call it belongs to (`voiceStreamId`); the gateway drops any that do not
   match the live call on that socket.
   ============================================================ */

/** Long edge of a sent frame. Keeps text on a 1440p screen readable at ~1.4k tokens. */
const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.7;
/** How often the thumbnail is checked for change (cheap: a 48x27 draw). */
const CHECK_EVERY_MS = 250;
/** A small change (the pointer, a hover) is sent at most this often. */
const SMALL_EVERY_MS = 1000;
/** A big change (a click, a new page) is sent at most this often. */
const BIG_EVERY_MS = 300;
/** Send even an unchanged picture this often, so the gateway's copy is never stale. */
const HEARTBEAT_MS = 10_000;
/** An encode that has not called back by now is abandoned and capture goes on. */
const ENCODE_DEADLINE_MS = 5_000;
const THUMB_W = 48;
const THUMB_H = 27;
/** Per-cell gray difference (0-255) that counts as "changed" — a pointer crossing a cell clears it. */
const CELL_THRESHOLD = 10;
/** Share of cells changed that counts as a big change. */
const BIG_FRACTION = 0.06;

/** What changed between two gray thumbnails: the share of cells, and their box (normalized). */
export function diffThumbs(
  a: Uint8ClampedArray | null,
  b: Uint8ClampedArray,
  w = THUMB_W,
  h = THUMB_H,
): { fraction: number; region: [number, number, number, number] | null } {
  if (!a || a.length !== b.length) return { fraction: 1, region: null };
  let n = 0;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (Math.abs(a[i] - b[i]) < CELL_THRESHOLD) continue;
      n++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (!n) return { fraction: 0, region: null };
  const r = (v: number): number => Math.round(v * 1000) / 1000;
  return { fraction: r(n / (w * h)), region: [r(x0 / w), r(y0 / h), r((x1 + 1) / w), r((y1 + 1) / h)] };
}

/** A 16x9 signature, one hex digit (gray / 16) per cell, from the 48x27 gray thumbnail. */
export function signature(g: Uint8ClampedArray, w = THUMB_W, h = THUMB_H): string {
  const cw = w / 16;
  const ch = h / 9;
  let out = "";
  for (let cy = 0; cy < 9; cy++) {
    for (let cx = 0; cx < 16; cx++) {
      let sum = 0;
      let cnt = 0;
      for (let y = Math.floor(cy * ch); y < Math.floor((cy + 1) * ch); y++)
        for (let x = Math.floor(cx * cw); x < Math.floor((cx + 1) * cw); x++) {
          sum += g[y * w + x];
          cnt++;
        }
      out += Math.min(15, Math.floor(sum / Math.max(1, cnt) / 16)).toString(16);
    }
  }
  return out;
}

/** Gray values (one byte per pixel) from RGBA. */
function toGray(px: Uint8ClampedArray): Uint8ClampedArray {
  const g = new Uint8ClampedArray(px.length / 4);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) g[j] = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
  return g;
}

/**
 * Should this check send a frame? `force` = the first frame. Returns why, or
 * null to skip. Pure, for the tests.
 */
export function sendDecision(
  fraction: number,
  sinceSentMs: number,
  force = false,
): "first" | "big" | "change" | "heartbeat" | null {
  if (force) return "first";
  if (fraction >= BIG_FRACTION && sinceSentMs >= BIG_EVERY_MS) return "big";
  if (fraction > 0 && sinceSentMs >= SMALL_EVERY_MS) return "change";
  if (sinceSentMs >= HEARTBEAT_MS) return "heartbeat";
  return null;
}

export function canShareScreen(): boolean {
  const md = (globalThis.navigator as Navigator | undefined)?.mediaDevices as
    | (MediaDevices & { getDisplayMedia?: unknown })
    | undefined;
  return typeof md?.getDisplayMedia === "function";
}

interface Share {
  stream: MediaStream;
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  thumb: HTMLCanvasElement;
  lastThumb: Uint8ClampedArray | null;
  /** A frame is being encoded: one at a time, so frames leave in order and each "change" is against the one sent before it. */
  encoding: boolean;
  lastSentAt: number;
  timer: number;
  onEnded: () => void;
  /** The call this share belongs to; every message names it. */
  voiceStreamId: string;
}

let share: Share | null = null;
/** Bumped by every start and every stop: a pending picker from an older generation is void. */
let generation = 0;

export function isSharingScreen(): boolean {
  return share !== null;
}

/**
 * Open the browser's picker and start sharing. Resolves true once sharing,
 * false if he cancelled the picker or it failed. `onEnded` fires if sharing
 * stops from outside the app (the browser's own "Stop sharing" bar).
 */
export async function startScreenShare(bot: string, onEnded: () => void, voiceStreamId: string | null): Promise<boolean> {
  if (share) return true;
  if (!canShareScreen() || !voiceStreamId) return false;
  const mine = ++generation;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      // `cursor: "always"` draws the pointer into the frames where the
      // browser supports it — that is how "where's my mouse" is answered.
      video: { cursor: "always", frameRate: 5 } as MediaTrackConstraints,
      audio: false,
    });
  } catch {
    return false; // cancelled the picker, or denied
  }
  if (mine !== generation || share) {
    // The call ended (or sharing was stopped/restarted) while the picker was
    // open. What he picked is released at once, never sent.
    for (const t of stream.getTracks()) {
      try {
        t.stop();
      } catch {
        /* already stopped */
      }
    }
    return false;
  }

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  void video.play().catch(() => {});

  const s: Share = {
    stream,
    video,
    canvas: document.createElement("canvas"),
    thumb: document.createElement("canvas"),
    lastThumb: null,
    encoding: false,
    lastSentAt: 0,
    timer: 0,
    onEnded,
    voiceStreamId,
  };
  s.thumb.width = THUMB_W;
  s.thumb.height = THUMB_H;
  share = s;

  const track = stream.getVideoTracks()[0];
  track?.addEventListener("ended", () => {
    if (share !== s) return;
    stopScreenShare(bot);
    s.onEnded();
  });

  // What was shared: a whole screen or a window draws the pointer; a browser tab never does.
  let surface = "unknown";
  try {
    const set = (track as MediaStreamTrack | undefined)?.getSettings?.() as { displaySurface?: string } | undefined;
    if (set?.displaySurface) surface = set.displaySurface;
  } catch {
    /* older browsers: unknown */
  }
  sendVoiceControl({ type: "screen-share", bot, on: true, voiceStreamId, surface });
  s.timer = window.setInterval(() => grab(s, bot), CHECK_EVERY_MS);
  // First frame as soon as the video has one.
  window.setTimeout(() => grab(s, bot), 250);
  return true;
}

/** Stop sharing: release the capture, tell the gateway to drop its frame. */
export function stopScreenShare(bot: string): void {
  generation++; // a picker still open is now void
  const s = share;
  if (!s) return;
  share = null;
  window.clearInterval(s.timer);
  for (const t of s.stream.getTracks()) {
    try {
      t.stop();
    } catch {
      /* already stopped */
    }
  }
  s.video.srcObject = null;
  s.lastThumb = null;
  sendVoiceControl({ type: "screen-share", bot, on: false, voiceStreamId: s.voiceStreamId });
}

function grab(s: Share, bot: string): void {
  if (share !== s || s.encoding) return;
  const vw = s.video.videoWidth;
  const vh = s.video.videoHeight;
  if (!vw || !vh) return;

  // Change detection on a small gray thumbnail, against the last frame SENT.
  const tctx = s.thumb.getContext("2d", { willReadFrequently: true });
  if (!tctx) return;
  tctx.drawImage(s.video, 0, 0, s.thumb.width, s.thumb.height);
  const gray = toGray(tctx.getImageData(0, 0, s.thumb.width, s.thumb.height).data);
  const { fraction, region } = diffThumbs(s.lastThumb, gray);
  const now = Date.now();
  // The first picture goes out once, whichever timer reaches it first.
  const why = sendDecision(fraction, now - s.lastSentAt, !s.lastThumb);
  if (!why) return;
  const sig = signature(gray);

  const scale = Math.min(1, MAX_EDGE / Math.max(vw, vh));
  const w = Math.max(16, Math.round(vw * scale));
  const h = Math.max(16, Math.round(vh * scale));
  if (s.canvas.width !== w) s.canvas.width = w;
  if (s.canvas.height !== h) s.canvas.height = h;
  const ctx = s.canvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(s.video, 0, 0, w, h);
  const grabbedAt = now;
  // The baseline (what the next check compares against) moves only once this frame is actually sent
  // (Codex r1/r2): a failed, aborted or throwing encode releases the lock and leaves the last SENT
  // picture as the baseline. A share that stopped meanwhile is a new Share; this one's late callbacks
  // see `share !== s` and do nothing.
  s.encoding = true;
  let settled = false;
  // A browser that never calls back (a lost toBlob or read) must not stall capture: after 5 s the
  // lock is released and this frame's late callbacks are ignored (Codex r3).
  const deadline = window.setTimeout(() => release(false), ENCODE_DEADLINE_MS);
  const release = (sentOk: boolean): void => {
    if (settled) return;
    settled = true;
    window.clearTimeout(deadline);
    if (share !== s) return;
    if (sentOk) {
      s.lastThumb = gray;
      s.lastSentAt = grabbedAt;
    }
    s.encoding = false;
  };
  try {
    s.canvas.toBlob(
      (blob) => {
        if (settled) return;
        if (!blob || share !== s) return release(false);
        try {
          const reader = new FileReader();
          reader.onerror = () => release(false);
          reader.onabort = () => release(false);
          reader.onload = () => {
            if (settled) return;
            if (share !== s || typeof reader.result !== "string") return release(false);
            const data = reader.result.slice(reader.result.indexOf(",") + 1);
            try {
              sendVoiceControl({
                type: "screen-frame",
                bot,
                mime: "image/jpeg",
                data,
                width: w,
                height: h,
                voiceStreamId: s.voiceStreamId,
                why,
                change: why === "first" ? 1 : fraction,
                ...(region ? { region } : {}),
                sig,
                ageMs: Date.now() - grabbedAt,
              });
            } catch {
              return release(false);
            }
            release(true);
          };
          reader.readAsDataURL(blob);
        } catch {
          release(false);
        }
      },
      "image/jpeg",
      JPEG_QUALITY,
    );
  } catch {
    release(false);
  }
}
