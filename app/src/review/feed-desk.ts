/**
 * feed-desk.ts — the Feed's one object: reads every source through the review
 * desk, derives the list (feed.ts), holds the launch ledger and the registry,
 * and performs the owner's four actions — Start (passkey), ask for a brief, close,
 * file under a track. Side effects (the runner, the wake to Michael) are
 * injected, so the whole thing runs in tests with no gateway and no systemd.
 *
 * It never writes a foreman file: the launch script does the launching, the
 * ledger stays the foreman's, and HOLD files, briefs and the idea vault are
 * read only.
 */
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { atomicWriteJson } from "../multi-user-paths.js";
import { scanBriefs, type BriefFile } from "./brief-header.js";
import type { ReviewDesk } from "./desk.js";
import { deriveFeed, foldRegistry, type FeedRegistryRow, type FeedRow, type FeedView, type HoldFile } from "./feed.js";
import { readIdeas, type IdeasRead } from "./ideas.js";
import { readBuilds, type BuildSummary } from "./ledger.js";
import { LaunchLedger, defaultRunner, type LaunchEntry, type Runner } from "./launches.js";
import { restrictionAt } from "./sacred-time.js";
import { humanize } from "./builds.js";
import type { LogRecord, PasskeyEvidence } from "./types.js";

export interface FeedDeskOptions {
  desk: ReviewDesk;
  /** The review state root (launches.json, feed.json live beside items.json). */
  root: string;
  now?: () => Date;
  foremanBuildsDir: string | null;
  /** foreman/briefs — every *.md with a valid header can be started. */
  briefsDir: string | null;
  /** ~/AHI/personal/creative/ideas-future-build/IDEAS.md */
  ideasPath: string | null;
  /** foreman/bin/build_from_brief.sh and the foreman root it runs in. */
  launchScript: string;
  foremanRoot: string;
  /** FEED_SLOT_CAP — build_start's FM_CAP, default 5. */
  cap?: number;
  runner?: Runner;
  /** Michael's quiet wake (the review desk's waker). Rejects when the turn failed. */
  wake?: (owner: string, text: string) => Promise<void>;
}

export type FeedError = { ok: false; status: 400 | 403 | 404 | 409 | 422 | 503; code: string; reason: string };

interface FeedFile {
  version: 1;
  rows: FeedRegistryRow[];
}

export class FeedDesk {
  readonly launches: LaunchLedger;
  private readonly desk: ReviewDesk;
  private readonly clock: () => Date;
  private readonly opts: FeedDeskOptions;
  private registry: FeedRegistryRow[];
  private runner: Runner;
  private wakeFn: FeedDeskOptions["wake"] | null;

  constructor(opts: FeedDeskOptions) {
    this.opts = opts;
    this.desk = opts.desk;
    this.clock = opts.now ?? (() => new Date());
    this.launches = new LaunchLedger(opts.root);
    this.registry = this.readRegistry();
    this.runner = opts.runner ?? defaultRunner;
    this.wakeFn = opts.wake ?? null;
  }

  setWaker(fn: FeedDeskOptions["wake"] | null): void {
    this.wakeFn = fn ?? null;
  }

  private get registryPath(): string {
    return join(this.opts.root, "feed.json");
  }

  private readRegistry(): FeedRegistryRow[] {
    if (!existsSync(this.registryPath)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.registryPath, "utf8")) as FeedFile;
      return Array.isArray(raw?.rows) ? raw.rows : [];
    } catch (err) {
      throw new Error(`[feed] feed.json unreadable at ${this.registryPath}: ${(err as Error).message}`);
    }
  }

  private flushRegistry(): void {
    atomicWriteJson(this.registryPath, { version: 1, rows: this.registry } satisfies FeedFile);
  }

  private log(rec: Omit<LogRecord, "at">): void {
    this.desk.store.log({ at: this.clock().toISOString(), ...rec });
  }

  get cap(): number {
    return this.opts.cap ?? 5;
  }

  // ── sources ──────────────────────────────────────────────────────────

  private runs(partial: string[]): BuildSummary[] {
    try {
      // Every build with no closing status, however old — what build_start counts against the cap.
      return readBuilds(this.opts.foremanBuildsDir, new Date(this.clock().getTime() - 60 * 86_400_000), { includeRunning: true, strict: true });
    } catch (err) {
      console.error("[feed] ledger unreadable:", (err as Error).message);
      partial.push("ledger");
      return [];
    }
  }

  private holds(runs: BuildSummary[]): HoldFile[] {
    const dir = this.opts.foremanBuildsDir;
    if (!dir) return [];
    const out: HoldFile[] = [];
    for (const r of runs) {
      if (r.state !== "running") continue;
      const p = join(dir, r.id, "HOLD");
      try {
        if (!existsSync(p)) continue;
        out.push({ build: r.id, text: readFileSync(p, "utf8").slice(0, 2000), mtime: new Date(statSync(p).mtimeMs).toISOString() });
      } catch {
        /* a torn HOLD is not a reason to lose the feed */
      }
    }
    return out;
  }

  private briefs(partial: string[]): BriefFile[] {
    try {
      return scanBriefs(this.opts.briefsDir);
    } catch (err) {
      console.error("[feed] briefs unreadable:", (err as Error).message);
      partial.push("briefs");
      return [];
    }
  }

  private restriction(): string | null {
    const r = restrictionAt(this.clock(), this.desk.cfg.place);
    return r.restricted ? r.reason ?? "Shabbat" : null;
  }

  /** The feed, composed from every source, with the launch ledger reconciled first. */
  view(owner: string): FeedView {
    const partial: string[] = [];
    this.reconcile();
    const builds = this.desk.buildsView(owner);
    partial.push(...builds.partial);
    const runs = this.runs(partial);
    const ideas: IdeasRead = readIdeas(this.opts.ideasPath);
    const view = deriveFeed({
      now: this.clock(),
      tz: this.desk.cfg.tz,
      builds,
      tracks: this.desk.tracks.all(),
      runs,
      reviewItems: this.desk.itemsFor(owner),
      holds: this.holds(runs),
      briefs: this.briefs(partial),
      ideas,
      launches: this.launches.all(),
      registry: this.registry,
      cap: this.cap,
      restricted: this.restriction(),
      partial,
    });
    const fold = foldRegistry(this.registry, view, ideas, this.launches.all(), this.clock());
    if (fold.left.length || fold.rows.length !== this.registry.length || fold.rows.some((r, i) => r !== this.registry[i])) {
      this.registry = fold.rows;
      this.flushRegistry();
    }
    for (const l of fold.left) this.log({ kind: "feed-row-left", row_id: l.id, actor: "feed", how: l.how });
    return view;
  }

  row(owner: string, id: string): FeedRow | null {
    return this.view(owner).rows.find((r) => r.id === id) ?? null;
  }

  // ── Start ────────────────────────────────────────────────────────────

  /** Fingerprint request for starting one row. */
  async startChallenge(owner: string, id: string): Promise<{ ok: true; options: unknown } | FeedError> {
    const row = this.row(owner, id);
    if (!row) return { ok: false, status: 404, code: "not-found", reason: "No such row on the feed" };
    if (!row.start?.brief) return { ok: false, status: 409, code: "brief-needed", reason: "No brief behind this row — ask Michael for one" };
    if (!row.start.ok) return { ok: false, status: 409, code: "not-now", reason: row.start.why ?? "Not now" };
    const options = await this.desk.passkeys.authOptions(owner, `launch:${id}`);
    if ("ok" in options && options.ok === false) return { ok: false, status: 409, code: options.code, reason: options.reason };
    return { ok: true, options };
  }

  /**
   * Start a row's brief. The passkey assertion is verified by THIS process;
   * then the launch is recorded (idempotent on the brief's sha) and the
   * launcher is started out of process. The answer never waits on build_start.
   */
  async start(owner: string, id: string, webauthn: unknown, actor: string): Promise<{ ok: true; launch: LaunchEntry; fresh: boolean } | FeedError> {
    const r = await this.desk.passkeys.verifyAssertion(owner, `launch:${id}`, webauthn);
    if (!r.ok) {
      this.log({ kind: "refused", row_id: id, actor, reason: `${r.code}: ${r.reason}`, note: "feed start" });
      return { ok: false, status: 403, code: r.code, reason: r.reason };
    }
    // Re-read after the await: the slots, the restriction and the ledger as they are NOW.
    const row = this.row(owner, id);
    if (!row) return { ok: false, status: 404, code: "not-found", reason: "No such row on the feed" };
    if (!row.start?.brief) return { ok: false, status: 409, code: "brief-needed", reason: "No brief behind this row" };
    const open = this.launches.openFor(row.start.brief.sha256);
    if (open) return { ok: true, launch: open, fresh: false };
    if (!row.start.ok) return { ok: false, status: 409, code: "not-now", reason: row.start.why ?? "Not now" };
    return this.launch(row, owner, actor, r.evidence);
  }

  private launch(row: FeedRow, owner: string, actor: string, evidence: PasskeyEvidence | null): { ok: true; launch: LaunchEntry; fresh: boolean } | FeedError {
    const brief = row.start!.brief!;
    const now = this.clock();
    const { entry, fresh } = this.launches.request(
      { row: row.id, brief_path: brief.path, brief_sha256: brief.sha256, name: brief.name, pre_approved: brief.pre_approved, owner, actor, requested_at: now.toISOString(), passkey: evidence },
      now,
    );
    if (!fresh) return { ok: true, launch: entry, fresh: false };
    const out = this.launches.outDir(entry.id);
    const spawned = this.runner({
      script: this.opts.launchScript,
      args: ["--out", out, "--launch-id", entry.id, "--actor", actor, brief.path],
      cwd: this.opts.foremanRoot,
      unit: `ahi-feed-launch-${entry.id}`,
      logPath: join(out, "launch.log"),
    });
    if (!spawned.ok) {
      const failed = this.launches.update(entry.id, { state: "failed", error: spawned.error, resolved_at: this.clock().toISOString(), runner: null })!;
      this.log({ kind: "feed-launch-failed", row_id: row.id, actor, reason: spawned.error, note: brief.path });
      return { ok: true, launch: failed, fresh: true };
    }
    const started = this.launches.update(entry.id, { runner: spawned.runner })!;
    this.log({ kind: "feed-launch-requested", row_id: row.id, actor, how: spawned.runner, note: `${brief.name} · ${brief.path}`, brief_sha256: brief.sha256, ...(evidence ? { passkey: evidence } : {}) });
    return { ok: true, launch: started, fresh: true };
  }

  /**
   * Fold the launchers' reports in. For each launch that resolved this pass:
   * the ledger line, and one line to Michael naming the build (or the
   * failure) so he supervises. Never throws; a failed wake is retried on the
   * next pass (woke_at stays null).
   */
  reconcile(): void {
    let changed: LaunchEntry[];
    try {
      changed = this.launches.reconcile(this.clock());
    } catch (err) {
      console.error("[feed] launch reconcile failed:", err);
      return;
    }
    for (const l of changed) {
      if (l.state === "started") this.log({ kind: "feed-launch-started", row_id: l.row, actor: l.actor, note: `${l.build_id} from ${l.brief_path}`, brief_sha256: l.brief_sha256 });
      else this.log({ kind: "feed-launch-failed", row_id: l.row, actor: l.actor, reason: l.error ?? "failed", note: l.brief_path });
    }
    for (const l of this.launches.all()) {
      if (l.state === "pending" || l.woke_at) continue;
      void this.wakeFor(l);
    }
  }

  private wakeText(l: LaunchEntry): string {
    if (l.state === "started") {
      return [
        `FEED START by ${l.actor} — build ${l.build_id} (${humanize(l.name)}) is running, launched from the Feed off the brief ${l.brief_path} (sha ${l.brief_sha256.slice(0, 12)}).`,
        `Pre-approved: ${l.pre_approved ? "yes — it runs to a preview with no approve step; the owner hears about it when a preview exists" : "no — the normal close-out applies"}. Workdir: ${l.workdir ?? "?"}. Supervise it as you would any build; no reply to the owner is needed for the launch itself.`,
      ].join("\n");
    }
    return [
      `FEED START FAILED — ${humanize(l.name)} from the brief ${l.brief_path}: ${l.error ?? "the launcher failed"}.`,
      `${l.actor} tapped Start at ${l.requested_at}; nothing is running. Fix the brief or the launcher, then tell the owner in one line (build_ask.sh if a build exists, otherwise the chat).`,
    ].join("\n");
  }

  private async wakeFor(l: LaunchEntry): Promise<void> {
    if (!this.wakeFn) return;
    // Claim first so two overlapping passes never send two lines; a failed send gives it back.
    if (!this.launches.update(l.id, { woke_at: this.clock().toISOString() })) return;
    try {
      await this.wakeFn(l.owner, this.wakeText(l));
    } catch (err) {
      console.error(`[feed] wake for launch ${l.id} failed (will retry):`, (err as Error).message);
      this.launches.update(l.id, { woke_at: null });
    }
  }

  // ── ask Michael for a brief ──────────────────────────────────────────

  async askBrief(owner: string, id: string, actor: string): Promise<{ ok: true; asked_at: string; fresh: boolean } | FeedError> {
    const row = this.row(owner, id);
    if (!row) return { ok: false, status: 404, code: "not-found", reason: "No such row on the feed" };
    if (row.action.kind !== "ask-brief") return { ok: false, status: 409, code: "not-an-idea", reason: "Only an idea row asks for a brief" };
    const reg = this.registry.find((r) => r.id === id);
    if (reg?.asked_at) return { ok: true, asked_at: reg.asked_at, fresh: false };
    if (!this.wakeFn) return { ok: false, status: 503, code: "no-wake", reason: "Michael's wake path is not up — try again in a minute" };
    const nowIso = this.clock().toISOString();
    const text = [
      `FEED ASK by ${actor} — he wants a brief for the idea "${row.what}" (${id}, idea vault; next step: ${row.where.replace(/^Next: /, "")}).`,
      `Write it in foreman/briefs/ with the machine header (feed: brief … track: ${id}); the Feed shows Start the moment the header validates. No reply to the owner is needed beyond the brief itself.`,
    ].join("\n");
    try {
      await this.wakeFn(owner, text);
    } catch (err) {
      return { ok: false, status: 503, code: "wake-failed", reason: `Couldn't reach Michael — ${(err as Error).message}` };
    }
    if (reg) reg.asked_at = nowIso;
    else this.registry.push({ id, kind: "idea", what: row.what, first_seen: nowIso, last_seen: nowIso, left: null, asked_at: nowIso });
    this.flushRegistry();
    this.log({ kind: "feed-brief-asked", row_id: id, actor, note: row.what });
    return { ok: true, asked_at: nowIso, fresh: true };
  }

  // ── close / file ─────────────────────────────────────────────────────

  close(owner: string, id: string, kind: "closed" | "cancelled"): { ok: true; closed: string[] } | FeedError {
    const row = this.row(owner, id);
    if (!row) return { ok: false, status: 404, code: "not-found", reason: "No such row on the feed" };
    if (row.card) {
      const r = this.desk.buildClose(owner, row.card, kind);
      if (!r.ok) return { ok: false, status: r.status, code: "close", reason: r.reason };
      this.log({ kind: "feed-row-closed", row_id: id, actor: "owner (app)", how: kind, note: row.what });
      return { ok: true, closed: r.closed };
    }
    const reg = this.registry.find((r) => r.id === id);
    if (!reg) return { ok: false, status: 409, code: "not-closable", reason: "This row closes from its own source (Review, or the idea vault)" };
    if (reg.left) return { ok: false, status: 409, code: "closed", reason: "already closed" };
    reg.left = { at: this.clock().toISOString(), how: `${kind} by owner (app)` };
    this.flushRegistry();
    this.log({ kind: "feed-row-closed", row_id: id, actor: "owner (app)", how: kind, note: row.what });
    return { ok: true, closed: [id] };
  }

  file(owner: string, id: string, track: unknown): { ok: true; track: string } | FeedError {
    const row = this.row(owner, id);
    if (!row) return { ok: false, status: 404, code: "not-found", reason: "No such row on the feed" };
    if (!row.card) return { ok: false, status: 400, code: "not-a-build", reason: "Only a loose build can be filed under a track" };
    const r = this.desk.buildFile(owner, row.card, track);
    if (!r.ok) return { ok: false, status: r.status, code: "file", reason: r.reason };
    this.log({ kind: "feed-row-filed", row_id: id, actor: "owner (app)", note: `filed under ${r.track.id}` });
    return { ok: true, track: r.track.id };
  }
}
