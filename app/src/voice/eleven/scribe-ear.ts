/* ============================================================
   scribe-ear.ts — the side ear's recognizer: ElevenLabs Scribe, realtime.

   The side ear paints his words while he speaks (side.ts). Through 10/22 it
   rode the voice-mode recognizer, which since the Cartesia credits ran out is
   OpenAI's: a batch model whose "partials" are the utterance-so-far
   re-transcribed every 900 ms, a round trip behind. A short phrase is over
   before its first partial lands, so the line appeared a breath at a time
   (10/23 12:4x AM: "one breath-chunk at a time… like it used to").

   Scribe realtime streams: `partial_transcript` grows with the words (about
   one a second, measured 10/23), `committed_transcript` closes a segment at
   its own pause. The same 16 kHz PCM the ear already gets goes straight in.

   Display only, like the ear: partials → `onPartial`, commits → `onTurnEnd`.
   ElevenLabs' own final is still the line Michael answers; nothing here
   reaches a turn. The native call keeps its own recognizer (stt-select.ts).

   NO AUDIO IS NOT SILENCE (10/23 PM). ElevenLabs closes a realtime socket
   that stops receiving audio (`insufficient_audio_activity`, then a 1000
   close). MUTE stops every frame — the app sends none, side.ts drops any in
   flight — so the first mute of a call killed the ear for the rest of it
   (the owner's call at 16:44Z: lost 1.8 minutes in, ten minutes of nothing after).
   Their own `keepalive_interval_ms` only holds while audio streams. So once
   no frame has come for GAP_FILL_MS, the stream is fed zeroed frames of the
   size the app sends, at its cadence, until frames come again: silence,
   not absence. Zeros are not the room; nothing captured while muted is sent.
   Billed as audio — a muted minute costs what a spoken one does, inside the
   ~1 audio-minute per call-minute already budgeted. Anything that still
   closes the socket is a loss, and side.ts reopens it.
   ============================================================ */

import WebSocket from "ws";

import type { VoiceSttCallbacks } from "../stt-select.js";

const URL_BASE = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const MODEL = "scribe_v2_realtime";
const SAMPLE_RATE = 16000;
/** The segment closes after this much quiet (their range 0.3–3 s). */
const VAD_SILENCE_SECS = 0.8;
/** How long the open may take before the ear falls back. */
const OPEN_TIMEOUT_MS = 5_000;
/** ElevenLabs' own keepalive (their range 500–10000 ms); it rides on the audio, not instead of it. */
const KEEPALIVE_INTERVAL_MS = 5_000;
/** Silence starts once no frame has come for this long (a hiccup, or mute). */
const GAP_FILL_MS = 1_000;
/** The app's frame: 100 ms of 16 kHz s16le (elevenear.ts). The filler matches what was last fed. */
const FRAME_MS = 100;
const FRAME_BYTES = (SAMPLE_RATE * 2 * FRAME_MS) / 1000;
/** A message type that is a refusal or a fault, not words (`insufficient_audio_activity` was swallowed). */
const FAULT = /error|exceeded|throttled|limited|unaccepted|insufficient/;
/** A line with no letter or digit (Scribe sends a lone "-" on noise) is not his words. */
const SPOKEN = /[\p{L}\p{N}]/u;

/** The ear's recognizer: what side.ts needs of one. */
export interface EarStt {
  readonly provider: string;
  readonly supportsPartials: boolean;
  feed(frame: Buffer): void;
  /** Silence sent to hold the stream while no audio came (Scribe only). */
  readonly silentSec?: number;
  close(agent?: string): Promise<{ audioSec: number; credits: number; turns: number } | null>;
}

/** Test seam: the socket constructor. */
type SocketCtor = new (url: string, opts: { headers: Record<string, string> }) => WebSocket;
let Socket: SocketCtor = WebSocket as unknown as SocketCtor;
export function __setScribeSocketForTests(s: SocketCtor | null): void {
  Socket = s ?? (WebSocket as unknown as SocketCtor);
}

/**
 * Open a Scribe stream. Resolves once the session has started; rejects (and
 * the ear falls back) when the key is missing or the service refuses.
 */
export function openScribeEar(cb: VoiceSttCallbacks, apiKey = process.env.ELEVENLABS_API_KEY): Promise<EarStt> {
  if (!apiKey) return Promise.reject(new Error("no ElevenLabs key"));
  const q = new URLSearchParams({
    model_id: MODEL,
    audio_format: `pcm_${SAMPLE_RATE}`,
    commit_strategy: "vad",
    vad_silence_threshold_secs: String(VAD_SILENCE_SECS),
    language_code: "en",
    keepalive_interval_ms: String(KEEPALIVE_INTERVAL_MS),
  });
  const ws = new Socket(`${URL_BASE}?${q}`, { headers: { "xi-api-key": apiKey } });
  let bytes = 0;
  let commits = 0;
  let open = false;
  let closing = false;
  let lastPartial = "";
  let silentBytes = 0;
  let lastFedAt = 0;
  let frameBytes = FRAME_BYTES;
  const seen = new Set<string>();

  const sendChunk = (frame: Buffer): void => {
    bytes += frame.length;
    ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: frame.toString("base64"), commit: false, sample_rate: SAMPLE_RATE }));
  };
  // The gap filler: from the open on, every frame-time with no frame for
  // GAP_FILL_MS gets one frame of zeros. Stopped by any close, ours or theirs.
  let filler: NodeJS.Timeout | null = null;
  const stopFiller = (): void => {
    if (filler) clearInterval(filler);
    filler = null;
  };
  const startFiller = (): void => {
    lastFedAt = Date.now();
    filler = setInterval(() => {
      if (!open || closing || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastFedAt < GAP_FILL_MS) return;
      silentBytes += frameBytes;
      sendChunk(Buffer.alloc(frameBytes));
    }, FRAME_MS);
    filler.unref?.();
  };

  return new Promise<EarStt>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("scribe did not start in time"));
      closing = true;
      ws.terminate();
    }, OPEN_TIMEOUT_MS);
    timer.unref?.();

    const stt: EarStt = {
      provider: "scribe",
      supportsPartials: true,
      get silentSec() {
        return silentBytes / (SAMPLE_RATE * 2);
      },
      feed(frame) {
        if (!open || closing || ws.readyState !== WebSocket.OPEN) return;
        lastFedAt = Date.now();
        if (frame.length >= 2 && frame.length <= FRAME_BYTES * 4) frameBytes = frame.length - (frame.length % 2);
        sendChunk(frame);
      },
      async close() {
        closing = true;
        stopFiller();
        try {
          ws.close();
        } catch {
          /* already gone */
        }
        return { audioSec: bytes / (SAMPLE_RATE * 2), credits: 0, turns: commits };
      },
    };

    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      closing = true;
      reject(new Error(`scribe refused: http ${res.statusCode}`));
      // Listening for this makes the refused upgrade ours to drop (ws leaves
      // the request open otherwise); terminate aborts the handshake.
      ws.terminate();
    });
    ws.on("message", (raw) => {
      if (closing) return; // words queued behind our close are not painted
      let d: { message_type?: string; text?: string; error?: string; message?: string };
      try {
        d = JSON.parse(String(raw));
      } catch {
        return;
      }
      switch (d.message_type) {
        case "session_started":
          open = true;
          clearTimeout(timer);
          startFiller();
          resolve(stt);
          return;
        case "partial_transcript": {
          const text = (d.text ?? "").trim();
          if (SPOKEN.test(text) && text !== lastPartial) {
            lastPartial = text;
            cb.onPartial?.(text);
          }
          return;
        }
        case "committed_transcript": {
          lastPartial = "";
          const text = (d.text ?? "").trim();
          if (!SPOKEN.test(text)) return;
          commits++;
          cb.onTurnEnd?.(text, { sttMs: 0, turnDurMs: 0 } as never);
          return;
        }
        default:
          if (d.message_type && FAULT.test(d.message_type)) {
            const err = new Error(`scribe ${d.message_type}: ${String(d.error ?? d.message ?? "").slice(0, 100)}`);
            if (!open) {
              clearTimeout(timer);
              closing = true;
              reject(err);
              ws.terminate();
            } else cb.onError?.(err);
          } else if (d.message_type && !seen.has(d.message_type) && seen.size < 8) {
            // Named once per socket, so a new kind of message is visible in the log.
            seen.add(d.message_type);
            console.log(`[eleven-ear] scribe sent ${d.message_type.replace(/[^\w.-]/g, "").slice(0, 40)} (not handled)`);
          }
      }
    });
    ws.on("error", (err) => {
      if (!open) {
        clearTimeout(timer);
        closing = true;
        reject(err);
      } else cb.onError?.(err);
    });
    ws.on("close", (code) => {
      clearTimeout(timer);
      stopFiller();
      if (!open) {
        reject(new Error(`scribe closed before it started (${code})`));
        return;
      }
      if (!closing) cb.onLost?.(`scribe socket closed (${code})`);
    });
  });
}
