/**
 * read-state.ts — what the owner has already seen, so the calendar badge only
 * ever counts what is new ("never accumulates stale
 * numbers").
 *
 *   <gateway state>/schedule/read-<user>.json   { v:1, read: { "<item id>": ISO } }
 *
 * The badge is computed, never stored: unread = items that need him RIGHT
 * NOW (open question, waiting card, a decision he can still overrule —
 * stopped builds are lines, never badge items) whose id is not in `read`. A resolved item leaves the count by
 * itself; a read one never comes back. Ids carry the version of the thing
 * (the question's record id), so a NEW question on the
 * same build is a new item. A mark is pruned only when it is older than 45
 * days AND its item is no longer live — a question that is still open keeps
 * its mark however old it is, so nothing cleared ever comes back. Re-marking
 * refreshes the time. The gateway is the only writer (one process,
 * whole-file atomic rename).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { gatewayStateRoot } from "../multi-user-paths.js";

const KEEP_MS = 45 * 86_400_000;
const USER = /^[a-z0-9][a-z0-9_-]{0,40}$/i;

export function defaultReadStateDir(): string {
  const o = process.env.SCHEDULE_STATE_DIR;
  return o ? resolve(o) : resolve(gatewayStateRoot(), "schedule");
}

export class ReadState {
  constructor(readonly dir: string = defaultReadStateDir()) {}

  private file(user: string): string {
    if (!USER.test(user)) throw new Error(`bad user id: ${user}`);
    return join(this.dir, `read-${user.toLowerCase()}.json`);
  }

  read(user: string): Map<string, string> {
    const f = this.file(user);
    if (!existsSync(f)) return new Map();
    try {
      const raw = JSON.parse(readFileSync(f, "utf8")) as { read?: Record<string, string> };
      return new Map(Object.entries(raw.read ?? {}).filter(([, v]) => typeof v === "string"));
    } catch {
      return new Map();
    }
  }

  /**
   * Mark ids read. A mark already there is refreshed to `now`. Returns how many
   * were new. `live` = the ids that still need him right now: those are never
   * pruned. Without `live` nothing is pruned at all.
   */
  mark(user: string, ids: string[], now = new Date(), live?: ReadonlySet<string>): number {
    const marks = this.read(user);
    let fresh = 0;
    for (const id of ids) {
      if (typeof id !== "string" || !id || id.length > 200) continue;
      if (!marks.has(id)) fresh++;
      marks.set(id, now.toISOString());
    }
    if (live) {
      const cutoff = now.getTime() - KEEP_MS;
      for (const [id, at] of marks) if (!live.has(id) && Date.parse(at) < cutoff) marks.delete(id);
    }
    mkdirSync(this.dir, { recursive: true });
    const f = this.file(user);
    const tmp = `${f}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ v: 1, read: Object.fromEntries(marks) }, null, 1) + "\n");
    renameSync(tmp, f);
    return fresh;
  }
}

/** Badge text: "" for none, "9+" past nine. */
export function badgeText(n: number): string {
  return n <= 0 ? "" : n > 9 ? "9+" : String(n);
}
