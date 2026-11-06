/**
 * launches.ts — the Start button's ledger and its out-of-process runner.
 *
 * A Start tap becomes ONE launch entry in <review root>/launches.json (written
 * only by the gateway, like every review state file) and one detached process
 * running foreman/bin/build_from_brief.sh — via `systemd-run --user`, so a
 * build_start that takes a minute never blocks the request and a gateway
 * restart never kills it (the detached-restart pattern). The script reports
 * back by writing <review root>/launches/<id>/result.json; the gateway only
 * ever READS that file (reconcile) and the row moves from "starting" to the
 * running build, or to "failed" with the launcher's own words.
 *
 * Idempotent at three levels, each proven in tests:
 *   1. here: one open (pending/started-and-running) launch per brief sha —
 *      a second Start, a double tap, a retried request returns the first;
 *   2. the script: a flock on the brief sha for the life of the launch;
 *   3. the ledger: an ACTIVE build carrying a `brief` event for that sha is
 *      reported as "already running", never started twice.
 */
import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { atomicWriteJson, ensureDir } from "../multi-user-paths.js";
import type { PasskeyEvidence } from "./types.js";
import { unshieldChild } from "../lifecycle.js";

export type LaunchState = "pending" | "started" | "failed";

export interface LaunchEntry {
  id: string;
  /** The feed row the Start sat on. */
  row: string;
  brief_path: string;
  brief_sha256: string;
  /** The brief's build name (meta.json `name`). */
  name: string;
  pre_approved: boolean;
  /** The user the row belongs to (the wake goes to his thread). */
  owner: string;
  actor: string;
  requested_at: string;
  state: LaunchState;
  build_id: string | null;
  workdir: string | null;
  /** The launcher's own words when it refused or died. */
  error: string | null;
  resolved_at: string | null;
  /** Michael was told (one line) at… */
  woke_at: string | null;
  passkey: PasskeyEvidence | null;
  /** How the process was spawned: "systemd-run" | "setsid" | "none (dry)". */
  runner: string | null;
}

export interface LaunchResult {
  state: "started" | "failed" | "dry-run";
  build_id?: string;
  workdir?: string;
  error?: string;
  code?: string;
  already?: string;
  at?: string;
}

/** Pending for longer than this with no result.json: the launcher never reported. */
export const LAUNCH_TIMEOUT_MS = 10 * 60_000;

export class LaunchLedger {
  private entries: LaunchEntry[];

  constructor(readonly root: string) {
    this.entries = this.read();
  }

  private get path(): string {
    return join(this.root, "launches.json");
  }

  /** Where the runner writes result.json + log for one launch. */
  outDir(id: string): string {
    return join(this.root, "launches", id);
  }

  private read(): LaunchEntry[] {
    if (!existsSync(this.path)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      return Array.isArray(raw?.launches) ? raw.launches : [];
    } catch (err) {
      // A lost ledger would let a second Start start a second build — refuse loudly.
      throw new Error(`[feed] launches.json unreadable at ${this.path}: ${(err as Error).message}`);
    }
  }

  private flush(): void {
    atomicWriteJson(this.path, { version: 1, launches: this.entries });
  }

  all(): LaunchEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  get(id: string): LaunchEntry | null {
    const e = this.entries.find((x) => x.id === id);
    return e ? { ...e } : null;
  }

  /** The launch that still "owns" this brief: pending, or started (its build may still be running — the caller checks the ledger). */
  openFor(sha: string): LaunchEntry | null {
    const e = [...this.entries].reverse().find((x) => x.brief_sha256 === sha && x.state !== "failed");
    return e ? { ...e } : null;
  }

  /** Newest launch per row id (any state) — the feed renders "starting" / "failed" from it. */
  byRow(): Map<string, LaunchEntry> {
    const out = new Map<string, LaunchEntry>();
    for (const e of this.entries) out.set(e.row, { ...e });
    return out;
  }

  /** Idempotent: an open launch for the same brief sha is returned instead of a new one. */
  request(input: Omit<LaunchEntry, "id" | "state" | "build_id" | "workdir" | "error" | "resolved_at" | "woke_at" | "runner">, now: Date): { entry: LaunchEntry; fresh: boolean } {
    const existing = this.openFor(input.brief_sha256);
    if (existing) return { entry: existing, fresh: false };
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const id = `ln-${stamp}-${input.brief_sha256.slice(0, 6)}`;
    const entry: LaunchEntry = { ...input, id, state: "pending", build_id: null, workdir: null, error: null, resolved_at: null, woke_at: null, runner: null };
    this.entries.push(entry);
    this.flush();
    return { entry: { ...entry }, fresh: true };
  }

  update(id: string, patch: Partial<LaunchEntry>): LaunchEntry | null {
    const i = this.entries.findIndex((x) => x.id === id);
    if (i === -1) return null;
    this.entries[i] = { ...this.entries[i], ...patch, id };
    this.flush();
    return { ...this.entries[i] };
  }

  /** The runner's report for a launch, if it has written one. Never throws. */
  readResult(id: string): LaunchResult | null {
    const p = join(this.outDir(id), "result.json");
    if (!existsSync(p)) return null;
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
      if (raw.state !== "started" && raw.state !== "failed" && raw.state !== "dry-run") return null;
      const str = (k: string) => (typeof raw[k] === "string" && raw[k] ? (raw[k] as string) : undefined);
      return { state: raw.state, build_id: str("build_id"), workdir: str("workdir"), error: str("error"), code: str("code"), already: str("already"), at: str("at") };
    } catch {
      return null;
    }
  }

  /**
   * Fold the runners' results into the ledger. Returns the entries that
   * changed state this pass (the desk wakes Michael for each). Pending
   * launches older than LAUNCH_TIMEOUT_MS with no report fail as such.
   */
  reconcile(now: Date): LaunchEntry[] {
    const changed: LaunchEntry[] = [];
    for (const e of this.entries) {
      if (e.state !== "pending") continue;
      const r = this.readResult(e.id);
      if (r?.state === "started" && r.build_id) {
        Object.assign(e, { state: "started", build_id: r.build_id, workdir: r.workdir ?? null, resolved_at: r.at ?? now.toISOString(), error: null });
        changed.push({ ...e });
      } else if (r?.state === "failed") {
        Object.assign(e, { state: "failed", error: (r.error ?? "launcher failed").slice(0, 1200), resolved_at: r.at ?? now.toISOString() });
        changed.push({ ...e });
      } else if (now.getTime() - Date.parse(e.requested_at) > LAUNCH_TIMEOUT_MS) {
        Object.assign(e, { state: "failed", error: "the launcher never reported back — check the foreman ledger and the launch log", resolved_at: now.toISOString() });
        changed.push({ ...e });
      }
    }
    if (changed.length) this.flush();
    return changed;
  }
}

// ── the runner ─────────────────────────────────────────────────────────

export interface RunnerSpec {
  script: string;
  args: string[];
  /** Working directory for the script (the foreman root). */
  cwd: string;
  unit: string;
  logPath: string;
}

export type Runner = (spec: RunnerSpec) => { ok: true; runner: string } | { ok: false; error: string };

/**
 * Production runner. `systemd-run --user --collect` puts the launch in its own
 * transient unit outside the gateway's cgroup (a gateway restart leaves it
 * running); when systemd-run is missing or refuses, a `setsid` detached child
 * is the fallback — it survives the request, not necessarily a restart, and
 * the ledger entry says which one ran.
 */
export function defaultRunner(spec: RunnerSpec): ReturnType<Runner> {
  ensureDir(join(spec.logPath, ".."));
  const shell = `exec ${[spec.script, ...spec.args].map(q).join(" ")} >> ${q(spec.logPath)} 2>&1`;
  const probe = spawnSync("systemd-run", ["--user", "--version"], { stdio: "ignore", timeout: 5000 });
  if (probe.status === 0) {
    const r = spawnSync(
      "systemd-run",
      ["--user", "--collect", "--quiet", `--unit=${spec.unit}`, `--property=WorkingDirectory=${spec.cwd}`, "/bin/bash", "-c", shell],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
    );
    if (r.status === 0) return { ok: true, runner: "systemd-run" };
    // fall through: a refused unit (name clash, no user bus) must not lose the launch
  }
  try {
    const child = spawn("/bin/bash", ["-c", shell], { cwd: spec.cwd, detached: true, stdio: "ignore" });
    unshieldChild(child.pid);
    child.unref();
    return { ok: true, runner: "setsid" };
  } catch (err) {
    return { ok: false, error: `could not start the launcher: ${(err as Error).message}` };
  }
}

function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
