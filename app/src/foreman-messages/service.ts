/**
 * service.ts — the foreman-messages desk: one ingest path, one wake path.
 *
 * ingest(record)
 *   1. parse (record.ts). Structural failure → refused, nothing stored.
 *   2. claim the record id — the same record forwarded twice is a no-op.
 *   3. progress → timeline only (a progress that answers an open question also
 *      rings the app's change signal — the card stops asking).
 *      needs_operator | closed | failed → claim the chat key; first claim posts the
 *      rendered message to the owner's thread, every later one is timeline-only with
 *      `dedupedBy` naming the key that already spoke.
 *   4. append to the build's timeline (always — the app panel reads all kinds).
 *
 * wake(text)
 *   Michael's supervision wake, minus the owner's surface. The full raw text goes to
 *   Michael's turn exactly as before; the wake is NOT broadcast into the owner's
 *   feed, no stream events reach his screen, and Michael's reply is kept on the
 *   build's timeline instead of posted to the chat. Michael reaches the owner
 *   through a needs_operator record (build_ask.sh), which renders like any other.
 *
 * Side effects arrive as injected deps, so this runs in tests with no gateway.
 */
import { CHAT_KINDS, parseRecord, type ParseResult } from "./record.js";
import { chatKey, displayName, renderForOperator } from "./render.js";
import { ForemanTimeline } from "./timeline.js";
import { ANSWERED_FINISHED, hasOpenQuestion, openQuestionId } from "./answer.js";
import { parseStage, renderReady, shipState, shipWakeText, type RestartChoice, type ShipState } from "./ship.js";

export interface ForemanMessagesDeps {
  /** Persist + deliver one message into the user's thread as the agent. */
  postAsAgent(msg: { userId: string; bot: string; text: string; build: string; kind: string }): void;
  /** Optional Telegram copy of chat messages (FOREMAN_MESSAGES_TELEGRAM=true). */
  telegram?(userId: string, text: string): Promise<void>;
  /** Run Michael's supervision turn on the raw wake; resolves to his reply text. */
  invokeWake?(userId: string, text: string): Promise<string>;
  /** Something on a build's timeline changed in a way the app shows (an ask, a close, a ship stage). */
  onBuildChange?(build: string): void;
  /** A ship reached its result — the review desk closes the card / marks the review item done. */
  onShipResult?(state: ShipState): void;
  /** The exact command Michael runs for a build's ship. Default: the live checkout's ship.sh. */
  shipCommand?(build: string, restart: RestartChoice): string;
  now?: () => Date;
  log?: (msg: string) => void;
}

export const DEFAULT_SHIP_COMMAND = (build: string, restart: RestartChoice) =>
  `~/AHI/AHI_OS/gateway/scripts/ship/ship.sh ${build}${restart === "now" ? " --now" : ""}`;

export type ShipIngestOutcome =
  | { ok: false; status: 422; errors: string[] }
  | { ok: true; duplicate: boolean; build: string; stage: string; chat: boolean; state: ShipState | null };

export type IngestOutcome =
  | { ok: false; status: 422; errors: string[]; textErrors: ParseResult["textErrors"] }
  | {
      ok: true;
      duplicate: boolean;
      build: string;
      kind: string;
      chat: boolean;
      dedupedBy: string | null;
      rendered: string | null;
      textErrors: ParseResult["textErrors"];
    };

/** Fixed note appended to every quiet wake, so Michael knows where his reply goes. */
export const WAKE_DELIVERY_NOTE =
  "\n\n(delivery: this wake and your reply stay off the owner's chat — your reply is kept on the build's timeline. " +
  "The owner's chat gets only \"I need you\", \"Build closed\" and \"Build failed\", rendered in code from status records. " +
  "To put a question in front of the owner: ~/AHI/AHI_OS/foreman/bin/build_ask.sh <build-id> \"<one question?>\")";

const WAKE_BUILD_RE = /\bbuild (\d{8}-\d{6}-[a-z0-9][a-z0-9._-]{0,80})\b/;

/** The build a wake is about, from its first line only (the body carries transcripts). */
export function wakeBuildId(text: string): string | null {
  const first = text.split("\n", 1)[0] ?? "";
  return WAKE_BUILD_RE.exec(first)?.[1] ?? null;
}

export class ForemanMessages {
  readonly timeline: ForemanTimeline;
  private readonly deps: ForemanMessagesDeps;
  private readonly agent: string;
  private readonly telegramCopy: boolean;

  /** Hooks bound after both desks are up (index.ts): the review desk's ship-landed and the app's change signal. */
  private hooks: Partial<Pick<ForemanMessagesDeps, "onShipResult" | "onBuildChange" | "shipCommand">> = {};

  constructor(opts: { deps: ForemanMessagesDeps; root?: string; agent?: string; telegramCopy?: boolean }) {
    this.deps = opts.deps;
    this.timeline = new ForemanTimeline(opts.root);
    this.agent = opts.agent ?? "michael";
    this.telegramCopy = opts.telegramCopy ?? false;
  }

  /** App answers being written, by build: the question each answers and the line its record will carry. */
  private readonly answerGuards = new Map<string, Array<{ record: string; line: string }>>();

  /**
   * Hold `build` to the question `record` while its answer is written: the
   * answered record build_answered.sh posts with `line` is refused if, by the
   * time it lands, that question is no longer the run's newest record. Records
   * from anyone else (the run moving on, Michael by hand) pass as before.
   */
  guardAnswer(build: string, record: string, line: string): () => void {
    const g = { record, line };
    this.answerGuards.set(build, [...(this.answerGuards.get(build) ?? []), g]);
    return () => {
      const rest = (this.answerGuards.get(build) ?? []).filter((x) => x !== g);
      if (rest.length) this.answerGuards.set(build, rest);
      else this.answerGuards.delete(build);
    };
  }

  /** An app answer's record whose question is no longer the newest: refuse it. Null = let it in. */
  private staleAnswer(rec: { build: string; kind: string; source?: string; finished?: string; now?: string }): string | null {
    if (rec.kind !== "progress" || rec.source !== "michael" || rec.finished !== ANSWERED_FINISHED) return null;
    const mine = (this.answerGuards.get(rec.build) ?? []).filter((g) => g.line === rec.now);
    if (!mine.length) return null;
    const open = openQuestionId(this.timeline.read(rec.build));
    return mine.some((g) => g.record === open) ? null : "the question this answer was for is no longer the build's newest record";
  }

  bind(hooks: Partial<Pick<ForemanMessagesDeps, "onShipResult" | "onBuildChange" | "shipCommand">>): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  private nowIso(): string {
    return (this.deps.now ? this.deps.now() : new Date()).toISOString();
  }

  ingest(input: unknown, opts: { userId: string }): IngestOutcome {
    // `source` comes from the body. It is stamped by foreman code (fm_status.py
    // forward sets "executor" on every line it reads from a worktree), never by
    // the executor: an executor writes a file and holds no gateway credential.
    const parsed = parseRecord(input);
    if (!parsed.ok || !parsed.record) {
      return { ok: false, status: 422, errors: parsed.errors, textErrors: parsed.textErrors };
    }
    const rec = parsed.record;

    const stale = this.staleAnswer(rec);
    if (stale) return { ok: false, status: 422, errors: [stale], textErrors: parsed.textErrors };

    if (!this.timeline.claim(`id:${rec.build}:${rec.id}`)) {
      return { ok: true, duplicate: true, build: rec.build, kind: rec.kind, chat: false, dedupedBy: `id:${rec.id}`, rendered: null, textErrors: parsed.textErrors };
    }

    let chat = false;
    let rendered: string | null = null;
    let dedupedBy: string | null = null;
    const key = CHAT_KINDS.has(rec.kind) ? chatKey(rec) : null;
    if (key) {
      if (this.timeline.claim(`chat:${key}`)) {
        rendered = renderForOperator(parsed);
        if (rendered) {
          try {
            this.deps.postAsAgent({ userId: opts.userId, bot: this.agent, text: rendered, build: rec.build, kind: rec.kind });
            chat = true;
          } catch (err) {
            // Delivery failed: give the key back so the next path can say it,
            // and give the record id back so a retry of THIS record is not a no-op.
            this.timeline.release(`chat:${key}`);
            this.timeline.release(`id:${rec.build}:${rec.id}`);
            throw err;
          }
          if (this.telegramCopy && this.deps.telegram) {
            this.deps.telegram(opts.userId, rendered.replace(/\*\*/g, "")).catch((e) =>
              this.deps.log?.(`[foreman-messages] telegram copy failed: ${String(e)}`),
            );
          }
        }
      } else {
        dedupedBy = key;
      }
    }

    // A progress that lands on an open question answers it (build_answered.sh, or the
    // run moving on) — the card stops asking, so the app must refetch like any ask/close.
    const answers = rec.kind === "progress" && hasOpenQuestion(this.timeline.read(rec.build));
    this.timeline.append(rec.build, {
      ts: this.nowIso(),
      type: "record",
      record: rec,
      chat,
      rendered: chat ? rendered : null,
      dedupedBy,
      textErrors: parsed.textErrors as Record<string, string[]>,
    });
    if (rec.kind !== "progress" || answers) this.notifyChange(rec.build);
    return { ok: true, duplicate: false, build: rec.build, kind: rec.kind, chat, dedupedBy, rendered: chat ? rendered : null, textErrors: parsed.textErrors };
  }

  private notifyChange(build: string): void {
    try {
      (this.hooks.onBuildChange ?? this.deps.onBuildChange)?.(build);
    } catch (err) {
      this.deps.log?.(`[foreman-messages] change hook failed: ${String(err)}`);
    }
  }

  // ── the ship lane (ship.ts) ───────────────────────────────────────────

  shipState(build: string): ShipState | null {
    return shipState(build, this.timeline.read(build));
  }

  /**
   * One ship stage from ship_ready.sh / ship.sh / ship-restart.sh. Same id
   * twice is a no-op. A `ready` says "Ready to ship" in the owner's chat exactly
   * once per reviewed tip; every other stage is timeline-only (the app shows
   * them). A `result` hands the state to the review desk.
   */
  shipIngest(input: unknown, opts: { userId: string; title?: string | null }): ShipIngestOutcome {
    const parsed = parseStage(input);
    if (!parsed.ok) return { ok: false, status: 422, errors: parsed.errors };
    const e = parsed.entry;
    if (!this.timeline.claim(`ship:${e.build}:${e.id}`)) {
      return { ok: true, duplicate: true, build: e.build, stage: e.stage, chat: false, state: this.shipState(e.build) };
    }
    this.timeline.append(e.build, { ts: this.nowIso(), ...e });
    const state = this.shipState(e.build);
    let chat = false;
    if (e.stage === "ready" && state && this.timeline.claim(`chat:ship:${e.build}:${e.id}`)) {
      const name = displayName({ build: e.build, title: opts.title ?? null });
      const text = renderReady(name, state);
      try {
        this.deps.postAsAgent({ userId: opts.userId, bot: this.agent, text, build: e.build, kind: "ship" });
        chat = true;
        if (this.telegramCopy && this.deps.telegram) {
          this.deps.telegram(opts.userId, text.replace(/\*\*/g, "")).catch((err) => this.deps.log?.(`[foreman-messages] telegram copy failed: ${String(err)}`));
        }
      } catch (err) {
        this.timeline.release(`chat:ship:${e.build}:${e.id}`);
        this.deps.log?.(`[foreman-messages] ready-to-ship chat failed: ${String(err)}`);
      }
    }
    if (e.stage === "result" && state) {
      try {
        (this.hooks.onShipResult ?? this.deps.onShipResult)?.(state);
      } catch (err) {
        this.deps.log?.(`[foreman-messages] ship result hook failed: ${String(err)}`);
      }
    }
    this.notifyChange(e.build);
    return { ok: true, duplicate: false, build: e.build, stage: e.stage, chat, state };
  }

  /**
   * The owner tapped Ship. Records the approval once per ready (a second tap, a
   * retry, a duplicate wake: same entry) and wakes Michael with the envelope.
   * A tap on an approved-but-unwoken ship wakes again; a tap on a ship that is
   * already running or done changes nothing and says so.
   */
  async shipApprove(opts: { build: string; userId: string; by: string; restart: RestartChoice; title: string }): Promise<{ ok: true; state: ShipState; woke: boolean; already: boolean } | { ok: false; status: 404 | 409; reason: string }> {
    const before = this.shipState(opts.build);
    if (!before) return { ok: false, status: 404, reason: "Nothing is ready to ship on this build" };
    if (before.phase === "candidate") return { ok: false, status: 409, reason: "Built, but Michael has not reviewed it yet" };
    if (before.phase === "shipping" || before.phase === "restarting") return { ok: false, status: 409, reason: "It is shipping right now" };
    if (before.phase === "shipped") return { ok: false, status: 409, reason: "Already shipped" };
    const already = before.phase === "approved";
    const id = `approved-${opts.build}-${before.ready_at ?? "x"}`;
    if (!already) {
      // `by` on the entry is the user id (the desk closes the card as that owner); the name rides in the wake.
      const parsed = parseStage({ build: opts.build, stage: "approved", id, by: opts.userId, restart: opts.restart });
      if (!parsed.ok) return { ok: false, status: 409, reason: parsed.errors.join("; ") };
      if (this.timeline.claim(`ship:${opts.build}:${id}`)) this.timeline.append(opts.build, { ts: this.nowIso(), ...parsed.entry });
    }
    const state = this.shipState(opts.build)!;
    this.notifyChange(opts.build);
    const command = (this.hooks.shipCommand ?? this.deps.shipCommand ?? DEFAULT_SHIP_COMMAND)(opts.build, state.approved?.restart ?? opts.restart);
    const text = shipWakeText({ build: opts.build, title: opts.title, by: opts.by, restart: state.approved?.restart ?? opts.restart, command, summary: state.summary });
    let woke = false;
    try {
      woke = await this.wake(opts.userId, text);
    } catch (err) {
      this.deps.log?.(`[foreman-messages] ship wake failed: ${String(err)}`);
    }
    return { ok: true, state, woke, already };
  }

  /**
   * Quiet wake. Resolves when Michael's turn finishes (the route does not
   * await it) — true when the turn ran, false when it failed. Throws only when
   * no wake path is configured; a failed turn is logged and recorded on the
   * timeline, never thrown. (The review desk's approval wakes read the result
   * to know whether to retry.)
   */
  async wake(userId: string, text: string): Promise<boolean> {
    const build = wakeBuildId(text);
    const record = (e: Parameters<ForemanTimeline["append"]>[1]) => {
      if (!build) return;
      try {
        this.timeline.append(build, e);
      } catch (err) {
        this.deps.log?.(`[foreman-messages] timeline append failed: ${String(err)}`);
      }
    };
    if (!this.deps.invokeWake) throw new Error("wake path not configured");
    try {
      const reply = await this.deps.invokeWake(userId, text + WAKE_DELIVERY_NOTE);
      record({ ts: this.nowIso(), type: "michael-wake", bytes: Buffer.byteLength(text), ok: true });
      if (reply && reply.trim()) record({ ts: this.nowIso(), type: "michael-reply", text: reply });
      return true;
    } catch (err) {
      this.deps.log?.(`[foreman-messages] wake turn failed: ${String(err)}`);
      record({ ts: this.nowIso(), type: "michael-wake", bytes: Buffer.byteLength(text), ok: false, error: String(err).slice(0, 300) });
      return false;
    }
  }
}
