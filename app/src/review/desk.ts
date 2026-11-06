/**
 * desk.ts — the review desk: one object that owns the queue, the passkeys,
 * the schedule ledger, and every side effect (thread posts, push, Telegram).
 *
 * Side effects arrive as injected deps so the whole desk runs in tests with
 * no gateway, no sockets, no Telegram — and so production wiring (src/index.ts)
 * is the only place that knows about broadcast() and web-push.
 */
import { APP_URL } from "../app-url.js";
import { ownerUserId } from "../users.js";
import { createHash, randomBytes } from "crypto";
import { localIsoDate, localParts, startOfLocalDay } from "./clock.js";
import { composeClose, composeDigest, composeMotzei } from "./compose.js";
import { canDecide, statusFor } from "./lanes.js";
import { readBuilds, type BuildSummary } from "./ledger.js";
import { PasskeyService, passkeyConfigFromEnv, type PasskeyConfig, type PublicPasskey } from "./passkeys.js";
import { parseDigestReply } from "./reply.js";
import { restrictionAt } from "./sacred-time.js";
import { DEFAULT_SCHEDULE, dueSlots, upcomingSlots, type ScheduleConfig, type Slot } from "./schedule.js";
import { ReviewStore, defaultReviewRoot } from "./store.js";
import { TrackBoard, type Track, type TrackRow } from "./tracks.js";
import { deriveBuildDetail, deriveBuildsView, SECTION_ORDER, type BuildDetail, type BuildsInput, type BuildsView, type Card, type SectionKey } from "./builds.js";
import type { TimelineEntry } from "../foreman-messages/timeline.js";
import { WakeOutbox, backoffMs } from "./wakes.js";
import type { RestartChoice, ShipState } from "../foreman-messages/ship.js";
import { AlertFeed, alertDue, alertPushBody, alertWakeText, validateAlert, type AlertEntry, type AlertInput } from "./alerts.js";
import { LANES, type Decision, type Lane, type LogRecord, type NewItemInput, type PasskeyEvidence, type ReviewItem } from "./types.js";

export type PushOutcome = "sent" | "unconfigured" | "no-devices" | "disabled" | "muted" | "source-off" | "quiet-hours" | "failed";

export interface DeskDeps {
  /** Persist + deliver a message into the user's thread as the agent (gateway broadcast()). */
  postAsAgent(msg: { userId: string; bot: string; text: string; turnId: string }): void;
  /** Direct Web Push — the user's push settings and quiet hours still apply. */
  push(userId: string, p: { title: string; body: string; url: string; tag: string; source?: string; event?: string }): Promise<PushOutcome>;
  /** Nudge the user's open app windows that the queue changed (not persisted). */
  notifyClients(userId: string, event: Record<string, unknown>): void;
  /** turnId of the agent's most recent message in this user's thread. */
  lastAgentTurnId(userId: string, bot: string): string | null;
  /** The user's own recent messages (inbound, newest last) — the day close lifts what he said is for tomorrow. */
  recentUserMessages?(userId: string): Array<{ text: string; timestamp: string }>;
  /**
   * A new card, said in the owner's chat by the agent: one short message plus
   * a voice note of the same words (production: TTS → one broadcast, whose
   * push opens the card). This message IS the card's notification — the desk
   * sends no separate push for it. Absent (older wiring) → a plain postAsAgent.
   */
  announce?(msg: { userId: string; bot: string; text: string; itemId: string; turnId: string }): Promise<void>;
  /** Optional Telegram copy — only called when REVIEW_TELEGRAM_COPY=true. */
  telegram?(userId: string, text: string): Promise<void>;
  /**
   * Wake Michael in his own turn (the foreman's quiet wake path — never
   * The owner's chat). Rejects when the turn failed, so the outbox retries.
   */
  wakeMichael?(userId: string, text: string): Promise<void>;
}

export interface DeskOptions {
  deps: DeskDeps;
  root?: string;
  now?: () => Date;
  schedule?: ScheduleConfig;
  passkeys?: PasskeyConfig;
  /** Agent whose thread carries digests and parses replies. */
  agent?: string;
  /** Who scheduled messages are for. */
  owners?: string[];
  foremanBuildsDir?: string | null;
  /** foreman/QUEUE.md — read-only, for its OPEN-TRACKS block. */
  foremanQueuePath?: string | null;
  telegramCopy?: boolean;
  chatReplies?: boolean;
  /** The foreman's status timelines (read-only) — the Builds panel's "now", asks and checks. */
  timelines?: { builds(): Array<{ build: string }>; read(build: string): TimelineEntry[] } | null;
  /** Track builds started since this even if the board went live later (REVIEW_TRACKS_SINCE). */
  tracksSince?: Date | null;
  /** Public app origin for links in messages (AHI_APP_URL). */
  appUrl?: string;
  /** Lanes whose new cards are announced in chat (default: every lane — REVIEW_ANNOUNCE_LANES). */
  announceLanes?: Lane[];
}

export interface WakeDrain {
  sent: number;
  deferred: number;
  failed: number;
  skipped: number;
}

export type DeskError = { ok: false; status: 400 | 403 | 404 | 409 | 422; code: string; reason: string };

const MAX_BRIEF = 20_000;

/** Things that must never ride into a brief (and from there into the thread + retrieval corpus). */
const FORBIDDEN_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/, "an API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\b\d{3}-\d{2}-\d{4}\b/, "an SSN-shaped number"],
];

function oneLine(s: unknown, max: number): string | null {
  if (typeof s !== "string") return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t && t.length <= max ? t : null;
}

export interface ReviewView {
  now: string;
  since: string;
  /** No earlier visit on record — "since" is just the last 7 days. */
  first_visit: boolean;
  /** The zone the schedule runs in (for "next" labels). */
  tz: string;
  waiting: ReviewItem[];
  holding: ReviewItem[];
  done: ReviewItem[];
  builds: Array<{ id: string; name: string; agent: string; state: string; at: string | null }>;
  passkeys: number;
  enroll_open_until: string | null;
  next: Array<{ kind: string; at: string; label: string }>;
  tracks: TrackRow[];
  /** Review → System: open alerts (collapsed per class), then those resolved in the last day. */
  alerts: AlertEntry[];
}

export class ReviewDesk {
  readonly store: ReviewStore;
  readonly passkeys: PasskeyService;
  readonly tracks: TrackBoard;
  readonly wakes: WakeOutbox;
  readonly alerts: AlertFeed;
  readonly cfg: ScheduleConfig;
  private readonly deps: DeskDeps;
  private readonly clock: () => Date;
  private readonly agent: string;
  private readonly owners: string[];
  private readonly buildsDir: string | null;
  private readonly telegramCopy: boolean;
  private readonly chatReplies: boolean;
  private readonly timelines: DeskOptions["timelines"];
  private waker: DeskDeps["wakeMichael"] | null;
  /** The foreman-messages desk's ship approval (bound in production after both desks are up). */
  private shipper: ((opts: { build: string; userId: string; by: string; restart: RestartChoice; title: string }) => Promise<{ ok: true; state: ShipState; woke: boolean; already: boolean } | { ok: false; status: 404 | 409; reason: string }>) | null = null;
  private draining: Promise<WakeDrain> | null = null;
  private alertDraining: Promise<void> | null = null;
  private readonly announceLanes: Lane[];
  private readonly appUrl: string;
  private whatsappLines: ((link: string) => string[]) | null = null;

  constructor(opts: DeskOptions) {
    const root = opts.root ?? defaultReviewRoot();
    this.clock = opts.now ?? (() => new Date());
    this.store = new ReviewStore(root);
    this.passkeys = new PasskeyService(root, opts.passkeys ?? passkeyConfigFromEnv(), this.clock);
    this.tracks = new TrackBoard(root, opts.foremanQueuePath ?? null, this.clock, opts.tracksSince ?? null);
    this.wakes = new WakeOutbox(root);
    this.alerts = new AlertFeed(root);
    this.announceLanes = opts.announceLanes ?? [...LANES];
    this.waker = opts.deps.wakeMichael ?? null;
    this.cfg = opts.schedule ?? DEFAULT_SCHEDULE;
    this.deps = opts.deps;
    this.agent = opts.agent ?? "michael";
    this.owners = opts.owners ?? [ownerUserId()];
    this.buildsDir = opts.foremanBuildsDir ?? null;
    this.telegramCopy = opts.telegramCopy ?? false;
    this.chatReplies = opts.chatReplies ?? true;
    this.timelines = opts.timelines ?? null;
    this.appUrl = (opts.appUrl ?? APP_URL).replace(/\/$/, "");
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  private changed(owner: string): void {
    const waiting = this.store.all().filter((i) => i.owner === owner && i.status === "waiting").length;
    try {
      this.deps.notifyClients(owner, { type: "review-update", userId: owner, waiting });
    } catch (err) {
      console.error("[review] notifyClients failed (non-fatal):", err);
    }
  }

  private log(rec: Omit<LogRecord, "at">): void {
    this.store.log({ at: this.nowIso(), ...rec });
  }

  // ── create ───────────────────────────────────────────────────────────

  async create(input: Partial<NewItemInput>, actor: string): Promise<{ ok: true; item: ReviewItem } | DeskError> {
    const lane = typeof input.lane === "string" ? (input.lane.toUpperCase() as NewItemInput["lane"]) : null;
    if (!lane || !LANES.includes(lane)) return { ok: false, status: 400, code: "lane", reason: "lane must be GREEN, YELLOW or RED" };
    const desk = oneLine(input.desk, 60);
    if (!desk) return { ok: false, status: 400, code: "desk", reason: "desk is required (≤ 60 chars)" };
    if (typeof input.title !== "string" || /[\r\n]/.test(input.title.trim())) {
      return { ok: false, status: 400, code: "title", reason: "title must be one line" };
    }
    const title = oneLine(input.title, 160);
    if (!title) return { ok: false, status: 400, code: "title", reason: "title is required (one line, ≤ 160 chars)" };
    const brief = typeof input.brief === "string" ? input.brief.trim() : "";
    if (lane !== "GREEN" && !brief) return { ok: false, status: 400, code: "brief", reason: `${lane} items need a plain-English brief` };
    if (brief.length > MAX_BRIEF) return { ok: false, status: 400, code: "brief", reason: `brief over ${MAX_BRIEF} chars` };
    const costRisk = input.cost_risk === undefined || input.cost_risk === "" ? "" : oneLine(input.cost_risk, 200);
    if (costRisk === null) return { ok: false, status: 400, code: "cost_risk", reason: "cost_risk must be one line (≤ 200 chars)" };
    const owner = typeof input.owner === "string" && input.owner ? input.owner.trim().toLowerCase() : this.owners[0];
    if (!/^[a-z0-9._-]{1,40}$/.test(owner)) return { ok: false, status: 400, code: "owner", reason: "bad owner" };
    const ref = input.ref == null || input.ref === "" ? null : oneLine(input.ref, 300);
    const track = input.track == null || input.track === "" ? null : typeof input.track === "string" && /^(trk|bld)-[a-z0-9._-]{1,60}$/.test(input.track) ? input.track : undefined;
    if (track === undefined) return { ok: false, status: 400, code: "track", reason: "track must be a track id (trk-… or bld-…)" };
    for (const [re, what] of FORBIDDEN_PATTERNS) {
      if (re.test(`${title}\n${brief}\n${costRisk}\n${ref ?? ""}`)) {
        return { ok: false, status: 422, code: "sensitive", reason: `refused: the item contains what looks like ${what} — redact it and post again` };
      }
    }
    const now = this.clock();
    const stamp = localParts(now, "UTC");
    const id = `rv-${stamp.year}${String(stamp.month).padStart(2, "0")}${String(stamp.day).padStart(2, "0")}-${randomBytes(3).toString("hex")}`;
    const item: ReviewItem = {
      id,
      lane,
      desk,
      title,
      brief,
      cost_risk: costRisk,
      created: now.toISOString(),
      created_by: actor,
      owner,
      status: lane === "GREEN" ? "done" : "waiting",
      decided_at: null,
      decided_how: null,
      ref,
      done_at: lane === "GREEN" ? now.toISOString() : null,
      done_note: null,
      notified_at: null,
      notify_deferred: null,
      reminded_at: null,
      passkey: null,
      ...(track ? { track } : {}),
    };
    this.store.insert(item);
    this.log({ kind: "created", item_id: id, lane, actor, to: item.status, note: title });
    await this.announceCard(item);
    this.changed(owner);
    return { ok: true, item: this.store.get(id)! };
  }

  /**
   * Every new card buzzes the owner's phone — by Michael saying
   * so in the chat, with a voice note: that one message is the notification.
   * Inside Shabbat / Yom Tov nothing is said; the card is held and the motzei
   * message (which posts at nightfall) carries it — the gate exactly as before.
   */
  private async announceCard(item: ReviewItem): Promise<void> {
    if (!this.announceLanes.includes(item.lane)) return;
    const r = restrictionAt(this.clock(), this.cfg.place);
    if (r.restricted) {
      this.store.update(item.id, { notify_deferred: r.reason ?? "Shabbat" });
      return;
    }
    const text = announcementText(item);
    const turnId = `review-card-${item.id}`;
    try {
      if (this.deps.announce) await this.deps.announce({ userId: item.owner, bot: this.agent, text, itemId: item.id, turnId });
      else this.deps.postAsAgent({ userId: item.owner, bot: this.agent, text, turnId });
      this.store.update(item.id, { notified_at: this.nowIso(), notify_deferred: null });
      this.log({ kind: "announced", item_id: item.id, lane: item.lane, actor: "desk", note: text });
    } catch (err) {
      console.error("[review] card announcement failed (non-fatal — the card is in Review):", err);
      this.store.update(item.id, { notify_deferred: "failed" });
    }
  }

  // ── read ─────────────────────────────────────────────────────────────

  itemsFor(owner: string): ReviewItem[] {
    return this.store.all().filter((i) => i.owner === owner);
  }

  waitingCount(owner: string): number {
    return this.itemsFor(owner).filter((i) => i.status === "waiting").length;
  }

  /**
   * The app screen. `mark` advances the "since last time" mark — but only
   * when the previous look is >10 min old, so a refresh doesn't wipe the
   * Done list you are reading.
   */
  view(owner: string, mark: boolean): ReviewView {
    const now = this.clock();
    let seen = this.store.seen(owner);
    if (mark && (!seen.current || now.getTime() - Date.parse(seen.current) > 10 * 60_000)) {
      seen = { previous: seen.current, current: now.toISOString() };
      this.store.setSeen(owner, seen);
    }
    const since = seen.previous ? new Date(seen.previous) : new Date(now.getTime() - 7 * 86_400_000);
    const items = this.itemsFor(owner);
    const laneRank = (i: ReviewItem) => (i.lane === "RED" ? 0 : 1);
    const at = (i: ReviewItem) => Date.parse(i.done_at ?? i.decided_at ?? i.created);
    const builds = readBuilds(this.buildsDir, new Date(since.getTime() - 3 * 86_400_000))
      .filter((b) => b.stateAt && b.stateAt >= since && b.state !== "running")
      .reverse()
      .slice(0, 12)
      .map((b) => ({ id: b.id, name: b.name, agent: b.agent, state: b.state, at: b.stateAt ? b.stateAt.toISOString() : null }));
    return {
      now: now.toISOString(),
      since: since.toISOString(),
      first_visit: !seen.previous,
      tz: this.cfg.tz,
      waiting: items.filter((i) => i.status === "waiting").sort((a, b) => laneRank(a) - laneRank(b) || a.created.localeCompare(b.created)),
      holding: items.filter((i) => i.status === "held").sort((a, b) => laneRank(a) - laneRank(b) || a.created.localeCompare(b.created)),
      done: items
        .filter((i) => (i.status === "approved" || i.status === "denied" || i.status === "done") && at(i) >= since.getTime())
        .sort((a, b) => at(b) - at(a)),
      builds,
      passkeys: this.passkeys.count(owner),
      enroll_open_until: this.passkeys.enrollmentOpenUntil(owner)?.toISOString() ?? null,
      next: this.nextSlots(now),
      tracks: this.board(),
      alerts: this.alerts.view(now),
    };
  }

  // ── open tracks ──────────────────────────────────────────────────────

  private trackBuilds(strict = false): BuildSummary[] {
    // Linked builds up to two weeks older than the board still show their
    // state; anything that never closed shows no matter how old — with the
    // other runs of its job, so "never redone" can be told from "redone".
    return readBuilds(this.buildsDir, new Date(this.tracks.epoch.getTime() - 14 * 86_400_000), { includeRunning: true, withSiblings: true, strict });
  }

  /** Sync the sources (never removes) and render the open rows. */
  board(): TrackRow[] {
    const builds = this.trackBuilds();
    this.syncTracks(builds);
    return this.tracks.board(builds);
  }

  private syncTracks(builds: BuildSummary[]): void {
    const before = new Set(this.tracks.all().map((t) => t.id));
    if (this.tracks.sync(builds)) {
      for (const t of this.tracks.all()) {
        if (!before.has(t.id)) this.log({ kind: "track-added", track_id: t.id, actor: `sync:${t.source}`, note: t.title });
      }
    }
    for (const f of this.tracks.drainFiled()) this.log({ kind: "track-filed", track_id: f.row, actor: "sync", note: `filed under ${f.track}` });
  }

  // ── builds panel (B1/B2) ─────────────────────────────────────────────

  /**
   * Every source the panel composes, read once. A source that fails is
   * named in `partial` and the rest still render — a board with a banner
   * beats a blank screen (design C19).
   */
  private buildsInput(owner: string): BuildsInput {
    const partial: string[] = [];
    let runs: BuildSummary[] = [];
    try {
      runs = this.trackBuilds(true);
    } catch (err) {
      console.error("[review] builds: ledger unreadable:", (err as Error).message);
      partial.push("ledger");
    }
    if (!partial.includes("ledger")) {
      try {
        this.syncTracks(runs);
      } catch (err) {
        console.error("[review] builds: track sync failed:", (err as Error).message);
        partial.push("tracks");
      }
    }
    const timelines = new Map<string, TimelineEntry[]>();
    if (this.timelines) {
      try {
        for (const { build } of this.timelines.builds()) timelines.set(build, this.timelines.read(build));
      } catch (err) {
        console.error("[review] builds: timelines unreadable:", (err as Error).message);
        partial.push("timeline");
      }
    }
    return {
      now: this.clock(),
      tz: this.cfg.tz,
      tracks: this.tracks.all(),
      runs,
      timelines,
      reviewItems: this.itemsFor(owner),
      partial,
    };
  }

  buildsView(owner: string): BuildsView {
    return deriveBuildsView(this.buildsInput(owner));
  }

  buildDetail(owner: string, id: string): BuildDetail | null {
    return deriveBuildDetail(this.buildsInput(owner), id);
  }

  /** the owner's close from the app: every registry row the card stands for. */
  buildClose(owner: string, id: string, kind: "closed" | "cancelled"): { ok: true; closed: string[] } | { ok: false; status: 404 | 409; reason: string } {
    const card = this.buildDetail(owner, id);
    if (!card) return { ok: false, status: 404, reason: "No such build on the board" };
    if (card.section === "closed_week") return { ok: false, status: 409, reason: "already closed" };
    const closed: string[] = [];
    for (const tid of card.track_ids) {
      const r = this.trackClose(tid, kind, "", null);
      if ("error" in r) {
        if (!closed.length) return { ok: false, status: 409, reason: r.error };
        continue;
      }
      closed.push(tid);
    }
    this.changed(owner);
    return { ok: true, closed };
  }

  /**
   * The foreman's close after a ship (close-chain: "once I give my
   * okay, it should … get closed out"). Finds the card a BUILD RUN belongs to
   * and closes every row of it, relaying the owner's recorded word like track-close
   * does. Idempotent: a card already closed answers `already`, so a re-run of
   * the finish is a no-op. A real track that still has work on it (a running
   * run, a step not done, something left) is refused — one run shipping does
   * not finish a program.
   */
  buildCloseByRun(
    owner: string,
    build: string,
    kind: "closed" | "cancelled",
    operatorSaid: string,
    relayedBy: string,
  ): { ok: true; card: string; closed: string[]; already: boolean } | { ok: false; status: 400 | 404 | 409; reason: string } {
    if (!operatorSaid.trim()) return { ok: false, status: 400, reason: "closing a card needs the owner's word (owner_said)" };
    const view = this.buildsView(owner);
    let card: Card | null = null;
    let section: SectionKey | null = null;
    for (const s of SECTION_ORDER) {
      card = view.sections[s].find((c) => c.track_ids.includes(`bld-${build}`) || c.runs.some((r) => r.build === build)) ?? null;
      if (card) {
        section = s;
        break;
      }
    }
    if (!card) return { ok: false, status: 404, reason: "No card on the board carries that build" };
    if (section === "closed_week") return { ok: true, card: card.id, closed: [], already: true };
    if (card.id.startsWith("trk-")) {
      const t = this.tracks.get(card.id);
      const busy = card.runs.some((r) => r.counted && r.state === "running" && r.build !== build);
      const unfinished = (t?.steps ?? []).some((s) => s.state !== "done") || !!t?.left?.trim();
      if (busy || unfinished)
        return { ok: false, status: 409, reason: `${card.id} still has work on it (${busy ? "another run is running" : "steps or 'left' not done"}) — close the track itself when it is finished` };
    }
    const closed: string[] = [];
    for (const tid of card.track_ids) {
      const r = this.trackClose(tid, kind, operatorSaid, relayedBy);
      if ("error" in r) {
        if (!closed.length) return { ok: false, status: 409, reason: r.error };
        continue;
      }
      closed.push(tid);
    }
    this.changed(owner);
    return { ok: true, card: card.id, closed, already: false };
  }

  /** File a loose build (every run of it) under an open track. */
  buildFile(owner: string, id: string, target: unknown): { ok: true; track: Track } | { ok: false; status: 400 | 404 | 409; reason: string } {
    const card = this.buildDetail(owner, id);
    if (!card) return { ok: false, status: 404, reason: "No such build on the board" };
    if (card.section === "closed_week") return { ok: false, status: 409, reason: "already closed" };
    if (!card.id.startsWith("bld-")) return { ok: false, status: 400, reason: "only a loose build can be filed under a track" };
    const into = typeof target === "string" ? this.tracks.get(target) : null;
    if (!into || into.source === "build") return { ok: false, status: 400, reason: "track must be an open track (trk-…)" };
    if (into.state === "closed" || into.state === "cancelled") return { ok: false, status: 409, reason: `that track is ${into.state}` };
    const builds = [...new Set([...card.runs.map((r) => r.build), ...card.track_ids.map((t) => t.slice(4))])];
    const r = this.trackUpsert({ id: into.id, builds }, "owner (app)");
    if ("error" in r) return { ok: false, status: 409, reason: r.error };
    this.changed(owner);
    return { ok: true, track: r };
  }

  trackUpsert(input: Parameters<TrackBoard["upsert"]>[0], actor: string): Track | { error: string } {
    const existed = typeof input.id === "string" && !!this.tracks.get(input.id);
    const r = this.tracks.upsert(input);
    if (!("error" in r)) {
      this.log({ kind: existed ? "track-updated" : "track-added", track_id: r.id, actor, note: r.title });
      for (const f of this.tracks.drainFiled()) this.log({ kind: "track-filed", track_id: f.row, actor, note: `filed under ${f.track}` });
    }
    return r;
  }

  /**
   * Off the board — only with the owner's word. Over the service API that word is
   * quoted (`operatorSaid`) and logged beside whoever relayed it; `relayedBy` is
   * null only for the owner acting in the app himself.
   */
  trackClose(id: string, kind: "closed" | "cancelled", operatorSaid: string, relayedBy: string | null): Track | { error: string } {
    const said = operatorSaid.replace(/\s+/g, " ").trim().slice(0, 300);
    if (relayedBy !== null && !said) return { error: "closing or cancelling a track needs the owner's word (owner_said)" };
    const how = relayedBy === null ? "owner (app)" : `owner (relayed by ${relayedBy}): ${said}`;
    const r = this.tracks.close(id, kind, how);
    if (!("error" in r)) this.log({ kind: "track-closed", track_id: id, actor: relayedBy ?? "owner", how: kind, note: how });
    return r;
  }

  private nextSlots(now: Date): ReviewView["next"] {
    return upcomingSlots(this.cfg, now, 10, 10)
      .filter((s) => !restrictionAt(s.at, this.cfg.place).restricted)
      .slice(0, 2)
      .map((s) => ({
        kind: s.kind,
        at: s.at.toISOString(),
        label: s.kind === "digest" ? "Digest" : s.kind === "motzei" ? `Motzei ${s.window?.label ?? "Shabbat"}` : s.erev ? (s.erev.entering === "Shabbat" ? "Shabbat close" : "Erev close") : "Day close",
      }));
  }

  // ── decide ───────────────────────────────────────────────────────────

  /** Fingerprint request for approving one RED item. */
  async approveChallenge(owner: string, id: string) {
    const item = this.store.get(id);
    if (!item || item.owner !== owner) return { ok: false as const, status: 404 as const, code: "not-found", reason: "No such item" };
    if (item.lane !== "RED") return { ok: false as const, status: 409 as const, code: "not-red", reason: "Only RED items need a fingerprint" };
    if (item.status !== "waiting" && item.status !== "held") return { ok: false as const, status: 409 as const, code: "closed", reason: `already ${item.status}` };
    const options = await this.passkeys.authOptions(owner, `approve:${id}`);
    if ("ok" in options && options.ok === false) return { ...options, status: 409 as const };
    return { ok: true as const, options };
  }

  /**
   * One decision from the app. `webauthn` is the raw authenticator response
   * for a RED approval; every other field a client might send ("verified",
   * "channel", …) is ignored — the channel is fingerprint only when THIS
   * process verified the assertion.
   */
  async decide(owner: string, id: string, decision: unknown, webauthn: unknown, actor: string): Promise<{ ok: true; item: ReviewItem } | DeskError> {
    const item = this.store.get(id);
    if (!item || item.owner !== owner) return { ok: false, status: 404, code: "not-found", reason: "No such item" };
    if (decision !== "approve" && decision !== "deny" && decision !== "hold") {
      return { ok: false, status: 400, code: "decision", reason: "decision must be approve, deny or hold" };
    }
    let channel: "tap" | "fingerprint" = "tap";
    let evidence: PasskeyEvidence | null = null;
    if (decision === "approve" && webauthn !== undefined && webauthn !== null) {
      const r = await this.passkeys.verifyAssertion(owner, `approve:${id}`, webauthn);
      if (!r.ok) {
        const credId = typeof (webauthn as { id?: unknown })?.id === "string" ? String((webauthn as { id: string }).id).slice(0, 200) : undefined;
        this.log({ kind: "refused", item_id: id, lane: item.lane, actor, decision, channel: "fingerprint", reason: `${r.code}: ${r.reason}`, credential_id: credId });
        return { ok: false, status: 403, code: r.code, reason: r.reason };
      }
      channel = "fingerprint";
      evidence = r.evidence;
    }
    // Re-read after the await: a deny or hold that landed while the assertion
    // was being verified must win over this decision, so canDecide (in apply)
    // judges the item as it is NOW, not the copy read before the await.
    const fresh = this.store.get(id);
    if (!fresh || fresh.owner !== owner) return { ok: false, status: 404, code: "not-found", reason: "No such item" };
    return this.apply(fresh, decision, channel, actor, evidence);
  }

  private apply(item: ReviewItem, decision: Decision, channel: "tap" | "fingerprint" | "chat", actor: string, evidence: PasskeyEvidence | null, how?: string): { ok: true; item: ReviewItem } | DeskError {
    const verdict = canDecide(item, decision, channel);
    if (!verdict.ok) {
      this.log({ kind: "refused", item_id: item.id, lane: item.lane, actor, decision, channel, reason: `${verdict.code}: ${verdict.reason}` });
      return { ok: false, status: verdict.code === "closed" || verdict.code === "noop" ? 409 : 403, code: verdict.code, reason: verdict.reason };
    }
    const to = statusFor(decision);
    const updated = this.store.update(item.id, {
      status: to,
      decided_at: this.nowIso(),
      decided_how: how ?? channel,
      ...(evidence ? { passkey: evidence } : {}),
    });
    this.log({
      kind: "decision",
      item_id: item.id,
      lane: item.lane,
      actor,
      from: item.status,
      to,
      decision,
      channel,
      how: how ?? channel,
      brief_sha256: createHash("sha256").update(item.brief).digest("hex"),
      ...(evidence ? { passkey: evidence } : {}),
    });
    this.changed(item.owner);
    if (to === "approved") this.approvalWake(updated);
    return { ok: true, item: updated };
  }

  // ── approval wakes (an approval STARTS the work) ─────────

  /** Production wiring binds the waker after the foreman-messages desk is up. */
  /**
   * W10 (Michael): the WhatsApp dashboard's line rides the existing day-close —
   * no second digest. The WhatsApp module composes it (only it can read the
   * store); the desk only places it. Counts only, never a customer name.
   */
  setWhatsAppDigest(fn: ((link: string) => string[]) | null): void {
    this.whatsappLines = fn;
  }

  private whatsappDigest(): string[] | undefined {
    if (!this.whatsappLines) return undefined;
    try {
      return this.whatsappLines(`${this.appUrl}/#whatsapp`);
    } catch (err) {
      console.error("[review] WhatsApp digest line failed (non-fatal):", err);
      return undefined;
    }
  }

  setShipper(fn: ReviewDesk["shipper"]): void {
    this.shipper = fn ?? null;
  }

  /**
   * Fingerprint request for Ship update (FINAL ship flow). Null options = no passkey is
   * registered for this owner, so the ship is a tap (as before); with one, the ship needs it.
   */
  async shipChallenge(owner: string, id: string): Promise<{ ok: true; options: unknown | null } | { ok: false; status: 404 | 409; reason: string }> {
    const card = this.buildDetail(owner, id);
    if (!card || !card.ship) return { ok: false, status: 404, reason: "Nothing is ready to ship on this card" };
    if (this.passkeys.count(owner) === 0) return { ok: true, options: null };
    const options = await this.passkeys.authOptions(owner, `ship:${id}`);
    if ("ok" in options && options.ok === false) return { ok: false, status: 409, reason: options.reason };
    return { ok: true, options };
  }

  /**
   * The owner's Ship tap on a card. The card's lead run carries the
   * ship; the approval is recorded once and Michael is woken with the envelope.
   * Idempotent through the foreman desk: a second tap returns the same state.
   */
  async buildShip(owner: string, id: string, restart: unknown, by: string, webauthn?: unknown): Promise<{ ok: true; build: string; state: ShipState; woke: boolean; already: boolean } | { ok: false; status: 400 | 403 | 404 | 409 | 503; reason: string }> {
    const choice: RestartChoice = restart === "now" ? "now" : "wait";
    if (restart !== undefined && restart !== "now" && restart !== "wait") return { ok: false, status: 400, reason: "restart must be wait or now" };
    const card = this.buildDetail(owner, id);
    if (!card) return { ok: false, status: 404, reason: "No such build on the board" };
    if (!card.ship) return { ok: false, status: 409, reason: "Nothing is ready to ship on this card" };
    if (!this.shipper) return { ok: false, status: 503, reason: "The ship lane is not up" };
    if (card.ship.review) {
      const item = this.store.get(card.ship.review);
      if (item && item.status !== "approved" && item.status !== "done") return { ok: false, status: 409, reason: "Approve it in Review first" };
    }
    // With a passkey registered, Ship update takes the fingerprint (FINAL): verified HERE, never trusted from the client.
    if (this.passkeys.count(owner) > 0) {
      const v = await this.passkeys.verifyAssertion(owner, `ship:${id}`, webauthn);
      if (!v.ok) {
        this.log({ kind: "refused", track_id: card.id, actor: by, channel: "fingerprint", reason: `ship ${v.code}: ${v.reason}` } as never);
        return { ok: false, status: 403, reason: v.code === "no-challenge" ? "Ship needs your fingerprint — tap Ship update again." : v.reason };
      }
    }
    const r = await this.shipper({ build: card.ship.build, userId: owner, by, restart: choice, title: card.title });
    if (!r.ok) return r;
    this.log({ kind: "ship-approved", track_id: card.id, actor: by, note: `${card.ship.build} restart:${choice}${r.already ? " (again)" : ""}${r.woke ? "" : " wake failed"}` });
    this.changed(owner);
    return { ok: true, build: card.ship.build, state: r.state, woke: r.woke, already: r.already };
  }

  /**
   * A ship reached its result. Healthy: the card closes as shipped (the owner's
   * tap was his decision; nothing is left for him) and a linked review item is
   * marked done. A rollback or failure leaves the card open, where it says so.
   */
  shipLanded(state: ShipState): void {
    const owner = state.approved?.by && state.approved.by !== "michael" ? state.approved.by : (this.owners[0] ?? ownerUserId());
    try {
      if (state.result?.outcome === "ok") {
        const card = this.buildDetail(owner, `bld-${state.build}`);
        if (card && card.section !== "closed_week") {
          const how = `owner (ship): back on ${state.result.sha ?? "the new build"}`;
          for (const tid of card.track_ids) {
            const r = this.tracks.close(tid, "closed", how);
            if (!("error" in r)) this.log({ kind: "track-closed", track_id: tid, actor: "ship", how: "closed", note: how });
          }
        }
        if (state.review) {
          const item = this.store.get(state.review);
          if (item?.status === "approved") {
            const note = `Shipped: back on ${state.result.sha ?? "the new build"}${state.result.dark_s !== null ? ` after ${state.result.dark_s} s dark` : ""}.`;
            this.store.update(state.review, { status: "done", done_at: this.nowIso(), done_note: note });
            this.log({ kind: "done", item_id: state.review, lane: item.lane, actor: "ship", from: "approved", to: "done", note });
          }
        }
      }
    } catch (err) {
      console.error("[review] ship landed hook failed:", err);
    }
    this.changed(owner);
  }

  setWaker(fn: DeskDeps["wakeMichael"] | null): void {
    this.waker = fn ?? null;
  }

  /** The Feed's launches and brief-asks ride the same quiet wake path. Rejects when there is none, or the turn failed. */
  async wakeMichael(owner: string, text: string): Promise<void> {
    if (!this.waker) throw new Error("no wake path (foreman-messages desk not up)");
    await this.waker(owner, text);
  }

  /**
   * Queue the one wake this approval owes Michael and try it now — without
   * awaiting: the approval's answer to the phone never waits on his turn, and
   * nothing here can throw into it.
   */
  private approvalWake(item: ReviewItem): void {
    try {
      const { fresh } = this.wakes.enqueue({ item_id: item.id, owner: item.owner, approved_at: item.decided_at ?? this.nowIso(), now: this.clock() });
      if (fresh) this.log({ kind: "wake-queued", item_id: item.id, lane: item.lane, actor: "desk", note: item.decided_how ?? undefined });
      void this.drainWakes().catch((err) => console.error("[review] approval wake drain failed (will retry):", err));
    } catch (err) {
      console.error("[review] approval wake could not be queued:", err);
    }
  }

  /** The words Michael is woken with. */
  approvalWakeText(item: ReviewItem, waited: string | null): string {
    const gate = this.mayExecute(item.id);
    const may = gate.ok ? "yes" : `no — ${gate.reason}`;
    const lines = [
      `REVIEW APPROVED by the owner — ${item.id} ${item.lane} ${item.title}. may_execute: ${may}. Get it rolling: launch or steer the build, then mark done via review.mjs done when shipped.`,
      `Desk: ${item.desk} · approved ${item.decided_how ?? "in the app"} at ${item.decided_at ?? "?"}${item.track ? ` · track ${item.track}` : ""}${item.ref ? ` · ref ${item.ref}` : ""}`,
    ];
    // close-chain: his OK ends the build completely — one command after the ship.
    const build = item.ref && /^\d{8}-\d{6}-[a-z0-9][a-z0-9._-]{0,80}$/.test(item.ref) ? item.ref : "<build-id>";
    lines.push(
      `Once shipped, finish it in one step: ~/AHI/AHI_OS/foreman/bin/build_finish.sh ${build} --shipped <repo>@<sha> --review ${item.id} — closes the build and its card, marks this item done, archives the keepers to the storage box, removes the copy.`,
    );
    if (waited) lines.push(`(Held until now: ${waited}.)`);
    return lines.join("\n");
  }

  /**
   * Send every due wake. One drain at a time (a second caller gets the running
   * one). Gated → deferred to nightfall; failed → retried with backoff; an item
   * no longer approved (done, or gone) → skipped, logged.
   */
  drainWakes(): Promise<WakeDrain> {
    if (this.draining) return this.draining;
    this.draining = this.runDrain().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async runDrain(): Promise<WakeDrain> {
    const out: WakeDrain = { sent: 0, deferred: 0, failed: 0, skipped: 0 };
    for (const w of this.wakes.due(this.clock())) {
      const item = this.store.get(w.item_id);
      if (!item || item.status !== "approved") {
        this.wakes.update(w.key, { state: "skipped", waiting: item ? `item is ${item.status}` : "item gone" });
        this.log({ kind: "wake-skipped", item_id: w.item_id, actor: "desk", note: item ? `item is ${item.status}` : "item gone" });
        out.skipped++;
        continue;
      }
      const gate = this.mayExecute(item.id);
      if (!gate.ok) {
        // Shabbat / Yom Tov: the wake waits for nightfall instead of being dropped.
        const until = gate.until ?? new Date(this.clock().getTime() + 60 * 60_000).toISOString();
        const waiting = `gate: ${gate.reason}`;
        if (w.waiting !== waiting) this.log({ kind: "wake-deferred", item_id: item.id, lane: item.lane, actor: "desk", note: `${gate.reason} · until ${until}` });
        this.wakes.update(w.key, { next_at: until, waiting });
        out.deferred++;
        continue;
      }
      const waited = w.waiting?.startsWith("gate: ") ? w.waiting.slice(6).replace(/ — .*$/, "") : null;
      const text = this.approvalWakeText(item, waited);
      try {
        if (!this.waker) throw new Error("no wake path (foreman-messages desk not up)");
        await this.waker(item.owner, text);
        this.wakes.update(w.key, { state: "sent", sent_at: this.nowIso(), attempts: w.attempts + 1, waiting: null, text });
        this.log({ kind: "wake-sent", item_id: item.id, lane: item.lane, actor: "desk", note: `attempt ${w.attempts + 1}` });
        out.sent++;
      } catch (err) {
        const attempts = w.attempts + 1;
        const msg = String((err as Error)?.message ?? err).slice(0, 200);
        console.error(`[review] approval wake for ${item.id} failed (attempt ${attempts}, retrying):`, msg);
        this.wakes.update(w.key, { attempts, next_at: new Date(this.clock().getTime() + backoffMs(attempts)).toISOString(), waiting: `retry: ${msg}` });
        this.log({ kind: "wake-failed", item_id: item.id, lane: item.lane, actor: "desk", reason: msg, note: `attempt ${attempts}` });
        out.failed++;
      }
    }
    return out;
  }

  /**
   * May Michael/foreman carry out this item NOW? Only approved YELLOW/RED
   * work, and never inside Shabbat / Yom Tov: the queue
   * keeps filling and GREEN keeps running, but nothing that needed a yes is
   * executed until nightfall.
   */
  mayExecute(id: string): { ok: boolean; reason: string | null; until: string | null } {
    const item = this.store.get(id);
    if (!item) return { ok: false, reason: "no such item", until: null };
    if (item.lane === "GREEN") return { ok: true, reason: null, until: null };
    if (item.status !== "approved") return { ok: false, reason: `item is ${item.status}, not approved`, until: null };
    const r = restrictionAt(this.clock(), this.cfg.place);
    if (r.restricted) return { ok: false, reason: `${r.reason} — YELLOW/RED work waits for nightfall`, until: r.until?.toISOString() ?? null };
    return { ok: true, reason: null, until: null };
  }

  /** Michael/foreman: the approved work has been carried out. */
  markDone(id: string, note: unknown, actor: string): { ok: true; item: ReviewItem } | DeskError {
    const item = this.store.get(id);
    if (!item) return { ok: false, status: 404, code: "not-found", reason: "No such item" };
    if (item.status !== "approved") return { ok: false, status: 409, code: "not-approved", reason: `item is ${item.status}, not approved` };
    const gate = this.mayExecute(id);
    if (!gate.ok) return { ok: false, status: 409, code: "not-now", reason: `${gate.reason} — record it after nightfall` };
    const doneNote = note == null || note === "" ? null : oneLine(note, 300);
    const updated = this.store.update(id, { status: "done", done_at: this.nowIso(), done_note: doneNote });
    this.log({ kind: "done", item_id: id, lane: item.lane, actor, from: "approved", to: "done", note: doneNote ?? undefined });
    this.changed(item.owner);
    return { ok: true, item: updated };
  }

  // ── passkeys (logging + owner notice around the service) ─────────────

  async passkeyAdded(owner: string, passkey: PublicPasskey, via: string, actor: string): Promise<void> {
    this.log({ kind: "passkey-added", actor, credential_id: passkey.id, how: via, note: passkey.label });
    await this.deps
      .push(owner, { title: "Passkey added", body: `${passkey.label} can now approve RED items. Not you? Tell Michael.`, url: "/?settings=passkeys", tag: `passkey-${passkey.id.slice(0, 16)}` })
      .catch(() => "failed");
    if (this.telegramCopy && this.deps.telegram) await this.deps.telegram(owner, `Passkey added: ${passkey.label}`).catch(() => undefined);
  }

  async passkeyRemoved(owner: string, credentialId: string, via: string, actor: string): Promise<void> {
    this.log({ kind: "passkey-removed", actor, credential_id: credentialId, how: via });
    await this.deps
      .push(owner, { title: "Passkey removed", body: "A passkey was removed from your account.", url: "/?settings=passkeys", tag: `passkey-${credentialId.slice(0, 16)}` })
      .catch(() => "failed");
  }

  openEnrollment(owner: string, minutes: number, actor: string): Date {
    const until = this.passkeys.openEnrollment(owner, minutes);
    this.log({ kind: "enrollment-opened", actor, note: `until ${until.toISOString()}` });
    this.changed(owner);
    return until;
  }

  // ── schedule ─────────────────────────────────────────────────────────

  /**
   * One cron tick. Delivers every due slot, records the ones that fall in
   * Shabbat/Yom Tov as skipped (they fold into the next message). `dry`
   * composes and reports without touching anything — and is the only mode
   * that accepts a caller-supplied time.
   */
  async tick(opts: { dry?: boolean; at?: Date } = {}): Promise<{ now: string; actions: Array<{ slot: string; action: "delivered" | "skipped" | "would-deliver"; reason?: string; texts?: Record<string, string> }> }> {
    const dry = opts.dry === true;
    const now = dry && opts.at ? opts.at : this.clock();
    const ledger = this.store.schedule();
    const actions: Array<{ slot: string; action: "delivered" | "skipped" | "would-deliver"; reason?: string; texts?: Record<string, string> }> = [];
    for (const slot of dueSlots(this.cfg, now, ledger)) {
      const r = restrictionAt(slot.at, this.cfg.place);
      const r2 = r.restricted ? r : restrictionAt(now, this.cfg.place);
      if (r2.restricted) {
        const reason = r2.reason ?? "Shabbat";
        actions.push({ slot: slot.key, action: "skipped", reason });
        if (!dry) {
          ledger.skipped.push({ slot: slot.key, reason, at: now.toISOString(), folded_into: null });
          this.log({ kind: "scheduled", actor: "schedule", how: "skipped", note: `${slot.key} (${reason})` });
        }
        continue;
      }
      const folded = ledger.skipped.filter((s) => !s.folded_into).map((s) => ({ slot: s.slot, reason: s.reason }));
      const texts: Record<string, string> = {};
      for (const owner of this.owners) {
        texts[owner] = this.deliver(slot, owner, now, ledger, folded, dry);
      }
      actions.push({ slot: slot.key, action: dry ? "would-deliver" : "delivered", texts });
      if (!dry) {
        ledger.delivered[slot.key] = now.toISOString();
        if (slot.kind === "digest") ledger.last_digest_at = now.toISOString();
        else if (slot.kind === "motzei") ledger.last_motzei_at = now.toISOString();
        else ledger.last_close_at = now.toISOString();
        for (const s of ledger.skipped) if (!s.folded_into) s.folded_into = slot.key;
        this.log({ kind: "scheduled", actor: "schedule", how: "delivered", note: slot.key });
      }
    }
    if (!dry && actions.length) this.store.setSchedule(ledger, now);
    // Approval wakes that waited out the gate or a failure go on the same minute.
    if (!dry) await this.drainWakes().catch((err) => console.error("[review] wake drain on tick failed:", err));
    if (!dry) await this.drainAlerts().catch((err) => console.error("[review] alert drain on tick failed:", err));
    return { now: now.toISOString(), actions };
  }

  /** The owner's recent messages for the close — never a credential-shaped one, never a reason to miss the close. */
  private saidLately(owner: string): Array<{ text: string; timestamp: string }> {
    try {
      return (this.deps.recentUserMessages?.(owner) ?? []).filter(
        (m) => typeof m.text === "string" && !FORBIDDEN_PATTERNS.some(([re]) => re.test(m.text)),
      );
    } catch (err) {
      console.error("[review] reading recent messages for the close failed (non-fatal):", err);
      return [];
    }
  }

  private deliver(slot: Slot, owner: string, now: Date, ledger: ReturnType<ReviewStore["schedule"]>, folded: Array<{ slot: string; reason: string }>, dry: boolean): string {
    const week = 7 * 86_400_000;
    const floor = new Date(now.getTime() - week);
    // A close reports since the last close OR motzei, whichever is later —
    // so the Sunday close never repeats what the motzei message just said.
    const lastClose = Math.max(ledger.last_close_at ? Date.parse(ledger.last_close_at) : 0, ledger.last_motzei_at ? Date.parse(ledger.last_motzei_at) : 0);
    const sinceRaw =
      slot.kind === "digest"
        ? ledger.last_digest_at ? new Date(ledger.last_digest_at) : new Date(now.getTime() - 3 * 86_400_000)
        : slot.kind === "motzei"
          ? slot.window?.start ?? new Date(now.getTime() - 86_400_000)
          : lastClose ? new Date(lastClose) : startOfLocalDay(now, this.cfg.tz);
    const since = sinceRaw < floor ? floor : sinceRaw;
    const builds: BuildSummary[] = readBuilds(this.buildsDir, new Date(since.getTime() - week));
    const input = {
      now,
      cfg: this.cfg,
      slot,
      items: this.itemsFor(owner),
      builds,
      since,
      folded,
      numbering: this.store.numbering(owner),
      buildsView: slot.kind === "close" ? this.buildsView(owner) : undefined,
      whatsapp: slot.kind === "close" ? this.whatsappDigest() : undefined,
      appUrl: this.appUrl,
      said: slot.kind === "close" ? this.saidLately(owner) : undefined,
    };
    const composed = slot.kind === "digest" ? composeDigest(input) : slot.kind === "motzei" ? composeMotzei(input) : composeClose(input);
    if (dry) return composed.text;

    this.store.setNumbering(owner, composed.numbering);
    this.deps.postAsAgent({ userId: owner, bot: this.agent, text: composed.text, turnId: `review-${slot.key.replace(":", "-")}` });
    for (const id of composed.remindedIds) {
      // The one reminder is out — the item now holds, quietly, in Review.
      const before = this.store.get(id);
      this.store.update(id, { reminded_at: now.toISOString(), status: "held", decided_at: now.toISOString(), decided_how: "auto-hold: one reminder sent" });
      this.log({ kind: "reminded", item_id: id, lane: "RED", actor: "schedule", note: slot.key });
      this.log({ kind: "auto-hold", item_id: id, lane: "RED", actor: "schedule", from: before?.status, to: "held" });
    }
    if (this.telegramCopy && this.deps.telegram) {
      void this.deps.telegram(owner, composed.text.replace(/\*\*/g, "").replace(/(^|\s)_([^_]+)_/g, "$1$2")).catch((err) =>
        console.error("[review] Telegram copy failed (non-fatal):", err),
      );
    }
    this.changed(owner);
    return composed.text;
  }

  // ── system alerts (Review → System) ──────────────────────────────────

  /**
   * One alert occurrence from the gateway or a Bina script. Collapses on its
   * class; a hard one wakes Michael and — only after 6 h unacknowledged —
   * pushes the owner once that day. Nothing is ever sent to Telegram.
   */
  recordAlert(input: AlertInput, actor: string): { ok: true; entry: AlertEntry; started: boolean } | DeskError {
    const v = validateAlert(input);
    if (!v.ok) return { ok: false, status: 400, code: "alert", reason: v.reason };
    for (const [re, what] of FORBIDDEN_PATTERNS) {
      if (re.test(v.value.title)) return { ok: false, status: 422, code: "sensitive", reason: `refused: the alert title contains what looks like ${what}` };
      if (re.test(v.value.detail)) v.value.detail = `(detail withheld — it contained what looks like ${what})`;
    }
    const { entry, started } = this.alerts.record(v.value, this.clock());
    if (started) this.log({ kind: "alert-started", actor, note: `${entry.severity} ${entry.class}: ${entry.title}` });
    this.changed(this.owners[0]);
    void this.drainAlerts().catch((err) => console.error("[review] alert drain failed (will retry):", err));
    return { ok: true, entry, started };
  }

  /** "Resolved" / "back online": silent — the entry closes, nothing is sent. */
  resolveAlerts(by: { class?: unknown; source?: unknown }, actor: string): string[] {
    const cls = typeof by.class === "string" && by.class ? by.class.trim().toLowerCase() : undefined;
    const source = typeof by.source === "string" && by.source ? by.source.trim().toLowerCase() : undefined;
    if (!cls && !source) return [];
    const closed = this.alerts.resolve({ class: cls, source }, this.clock());
    for (const c of closed) this.log({ kind: "alert-resolved", actor, note: c });
    if (closed.length) this.changed(this.owners[0]);
    return closed;
  }

  ackAlert(cls: string, actor: string): AlertEntry | null {
    const e = this.alerts.ack(cls, actor, this.clock());
    if (e) {
      this.log({ kind: "alert-acked", actor, note: cls });
      this.changed(this.owners[0]);
    }
    return e;
  }

  /** Push + wake what is due. One drain at a time; never inside Shabbat / Yom Tov. */
  drainAlerts(): Promise<void> {
    if (this.alertDraining) return this.alertDraining;
    this.alertDraining = this.runAlertDrain().finally(() => {
      this.alertDraining = null;
    });
    return this.alertDraining;
  }

  private async runAlertDrain(): Promise<void> {
    const now = this.clock();
    if (restrictionAt(now, this.cfg.place).restricted) return; // waits for nightfall, like every push and wake
    const owner = this.owners[0];
    const today = localIsoDate(now, this.cfg.tz);
    for (const e of this.alerts.all()) {
      const due = alertDue(e, now, this.cfg.tz);
      // A failed wake is retried, but not more than every 15 minutes.
      if (due.wake && this.waker && !(e.woke_at && now.getTime() - Date.parse(e.woke_at) < 15 * 60_000)) {
        try {
          await this.waker(owner, alertWakeText(e, now, this.cfg.tz));
          this.alerts.mark(e.class, { woke_day: today, woke_at: now.toISOString() });
          this.log({ kind: "alert-wake", actor: "desk", note: e.class });
        } catch (err) {
          this.alerts.mark(e.class, { woke_at: now.toISOString() });
          console.error(`[review] alert wake for ${e.class} failed (will retry):`, String((err as Error)?.message ?? err).slice(0, 200));
        }
      }
      if (due.push) {
        let outcome: PushOutcome = "failed";
        try {
          outcome = await this.deps.push(owner, { title: "AHI system", body: alertPushBody(e, now, this.cfg.tz), url: "/?review=", tag: `alert-${e.class}`, source: "connections", event: "attention" });
        } catch (err) {
          console.error("[review] alert push failed (non-fatal):", err);
        }
        // Quiet hours / a failed send try again later the same day; anything else counts as today's one.
        if (outcome !== "quiet-hours" && outcome !== "failed") {
          this.alerts.mark(e.class, { pushed_day: today, pushed_at: now.toISOString() });
          this.log({ kind: "alert-pushed", actor: "desk", note: `${e.class} (${outcome})` });
        }
      }
    }
  }

  // ── chat replies ("yes 1, 2, no 3") ──────────────────────────────────

  /**
   * Called by /app/send right after the user's message is stored. Returns
   * true when the message WAS a digest answer and has been handled (the
   * caller then skips the agent turn). Only YELLOW items can be decided
   * here; RED is refused by the lane rules no matter what the text says.
   */
  tryChatReply(user: { userId: string; admin: boolean }, bot: string, text: string): boolean {
    if (!this.chatReplies || bot !== this.agent || !user.admin) return false;
    const parsed = parseDigestReply(text);
    if (!parsed) return false;
    const numbering = this.store.numbering(user.userId);
    if (!numbering) return false;
    const lastTurn = this.deps.lastAgentTurnId(user.userId, bot);
    if (!lastTurn || !lastTurn.startsWith("review-")) return false;

    const unknown = parsed.decisions.filter((d) => !numbering.map[String(d.n)]).map((d) => d.n);
    const turnId = `review-reply-${this.clock().getTime()}`;
    if (unknown.length) {
      const nums = Object.keys(numbering.map).map(Number).sort((a, b) => a - b);
      this.deps.postAsAgent({
        userId: user.userId,
        bot,
        turnId,
        text: `Didn't apply anything — ${unknown.join(", ")} ${unknown.length === 1 ? "isn't" : "aren't"} on the list${nums.length ? ` (${nums[0]}–${nums[nums.length - 1]})` : ""}. Try again, or open Review.`,
      });
      return true;
    }
    const lines = { approve: [] as string[], deny: [] as string[], hold: [] as string[], skipped: [] as string[] };
    for (const d of parsed.decisions) {
      const item = this.store.get(numbering.map[String(d.n)]);
      if (!item || item.owner !== user.userId) {
        lines.skipped.push(`${d.n} (gone)`);
        continue;
      }
      const r = this.apply(item, d.decision, "chat", user.userId, null, `chat: ${numbering.source}`);
      if (r.ok) lines[d.decision].push(`${d.n} · ${item.title}`);
      else lines.skipped.push(`${d.n} (${r.reason})`);
    }
    const out = ["Got it."];
    if (lines.approve.length) out.push(`- Approved: ${lines.approve.join("; ")}`);
    if (lines.deny.length) out.push(`- No: ${lines.deny.join("; ")}`);
    if (lines.hold.length) out.push(`- Holding: ${lines.hold.join("; ")}`);
    if (lines.skipped.length) out.push(`- Left alone: ${lines.skipped.join("; ")}`);
    this.deps.postAsAgent({ userId: user.userId, bot, turnId, text: out.join("\n") });
    return true;
  }
}

// ── card announcement text ─────────────────────────────────────────────

/**
 * Plain words only — a title can carry a build id, a path, a hash or code,
 * and none of that belongs in a sentence read aloud.
 */
export function speakableTitle(title: string): string {
  // A bracket that held only ids ("(build 2026…, branch feat/x)") goes whole.
  const bracketed = title.replace(/\(([^()]*)\)|\[([^\[\]]*)\]/g, (m, a: string | undefined, b: string | undefined) => {
    const inner = stripCode(a ?? b ?? "");
    const words = inner.split(/[\s,;:]+/).filter((w) => w && !BRACKET_FILLER.has(w.toLowerCase()));
    return words.length ? m.replace(a ?? b ?? "", inner) : " ";
  });
  return stripCode(bracketed);
}

const BRACKET_FILLER = new Set(["build", "branch", "ref", "id", "see", "commit", "pr", "on", "at", "in", "the", "and", "@"]);

function stripCode(title: string): string {
  return title
    .replace(/`[^`]*`/g, " ")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/(^|\s)(?:~|\.{1,2})?\/[\w.@~-]+(?:\/[\w.@~-]+)*\/?/g, " ") // absolute paths
    .replace(/\b[\w~-]+(?:\/[\w.@~-]+)+/g, (m) => (/[-.~_]/.test(m) ? " " : m)) // relative paths, branches (kept: "and/or", "GV70/GV80")
    .replace(/\b\d{8}-\d{6}(?:-[\w-]+)?\b/g, " ") // foreman build ids
    .replace(/\b(?:rv|trk|bld)-[\w.-]+/g, " ") // desk ids
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/gi, " ") // commit hashes
    .replace(/\b[\w-]+\.(?:ts|tsx|js|mjs|sh|py|json|md)\b/g, " ") // file names
    .replace(/\s*([(\[{]\s*[)\]}])\s*/g, " ") // brackets left empty
    .replace(/(^|\s)[@#:]+(?=\s|[,.;]|$)/g, " ") // stray symbols left behind
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.;:—–-]+|[\s,;:—–-]+$/g, "")
    .trim();
}

export function announcementText(item: Pick<ReviewItem, "lane" | "title" | "desk">): string {
  const title = speakableTitle(item.title).replace(/[.!?]+$/, "") || `A new card from ${item.desk}`;
  if (item.lane === "GREEN") return `${title} — done, and logged in Reviews.`;
  if (item.lane === "RED") return `${title} is ready for you in Reviews. It needs your fingerprint.`;
  return `${title} is ready for you in Reviews.`;
}
