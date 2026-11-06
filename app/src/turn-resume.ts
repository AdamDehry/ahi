/**
 * turn-resume.ts — finish the turns a gateway restart killed: when a computer
 * reboots, something triggers automatically, and the same goes for the gateway.
 *
 * At boot, every in-flight marker left by the previous process
 * (turn-journal.ts) is an orphan: the owner's message got no reply. For each,
 * oldest first:
 *   - interrupted within TURN_RESUME_MAX_AGE_MIN (30) of the restart → re-run
 *     the turn as a normal reply in the owner's SAME thread, with a one-line note
 *     telling the agent what happened and to check state before redoing work;
 *   - older → no turn; one short line in the thread offering to pick it up.
 * Exactly once per marker: the outcome is written to the journal's ledger
 * before the marker goes. Each resume run is recorded BEFORE it starts, so a
 * crash during it is seen by the next boot — which retries once, then gives
 * up loudly (a line in the thread + an error in the log).
 * Inside Shabbat / Yom Tov everything waits for nightfall, as approval wakes do.
 *
 * Markers created after this boot belong to live turns and are never touched.
 */
import type { InflightTurn, TurnJournal } from "./turn-journal.js";
import { DEFAULT_TIMEZONE, formatClock, formatShortDay, isValidTimeZone, localDateKey } from "./local-time.js";

export interface ResumeRestriction {
  restricted: boolean;
  reason: string | null;
  until: Date | null;
}

/** A failure that is not the turn's fault (bot at its concurrency cap): retry without spending an attempt. */
export class TransientResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientResumeError";
  }
}

export interface ResumeDeps {
  journal: TurnJournal;
  clock?: () => Date;
  /** Shabbat / Yom Tov gate (may_execute). */
  restriction: (at: Date) => ResumeRestriction;
  /** the owner's timezone, for every time shown to him or about him. */
  timeZone: (userId: string) => string | null;
  /** First name for the note ("the owner"). */
  userName: (userId: string) => string;
  /**
   * Re-run the turn with `prompt` and deliver the reply into the marker's
   * thread. Resolves "cancelled" when the person stopped it.
   */
  run: (marker: InflightTurn, prompt: string) => Promise<"delivered" | "cancelled">;
  /** Post one short line into the marker's thread — no agent turn. */
  notice: (marker: InflightTurn, text: string) => Promise<void>;
  log?: (line: string) => void;
  error?: (line: string) => void;
  maxAgeMs?: number;
  /** Resume runs per marker, crash retries included. */
  maxAttempts?: number;
}

export interface ResumeSummary {
  resumed: number;
  noticed: number;
  deferred: number;
  failed: number;
  gaveUp: number;
  skipped: number;
}

const RETRY_MS = 60_000;
const TRANSIENT_RETRY_MS = 30_000;
const NOTICE_TRIES = 3;
const MAX_TIMER_MS = 60 * 60_000;

export function resumeMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TURN_RESUME_MAX_AGE_MIN);
  return Number.isFinite(n) && n > 0 ? n * 60_000 : 30 * 60_000;
}

export class TurnResumer {
  private readonly clock: () => Date;
  private readonly bootAt: Date;
  private readonly inProgress = new Set<string>();
  private draining: Promise<ResumeSummary> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private noticeTries = new Map<string, number>();
  private transientTries = new Map<string, number>();

  constructor(private readonly deps: ResumeDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.bootAt = this.clock();
  }

  private log(line: string): void {
    (this.deps.log ?? console.log)(`[turn-resume] ${line}`);
  }

  private err(line: string): void {
    (this.deps.error ?? console.error)(`[turn-resume] ${line}`);
  }

  private tz(userId: string): string {
    const z = this.deps.timeZone(userId);
    return isValidTimeZone(z) ? z : DEFAULT_TIMEZONE;
  }

  /** "3:42 PM", or "Wed Oct 7, 3:42 PM" when not today (the owner's local time). */
  clockFor(iso: string, userId: string): string {
    const tz = this.tz(userId);
    const at = new Date(iso);
    const clock = formatClock(at, tz);
    return localDateKey(at, tz) === localDateKey(this.clock(), tz) ? clock : `${formatShortDay(at, tz)}, ${clock}`;
  }

  /** The one-line note prepended to the resumed turn. */
  resumePrompt(m: InflightTurn): string {
    const restart = this.clockFor(m.resume.orphanedAt ?? this.bootAt.toISOString(), m.userId);
    const sent = this.clockFor(m.startedAt, m.userId);
    return (
      `[A gateway restart interrupted this turn at ${restart}; finish your reply. Don't redo actions you already completed — ` +
      `check state first (logs, git, files). ${this.deps.userName(m.userId)} sent the message below at ${sent}.]\n\n${m.prompt}`
    );
  }

  staleNotice(m: InflightTurn): string {
    return `A restart cut off my reply to your ${this.clockFor(m.startedAt, m.userId)} message — want me to pick it up?`;
  }

  gaveUpNotice(m: InflightTurn): string {
    return `I couldn't finish my reply to your ${this.clockFor(m.startedAt, m.userId)} message after a restart — tried twice. Send it again and I'll take it from the top.`;
  }

  /**
   * Boot: claim every marker the previous process left (stamp orphanedAt
   * once — a deferred marker keeps its first stamp), then drain.
   */
  async boot(): Promise<ResumeSummary> {
    const markers = this.deps.journal.list((f, e) => this.err(`unreadable marker ${f}: ${e.message}`));
    const stamp = this.bootAt.toISOString();
    for (const m of markers) {
      if (Date.parse(m.startedAt) > this.bootAt.getTime()) continue; // a live turn of this process
      if (!m.resume.orphanedAt) this.deps.journal.update(m.key, { orphanedAt: stamp });
    }
    const orphans = markers.filter((m) => Date.parse(m.startedAt) <= this.bootAt.getTime()).length;
    if (orphans) this.log(`boot: ${orphans} interrupted turn(s) found`);
    return this.drain();
  }

  /** One drain at a time; a second caller gets the running one. */
  drain(): Promise<ResumeSummary> {
    if (this.draining) return this.draining;
    this.draining = this.runDrain().finally(() => {
      this.draining = null;
      this.schedule();
    });
    return this.draining;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private orphans(): InflightTurn[] {
    return this.deps.journal
      .list((f, e) => this.err(`unreadable marker ${f}: ${e.message}`))
      .filter((m) => m.resume.orphanedAt !== null && !this.inProgress.has(m.key));
  }

  private schedule(): void {
    this.stop();
    const next = this.orphans()
      .map((m) => (m.resume.notBefore ? Date.parse(m.resume.notBefore) : NaN))
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;
    const delay = Math.min(Math.max(next - this.clock().getTime(), 1_000), MAX_TIMER_MS);
    this.timer = setTimeout(() => void this.drain().catch((e) => this.err(`drain failed: ${(e as Error).message}`)), delay);
    this.timer.unref?.();
  }

  private async runDrain(): Promise<ResumeSummary> {
    const out: ResumeSummary = { resumed: 0, noticed: 0, deferred: 0, failed: 0, gaveUp: 0, skipped: 0 };
    const maxAge = this.deps.maxAgeMs ?? resumeMaxAgeMs();
    const maxAttempts = this.deps.maxAttempts ?? 2;

    for (const m of this.orphans()) {
      const now = this.clock();
      const who = `${m.bot}/${m.userId} ${m.surface} (sent ${m.startedAt})`;

      // Exactly once: a settled key whose file somehow survived is just removed.
      const settled = this.deps.journal.settled(m.key);
      if (settled) {
        this.deps.journal.clear(m.key);
        this.log(`already ${settled.outcome}: ${who} — duplicate marker removed`);
        out.skipped++;
        continue;
      }
      if (m.resume.notBefore && Date.parse(m.resume.notBefore) > now.getTime()) continue;

      const gate = this.deps.restriction(now);
      if (gate.restricted) {
        const until = (gate.until ?? new Date(now.getTime() + 60 * 60_000)).toISOString();
        const waiting = `gate: ${gate.reason ?? "restricted"}`;
        if (m.resume.waiting !== waiting) this.log(`deferred to ${until} (${gate.reason}): ${who}`);
        this.deps.journal.update(m.key, { notBefore: until, waiting });
        out.deferred++;
        continue;
      }

      const age = Date.parse(m.resume.orphanedAt!) - Date.parse(m.startedAt);
      if (age > maxAge) {
        await this.sendNotice(m, this.staleNotice(m), "stale-notice", out, who);
        continue;
      }

      if (m.resume.attempts >= maxAttempts) {
        this.err(`GAVE UP after ${m.resume.attempts} resume attempt(s): ${who} — telling them in the thread`);
        await this.sendNotice(m, this.gaveUpNotice(m), "gave-up", out, who);
        continue;
      }

      // Recorded BEFORE the run: a crash from here on is visible to the next boot.
      const attempt = m.resume.attempts + 1;
      this.deps.journal.update(m.key, { attempts: attempt, notBefore: null, waiting: null });
      this.inProgress.add(m.key);
      this.log(`resuming (attempt ${attempt}/${maxAttempts}): ${who}`);
      try {
        const how = await this.deps.run(m, this.resumePrompt(m));
        this.deps.journal.settle(m.key, how === "cancelled" ? "dropped" : "resumed", this.clock(), how === "cancelled" ? "stopped by the user" : `attempt ${attempt}`);
        this.log(`${how === "cancelled" ? "stopped by the user" : "reply delivered"}: ${who}`);
        if (how === "delivered") out.resumed++;
        else out.skipped++;
      } catch (e) {
        const msg = String((e as Error)?.message ?? e).slice(0, 200);
        if (e instanceof TransientResumeError && (this.transientTries.get(m.key) ?? 0) < 20) {
          this.transientTries.set(m.key, (this.transientTries.get(m.key) ?? 0) + 1);
          this.deps.journal.update(m.key, { attempts: m.resume.attempts, notBefore: new Date(this.clock().getTime() + TRANSIENT_RETRY_MS).toISOString(), waiting: `busy: ${msg}` });
          this.log(`busy, retrying in ${TRANSIENT_RETRY_MS / 1000}s: ${who}`);
        } else {
          this.err(`resume attempt ${attempt} failed: ${who}: ${msg}`);
          this.deps.journal.update(m.key, { notBefore: new Date(this.clock().getTime() + RETRY_MS).toISOString(), waiting: `retry: ${msg}` });
          out.failed++;
        }
      } finally {
        this.inProgress.delete(m.key);
      }
    }
    return out;
  }

  private async sendNotice(m: InflightTurn, text: string, outcome: "stale-notice" | "gave-up", out: ResumeSummary, who: string): Promise<void> {
    try {
      await this.deps.notice(m, text);
      this.deps.journal.settle(m.key, outcome, this.clock());
      this.log(`${outcome}: ${who}`);
      if (outcome === "gave-up") out.gaveUp++;
      else out.noticed++;
    } catch (e) {
      const tries = (this.noticeTries.get(m.key) ?? 0) + 1;
      this.noticeTries.set(m.key, tries);
      const msg = String((e as Error)?.message ?? e).slice(0, 200);
      if (tries >= NOTICE_TRIES) {
        this.err(`could not post the ${outcome} line after ${tries} tries — dropping: ${who}: ${msg}`);
        this.deps.journal.settle(m.key, "dropped", this.clock(), `notice failed: ${msg}`);
        out.failed++;
        return;
      }
      this.deps.journal.update(m.key, { notBefore: new Date(this.clock().getTime() + RETRY_MS).toISOString(), waiting: `retry: ${msg}` });
      out.failed++;
    }
  }
}
