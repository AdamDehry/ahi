/* ============================================================
   stt.ts — H-026 Phase 7
   Google Cloud Speech-to-Text client.

   Two paths:

     1. streamingRecognize(...)  — true interim+final streaming via
        gRPC. Used by the PWA's Voice Mode over the WebSocket; the
        gateway wraps each connected mic stream in one streaming
        recognizer and forwards partial results live.

        Auth: tries `apiKey` from GOOGLE_TTS_API_KEY first (same key
        already wired for Chirp 3 HD TTS — STT is enabled on the same
        project per the owner's 2026-04-20 confirmation). If the SDK
        rejects api-key auth for streaming (some gRPC targets require
        ADC), callers fall back to `transcribeShort` below.

     2. transcribeShort(...)     — one-shot REST `speech:recognize`.
        Used when streaming recognize isn't available or when the
        caller already has a full utterance buffer in hand. Returns
        only the final transcript (no interim).

   Audio format expected from the PWA:
     - LINEAR16 PCM, 16-bit, mono, 16000 Hz
     - frames arrive as raw binary (no WebM/OGG container)

   The PWA's audio.ts resamples from the browser's native
   mic rate (typically 44.1 or 48 kHz) to 16 kHz and emits raw s16le
   chunks. That's the only sample rate we promise here.
   ============================================================ */

import { SpeechClient } from "@google-cloud/speech";
import type { protos } from "@google-cloud/speech";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const RECOGNIZE_SAMPLE_RATE = 16000;
const RECOGNIZE_LANGUAGE = "en-US";

// ── Streaming client (gRPC) ───────────────────────────────────────────

let speechClient: SpeechClient | null = null;

/** Resolve auth source for streaming (gRPC) recognition.
 *
 * Priority:
 *   1. GOOGLE_APPLICATION_CREDENTIALS env var pointing to a service
 *      account JSON (the canonical Google SDK pattern — ADC picks it
 *      up transparently inside `new SpeechClient({})`).
 *   2. A service account JSON at `./.credentials/gcp-stt.json`
 *      relative to the gateway root — convenience path, auto-discovered
 *      so the owner can drop the file in and restart without touching env.
 *   3. An API key (GOOGLE_STT_API_KEY or GOOGLE_TTS_API_KEY). API keys
 *      do work over gRPC streaming in @google-cloud/speech v7, as long
 *      as we DON'T force `fallback: "rest"` (REST can't do bidi).
 *
 * The earlier code forced REST fallback, which silently disabled
 * streaming for every session — that's why interim transcripts were
 * dark. Removing the flag is the real fix; the service-account path
 * is a bonus for anyone who wants full ADC.
 */
function getSpeechClient(): SpeechClient {
  if (speechClient) return speechClient;

  // Path 1: explicit GOOGLE_APPLICATION_CREDENTIALS.
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.log("[stt] Using service account from GOOGLE_APPLICATION_CREDENTIALS");
    speechClient = new SpeechClient();
    return speechClient;
  }

  // Path 2: conventional .credentials/gcp-stt.json inside the gateway.
  const conventional = resolve(process.cwd(), ".credentials/gcp-stt.json");
  if (existsSync(conventional)) {
    console.log(`[stt] Using service account from ${conventional}`);
    speechClient = new SpeechClient({ keyFilename: conventional });
    return speechClient;
  }

  // Path 3: Application Default Credentials (gcloud auth application-default login).
  // Needs a quota project with the Speech-to-Text API enabled.
  // `new SpeechClient()` with no args auto-discovers ADC from
  // ~/.config/gcloud/application_default_credentials.json. This is the canonical
  // path for streaming gRPC because API-key auth has proven unreliable for
  // streamingRecognize (it silently never emitted interim hypotheses).
  const adcPath = resolve(homedir(), ".config/gcloud/application_default_credentials.json");
  if (existsSync(adcPath)) {
    console.log(`[stt] Using Application Default Credentials from ${adcPath}`);
    speechClient = new SpeechClient();
    return speechClient;
  }

  // Path 4: API key fallback (GOOGLE_STT_API_KEY preferred, TTS key as fallback).
  // Only reached if ADC isn't configured. Note: api-key auth has been observed
  // to disable streaming partial results — use ADC whenever possible.
  const apiKey = process.env.GOOGLE_STT_API_KEY || process.env.GOOGLE_TTS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "[stt] No credentials: run `gcloud auth application-default login`, set GOOGLE_APPLICATION_CREDENTIALS, drop a service account JSON at .credentials/gcp-stt.json, or set GOOGLE_STT_API_KEY / GOOGLE_TTS_API_KEY"
    );
  }
  console.log("[stt] Using API key auth (gRPC streaming) — ADC not found, interim results may not stream");
  speechClient = new SpeechClient({ apiKey });
  return speechClient;
}

/**
 * Begin a streaming recognition session. Returns handles to feed
 * audio chunks and close the stream.
 *
 * Events:
 *   - onInterim(text)  — partial transcript, may be revised
 *   - onFinal(text)    — finalized transcript; more may follow if the
 *                        user keeps talking (multi-utterance streams)
 *   - onError(err)     — stream died; caller should stop feeding audio
 *   - onEnd()          — stream closed cleanly
 */
export interface StreamingSttHandle {
  write(chunk: Buffer): void;
  end(): void;
  destroy(): void;
}

export interface StreamingSttCallbacks {
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (err: Error) => void;
  onEnd?: () => void;
}

export function startStreamingRecognize(
  cb: StreamingSttCallbacks
): StreamingSttHandle {
  const client = getSpeechClient();

  const request: protos.google.cloud.speech.v1.IStreamingRecognitionConfig = {
    config: {
      encoding:
        "LINEAR16" as unknown as protos.google.cloud.speech.v1.RecognitionConfig.AudioEncoding,
      sampleRateHertz: RECOGNIZE_SAMPLE_RATE,
      languageCode: RECOGNIZE_LANGUAGE,
      enableAutomaticPunctuation: true,
      model: "latest_short",
    },
    interimResults: true,
  };

  // NOTE: @google-cloud/speech v7 helpers.js#streamingRecognize is
  // special — it takes the streamingConfig as its first arg, auto-writes
  // the config frame on the first burst of data, and wraps each
  // subsequent write in `{ audioContent }` for you. Writing the config
  // manually OR wrapping audio in `{ audioContent }` ourselves causes
  // "Malordered Data Received. Expected audio_content none was set."
  // See node_modules/@google-cloud/speech/build/src/helpers.js:58-109.
  const stream = client
    .streamingRecognize(request)
    .on("error", (err: Error) => {
      console.error("[stt] streamingRecognize error:", err.message);
      cb.onError?.(err);
    })
    .on("data", (data: protos.google.cloud.speech.v1.IStreamingRecognizeResponse) => {
      // INSTRUMENTATION — prove whether Google is actually
      // emitting interim hypotheses at all. If this line never logs with
      // isFinal=false, the `latest_short` model isn't producing them and
      // we need to switch to a streaming-friendly model (e.g. "default"
      // or "latest_long") or use a Chirp recognizer.
      const rawResult = data.results?.[0];
      const rawAlt = rawResult?.alternatives?.[0];
      console.log(
        "[stt-raw] results:", data.results?.length ?? 0,
        "· isFinal:", rawResult?.isFinal ?? "n/a",
        "· stability:", rawResult?.stability ?? "n/a",
        "· transcript:", JSON.stringify((rawAlt?.transcript ?? "").slice(0, 80)),
      );
      const result = data.results?.[0];
      if (!result) return;
      const alt = result.alternatives?.[0];
      if (!alt?.transcript) return;
      if (result.isFinal) {
        console.log("[stt-final]", JSON.stringify(alt.transcript.trim().slice(0, 80)));
        cb.onFinal?.(alt.transcript.trim());
      } else {
        console.log("[stt-interim]", JSON.stringify(alt.transcript.trim().slice(0, 80)));
        cb.onInterim?.(alt.transcript.trim());
      }
    })
    .on("end", () => {
      cb.onEnd?.();
    });

  // NO manual config write — helpers.js auto-emits `{ streamingConfig }`
  // on the first data burst. And we write raw Buffers directly; the SDK's
  // PassThrough transform wraps each chunk as `{ audioContent }`.

  return {
    write(chunk: Buffer) {
      try {
        stream.write(chunk);
      } catch (err) {
        console.error("[stt] write after end:", (err as Error).message);
      }
    },
    end() {
      try {
        stream.end();
      } catch {
        /* noop */
      }
    },
    destroy() {
      try {
        stream.destroy();
      } catch {
        /* noop */
      }
    },
  };
}

// ── REST fallback — one-shot `speech:recognize` ───────────────────────
// Plain API-key HTTP, same key that TTS uses. Handy for environments
// where the streaming gRPC path won't authenticate.

const REST_RECOGNIZE_URL = "https://speech.googleapis.com/v1/speech:recognize";

export async function transcribeShort(
  pcm: Buffer,
  sampleRateHertz = RECOGNIZE_SAMPLE_RATE
): Promise<string> {
  const apiKey = process.env.GOOGLE_STT_API_KEY || process.env.GOOGLE_TTS_API_KEY;
  if (!apiKey) throw new Error("[stt] No GOOGLE_STT_API_KEY or GOOGLE_TTS_API_KEY");

  const res = await fetch(REST_RECOGNIZE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      config: {
        encoding: "LINEAR16",
        sampleRateHertz,
        languageCode: RECOGNIZE_LANGUAGE,
        enableAutomaticPunctuation: true,
        model: "latest_short",
      },
      audio: { content: pcm.toString("base64") },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[stt-rest] ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    results?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
  };
  const parts = (data.results ?? [])
    .map((r) => r.alternatives?.[0]?.transcript ?? "")
    .filter((s) => s.length > 0);
  return parts.join(" ").trim();
}
