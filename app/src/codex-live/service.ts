/**
 * service.ts — a Codex build's live transcript, tailed from its rollout.
 *
 * read(build, after) answers the app's one question: "what happened since
 * event N, and what is it doing now?" State per build is a byte offset into
 * the rollout plus the events parsed so far. Every read stats the file and
 * parses only the bytes appended since; a partial trailing line waits for its
 * newline. Nothing is persisted: after a gateway restart the first read
 * re-parses the file from byte 0, and because parsing is deterministic the
 * event numbers come out identical, so a phone holding `after=N` from before
 * the restart picks up exactly where it was.
 *
 * Push: builds read in the last WATCH_MS are watched (a 1 s stat). When a
 * watched rollout grows, or a build's state changes, one tiny admin-only
 * `codex-live` frame goes out over the app's existing socket — it carries no
 * transcript, only "build X moved", and the app fetches the delta over HTTP.
 * The socket is a doorbell; HTTP is the source of truth, so a dropped frame
 * costs at most one poll interval.
 */
import { closeSync, openSync, readSync, statSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { defaultForemanBuildsDir } from "../review/ledger.js";
import { locateRollout, readBuildMeta, type BuildMeta } from "./locate.js";
import { defaultRedactor, type Redactor } from "./redact.js";
import { newParseState, parseLine, type LiveEvent, type ParseState } from "./rollout.js";

export type LiveStatus = "starting" | "running" | "waiting" | "done" | "failed" | "stopped" | "stalled" | "not-codex" | "no-session";

export interface LiveView {
  build: string;
  status: LiveStatus;
  /** What it is doing right now: the command in flight, or null. */
  now: { text: string; since: string } | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Server clock, so the phone can tick elapsed without trusting its own. */
  serverNow: string;
  lastActivityAt: string | null;
  session: { id: string; model: string | null; effort: string | null; cli: string | null } | null;
  events: LiveEvent[];
  /** Highest event number in this build so far (send it back as `after`). */
  cursor: number;
  /** Events older than the window that were left out of this answer. */
  omitted: number;
  /** The rollout was rewritten/truncated: drop what you hold and take this whole answer. */
  reset: boolean;
}

interface Tail {
  path: string;
  offset: number;
  size: number;
  ino: number;
  st: ParseState;
  events: LiveEvent[];
  dropped: number;
  partial: Buffer;
}

interface Entry {
  meta: BuildMeta;
  metaAt: number;
  tail: Tail | null;
  lookedAt: number;
  viewedAt: number;
  signature: string;
}

const MAX_EVENTS = 1500;
const DEFAULT_WINDOW = 300;
const META_TTL_MS = 2_000;
const LOOK_EVERY_MS = 2_000;
const WATCH_MS = 60_000;
const EVICT_MS = 15 * 60_000;
const READ_CHUNK = 1024 * 1024;

const TERMINAL: Record<string, LiveStatus> = { done: "done", shipped: "done", failed: "failed", abandoned: "stopped", stalled: "stalled" };

export interface CodexLiveOpts {
  buildsDir?: string;
  codexHome?: string;
  redactor?: Redactor;
  now?: () => number;
  /** The doorbell. Default: none (tests); installCodexLive wires the socket. */
  notify?: (build: string) => void;
  pollMs?: number;
}

export class CodexLive {
  readonly buildsDir: string;
  readonly codexHome: string;
  private readonly redactor: Redactor;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: CodexLiveOpts = {}) {
    this.buildsDir = opts.buildsDir ?? defaultForemanBuildsDir();
    this.codexHome = opts.codexHome ?? (process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : resolve(homedir(), ".codex"));
    this.redactor = opts.redactor ?? defaultRedactor();
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer || !this.opts.notify) return;
    this.timer = setInterval(() => this.tick(), this.opts.pollMs ?? 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The app's read. null = no such build. */
  read(build: string, after = 0, window = DEFAULT_WINDOW): LiveView | null {
    const e = this.entry(build, true);
    if (!e) return null;
    e.viewedAt = this.now();
    let reset = false;
    if (e.meta.runtime === "codex") reset = this.advance(e);
    return this.view(e, reset ? 0 : after, window, reset);
  }

  /** Watcher tick: advance every recently viewed build; ring the bell on change. */
  tick(): void {
    const now = this.now();
    for (const [id, e] of this.entries) {
      if (now - e.viewedAt > EVICT_MS) {
        this.entries.delete(id);
        continue;
      }
      if (now - e.viewedAt > WATCH_MS) continue;
      try {
        this.entry(id, false);
        if (e.meta.runtime === "codex") this.advance(e);
        const sig = this.signature(e);
        if (sig !== e.signature) {
          e.signature = sig;
          this.opts.notify?.(id);
        }
      } catch (err) {
        console.warn(`[codex-live] tick ${id}: ${(err as Error).message}`);
      }
    }
  }

  private signature(e: Entry): string {
    const s = this.status(e);
    return `${s}|${e.tail?.st.seq ?? 0}|${e.tail?.st.inFlight.size ?? 0}`;
  }

  private entry(build: string, create: boolean): Entry | null {
    const now = this.now();
    let e = this.entries.get(build);
    if (e && now - e.metaAt < META_TTL_MS) return e;
    const meta = readBuildMeta(this.buildsDir, build);
    if (!meta) {
      if (e) this.entries.delete(build);
      return null;
    }
    if (!e) {
      if (!create) return null;
      e = { meta, metaAt: now, tail: null, lookedAt: 0, viewedAt: now, signature: "" };
      this.entries.set(build, e);
    } else {
      e.meta = meta;
      e.metaAt = now;
    }
    return e;
  }

  /** Pull new bytes into the parsed transcript. Returns true when the file was replaced. */
  private advance(e: Entry): boolean {
    const now = this.now();
    if (!e.tail) {
      if (now - e.lookedAt < LOOK_EVERY_MS && e.lookedAt) return false;
      e.lookedAt = now;
      const found = locateRollout(this.codexHome, e.meta, now);
      if (!found) return false;
      e.tail = this.freshTail(found.path);
    }
    const t = e.tail;
    let st;
    try {
      st = statSync(t.path);
    } catch {
      return false;
    }
    let reset = false;
    if (st.ino !== t.ino && t.ino !== 0) reset = true;
    else if (st.size < t.offset + t.partial.length) reset = true;
    if (reset) {
      e.tail = this.freshTail(t.path);
      return this.advance(e) || true;
    }
    t.ino = st.ino;
    t.size = st.size;
    const start = t.offset + t.partial.length;
    if (st.size <= start) return false;
    let fd: number | null = null;
    try {
      fd = openSync(t.path, "r");
      let pos = start;
      const buf = Buffer.alloc(READ_CHUNK);
      while (pos < st.size) {
        const n = readSync(fd, buf, 0, Math.min(READ_CHUNK, st.size - pos), pos);
        if (n <= 0) break;
        pos += n;
        this.consume(e, t, buf.subarray(0, n));
      }
    } finally {
      if (fd !== null) closeSync(fd);
    }
    return false;
  }

  private freshTail(path: string): Tail {
    return { path, offset: 0, size: 0, ino: 0, st: newParseState(), events: [], dropped: 0, partial: Buffer.alloc(0) };
  }

  private consume(e: Entry, t: Tail, chunk: Buffer): void {
    let data = t.partial.length ? Buffer.concat([t.partial, chunk]) : Buffer.from(chunk);
    let nl = data.indexOf(0x0a);
    while (nl >= 0) {
      const line = data.subarray(0, nl).toString("utf8");
      t.offset += nl + 1;
      data = data.subarray(nl + 1);
      if (line.trim()) {
        const evs = parseLine(line, t.st, { redact: (s) => this.redactor.redact(s), workdir: e.meta.workdir });
        if (evs.length) t.events.push(...evs);
      }
      nl = data.indexOf(0x0a);
    }
    t.partial = Buffer.from(data);
    if (t.events.length > MAX_EVENTS) {
      const cut = t.events.length - MAX_EVENTS;
      t.events.splice(0, cut);
      t.dropped += cut;
    }
  }

  private status(e: Entry): LiveStatus {
    if (e.meta.runtime !== "codex") return "not-codex";
    if (e.meta.state) return TERMINAL[e.meta.state] ?? "done";
    if (!e.tail) return e.meta.startedMs || this.now() - e.meta.createdMs < 10 * 60_000 ? "starting" : "no-session";
    return e.tail.st.turnOpen ? "running" : e.tail.st.turns ? "waiting" : "starting";
  }

  private view(e: Entry, after: number, window: number, reset: boolean): LiveView {
    const t = e.tail;
    const all = t?.events ?? [];
    const newer = all.filter((ev) => ev.seq > after);
    const events = newer.length > window ? newer.slice(-window) : newer;
    const status = this.status(e);
    const live = status === "running" || status === "waiting" || status === "starting";
    const inflight = t && live && t.st.turnOpen ? [...t.st.inFlight.values()].at(-1) ?? null : null;
    const started = e.meta.startedMs ?? e.meta.createdMs;
    return {
      build: e.meta.id,
      status,
      now: inflight ? { text: inflight.text, since: inflight.at } : null,
      startedAt: new Date(started).toISOString(),
      endedAt: e.meta.state && e.meta.stateAtMs ? new Date(e.meta.stateAtMs).toISOString() : null,
      serverNow: new Date(this.now()).toISOString(),
      lastActivityAt: t?.st.lastActivityAt ?? null,
      session: t?.st.session ? { id: t.st.session.id, model: t.st.session.model, effort: t.st.session.effort, cli: t.st.session.cli } : null,
      events,
      cursor: t?.st.seq ?? 0,
      omitted: newer.length - events.length + (after === 0 ? t?.dropped ?? 0 : 0),
      reset,
    };
  }
}
