/**
 * ship.ts — the ship lane of a build ("I just click Ship and you
 * auto-wake to ship it and restart").
 *
 * No new status kind. A ship is a chain of `ship` entries on the build's
 * timeline, each one a STAGE, and this module derives ONE state from the chain
 * that the board, the app and ship.sh all read. Pure except for the ingest
 * class at the bottom, which only appends and claims.
 *
 *   candidate   the executor's manifest, forwarded at close (built, not reviewed)
 *   ready       Michael reviewed it — the Ship button appears (reviewed, ready)
 *   approved    the owner tapped Ship: who, when, restart choice (wait | now)
 *   started     ship.sh began: the pre-ship sha it will roll back to
 *   merged      fast-forward landed
 *   built       server and/or web built
 *   restarting  the detached half is about to restart the gateway
 *   result      ok | rolled_back | failed — the sha it is on, how long it was dark
 *
 * The MANIFEST is the executor's word at close (.foreman/ship.json in its
 * worktree): branch, base sha, what it touches, build steps, env additions and
 * one plain paragraph. Its prose field is held to the same rails as a status
 * record (no paths, hashes, brackets, markup), so the app can show it as is.
 * Twin: scripts/ship/ship_manifest.py validates the same contract at write time.
 */
import { railHits, normalizeLine } from "./record.js";
import type { TimelineEntry } from "./timeline.js";

export const MANIFEST_VERSION = 1;
export const STAGES = ["candidate", "ready", "approved", "started", "merged", "built", "restarting", "result"] as const;
export type ShipStage = (typeof STAGES)[number];
export const TOUCHES = ["server", "app", "both"] as const;
export type Touches = (typeof TOUCHES)[number];
export const STEPS = ["server", "web"] as const;
export type BuildStep = (typeof STEPS)[number];
export const RESTART_CHOICES = ["wait", "now"] as const;
export type RestartChoice = (typeof RESTART_CHOICES)[number];
export const OUTCOMES = ["ok", "rolled_back", "failed"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const CAP_SUMMARY = 700;
export const CAP_LINE = 200;
export const BRANCH_RE = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*@\{)(?!.*[~^:?*[\\\s])[A-Za-z0-9._/-]{1,120}(?<!\/)(?<!\.lock)$/;
export const SHA_RE = /^[0-9a-f]{7,40}$/;
export const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
export const RUN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,80}$/;
export const REVIEW_ID_RE = /^rv-[A-Za-z0-9-]{4,60}$/;

export interface ShipManifest {
  v: 1;
  branch: string;
  /** The main sha the branch was cut from (merge-base at write time). */
  base: string;
  /** Branch tip at write time — informational; ship.sh re-reads the real tip. */
  head: string | null;
  touches: Touches;
  steps: BuildStep[];
  /** Names only — never a value. */
  env: string[];
  restart: boolean;
  /** One paragraph, plain words: what changes for the owner. */
  summary: string;
  /** One line, plain words: what the restart costs right now. Null = derived. */
  costs: string | null;
}

/** A ship-stage entry on the build timeline. */
export interface ShipEntry {
  ts: string;
  type: "ship";
  id: string;
  stage: ShipStage;
  build: string;
  /** candidate | ready */
  manifest?: ShipManifest;
  /** ready: who reviewed; approved: who tapped. */
  by?: string;
  /** ready: the review card this ship waits on (Ship shows once it is approved). */
  review?: string | null;
  /** approved */
  restart?: RestartChoice;
  /** started | merged | built | restarting | result: one ship.sh run. */
  run?: string;
  /** started: the sha to roll back to. merged | result: the sha landed / on. */
  sha?: string;
  /** result */
  outcome?: Outcome;
  /** result: seconds the gateway answered nothing. */
  dark_s?: number | null;
  /** result (failed | rolled_back): one plain sentence. */
  reason?: string | null;
}

export function isShipEntry(e: TimelineEntry | ShipEntry): e is ShipEntry {
  return (e as { type?: string }).type === "ship";
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function prose(value: unknown, cap: number, errs: string[], field: string): string {
  if (typeof value !== "string") {
    errs.push(`${field} must be a string`);
    return "";
  }
  const v = normalizeLine(value);
  if (!v) errs.push(`${field} is empty`);
  if ([...v].length > cap) errs.push(`${field} longer than ${cap} characters`);
  for (const id of railHits(v)) errs.push(`${field} rail:${id}`);
  return v;
}

/** Validate a manifest. Never throws. */
export function parseManifest(input: unknown): { ok: true; manifest: ShipManifest; errors: [] } | { ok: false; manifest: null; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, manifest: null, errors: ["manifest must be a JSON object"] };
  const known = new Set(["v", "branch", "base", "head", "touches", "steps", "env", "restart", "summary", "costs"]);
  for (const k of Object.keys(input)) if (!known.has(k)) errors.push(`unknown field: ${k}`);
  if (input.v !== MANIFEST_VERSION) errors.push(`v must be ${MANIFEST_VERSION}`);
  const branch = typeof input.branch === "string" ? input.branch : "";
  if (!BRANCH_RE.test(branch) || branch === "main" || branch === "master" || branch === "HEAD") errors.push("branch missing or not a feature branch");
  const base = typeof input.base === "string" ? input.base.toLowerCase() : "";
  if (!SHA_RE.test(base)) errors.push("base must be a commit sha");
  let head: string | null = null;
  if (input.head !== undefined && input.head !== null) {
    if (typeof input.head === "string" && SHA_RE.test(input.head.toLowerCase())) head = input.head.toLowerCase();
    else errors.push("head must be a commit sha");
  }
  const touches = input.touches;
  if (typeof touches !== "string" || !(TOUCHES as readonly string[]).includes(touches)) errors.push(`touches must be one of ${TOUCHES.join(", ")}`);
  const steps: BuildStep[] = [];
  if (!Array.isArray(input.steps)) errors.push("steps must be a list");
  else {
    for (const s of input.steps) {
      if (typeof s !== "string" || !(STEPS as readonly string[]).includes(s)) errors.push(`steps must be from ${STEPS.join(", ")}`);
      else if (!steps.includes(s as BuildStep)) steps.push(s as BuildStep);
    }
  }
  const env: string[] = [];
  if (input.env !== undefined) {
    if (!Array.isArray(input.env)) errors.push("env must be a list of names");
    else for (const e of input.env) {
      if (typeof e !== "string" || !ENV_NAME_RE.test(e)) errors.push("env entries must be variable NAMES, never values");
      else if (!env.includes(e)) env.push(e);
    }
  }
  const restart = input.restart === undefined ? true : input.restart;
  if (typeof restart !== "boolean") errors.push("restart must be true or false");
  const summary = prose(input.summary, CAP_SUMMARY, errors, "summary");
  let costs: string | null = null;
  if (input.costs !== undefined && input.costs !== null) costs = prose(input.costs, CAP_LINE, errors, "costs");
  if (touches === "server" && steps.includes("web")) errors.push("touches server but steps include web");
  if (touches === "app" && steps.includes("server")) errors.push("touches app but steps include server");
  if (errors.length) return { ok: false, manifest: null, errors };
  return { ok: true, errors: [], manifest: { v: 1, branch, base, head, touches: touches as Touches, steps, env, restart: restart as boolean, summary, costs } };
}

/** The restart cost line the app shows when the manifest gives none. */
export function costsLine(m: Pick<ShipManifest, "restart" | "touches">): string {
  if (!m.restart) return "No restart: nothing drops.";
  return "Michael restarts: a live call drops unless the ship waits for it, and the app is dark for a few seconds.";
}

// ── stage input validation ────────────────────────────────────────────

export interface StageInput {
  build: string;
  stage: ShipStage;
  id?: string;
  manifest?: unknown;
  by?: string;
  review?: string | null;
  restart?: string;
  run?: string;
  sha?: string;
  outcome?: string;
  dark_s?: number | null;
  reason?: string | null;
}

export type StageParse = { ok: true; entry: Omit<ShipEntry, "ts">; errors: [] } | { ok: false; entry: null; errors: string[] };

const BUILD_RE = /^\d{8}-\d{6}-[a-z0-9][a-z0-9._-]{0,80}$/;

/** Validate one stage post. The id defaults to something a re-post of the same stage shares, so a duplicate is a no-op. */
export function parseStage(input: unknown): StageParse {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, entry: null, errors: ["stage must be a JSON object"] };
  const known = new Set(["build", "stage", "id", "manifest", "by", "review", "restart", "run", "sha", "outcome", "dark_s", "reason"]);
  for (const k of Object.keys(input)) if (!known.has(k)) errors.push(`unknown field: ${k}`);
  const build = typeof input.build === "string" ? input.build : "";
  if (!BUILD_RE.test(build)) errors.push("build id missing or malformed");
  const stage = input.stage;
  if (typeof stage !== "string" || !(STAGES as readonly string[]).includes(stage)) {
    errors.push(`stage must be one of ${STAGES.join(", ")}`);
    return { ok: false, entry: null, errors };
  }
  const out: Omit<ShipEntry, "ts"> = { type: "ship", id: "", stage: stage as ShipStage, build };
  const by = typeof input.by === "string" ? normalizeLine(input.by).slice(0, 40) : "";
  const sha = typeof input.sha === "string" ? input.sha.toLowerCase() : "";
  const run = typeof input.run === "string" ? input.run : "";
  switch (stage) {
    case "candidate":
    case "ready": {
      const m = parseManifest(input.manifest);
      if (!m.ok) errors.push(...m.errors.map((e) => `manifest: ${e}`));
      else out.manifest = m.manifest;
      if (stage === "ready") {
        out.by = by || "michael";
        if (input.review !== undefined && input.review !== null) {
          if (typeof input.review === "string" && REVIEW_ID_RE.test(input.review)) out.review = input.review;
          else errors.push("review must be a review item id");
        } else out.review = null;
      }
      out.id = `${stage}-${build}-${m.ok ? m.manifest.head ?? m.manifest.base : "x"}`;
      break;
    }
    case "approved": {
      if (!by) errors.push("approved needs by");
      out.by = by;
      const r = input.restart ?? "wait";
      if (typeof r !== "string" || !(RESTART_CHOICES as readonly string[]).includes(r)) errors.push(`restart must be one of ${RESTART_CHOICES.join(", ")}`);
      else out.restart = r as RestartChoice;
      out.id = typeof input.id === "string" ? input.id : `approved-${build}`;
      break;
    }
    case "started":
    case "merged":
    case "built":
    case "restarting":
    case "result": {
      if (!RUN_RE.test(run)) errors.push("run id missing or malformed");
      out.run = run;
      if (stage === "started" || stage === "merged") {
        if (!SHA_RE.test(sha)) errors.push(`${stage} needs sha`);
        out.sha = sha;
      }
      if (stage === "result") {
        const o = input.outcome;
        if (typeof o !== "string" || !(OUTCOMES as readonly string[]).includes(o)) errors.push(`outcome must be one of ${OUTCOMES.join(", ")}`);
        else out.outcome = o as Outcome;
        if (sha) {
          if (!SHA_RE.test(sha)) errors.push("sha malformed");
          else out.sha = sha;
        }
        if (input.dark_s !== undefined && input.dark_s !== null) {
          const d = input.dark_s;
          if (typeof d !== "number" || !Number.isFinite(d) || d < 0 || d > 86_400) errors.push("dark_s must be seconds");
          else out.dark_s = Math.round(d);
        } else out.dark_s = null;
        if (input.reason !== undefined && input.reason !== null) out.reason = prose(input.reason, CAP_LINE, errors, "reason");
        else out.reason = null;
      }
      out.id = `${stage}-${build}-${run}`;
      break;
    }
  }
  if (typeof input.id === "string") {
    if (RUN_RE.test(input.id)) out.id = input.id;
    else errors.push("id malformed");
  }
  if (errors.length) return { ok: false, entry: null, errors };
  return { ok: true, entry: out, errors: [] };
}

// ── derived state ─────────────────────────────────────────────────────

export type ShipPhase =
  | "candidate" // built, not reviewed
  | "ready" // reviewed; Ship shows (unless gated on a review card)
  | "approved" // the owner tapped; Michael's wake pending / running
  | "shipping" // ship.sh started (merge + builds)
  | "restarting" // detached half about to / in the restart
  | "shipped" // result ok
  | "rolled_back"
  | "failed";

export interface ShipState {
  build: string;
  phase: ShipPhase;
  manifest: ShipManifest | null;
  summary: string | null;
  costs: string | null;
  review: string | null;
  ready_at: string | null;
  ready_by: string | null;
  approved: { by: string; at: string; restart: RestartChoice } | null;
  /** The latest ship.sh run, if any. */
  run: { id: string; started_at: string; pre: string | null; merged: string | null; built_at: string | null; restarting_at: string | null } | null;
  result: { outcome: Outcome; at: string; sha: string | null; dark_s: number | null; reason: string | null } | null;
  /** the owner's move: Ship is waiting on him (phase ready). */
  pending: boolean;
  /** Michael's / the script's move: approved … restarting. */
  active: boolean;
}

/**
 * The state of a build's ship from its timeline. A NEW ready (a re-review
 * after changes) starts the chain over: everything before the newest ready
 * is history. Entries are read in write order.
 */
export function shipState(build: string, entries: ReadonlyArray<TimelineEntry | ShipEntry>): ShipState | null {
  const ships = entries.filter(isShipEntry).filter((e) => e.build === build);
  if (!ships.length) return null;
  let lastReady = -1;
  ships.forEach((e, i) => {
    if (e.stage === "ready") lastReady = i;
  });
  const chain = lastReady >= 0 ? ships.slice(lastReady) : ships;
  const candidate = [...ships].reverse().find((e) => e.stage === "candidate") ?? null;
  const ready = chain[0]?.stage === "ready" ? chain[0] : null;
  const manifest = ready?.manifest ?? candidate?.manifest ?? null;
  const state: ShipState = {
    build,
    phase: ready ? "ready" : "candidate",
    manifest,
    summary: manifest?.summary ?? null,
    costs: manifest ? manifest.costs ?? costsLine(manifest) : null,
    review: ready?.review ?? null,
    ready_at: ready?.ts ?? null,
    ready_by: ready?.by ?? null,
    approved: null,
    run: null,
    result: null,
    pending: false,
    active: false,
  };
  for (const e of chain) {
    switch (e.stage) {
      case "approved":
        if (!state.approved) state.approved = { by: e.by ?? "owner", at: e.ts, restart: e.restart ?? "wait" };
        state.phase = "approved";
        break;
      case "started":
        state.run = { id: e.run ?? "", started_at: e.ts, pre: e.sha ?? null, merged: null, built_at: null, restarting_at: null };
        state.result = null;
        state.phase = "shipping";
        break;
      case "merged":
        if (state.run && state.run.id === e.run) state.run.merged = e.sha ?? null;
        break;
      case "built":
        if (state.run && state.run.id === e.run) state.run.built_at = e.ts;
        break;
      case "restarting":
        if (state.run && state.run.id === e.run) state.run.restarting_at = e.ts;
        state.phase = "restarting";
        break;
      case "result":
        state.result = { outcome: e.outcome ?? "failed", at: e.ts, sha: e.sha ?? null, dark_s: e.dark_s ?? null, reason: e.reason ?? null };
        state.phase = e.outcome === "ok" ? "shipped" : e.outcome === "rolled_back" ? "rolled_back" : "failed";
        break;
      default:
        break;
    }
  }
  state.pending = state.phase === "ready";
  state.active = state.phase === "approved" || state.phase === "shipping" || state.phase === "restarting";
  return state;
}

/** "Ready to ship — voice call drop" + the paragraph + the one action. Pure; once per ready. */
export function renderReady(name: string, st: Pick<ShipState, "summary" | "costs">): string {
  const lines = [`**Ready to ship — ${name}**`];
  if (st.summary) lines.push(st.summary);
  if (st.costs) lines.push(st.costs);
  lines.push("Ship it from Builds, or tell me here.");
  return lines.join("\n");
}

/** The wake Michael gets when the owner taps Ship. First line names the build (the desk keys on it). */
export function shipWakeText(opts: { build: string; title: string; by: string; restart: RestartChoice; command: string; summary: string | null }): string {
  const choice = opts.restart === "now" ? "restart NOW, even under a live call" : "restart when no call is live (the script waits)";
  return [
    `SHIP APPROVED by ${opts.by} — build ${opts.build} "${opts.title}". Restart choice: ${choice}.`,
    `One last look, then run exactly this, from any directory:`,
    `  ${opts.command}`,
    `It is the whole ship: fast-forward merge, builds, the detached restart with health check and rollback, and the records. Do not retype any of it. It is safe to run twice.`,
    `If it refuses (dirty tree, branch not fast-forwardable, missing env), it has already written why to the card; fix the cause, then run it again.`,
    opts.summary ? `What ships, in the owner's words on the card: ${opts.summary}` : "",
    `Reply to the owner briefly BEFORE the restart lands: the script waits its settle time so your reply can go out first.`,
  ]
    .filter(Boolean)
    .join("\n");
}
