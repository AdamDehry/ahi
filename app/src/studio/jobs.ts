/**
 * Live studio jobs: Avi starts a generation from his chat or a
 * call, keeps talking, and the result comes back as a decision card.
 *
 * A job is one engine run (engines.ts) into its own folder:
 *   <STUDIO_ROOT>/<user>/<yyyy-mm-dd>/<hhmmss>-<slug>-<id>/
 * The folder IS the result: whatever media is in it when the engine returns
 * becomes the card's options, in name order (labels.json may name them).
 *
 * Rails:
 *   - at most MAX_RUNNING jobs running per user (the rest are refused, and
 *     Avi is told on his next turn);
 *   - 1–4 options per job (a decision card shows 2–4);
 *   - each engine has a timeout; a stopped job is "failed", never hung;
 *   - a gateway restart kills running jobs: they come back as "lost" and Avi
 *     is told, so he never waits on a job that cannot finish.
 *
 * State: one JSON file this process alone rewrites (studio-jobs.json in the
 * gateway state dir). Nothing else writes it — the same single-writer rule
 * as the message store.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isAspect, isMediaFile, type Aspect, type StudioEngine } from "./engines.js";

export const MAX_RUNNING = 3;
/**
 * Background-Avi (worker) jobs running at once, gateway-wide. Each one holds
 * one of the gateway's few global `claude` spawn slots (concurrency.ts, 3 by
 * default) for as long as it runs, so more would starve chat and calls.
 */
export function maxWorkers(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.STUDIO_MAX_WORKERS);
  return Number.isInteger(n) && n >= 0 ? n : 1;
}
export const MAX_OPTIONS = 4;
export const MAX_PROMPT_CHARS = 12_000;
export const MAX_REFS = 8;
const KEEP_JOBS = 200;

export type JobStatus = "running" | "done" | "failed" | "lost";

export interface StudioJobSpec {
  engine: string;
  prompt: string;
  /** How many options to make (1–4). */
  n: number;
  /** The question the card asks when it lands ("Which cabin?"). */
  ask?: string;
  /** Names for the options, in order. */
  labels?: string[];
  /** Absolute paths of reference pictures. */
  refs?: string[];
  aspect?: Aspect;
  /** The guide in force ("film") and the step ("2-assets"). */
  guide?: string;
  step?: string;
}

export interface StudioJob extends StudioJobSpec {
  id: string;
  userId: string;
  bot: string;
  status: JobStatus;
  startedAt: string;
  endedAt?: string;
  outDir: string;
  /** Media files the job produced, absolute, in show order. */
  files: string[];
  note?: string;
  error?: string;
  /** The card that tracks this job in the chat. */
  cardMessageId?: string;
  /** Ended, but its card has not been updated yet (survives a restart; settled at boot). */
  pendingCard?: boolean;
}

export type SpecCheck = { ok: true; spec: StudioJobSpec } | { ok: false; error: string };

const clean = (s: unknown, max: number): string => (typeof s === "string" ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max) : "");

/** Validate what Avi asked for (from a sentinel or the service route). */
export function checkSpec(raw: unknown, engines: Record<string, StudioEngine>): SpecCheck {
  if (!raw || typeof raw !== "object") return { ok: false, error: "the job must be a JSON object" };
  const r = raw as Record<string, unknown>;
  const engine = clean(r.engine, 40).toLowerCase();
  const e = engines[engine];
  if (!e) return { ok: false, error: `unknown engine "${engine}" (use: ${Object.keys(engines).filter((k) => k !== "fixture").join(", ")})` };
  const why = e.unavailable();
  if (why) return { ok: false, error: `${e.label} is off: ${why}` };
  const prompt = clean(r.prompt, MAX_PROMPT_CHARS);
  if (!prompt) return { ok: false, error: "a prompt is required" };
  const n = Number(r.n ?? MAX_OPTIONS);
  if (!Number.isInteger(n) || n < 1 || n > MAX_OPTIONS) return { ok: false, error: `n must be 1–${MAX_OPTIONS}` };
  const refs: string[] = [];
  if (r.refs !== undefined) {
    if (!Array.isArray(r.refs)) return { ok: false, error: "refs must be a list of absolute paths" };
    if (r.refs.length > MAX_REFS) return { ok: false, error: `at most ${MAX_REFS} refs` };
    for (const p of r.refs) {
      const path = clean(p, 1000);
      if (!path.startsWith("/") || !existsSync(path)) return { ok: false, error: `ref not found: ${path || String(p)}` };
      if (!/\.(png|jpe?g|webp|gif|heic|heif)$/i.test(path)) return { ok: false, error: `a ref must be a picture: ${path}` };
      refs.push(resolve(path));
    }
  }
  if (r.aspect !== undefined && !isAspect(r.aspect)) return { ok: false, error: `aspect must be one of 21:9, 16:9, 3:2, 4:3, 1:1, 3:4, 2:3, 9:16` };
  const labels = Array.isArray(r.labels) ? r.labels.map((l) => clean(typeof l === "number" ? String(l) : l, 60)).filter(Boolean).slice(0, MAX_OPTIONS) : undefined;
  return {
    ok: true,
    spec: {
      engine,
      prompt,
      n,
      ...(clean(r.ask, 200) ? { ask: clean(r.ask, 200) } : {}),
      ...(labels?.length ? { labels } : {}),
      ...(refs.length ? { refs } : {}),
      ...(isAspect(r.aspect) ? { aspect: r.aspect } : {}),
      ...(clean(r.guide, 40) ? { guide: clean(r.guide, 40) } : {}),
      ...(clean(r.step, 60) ? { step: clean(r.step, 60) } : {}),
    },
  };
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "job";
}

/** Media in a job folder, in show order. */
export function listMedia(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(isMediaFile)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => join(dir, f));
}

/** listMedia that never throws (a folder that vanished = nothing made). */
function safeList(dir: string): string[] {
  try {
    return listMedia(dir);
  } catch {
    return [];
  }
}

/** labels.json in the folder (a worker may write one), else the spec's. */
export function readLabels(job: Pick<StudioJob, "outDir" | "labels">): string[] {
  try {
    const p = join(job.outDir, "labels.json");
    if (existsSync(p)) {
      const v = JSON.parse(readFileSync(p, "utf8"));
      if (Array.isArray(v)) return v.map((l) => clean(l, 60));
    }
  } catch {
    /* a bad labels file falls back to the spec */
  }
  return job.labels ?? [];
}

export interface StudioJobsDeps {
  engines: Record<string, StudioEngine>;
  /** Where job folders go (per user under it). */
  root: string;
  /** The state file, or null for in-memory (tests). */
  statePath: string | null;
  now?: () => number;
  /** The job just started (post its working card). Never throws. */
  onStart?: (job: StudioJob) => void;
  /** The job ended, however it ended. Never throws. */
  onEnd?: (job: StudioJob) => void;
  log?: (line: string) => void;
}

export class StudioJobs {
  private readonly jobs: StudioJob[] = [];
  /** Running at the last stop, marked lost at load; their cards still need settling. */
  private recoveredLost: StudioJob[] = [];
  private readonly aborts = new Map<string, AbortController>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: StudioJobsDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((l) => console.log(`[studio] ${l}`));
    this.load();
  }

  engines(): Record<string, StudioEngine> {
    return this.deps.engines;
  }

  private load(): void {
    const p = this.deps.statePath;
    if (!p || !existsSync(p)) return;
    try {
      const saved = JSON.parse(readFileSync(p, "utf8")) as StudioJob[];
      if (!Array.isArray(saved)) return;
      let lost = 0;
      for (const j of saved) {
        // A job that was running when the gateway stopped cannot finish now.
        if (j.status === "running") {
          j.status = "lost";
          j.endedAt = new Date(this.now()).toISOString();
          j.error = "the gateway restarted while it ran";
          j.pendingCard = true;
          lost++;
        }
        // Lost now, or ended but stopped before its card was updated.
        if (j.pendingCard) this.recoveredLost.push(j);
        this.jobs.push(j);
      }
      if (lost) {
        this.log(`${lost} job(s) were running at the last stop and are marked lost`);
        this.save();
      }
    } catch (err) {
      this.log(`state unreadable, starting empty: ${(err as Error).message}`);
    }
  }

  private save(): void {
    // One retained set for memory and disk: every running or unsettled job,
    // plus the newest KEEP_JOBS of the rest.
    const keep = new Set(this.jobs.filter((j) => j.status === "running" || j.pendingCard));
    for (const j of this.jobs.filter((x) => !keep.has(x)).slice(-KEEP_JOBS)) keep.add(j);
    if (keep.size < this.jobs.length) {
      const kept = this.jobs.filter((j) => keep.has(j));
      this.jobs.length = 0;
      this.jobs.push(...kept);
    }
    const p = this.deps.statePath;
    if (!p) return;
    try {
      mkdirSync(dirname(p), { recursive: true });
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.jobs, null, 1));
      renameSync(tmp, p);
    } catch (err) {
      this.log(`state save failed: ${(err as Error).message}`);
    }
  }

  /** The jobs lost at the last stop (once). */
  takeRecoveredLost(): StudioJob[] {
    const out = this.recoveredLost;
    this.recoveredLost = [];
    return out;
  }

  get(id: string): StudioJob | null {
    return this.jobs.find((j) => j.id === id) ?? null;
  }

  /** This user's jobs with this agent, newest first. */
  recent(userId: string, bot: string, limit = 8): StudioJob[] {
    return this.jobs.filter((j) => j.userId === userId && j.bot === bot).slice(-limit).reverse();
  }

  running(userId: string): StudioJob[] {
    return this.jobs.filter((j) => j.userId === userId && j.status === "running");
  }

  /** The job's card now shows how it ended. */
  cardSettled(id: string): void {
    const j = this.get(id);
    if (j?.pendingCard) {
      delete j.pendingCard;
      this.save();
    }
  }

  /** Remember the card that tracks a job (set by the card poster). */
  setCard(id: string, messageId: string): void {
    const j = this.get(id);
    if (j) {
      j.cardMessageId = messageId;
      this.save();
    }
  }

  /** Start a job. Returns at once; the engine runs in the background. */
  start(userId: string, bot: string, spec: StudioJobSpec): { ok: true; job: StudioJob } | { ok: false; error: string } {
    const engine = this.deps.engines[spec.engine];
    if (!engine) return { ok: false, error: `unknown engine "${spec.engine}"` };
    const why = engine.unavailable();
    if (why) return { ok: false, error: `${engine.label} is off: ${why}` };
    if (this.running(userId).length >= MAX_RUNNING) return { ok: false, error: `${MAX_RUNNING} jobs are already running; wait for one to land` };
    if (engine.kind === "worker") {
      const busy = this.jobs.filter((j) => j.status === "running" && this.deps.engines[j.engine]?.kind === "worker").length;
      if (busy >= maxWorkers()) return { ok: false, error: `a background Avi job is already running (at most ${maxWorkers()} at a time); use an image engine, or wait for it to land` };
    }
    const at = new Date(this.now());
    const id = `sj-${at.getTime().toString(36)}-${randomUUID().slice(0, 4)}`;
    const day = at.toISOString().slice(0, 10);
    const hms = at.toISOString().slice(11, 19).replace(/:/g, "");
    const outDir = join(this.deps.root, userId, day, `${hms}-${slugify(spec.ask || spec.prompt)}-${id.slice(-4)}`);
    try {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "job.json"), JSON.stringify({ id, engine: spec.engine, n: spec.n, ask: spec.ask, labels: spec.labels, refs: spec.refs, aspect: spec.aspect, guide: spec.guide, step: spec.step, startedAt: at.toISOString() }, null, 1));
      writeFileSync(join(outDir, "prompt.txt"), spec.prompt + "\n");
    } catch (err) {
      return { ok: false, error: `could not make the job folder: ${(err as Error).message}` };
    }
    const job: StudioJob = { ...spec, id, userId, bot, status: "running", startedAt: at.toISOString(), outDir, files: [] };
    this.jobs.push(job);
    this.save();
    this.log(`${id} started: ${engine.label} ×${spec.n} for ${userId}/${bot} → ${outDir}`);
    try {
      this.deps.onStart?.(job);
    } catch (err) {
      this.log(`${id} start hook failed: ${(err as Error).message}`);
    }
    this.runJob(job, engine).catch((err) => this.log(`${job.id} runner failed: ${(err as Error).message}`));
    return { ok: true, job };
  }

  /** Stop a running job (the owner: "drop that one"). */
  cancel(id: string): boolean {
    const a = this.aborts.get(id);
    if (!a) return false;
    a.abort();
    return true;
  }

  private async runJob(job: StudioJob, engine: StudioEngine): Promise<void> {
    const ac = new AbortController();
    this.aborts.set(job.id, ac);
    const timer = setTimeout(() => ac.abort(), engine.timeoutMs);
    timer.unref?.();
    const t0 = this.now();
    try {
      const r = await engine.run(job, { outDir: job.outDir, signal: ac.signal, log: (l) => this.log(`${job.id} ${l}`) });
      job.files = safeList(job.outDir);
      job.note = r.note;
      if (job.files.length) job.status = "done";
      else {
        job.status = "failed";
        job.error = r.note ? `nothing was saved (${r.note})` : "nothing was saved";
      }
    } catch (err) {
      job.files = safeList(job.outDir);
      job.status = job.files.length ? "done" : "failed";
      const msg = ac.signal.aborted ? (this.now() - t0 >= engine.timeoutMs - 50 ? `stopped after ${Math.round(engine.timeoutMs / 60_000)} minutes` : "stopped") : (err as Error).message;
      if (job.status === "failed") job.error = msg;
      else job.note = `${job.note ? `${job.note} · ` : ""}partial: ${msg}`;
    } finally {
      clearTimeout(timer);
      this.aborts.delete(job.id);
    }
    job.endedAt = new Date(this.now()).toISOString();
    job.pendingCard = true;
    this.save();
    this.log(`${job.id} ${job.status} in ${Math.round((this.now() - t0) / 1000)} s: ${job.files.length} file(s)${job.error ? ` — ${job.error}` : ""}`);
    try {
      this.deps.onEnd?.(job);
    } catch (err) {
      this.log(`${job.id} end hook failed: ${(err as Error).message}`);
    }
  }
}
