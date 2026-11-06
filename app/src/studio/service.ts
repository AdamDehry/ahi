/**
 * The live studio — jobs + cards + the call line, behind one
 * object the sentinel, the routes and the hint share.
 *
 *   Avi: [[studio_job: {...}]]       → startJob → working card now → engine
 *        in the background → the same card becomes the decision (or failure)
 *        → on a live call, one short spoken line: "They're in. Which cabin?"
 *   Avi: [[studio_decision: {...}]]  → postDecision → a decision card now,
 *        from files he already has (or a folder).
 *   The owner answers by voice, typing, a tap on an option (it arrives as
 *        "B — lantern left"), or by pasting a picture. Avi's next turn is told
 *        the open decision and its option files, so "B", "the second one" and
 *        a tap all resolve.
 *
 * Everything here is injected (users, broadcast, media, the call line), so
 * the tests and the preview run the real thing without a gateway.
 */
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { MessageEvent } from "../websocket.js";
import { buildOptions, cardEvent, recentDecisions, workingCard, type StoreMedia, type StudioCardMeta, type StudioCardUser } from "./cards.js";
import { checkSpec, listMedia, readLabels, StudioJobs, type StudioJob } from "./jobs.js";
import { isMediaFile, type StudioEngine } from "./engines.js";

export interface StudioUser extends StudioCardUser {
  agents: string[];
  admin?: boolean;
}

export interface StudioDeps {
  user(userId: string): StudioUser | null;
  broadcast(event: MessageEvent): void;
  broadcastUpdate(event: MessageEvent): void;
  storeMedia: StoreMedia;
  botLabel(bot: string): string;
  /** The user's thread with this agent (latest decision for the hint). */
  thread(bot: string, userId: string): MessageEvent[];
  /** May this user's agent use this file (refs, decision options)? */
  isAllowedPath(path: string, user: StudioUser): boolean;
  /** Agents with the studio (STUDIO_AGENTS). Another agent's studio lines are refused. */
  agents?(): string[];
  /** Say one line on this user's live call with this agent; false when there is none. */
  announce?(userId: string, bot: string, text: string): boolean;
  now?: () => Date;
  log?: (line: string) => void;
}

export type Outcome = { ok: true; job?: StudioJob; card?: StudioCardMeta } | { ok: false; error: string };

const MAX_NOTES = 4;
/** The plain refusal for a file the studio may not use. */
export const OUTSIDE = "that file is outside the folders the studio may use (his studio folder, the guides, the creative folders, his own uploads)";
const NUMBER_WORDS = ["", "one", "two", "three", "four"];

/** The line said on a call when a job lands. Short, his voice, no technical words. */
export function landedLine(job: StudioJob): string {
  if (job.status !== "done") return `That one didn't come back${job.error && !/[/\\]/.test(job.error) ? `: ${job.error.split(/[.;]/)[0]}` : ""}. Want me to run it again?`;
  const n = Math.min(job.files.length, 4);
  const head = n === 1 ? "It's in." : `They're in, ${NUMBER_WORDS[n]} to look at.`;
  return job.ask ? `${head} ${job.ask}` : `${head} Your call.`;
}

export class Studio {
  readonly jobs: StudioJobs;
  /** What went wrong with Avi's own studio lines, told on his next turn. */
  private readonly notes = new Map<string, string[]>();
  private readonly log: (line: string) => void;

  constructor(
    private readonly deps: StudioDeps,
    engines: Record<string, StudioEngine>,
    opts: { root: string; statePath: string | null; guidesDir: string },
  ) {
    this.log = deps.log ?? ((l) => console.log(`[studio] ${l}`));
    this.guidesDir = opts.guidesDir;
    this.root = resolve(opts.root);
    this.jobs = new StudioJobs({
      engines,
      root: this.root,
      statePath: opts.statePath,
      log: this.log,
      onStart: (job) => this.postWorking(job),
      onEnd: (job) => {
        this.land(job).catch((err) => this.log(`${job.id} card not updated: ${(err as Error).message}`));
      },
    });
  }

  readonly guidesDir: string;
  readonly root: string;

  /**
   * Jobs that were running when the gateway last stopped: their cards still
   * say "making". Turn each into the failure it is, and tell Avi once.
   * installStudio calls this after boot; never throws.
   */
  settleLost(): number {
    let n = 0;
    for (const job of this.jobs.takeRecoveredLost()) {
      const user = this.deps.user(job.userId);
      // It finished, but the gateway stopped before its card was posted or
      // updated: post it now (land() makes a new card when there was none).
      if (user && job.status === "done") {
        this.land(job).catch((err) => this.log(`${job.id} card not updated: ${(err as Error).message}`));
        n++;
        continue;
      }
      if (!user || !job.cardMessageId) {
        this.jobs.cardSettled(job.id);
        continue;
      }
      const engine = this.jobs.engines()[job.engine];
      const card: StudioCardMeta = {
        state: "failed",
        ask: job.ask || "",
        options: [],
        folder: job.outDir,
        jobId: job.id,
        engine: engine?.label ?? job.engine,
        n: job.n,
        error: "the gateway restarted while it ran",
        by: job.bot,
        at: this.now().toISOString(),
        startedAt: job.startedAt,
      };
      try {
        this.deps.broadcastUpdate(cardEvent({ bot: job.bot, user, byName: this.deps.botLabel(job.bot), card, messageId: job.cardMessageId }));
        this.note(job.userId, job.bot, `the job "${job.ask || job.prompt.slice(0, 60)}" was lost when the gateway restarted; run it again if it's still wanted`);
        this.jobs.cardSettled(job.id);
        n++;
      } catch (err) {
        this.log(`${job.id} lost card not updated: ${(err as Error).message}`);
      }
    }
    return n;
  }

  private key(userId: string, bot: string): string {
    return `${userId}/${bot}`;
  }

  note(userId: string, bot: string, text: string): void {
    const k = this.key(userId, bot);
    const list = [...(this.notes.get(k) ?? []), text].slice(-MAX_NOTES);
    this.notes.set(k, list);
    this.log(`note for ${k}: ${text}`);
  }

  /** The notes for this user's next turn with this agent (consumed). */
  takeNotes(userId: string, bot: string): string[] {
    const k = this.key(userId, bot);
    const list = this.notes.get(k) ?? [];
    this.notes.delete(k);
    return list;
  }

  private who(userId: string, bot: string): { ok: true; user: StudioUser } | { ok: false; error: string } {
    const user = this.deps.user(userId);
    if (!user) return { ok: false, error: `no such user: ${userId}` };
    if (!user.agents.includes(bot)) return { ok: false, error: `${user.name} does not have ${bot}` };
    if (this.deps.agents && !this.deps.agents().includes(bot)) return { ok: false, error: `${bot} does not have the studio` };
    return { ok: true, user };
  }

  /** Start a job from Avi's spec. Never throws. */
  startJob(userId: string, bot: string, raw: unknown): Outcome {
    const who = this.who(userId, bot);
    if (!who.ok) return who;
    const check = checkSpec(raw, this.jobs.engines());
    if (!check.ok) return check;
    for (const r of check.spec.refs ?? []) {
      if (!this.deps.isAllowedPath(r, who.user)) return { ok: false, error: `${OUTSIDE}: ${r}` };
    }
    const started = this.jobs.start(userId, bot, check.spec);
    return started.ok ? { ok: true, job: started.job } : started;
  }

  /** Put a decision up now, from files Avi already has. Never throws. */
  async postDecision(userId: string, bot: string, raw: unknown): Promise<Outcome> {
    const who = this.who(userId, bot);
    if (!who.ok) return who;
    const r = (raw && typeof raw === "object" ? raw : {}) as { ask?: unknown; options?: unknown; folder?: unknown; guide?: unknown; step?: unknown };
    const ask = typeof r.ask === "string" ? r.ask.trim().slice(0, 200) : "";
    if (!ask) return { ok: false, error: "a decision needs an ask (the question)" };
    const files: Array<{ path: string; label?: string }> = [];
    if (r.options !== undefined) {
      if (!Array.isArray(r.options)) return { ok: false, error: "options must be a list of {file, label}" };
      for (const o of r.options.slice(0, 4)) {
        const file = typeof o === "string" ? o : (o as { file?: unknown })?.file;
        const label = typeof (o as { label?: unknown })?.label === "string" ? String((o as { label: string }).label).trim().slice(0, 60) : undefined;
        if (typeof file !== "string" || !file.startsWith("/") || !existsSync(file) || !statSync(file).isFile()) return { ok: false, error: `option file not found: ${String(file)}` };
        if (!isMediaFile(basename(file))) return { ok: false, error: `an option must be a picture or a clip: ${file}` };
        if (!this.deps.isAllowedPath(file, who.user)) return { ok: false, error: `${OUTSIDE}: ${file}` };
        files.push({ path: resolve(file), ...(label ? { label } : {}) });
      }
    }
    let folder: string | undefined;
    let more = 0;
    if (typeof r.folder === "string" && r.folder.trim()) {
      folder = resolve(r.folder.trim());
      if (!existsSync(folder) || !statSync(folder).isDirectory()) return { ok: false, error: `folder not found: ${folder}` };
      if (!this.deps.isAllowedPath(folder, who.user)) return { ok: false, error: `${OUTSIDE}: ${folder}` };
      // Each file is checked itself (realpath): a link inside an allowed folder may point anywhere.
      const inFolder = listMedia(folder).filter((p) => this.deps.isAllowedPath(p, who.user));
      if (!files.length) files.push(...inFolder.slice(0, 4).map((path) => ({ path })));
      more = Math.max(0, inFolder.length - files.length);
    }
    if (!files.length) return { ok: false, error: "a decision needs options (files) or a folder with pictures" };
    const options = await buildOptions(userId, bot, files, this.deps.storeMedia, this.log);
    if (!options.length) return { ok: false, error: "none of the option files could be stored" };
    const card: StudioCardMeta = {
      state: "decision",
      ask,
      options,
      ...(more ? { more } : {}),
      ...(folder ? { folder } : {}),
      ...(typeof r.guide === "string" && r.guide ? { guide: r.guide.slice(0, 40) } : {}),
      ...(typeof r.step === "string" && r.step ? { step: r.step.slice(0, 60) } : {}),
      by: bot,
      at: this.now().toISOString(),
    };
    this.deps.broadcast(cardEvent({ bot, user: who.user, byName: this.deps.botLabel(bot), card }));
    return { ok: true, card };
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private postWorking(job: StudioJob): void {
    const user = this.deps.user(job.userId);
    if (!user) return;
    const engine = this.jobs.engines()[job.engine];
    const ev = cardEvent({ bot: job.bot, user, byName: this.deps.botLabel(job.bot), card: workingCard(job, engine?.label ?? job.engine, this.now()) });
    this.deps.broadcast(ev);
    // broadcast stamps meta.messageId (message-store ensureMessageId).
    if (ev.meta?.messageId) this.jobs.setCard(job.id, ev.meta.messageId);
  }

  /** A job ended: its card becomes the decision (or the failure), and a live call hears one line. */
  private async land(job: StudioJob): Promise<void> {
    const user = this.deps.user(job.userId);
    if (!user) return;
    const engine = this.jobs.engines()[job.engine];
    const labels = readLabels(job);
    const owner: StudioUser = { ...user };
    const files = job.files
      .map((path, i) => ({ path, ...(labels[i] ? { label: labels[i] } : {}) }))
      // A job's output is checked like any option: realpath inside the allowed folders.
      .filter((f) => this.deps.isAllowedPath(f.path, owner));
    const options = job.status === "done" ? await buildOptions(job.userId, job.bot, files, this.deps.storeMedia, this.log) : [];
    const ok = options.length > 0;
    const card: StudioCardMeta = {
      state: ok ? "decision" : "failed",
      ask: job.ask || (ok ? (options.length === 1 ? "Keep it?" : "Which one?") : ""),
      options,
      ...(job.files.length > options.length ? { more: job.files.length - options.length } : {}),
      folder: job.outDir,
      jobId: job.id,
      engine: engine?.label ?? job.engine,
      n: job.n,
      ...(job.guide ? { guide: job.guide } : {}),
      ...(job.step ? { step: job.step } : {}),
      ...(job.note ? { note: job.note } : {}),
      ...(!ok ? { error: job.error || "no pictures could be stored" } : {}),
      by: job.bot,
      at: this.now().toISOString(),
      startedAt: job.startedAt,
    };
    const ev = cardEvent({ bot: job.bot, user, byName: this.deps.botLabel(job.bot), card, messageId: job.cardMessageId });
    if (job.cardMessageId) this.deps.broadcastUpdate(ev);
    else this.deps.broadcast(ev);
    this.jobs.cardSettled(job.id);
    if (!ok && job.status === "done") job.error = card.error;
    const spoke = this.deps.announce?.(job.userId, job.bot, landedLine(ok ? job : { ...job, status: "failed" })) ?? false;
    if (spoke) this.log(`${job.id} announced on the live call`);
  }

  /** What the hint says about this user's studio right now. */
  state(userId: string, bot: string): { running: StudioJob[]; recent: StudioJob[]; decisions: ReturnType<typeof recentDecisions> } {
    const recent = this.jobs.recent(userId, bot, 6);
    let decisions: ReturnType<typeof recentDecisions> = [];
    try {
      decisions = recentDecisions(this.deps.thread(bot, userId).slice(-200), 3);
    } catch {
      /* no thread yet */
    }
    return { running: recent.filter((j) => j.status === "running"), recent: recent.filter((j) => j.status !== "running"), decisions };
  }
}
