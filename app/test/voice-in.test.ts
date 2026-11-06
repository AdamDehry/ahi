// Voice notes are transcribed with whichever listening key setup saved: OpenAI first, else Cartesia.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteTranscriber, transcribeAudio } from "../src/voice-in.js";

test("voice notes pick OpenAI, then Cartesia, else nothing", () => {
  assert.equal(noteTranscriber({ OPENAI_API_KEY: "o", CARTESIA_API_KEY: "c" }), "openai");
  assert.equal(noteTranscriber({ CARTESIA_API_KEY: "c" }), "cartesia");
  assert.equal(noteTranscriber({ ELEVENLABS_API_KEY: "e" }), null);
});

test("a Cartesia-only install transcribes a voice note through Cartesia's batch endpoint", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ text: "hello there", language: "en", duration: 1.2 }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await transcribeAudio(Buffer.from("OggS"), "audio/ogg", { env: { CARTESIA_API_KEY: "synthetic" }, fetchImpl });
  assert.deepEqual(r, { text: "hello there", language: "en", duration: 1.2 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://api.cartesia.ai/stt");
  assert.equal((seen[0].init.headers as Record<string, string>)["X-API-Key"], "synthetic");
  const form = seen[0].init.body as FormData;
  assert.equal(form.get("model"), "ink-whisper");
  assert.equal((form.get("file") as File).name, "voice.ogg");
});

test("a refused Cartesia call and a missing key are errors that say what to do", async () => {
  const fetchImpl = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(transcribeAudio(Buffer.from("x"), "audio/ogg", { env: { CARTESIA_API_KEY: "synthetic" }, fetchImpl }), /HTTP 401/);
  await assert.rejects(transcribeAudio(Buffer.from("x"), "audio/ogg", { env: {} }), /OpenAI or Cartesia key/);
});
