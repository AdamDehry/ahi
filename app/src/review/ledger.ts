/**
 * ledger.ts — read-only view of the foreman build ledger for digests.
 *
 * Source: <builds dir>/<build_id>/meta.json + events.jsonl, written by the
 * foreman (default ~/AHI/AHI_OS/foreman/builds, REVIEW_FOREMAN_BUILDS_DIR to
 * move it). Event timestamps are epoch SECONDS. A build's state is its last
 * `status:*` event; no status event = still running.
 *
 * Nothing here writes. Unreadable builds are skipped, never fatal — a digest
 * with one build missing beats no digest.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

export interface BuildSummary {
  id: string;
  name: string;
  agent: string;
  created: Date;
  /** done | failed | abandoned | stalled | running | <other status text> */
  state: string;
  stateAt: Date | null;
  /** Newest event of any kind — a "running" build quiet for days is stale. */
  lastEventAt: Date | null;
  /** The last status event's detail ("never launched; …", "corrective close by Michael: …"). */
  stateDetail?: string | null;
  /** A `superseded` event: the run was replaced; `by` is the successor build id when the detail names one. */
  superseded?: { at: Date | null; by: string | null } | null;
  /** The `started` event — absent for a run that never launched. */
  startedAt?: Date | null;
  /** meta.json `runtime`: "claude" | "codex" (absent on old builds = claude). */
  runtime?: string | null;
}

/**
 * The key runs of one job share: the build name without a redo suffix, so
 * "pricing-cleanup-resume" and "board-prerender-r2" land with their first run.
 */
export function runGroupKey(name: string): string {
  let key = name.toLowerCase();
  for (;;) {
    const next = key.replace(/-(?:resume|redo|retry|rerun|r\d+)$/, "");
    if (next === key || !next) return key;
    key = next;
  }
}

export function defaultForemanBuildsDir(): string {
  const override = process.env.REVIEW_FOREMAN_BUILDS_DIR;
  return override ? resolve(override) : resolve(homedir(), "AHI/AHI_OS/foreman/builds");
}

const ID_PATTERN = /^(\d{8})-(\d{6})-(.+)$/;

/**
 * Builds created on/after `createdSince` (by id timestamp, UTC) — plus their
 * current state. `createdSince` keeps the scan cheap; the ledger grows daily.
 */
export function readBuilds(
  dir: string | null,
  createdSince: Date,
  opts: { includeRunning?: boolean; withSiblings?: boolean; strict?: boolean } = {},
): BuildSummary[] {
  if (!dir || !existsSync(dir)) {
    if (opts.strict && dir) throw new Error(`foreman ledger not found at ${dir}`);
    return [];
  }
  const sinceKey = createdSince.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const out: BuildSummary[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (opts.strict) throw err;
    return [];
  }
  // withSiblings: an old run that is still open drags in the other runs of
  // the same job (same name group), so "died and never redone" can be told
  // apart from "died and redone" — those finished siblings are history, not rows.
  const oldOpenKeys = new Set<string>();
  const oldClosed: BuildSummary[] = [];
  for (const id of names) {
    const m = ID_PATTERN.exec(id);
    if (!m) continue;
    const old = `${m[1]}-${m[2]}` < sinceKey;
    // includeRunning: an old build with no terminal status still counts —
    // a build that never closed is exactly what the open-tracks board is for.
    if (old && !opts.includeRunning) continue;
    const b = readOne(dir, id, m);
    if (!b) continue;
    if (old && b.state !== "running") {
      if (opts.withSiblings) oldClosed.push(b);
      continue;
    }
    if (old) oldOpenKeys.add(runGroupKey(b.name));
    out.push(b);
  }
  if (opts.withSiblings && oldOpenKeys.size) {
    for (const b of oldClosed) if (oldOpenKeys.has(runGroupKey(b.name))) out.push(b);
  }
  return out.sort((a, b) => a.created.getTime() - b.created.getTime());
}

const SUCCESSOR = /\b(\d{8}-\d{6}-[a-z0-9][a-z0-9._-]*)/i;

function readOne(dir: string, id: string, m: RegExpExecArray): BuildSummary | null {
  try {
    const metaPath = join(dir, id, "meta.json");
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
    const created =
      typeof meta.created === "number"
        ? new Date(meta.created * 1000)
        : new Date(`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4, 6)}Z`);
    let state = "running";
    let stateAt: Date | null = null;
    let stateDetail: string | null = null;
    let lastEventAt: Date | null = null;
    let superseded: BuildSummary["superseded"] = null;
    let startedAt: Date | null = null;
    const evPath = join(dir, id, "events.jsonl");
    if (existsSync(evPath)) {
      const lines = readFileSync(evPath, "utf8").split("\n").filter(Boolean);
      const tail = /"ts":\s*(\d+)/.exec(lines[lines.length - 1] ?? "");
      if (tail) lastEventAt = new Date(Number(tail[1]) * 1000);
      for (const line of lines) {
        if (!line.includes('"status:') && !line.includes('"superseded"') && !line.includes('"started"')) continue;
        try {
          const ev = JSON.parse(line) as { ts?: number; type?: string; detail?: unknown };
          const at = typeof ev.ts === "number" ? new Date(ev.ts * 1000) : null;
          const detail = typeof ev.detail === "string" ? ev.detail : "";
          if (typeof ev.type === "string" && ev.type.startsWith("status:")) {
            state = ev.type.slice("status:".length).split(" ")[0].replace(/[^a-z-]/g, "") || "changed";
            stateAt = at;
            stateDetail = detail || null;
          } else if (ev.type === "superseded") {
            const by = SUCCESSOR.exec(detail)?.[1] ?? null;
            superseded = { at, by: by && by !== id ? by : null };
          } else if (ev.type === "started" && !startedAt) {
            startedAt = at;
          }
        } catch {
          /* skip a torn line */
        }
      }
    }
    return {
      id,
      name: typeof meta.name === "string" && meta.name ? meta.name : m[3],
      agent: typeof meta.agent === "string" ? meta.agent : "",
      created,
      state,
      stateAt,
      lastEventAt,
      stateDetail,
      superseded,
      startedAt,
      runtime: typeof meta.runtime === "string" && meta.runtime ? meta.runtime : null,
    };
  } catch {
    /* unreadable build — skip */
    return null;
  }
}
