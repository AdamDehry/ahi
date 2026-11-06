/**
 * locate.ts — which foreman build is which Codex rollout.
 *
 * Source of truth, in order:
 *
 *   1. A `codex-rollout` event in the build's events.jsonl (written by the
 *      foreman patch in builds/codex-live-view-out/foreman-patch): the exact
 *      file, recorded by build_start the moment Codex created it.
 *   2. Discovery, for builds launched before that patch (and as a fallback if
 *      the event never lands): the rollout whose session_meta `cwd` is the
 *      build's workdir, written by the interactive TUI (`originator
 *      codex-tui`, `source cli`, `thread_source user` — the foreman's own
 *      lane; `codex exec` consults in the same folder are excluded), created
 *      no earlier than the build. The earliest such file wins: the workdir
 *      lock means one build per folder at a time, and the notify hook already
 *      relies on exactly this identity (fm1_thread_state).
 *
 * Reads only: meta.json, events.jsonl, and the first line of candidate
 * rollouts (never the rest).
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from "fs";
import { join, resolve } from "path";

export interface BuildMeta {
  id: string;
  runtime: string;
  workdir: string;
  tmux: string | null;
  createdMs: number;
  startedMs: number | null;
  /** Terminal status from the ledger, or null while running. */
  state: string | null;
  stateAtMs: number | null;
  /** `codex-rollout` event path, when the foreman recorded one. */
  recordedRollout: string | null;
}

const BUILD_ID_RE = /^\d{8}-\d{6}-[a-z0-9][a-z0-9._-]*$/i;

export function readBuildMeta(buildsDir: string, id: string): BuildMeta | null {
  if (!BUILD_ID_RE.test(id)) return null;
  const dir = join(buildsDir, id);
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  let startedMs: number | null = null;
  let state: string | null = null;
  let stateAtMs: number | null = null;
  let recordedRollout: string | null = null;
  try {
    for (const line of readFileSync(join(dir, "events.jsonl"), "utf8").split("\n")) {
      if (!line.includes('"started"') && !line.includes('"status:') && !line.includes('"codex-rollout"')) continue;
      try {
        const ev = JSON.parse(line) as { ts?: number; type?: string; detail?: string };
        const at = typeof ev.ts === "number" ? ev.ts * 1000 : null;
        if (ev.type === "started" && startedMs === null) startedMs = at;
        else if (typeof ev.type === "string" && ev.type.startsWith("status:")) {
          state = ev.type.slice(7).split(" ")[0].replace(/[^a-z-]/g, "") || "changed";
          stateAtMs = at;
        } else if (ev.type === "codex-rollout" && typeof ev.detail === "string") {
          const m = /\bpath=(\S+\.jsonl)/.exec(ev.detail);
          if (m) recordedRollout = m[1];
        }
      } catch {
        /* torn line */
      }
    }
  } catch {
    /* no events yet */
  }
  const created = typeof meta.created === "number" ? meta.created * 1000 : idTime(id);
  return {
    id,
    runtime: typeof meta.runtime === "string" && meta.runtime ? meta.runtime : "claude",
    workdir: typeof meta.workdir === "string" ? meta.workdir : "",
    tmux: typeof meta.tmux === "string" ? meta.tmux : null,
    createdMs: created,
    startedMs,
    state,
    stateAtMs,
    recordedRollout,
  };
}

function idTime(id: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id)!;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/** First line of a file, bounded (session_meta carries the base instructions: tens of KB). */
export function firstLine(path: string, max = 512 * 1024): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(Math.min(max, 64 * 1024));
    let acc = Buffer.alloc(0);
    let pos = 0;
    while (acc.length < max) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      const chunk = buf.subarray(0, n);
      const nl = chunk.indexOf(0x0a);
      if (nl >= 0) return Buffer.concat([acc, chunk.subarray(0, nl)]).toString("utf8");
      acc = Buffer.concat([acc, chunk]);
      pos += n;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function sameDir(a: string, b: string): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/\/+$/, "");
  if (norm(a) === norm(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export interface RolloutMatch {
  path: string;
  sessionId: string;
  createdMs: number;
}

/** rollout-2026-10-14T05-56-08-<id>.jsonl → its creation instant (UTC, the name's own clock). */
function nameTime(name: string): number | null {
  const m = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

/** Day folders that can hold a session started in [from, to]. Codex names them by local date, so pad a day each side. */
function dayDirs(sessionsRoot: string, fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  const DAY = 86_400_000;
  for (let t = fromMs - DAY; t <= toMs + DAY; t += DAY) {
    const d = new Date(t);
    const p = join(sessionsRoot, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0"));
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** Clock slack between the build's `created` and Codex's own session timestamp. */
const SLACK_MS = 120_000;

export function locateRollout(codexHome: string, meta: BuildMeta, nowMs: number): RolloutMatch | null {
  const sessionsRoot = resolve(codexHome, "sessions");
  if (meta.recordedRollout) {
    const p = resolve(meta.recordedRollout);
    // Only a file under the Codex sessions store — the event is foreman-written, but a path is a path.
    if (p.startsWith(sessionsRoot + "/") && existsSync(p)) {
      const head = firstLine(p);
      const id = head ? sessionIdOf(head) : null;
      return { path: p, sessionId: id ?? "", createdMs: nameTime(p.split("/").pop() ?? "") ?? meta.createdMs };
    }
  }
  if (!meta.workdir) return null;
  const from = meta.createdMs - SLACK_MS;
  // A run that already ended cannot own a session created after it ended (a
  // launch that died at submit must not borrow its retry's transcript).
  const to = meta.stateAtMs !== null ? meta.stateAtMs + 5_000 : nowMs + SLACK_MS;
  let best: RolloutMatch | null = null;
  for (const dir of dayDirs(sessionsRoot, from, Math.min(to, nowMs))) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const t = nameTime(name);
      if (t === null || t < from || t > to) continue;
      if (best && t >= best.createdMs) continue;
      const path = join(dir, name);
      const head = firstLine(path);
      if (!head) continue;
      const m = matchMeta(head, meta.workdir);
      if (m) best = { path, sessionId: m, createdMs: t };
    }
  }
  return best;
}

function sessionIdOf(head: string): string | null {
  try {
    const row = JSON.parse(head) as { type?: string; payload?: { id?: unknown } };
    return row.type === "session_meta" && typeof row.payload?.id === "string" ? row.payload.id : null;
  } catch {
    return null;
  }
}

/** The session id when this session_meta is the foreman's TUI session in `workdir`; else null. */
export function matchMeta(head: string, workdir: string): string | null {
  try {
    const row = JSON.parse(head) as { type?: string; payload?: Record<string, unknown> };
    if (row.type !== "session_meta" || !row.payload) return null;
    const p = row.payload;
    if (!sameDir(String(p.cwd ?? ""), workdir)) return null;
    if (p.originator === "codex_exec" || p.source === "exec") return null;
    // Absent or null on threads started through the app-server API (thread/start); "user" from the TUI.
    if (p.thread_source !== undefined && p.thread_source !== null && p.thread_source !== "user") return null;
    if (p.source !== undefined && typeof p.source !== "string") return null; // {subagent: …}
    return typeof p.id === "string" ? p.id : null;
  } catch {
    return null;
  }
}
