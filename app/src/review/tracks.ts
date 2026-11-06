/**
 * tracks.ts — the OPEN TRACKS board: builds are closed, not left to pile up.
 *
 * Every running AND queued track, each with what's done and what's left,
 * until it is CLOSED. A row leaves the board only by an explicit close or
 * cancel carrying the owner's word — never because a source stopped mentioning it.
 *
 * Sources, merged on every read:
 *   1. The build order in foreman/QUEUE.md — a marked, chain-safe block
 *      (numbered lines, NO checkboxes, so the chain parser never fires on it):
 *
 *        <!-- OPEN-TRACKS:BEGIN -->
 *        1. Phase D business application [trk:phase-d] — done: round 1, consent v3 · left: review → migration → CRM → website · builds: 20261005-222902-business-app
 *        2. CRM speed pass — left: measure first; loading states; fix the slowest
 *        <!-- OPEN-TRACKS:END -->
 *
 *      A row that later disappears from the block STAYS, flagged "not in
 *      QUEUE.md" — dropping it would be exactly the silent removal the rule
 *      forbids.
 *   2. Michael/foreman via the service API (scripts/review.mjs track …).
 *   3. The foreman ledger: every build that has not closed, and every build
 *      started since the board went live, is a row of its own unless it is
 *      filed under a track. A finished-but-unfiled build stays as
 *      "finished — close or file it".
 *
 * Stored in <review root>/tracks.json; written only by the gateway process.
 */
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { atomicWriteJson } from "../multi-user-paths.js";
import type { BuildSummary } from "./ledger.js";

export type TrackState = "queued" | "running" | "closed" | "cancelled";

/** One station on a track's "what's left" rail (B3) — set by Michael or the foreman, never split from prose. */
export interface TrackStep {
  label: string;
  state: "done" | "now" | "you" | "left";
  who: string | null;
}

const STEP_STATES = new Set<TrackStep["state"]>(["done", "now", "you", "left"]);
const MAX_STEPS = 12;

export interface Track {
  id: string;
  title: string;
  /** Position in the build order (null = after the ordered ones). */
  order: number | null;
  state: TrackState;
  done: string;
  left: string;
  builds: string[];
  source: "queue" | "api" | "build";
  created: string;
  updated: string;
  /** Source no longer lists it, but nobody closed it — still on the board. */
  missing_from_source: boolean;
  closed_at: string | null;
  /** "closed" | "cancelled" + who: "owner (app)" or "owner (relayed by michael): <his words>". */
  closed_how: string | null;
  /** B3: the track is blocked on the owner's own step (it lands in Builds → Needs you). */
  waiting_on?: "owner" | null;
  /** B3: structured stations for the steps rail. Absent → no rail, DONE / LEFT stand alone. */
  steps?: TrackStep[] | null;
}

export interface TrackRow {
  id: string;
  title: string;
  order: number | null;
  /** Display state: queued | running | built | stale | failed. */
  status: string;
  done: string;
  left: string;
  builds: Array<{ id: string; name: string; state: string; at: string | null }>;
  source: Track["source"];
  note: string | null;
}

interface TracksFile {
  /** When the board went live — builds started after this are all tracked. */
  epoch: string;
  tracks: Track[];
}

export interface QueueRow {
  id: string;
  order: number;
  title: string;
  done: string;
  left: string;
  builds: string[];
}

const BEGIN = "<!-- OPEN-TRACKS:BEGIN";
const END = "<!-- OPEN-TRACKS:END";
const STALE_MS = 3 * 86_400_000;

export function slugId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `trk-${slug || "untitled"}`;
}

/** Parse the OPEN-TRACKS block. No block → []. Never throws. */
export function parseQueueBlock(text: string): QueueRow[] {
  const start = text.indexOf(BEGIN);
  if (start === -1) return [];
  const end = text.indexOf(END, start);
  const block = text.slice(start, end === -1 ? undefined : end).split("\n").slice(1);
  const rows: QueueRow[] = [];
  for (const raw of block) {
    const m = /^\s*(\d+)[.)]\s+(.+?)\s*$/.exec(raw);
    if (!m) continue;
    const order = Number(m[1]);
    const [head, ...restParts] = m[2].split(/\s+[—–]\s+/);
    const rest = restParts.join(" — ");
    const idMatch = /\[trk:([a-z0-9._-]{1,48})\]/i.exec(head);
    const title = head.replace(/\[trk:[^\]]*\]/i, "").replace(/\s+/g, " ").trim();
    if (!title) continue;
    // " · " separates fields, but prose inside a field may use it too: a
    // segment that doesn't open with a known key continues the last field.
    const fields: Record<string, string> = {};
    let last: string | null = null;
    for (const seg of rest.split(/\s+·\s+/)) {
      const f = /^\s*(done|left|builds?)\s*:\s*(.*)$/i.exec(seg);
      if (f) {
        last = f[1].toLowerCase().replace(/s$/, "");
        fields[last] = f[2].trim();
      } else if (last) {
        fields[last] = `${fields[last]} · ${seg.trim()}`;
      }
    }
    rows.push({
      id: idMatch ? `trk-${idMatch[1].toLowerCase()}` : slugId(title),
      order,
      title: title.slice(0, 160),
      done: (fields.done ?? "").slice(0, 300),
      left: (fields.left ?? "").slice(0, 300),
      builds: (fields.build ?? "")
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter((s) => /^\d{8}-\d{6}-[a-z0-9._-]+$/i.test(s)),
    });
  }
  return rows;
}

export class TrackBoard {
  private data: TracksFile;
  private queueCache: { path: string; mtimeMs: number; rows: QueueRow[] } | null = null;
  /** Build rows retired by filing since the last drain — the desk logs them. */
  private filed: Array<{ row: string; track: string }> = [];

  constructor(
    private readonly root: string,
    private readonly queuePath: string | null,
    private readonly now: () => Date,
    /**
     * Builds started on/after this are tracked even when the board went live
     * later — so the first board is the honest backlog, not an empty slate.
     */
    private readonly backfillSince: Date | null = null,
  ) {
    const p = this.path;
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, "utf8"));
        this.data = { epoch: raw.epoch ?? now().toISOString(), tracks: Array.isArray(raw.tracks) ? raw.tracks : [] };
        return;
      } catch (err) {
        throw new Error(`[review] tracks.json unreadable at ${p}: ${(err as Error).message}`);
      }
    }
    this.data = { epoch: now().toISOString(), tracks: [] };
  }

  private get path(): string {
    return join(this.root, "tracks.json");
  }

  private flush(): void {
    atomicWriteJson(this.path, this.data);
  }

  get epoch(): Date {
    const epoch = new Date(this.data.epoch);
    return this.backfillSince && this.backfillSince < epoch ? new Date(this.backfillSince) : epoch;
  }

  all(): Track[] {
    return this.data.tracks.map((t) => ({ ...t, builds: [...t.builds] }));
  }

  get(id: string): Track | null {
    const t = this.data.tracks.find((x) => x.id === id);
    return t ? { ...t, builds: [...t.builds] } : null;
  }

  private queueRows(): QueueRow[] {
    if (!this.queuePath || !existsSync(this.queuePath)) return [];
    try {
      const st = statSync(this.queuePath);
      if (this.queueCache && this.queueCache.path === this.queuePath && this.queueCache.mtimeMs === st.mtimeMs) {
        return this.queueCache.rows;
      }
      const rows = parseQueueBlock(readFileSync(this.queuePath, "utf8"));
      this.queueCache = { path: this.queuePath, mtimeMs: st.mtimeMs, rows };
      return rows;
    } catch {
      return this.queueCache?.rows ?? [];
    }
  }

  /**
   * Merge the sources into the registry. Adds and updates; NEVER removes.
   * Returns true when something changed (and was written).
   */
  sync(builds: BuildSummary[]): boolean {
    const nowIso = this.now().toISOString();
    let changed = false;
    const byId = new Map(this.data.tracks.map((t) => [t.id, t]));
    const rows = this.queueRows();
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.id);
      const t = byId.get(row.id);
      if (!t) {
        const track: Track = {
          id: row.id,
          title: row.title,
          order: row.order,
          state: "queued",
          done: row.done,
          left: row.left,
          builds: row.builds,
          source: "queue",
          created: nowIso,
          updated: nowIso,
          missing_from_source: false,
          closed_at: null,
          closed_how: null,
        };
        this.data.tracks.push(track);
        byId.set(track.id, track);
        changed = true;
        continue;
      }
      if (t.state === "closed" || t.state === "cancelled") continue; // the owner closed it — the text lingering doesn't reopen it
      const builds = [...new Set([...t.builds, ...row.builds])];
      if (t.title !== row.title || t.order !== row.order || t.done !== row.done || t.left !== row.left || builds.length !== t.builds.length || t.missing_from_source) {
        Object.assign(t, { title: row.title, order: row.order, done: row.done, left: row.left, builds, missing_from_source: false, updated: nowIso });
        changed = true;
      }
    }
    for (const t of this.data.tracks) {
      if (t.source === "queue" && !seen.has(t.id) && isOpen(t) && !t.missing_from_source && this.queuePath && existsSync(this.queuePath)) {
        t.missing_from_source = true;
        t.updated = nowIso;
        changed = true;
      }
    }
    for (const t of this.data.tracks) {
      if (t.source !== "build" && isOpen(t) && this.absorbBuildRows(t)) changed = true;
    }
    // Builds: anything not filed under a track becomes its own row.
    const filed = new Set(this.data.tracks.filter((t) => t.source !== "build").flatMap((t) => t.builds));
    const epoch = this.epoch.getTime();
    for (const b of builds) {
      if (filed.has(b.id)) continue;
      const relevant = b.state === "running" || b.created.getTime() >= epoch;
      if (!relevant) continue;
      const id = `bld-${b.id}`;
      if (byId.has(id)) continue;
      const track: Track = {
        id,
        title: b.name,
        order: null,
        state: "running",
        done: "",
        left: "",
        builds: [b.id],
        source: "build",
        created: nowIso,
        updated: nowIso,
        missing_from_source: false,
        closed_at: null,
        closed_how: null,
      };
      this.data.tracks.push(track);
      byId.set(id, track);
      changed = true;
    }
    if (changed) this.flush();
    return changed;
  }

  /** Service API upsert (Michael / foreman). Cannot close — see close(). */
  upsert(input: {
    id?: string;
    title?: string;
    order?: number | null;
    state?: string;
    done?: string;
    left?: string;
    builds?: string[];
    waiting_on?: unknown;
    steps?: unknown;
  }): Track | { error: string } {
    const nowIso = this.now().toISOString();
    const title = typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    const id = typeof input.id === "string" && /^(trk|bld)-[a-z0-9._-]{1,60}$/.test(input.id) ? input.id : title ? slugId(title) : "";
    if (!id) return { error: "track needs a title (or an existing id)" };
    if (input.state === "closed" || input.state === "cancelled") return { error: "closing a track needs the owner's word — use the close endpoint" };
    const state = input.state === "running" || input.state === "queued" ? input.state : undefined;
    const builds = Array.isArray(input.builds) ? input.builds.filter((b) => typeof b === "string" && /^\d{8}-\d{6}-[a-z0-9._-]+$/i.test(b)) : [];
    if (input.waiting_on !== undefined && input.waiting_on !== null && input.waiting_on !== "owner") return { error: 'waiting_on must be "owner" or null' };
    const steps = input.steps === undefined ? undefined : parseSteps(input.steps);
    if (steps && "error" in steps) return steps;
    const existing = this.data.tracks.find((t) => t.id === id);
    if (existing) {
      if (!isOpen(existing)) return { error: `track is ${existing.state}` };
      if (title) existing.title = title;
      if (input.order !== undefined) existing.order = typeof input.order === "number" ? input.order : null;
      if (state) existing.state = state;
      if (typeof input.done === "string") existing.done = input.done.trim().slice(0, 300);
      if (typeof input.left === "string") existing.left = input.left.trim().slice(0, 300);
      existing.builds = [...new Set([...existing.builds, ...builds])];
      if (input.waiting_on !== undefined) existing.waiting_on = input.waiting_on === "owner" ? "owner" : null;
      if (steps !== undefined) existing.steps = steps.steps;
      existing.updated = nowIso;
      this.absorbBuildRows(existing);
      this.flush();
      return { ...existing };
    }
    if (!title) return { error: "new track needs a title" };
    const track: Track = {
      id,
      title,
      order: typeof input.order === "number" ? input.order : null,
      state: state ?? "queued",
      done: typeof input.done === "string" ? input.done.trim().slice(0, 300) : "",
      left: typeof input.left === "string" ? input.left.trim().slice(0, 300) : "",
      builds,
      source: "api",
      created: nowIso,
      updated: nowIso,
      missing_from_source: false,
      closed_at: null,
      closed_how: null,
      ...(input.waiting_on === "owner" ? { waiting_on: "owner" as const } : {}),
      ...(steps?.steps ? { steps: steps.steps } : {}),
    };
    this.data.tracks.push(track);
    this.absorbBuildRows(track);
    this.flush();
    return { ...track };
  }

  /**
   * Filing a build under a track retires its stand-alone row: the build is
   * still on the board, inside the track's row. Recorded for the desk's log.
   */
  private absorbBuildRows(track: Track): boolean {
    let any = false;
    for (const b of track.builds) {
      const row = this.data.tracks.find((t) => t.id === `bld-${b}` && isOpen(t));
      if (row) {
        row.state = "closed";
        row.closed_at = this.now().toISOString();
        row.closed_how = `filed under ${track.id}`;
        this.filed.push({ row: row.id, track: track.id });
        any = true;
      }
    }
    return any;
  }

  drainFiled(): Array<{ row: string; track: string }> {
    const out = this.filed;
    this.filed = [];
    return out;
  }

  /** The only way off the board. `how` must carry who closed it. */
  close(id: string, kind: "closed" | "cancelled", how: string): Track | { error: string } {
    const t = this.data.tracks.find((x) => x.id === id);
    if (!t) return { error: "no such track" };
    if (!isOpen(t)) return { error: `already ${t.state}` };
    t.state = kind;
    t.closed_at = this.now().toISOString();
    t.closed_how = how;
    t.updated = t.closed_at;
    this.flush();
    return { ...t };
  }

  /** Open rows, rendered: build order first, then other tracks, then loose builds. */
  board(builds: BuildSummary[]): TrackRow[] {
    const byBuild = new Map(builds.map((b) => [b.id, b]));
    const now = this.now().getTime();
    const rows: TrackRow[] = [];
    for (const t of this.data.tracks) {
      if (!isOpen(t)) continue;
      const linked = t.builds.map((id) => byBuild.get(id)).filter((b): b is BuildSummary => !!b);
      const running = linked.filter((b) => b.state === "running");
      let status: string = t.state;
      let note: string | null = t.missing_from_source ? "not in QUEUE.md any more — still open until the owner closes it" : null;
      if (running.length) {
        const freshest = Math.max(...running.map((b) => (b.lastEventAt ?? b.created).getTime()));
        status = now - freshest > STALE_MS ? "stale" : "running";
        if (status === "stale") note = `no activity for ${Math.floor((now - freshest) / 86_400_000)} days`;
      } else if (t.source === "build" && linked.length) {
        const b = linked[0];
        const finished = b.state === "done" || b.state === "shipped";
        status = finished ? "built" : b.state;
        if (!note) note = finished ? "finished — close it or file it under a track" : `build ${b.state}`;
      }
      rows.push({
        id: t.id,
        title: t.title,
        order: t.order,
        status,
        done: t.done,
        left: t.left,
        builds: linked.map((b) => ({ id: b.id, name: b.name, state: b.state, at: (b.stateAt ?? b.lastEventAt)?.toISOString() ?? null })),
        source: t.source,
        note,
      });
    }
    const rank = (r: TrackRow) => (r.source === "build" ? 2 : r.order !== null ? 0 : 1);
    return rows.sort((a, b) => rank(a) - rank(b) || (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title));
  }
}

export function isOpen(t: Track): boolean {
  return t.state !== "closed" && t.state !== "cancelled";
}

/** null clears the rail; anything malformed is refused whole, never half-applied. */
function parseSteps(raw: unknown): { steps: TrackStep[] | null } | { error: string } {
  if (raw === null) return { steps: null };
  if (!Array.isArray(raw) || raw.length > MAX_STEPS) return { error: `steps must be an array of at most ${MAX_STEPS}` };
  const steps: TrackStep[] = [];
  for (const s of raw) {
    const label = typeof s?.label === "string" ? s.label.replace(/\s+/g, " ").trim() : "";
    if (!label || label.length > 80) return { error: "each step needs a label (≤ 80 chars)" };
    if (!STEP_STATES.has(s.state)) return { error: "step state must be done, now, you or left" };
    const who = s.who == null || s.who === "" ? null : typeof s.who === "string" && s.who.trim().length <= 30 ? s.who.trim() : undefined;
    if (who === undefined) return { error: "step who must be a short name or null" };
    steps.push({ label, state: s.state, who });
  }
  return { steps: steps.length ? steps : null };
}
