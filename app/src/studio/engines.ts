/**
 * Live studio engines: what a studio job can run on.
 *
 *   nano-banana      fal.ai Nano Banana 2 (text → image, or an edit when refs are given)
 *   nano-banana-pro  fal.ai Nano Banana Pro (slower, higher quality)
 *   gpt-image        fal.ai GPT Image 2 (photoreal sheets, precise edits)
 *   avi              a background Avi turn with ALL his tools: Higgsfield MCP,
 *                    Seedance video, the video pipeline, Foreman. Whatever it
 *                    saves into the job's folder becomes the options.
 *   fixture          preview/tests ONLY (STUDIO_FIXTURE_DIR): copies pictures.
 *
 * The fal engines run IN the gateway: a fetch to fal's queue, a poll, a
 * download. The key is read from the gateway's own environment at call time
 * and never leaves this file (never logged, never put in a prompt, never in a
 * job record). No key → the engine reports itself unavailable and a job on
 * it is refused before it starts.
 *
 * Every engine writes its results into `outDir` and returns; the job runner
 * (jobs.ts) reads the folder, so "what the engine made" and "what the card
 * shows" are the same thing by construction.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import sharp from "sharp";
import type { StudioJob } from "./jobs.js";

export interface EngineContext {
  outDir: string;
  signal: AbortSignal;
  log: (line: string) => void;
}

export interface EngineResult {
  /** Words from the engine (the worker's closing line, a provider note). */
  note?: string;
}

export interface StudioEngine {
  name: string;
  /** Plain name for cards and Avi's hint ("Nano Banana"). */
  label: string;
  /** "image" engines make stills from a prompt; "worker" runs Avi with tools. */
  kind: "image" | "worker" | "fixture";
  /** Why it can't run right now, or null when it can. */
  unavailable(): string | null;
  /** Longest a job may run before it is stopped. */
  timeoutMs: number;
  run(job: StudioJob, ctx: EngineContext): Promise<EngineResult>;
}

export const MEDIA_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov", ".webm"]);
export const VIDEO_EXT = new Set([".mp4", ".mov", ".webm"]);

export function isMediaFile(name: string): boolean {
  return MEDIA_EXT.has(extname(name).toLowerCase()) && !name.startsWith(".");
}

// ── fal.ai ──────────────────────────────────────────────────────────────

export function falKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const k = (env.FAL_KEY || env.FAL_API_KEY || "").trim();
  return k || null;
}

/** The aspect words Avi may use, as each fal model spells them. */
const ASPECTS = ["21:9", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16"] as const;
export type Aspect = (typeof ASPECTS)[number];
export function isAspect(a: unknown): a is Aspect {
  return typeof a === "string" && (ASPECTS as readonly string[]).includes(a);
}
/** GPT Image 2 takes size presets, not ratios. */
function gptImageSize(a: Aspect | undefined): string {
  if (!a) return "auto";
  if (a === "1:1") return "square_hd";
  if (a === "4:3" || a === "3:2" || a === "5:4") return "landscape_4_3";
  if (a === "3:4" || a === "2:3" || a === "4:5") return "portrait_4_3";
  if (a === "9:16") return "portrait_16_9";
  return "landscape_16_9"; // 16:9 and 21:9
}

/** A reference picture as a data URI fal accepts: JPEG, long side ≤ 2048. */
export async function refDataUri(path: string): Promise<string> {
  const buf = await sharp(readFileSync(path)).rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

export interface FalModel {
  name: string;
  label: string;
  /** Text → image. */
  model: string;
  /** Image(s) + text → image. */
  editModel: string;
  /** The request body for this model. */
  body(job: StudioJob, imageUrls: string[]): Record<string, unknown>;
}

export const FAL_MODELS: FalModel[] = [
  {
    name: "nano-banana",
    label: "Nano Banana",
    model: "fal-ai/nano-banana-2",
    editModel: "fal-ai/nano-banana-2/edit",
    body: (job, urls) => ({ prompt: job.prompt, num_images: job.n, output_format: "png", ...(job.aspect ? { aspect_ratio: job.aspect } : {}), ...(urls.length ? { image_urls: urls } : {}) }),
  },
  {
    name: "nano-banana-pro",
    label: "Nano Banana Pro",
    model: "fal-ai/nano-banana-pro",
    editModel: "fal-ai/nano-banana-pro/edit",
    body: (job, urls) => ({ prompt: job.prompt, num_images: job.n, output_format: "png", ...(job.aspect ? { aspect_ratio: job.aspect } : {}), ...(urls.length ? { image_urls: urls } : {}) }),
  },
  {
    name: "gpt-image",
    label: "GPT Image 2",
    model: "openai/gpt-image-2",
    editModel: "openai/gpt-image-2/edit",
    body: (job, urls) => ({ prompt: job.prompt, num_images: job.n, quality: "high", image_size: gptImageSize(job.aspect), output_format: "png", ...(urls.length ? { image_urls: urls } : {}) }),
  },
];

type Fetch = typeof fetch;

const FAL_QUEUE = "https://queue.fal.run/";

const POLL_MS = 2_000;

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("stopped");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => (clearTimeout(t), reject(new Error("stopped")));
    const t = setTimeout(() => (signal.removeEventListener("abort", onAbort), resolve()), ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** fal's error body, in a sentence (never the request, never the key). */
function falError(status: number, body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  const msg = typeof detail === "string" ? detail : Array.isArray(detail) ? detail.map((d) => (d as { msg?: string })?.msg).filter(Boolean).join("; ") : "";
  // Not truncated here: the caller redacts the key from the WHOLE message first.
  return `fal answered ${status}${msg ? `: ${msg}` : ""}`;
}

export function falEngine(m: FalModel, deps: { fetch?: Fetch; env?: NodeJS.ProcessEnv; pollMs?: number } = {}): StudioEngine {
  const env = deps.env ?? process.env;
  return {
    name: m.name,
    label: m.label,
    kind: "image",
    timeoutMs: 6 * 60_000,
    unavailable: () => (falKey(env) ? null : "no fal key on this gateway"),
    async run(job, ctx) {
      const key = falKey(env);
      if (!key) throw new Error("no fal key on this gateway");
      try {
        return await runFal(job, ctx, key);
      } catch (err) {
        // Whatever fal (or fetch) said, the key never leaves this function.
        throw new Error(redactKey((err as Error).message, key).slice(0, 300));
      }
    },
  };

  async function runFal(job: StudioJob, ctx: EngineContext, key: string): Promise<EngineResult> {
    const f = deps.fetch ?? fetch;
    const headers = { Authorization: `Key ${key}`, "Content-Type": "application/json" };
    const urls: string[] = [];
    for (const r of job.refs ?? []) urls.push(await refDataUri(r));
    const model = urls.length ? m.editModel : m.model;
    ctx.log(`${model} ×${job.n}${urls.length ? ` with ${urls.length} reference(s)` : ""}`);
    const sub = await f(`${FAL_QUEUE}${model}`, { method: "POST", headers, body: JSON.stringify(m.body(job, urls)), signal: ctx.signal });
    const subBody = (await sub.json().catch(() => null)) as { status_url?: string; response_url?: string } | null;
    if (!sub.ok || !subBody?.status_url || !subBody.response_url) throw new Error(falError(sub.status, subBody));
    // The key rides on these two requests: only ever to fal's own queue.
    if (!subBody.status_url.startsWith(FAL_QUEUE) || !subBody.response_url.startsWith(FAL_QUEUE)) throw new Error("fal answered with an unexpected address");
    for (;;) {
      await sleep(deps.pollMs ?? POLL_MS, ctx.signal);
      const st = await f(subBody.status_url, { headers, signal: ctx.signal });
      const stBody = (await st.json().catch(() => null)) as { status?: string } | null;
      if (!st.ok && st.status !== 202) throw new Error(falError(st.status, stBody));
      if (stBody?.status === "COMPLETED") break;
      if (stBody?.status && !["IN_QUEUE", "IN_PROGRESS"].includes(stBody.status)) throw new Error(`fal job ${stBody.status.toLowerCase()}`);
    }
    const res = await f(subBody.response_url, { headers, signal: ctx.signal });
    const out = (await res.json().catch(() => null)) as { images?: Array<{ url?: string }>; video?: { url?: string }; description?: string } | null;
    if (!res.ok) throw new Error(falError(res.status, out));
    const files = [...(out?.images ?? []).map((i) => i.url), out?.video?.url].filter((u): u is string => typeof u === "string" && /^https:\/\//.test(u));
    if (!files.length) throw new Error("fal returned no pictures");
    let i = 0;
    for (const url of files) {
      const r = await f(url, { signal: ctx.signal });
      if (!r.ok) throw new Error(`download failed (${r.status})`);
      const type = r.headers.get("content-type") ?? "";
      const ext = type.includes("jpeg") ? ".jpg" : type.includes("webp") ? ".webp" : type.includes("mp4") ? ".mp4" : extname(new URL(url).pathname) || ".png";
      const declared = Number(r.headers.get("content-length") || 0);
      if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`a result is over ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB`);
      writeFileSync(join(ctx.outDir, `${String(++i).padStart(2, "0")}${ext}`), await readCapped(r, MAX_DOWNLOAD_BYTES));
    }
    return { note: typeof out?.description === "string" ? redactKey(out.description, key).slice(0, 300) : undefined };
  }
}

/** A response body, counted as it streams; stops at `max` bytes whatever the headers said. */
export async function readCapped(r: Response, max: number): Promise<Buffer> {
  if (!r.body) return Buffer.alloc(0);
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`a result is over ${Math.round(max / 1024 / 1024)} MB`);
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

/** Largest single result a fal job may download (a still is a few MB; a clip tens). */
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

/** The key, wherever it might appear in a message, replaced. */
export function redactKey(text: string, key: string): string {
  if (!key) return text;
  let out = text.split(key).join("[key]");
  // A "id:secret" key: neither half on its own either.
  for (const part of key.split(":")) if (part.length >= 8) out = out.split(part).join("[key]");
  return out;
}

// ── The worker: a background Avi with every tool ───────────────────────

export type RunWorker = (job: StudioJob, ctx: EngineContext) => Promise<{ text: string }>;

/** The instruction a worker turn receives. Exported for tests. */
export function workerMessage(job: StudioJob): string {
  return [
    `[STUDIO WORKER — background job ${job.id}]`,
    "You are Avi, running one studio job in the background while the conversation with the owner carries on elsewhere.",
    "Nobody reads this turn live. Do the job, then stop. Do not message the owner, do not post cards, do not ask questions: if a choice is needed, make the options and let the card ask.",
    `Save every result (pictures, clips, a contact sheet) into this folder, and nowhere else: ${job.outDir}`,
    `Make ${job.n} option${job.n === 1 ? "" : "s"} unless the job says otherwise. Name files so they sort in the order they should be shown (01-…, 02-…).`,
    job.refs?.length ? `References to use: ${job.refs.join(", ")}` : "",
    job.guide ? `Guide in force: ${job.guide}${job.step ? `, step ${job.step}` : ""}. Follow it.` : "",
    `Write ${job.outDir}/labels.json as a JSON array of short labels, one per file in order, if the options need names.`,
    "End with ONE short line: what you made, or why you could not.",
    "",
    "The job:",
    job.prompt,
  ]
    .filter(Boolean)
    .join("\n");
}

export function workerEngine(run: RunWorker | null): StudioEngine {
  return {
    name: "avi",
    label: "Avi (background, all tools)",
    kind: "worker",
    timeoutMs: 45 * 60_000,
    unavailable: () => (run ? null : "the background worker is not wired on this gateway"),
    async run(job, ctx) {
      if (!run) throw new Error("the background worker is not wired on this gateway");
      const r = await run(job, ctx);
      return { note: r.text.trim().split("\n").filter(Boolean).pop()?.slice(0, 300) };
    },
  };
}

// ── Fixture (preview and tests only) ───────────────────────────────────

export function fixtureEngine(dir: string, delayMs = 1_500): StudioEngine {
  return {
    name: "fixture",
    label: "Fixture",
    kind: "fixture",
    timeoutMs: 60_000,
    unavailable: () => (existsSync(dir) ? null : `fixture folder missing: ${dir}`),
    async run(job, ctx) {
      await sleep(delayMs, ctx.signal);
      const pics = readdirSync(dir).filter(isMediaFile).sort();
      if (!pics.length) throw new Error("fixture folder has no pictures");
      for (let i = 0; i < job.n; i++) {
        const src = pics[i % pics.length];
        copyFileSync(join(dir, src), join(ctx.outDir, `${String(i + 1).padStart(2, "0")}${extname(src)}`));
      }
      return {};
    },
  };
}
