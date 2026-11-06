/**
 * sources.ts — the raw feeds the calendar's briefs come from. All read-only,
 * all already on the box; nothing new is recorded to feed this tab.
 *
 *   builds     foreman ledger (meta.json + events.jsonl) via review/ledger.ts;
 *              the brief's own `tag:` header when it has one
 *   records    the gateway's foreman status timeline (plain sentences, rail-checked)
 *   review     the review desk's cards (waiting / decided / done)
 *   activity   mission-control/ACTIVITY_FEED.md headings ("## 2026-10-19 13:32 — AHI tech radar")
 *   decisions  decisions.jsonl (decisions.ts)
 *
 * The interface is what compose.ts sees; tests hand it fakes. A reader that
 * cannot read THROWS — it never answers "nothing" — so compose.ts can tell an
 * empty feed from an outage (an outage must not prune read marks).
 */
import { existsSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { readBuilds } from "../review/ledger.js";
import type { TimelineEntry } from "../foreman-messages/timeline.js";
import { wallTimeToUtc } from "../local-time.js";
import { readDecisions, type Decision } from "./decisions.js";

export interface RawBuild {
  id: string;
  name: string;
  agent: string;
  /** running | done | failed | abandoned | … (the ledger's last status event). */
  state: string;
  created: Date;
  stateAt: Date | null;
  lastEventAt: Date | null;
  /** `tag:` from the brief's header, if the brief carries one. */
  briefTag: string | null;
}

export interface RawRecord {
  id: string;
  at: Date;
  kind: "progress" | "needs_operator" | "closed" | "failed";
  title: string | null;
  finished: string;
  now: string;
  question: string | null;
}

export interface RawReview {
  id: string;
  title: string;
  lane: string;
  status: string;
  created: string;
  decided_at: string | null;
  decided_how: string | null;
  done_at: string | null;
  ref: string | null;
}

export interface RawActivity {
  at: Date;
  title: string;
}

export interface ScheduleSources {
  builds(since: Date): RawBuild[];
  records(build: string): RawRecord[];
  review(owner: string): RawReview[];
  activity(since: Date): RawActivity[];
  decisions(): Decision[];
}

// ── defaults ──────────────────────────────────────────────────────────

const BRIEF_EVENT = /"type":\s*"brief".*?path=(\S+?\.md)/;

/** How long a brief-tag miss is trusted before the brief is read again. */
const TAG_RETRY_MS = 60_000;

function briefTagOf(buildsDir: string, id: string): string | null {
  try {
    const ev = join(buildsDir, id, "events.jsonl");
    if (!existsSync(ev)) return null;
    const m = BRIEF_EVENT.exec(readFileSync(ev, "utf8"));
    if (!m || !existsSync(m[1])) return null;
    const head = readFileSync(m[1], "utf8").slice(0, 4000);
    const fm = /^---\n([\s\S]*?)\n---/.exec(head);
    const tag = fm && /^tag:\s*([a-z0-9-]+)\s*$/im.exec(fm[1]);
    return tag ? tag[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * ACTIVITY_FEED.md headings. The box writes them in UTC (cron runs UTC; the
 * radar's 13:30 UTC cron lands as "13:32"), so that is the default zone;
 * SCHEDULE_ACTIVITY_TZ moves it. Only the heading is used — the bodies carry
 * paths and detail that do not belong on a one-line brief.
 */
export function parseActivityHeadings(text: string, zone = "UTC"): RawActivity[] {
  const out: RawActivity[] = [];
  const re = /^##\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s*(?:[A-Z]{2,4}\s*)?[—–-]+\s*(.+)$/gm;
  for (const m of text.matchAll(re)) {
    const at = wallTimeToUtc({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] }, zone);
    out.push({ at, title: m[6].trim() });
  }
  return out;
}

export interface DefaultSourceOptions {
  buildsDir: string;
  timelines: { read(build: string): TimelineEntry[] } | null;
  reviewItems: ((owner: string) => RawReview[]) | null;
  activityPath: string;
  decisionsPath: string;
}

export function defaultActivityPath(): string {
  const o = process.env.SCHEDULE_ACTIVITY_FEED;
  return o ? resolve(o) : resolve(homedir(), "AHI/AHI_OS/mission-control/ACTIVITY_FEED.md");
}

export function defaultSources(o: DefaultSourceOptions): ScheduleSources {
  // A found tag is kept for good; a miss (the brief or its event may not exist yet
  // when a build is first polled) is looked up again after TAG_RETRY_MS.
  const tagCache = new Map<string, { tag: string | null; at: number }>();
  let activityCache: { mtimeMs: number; items: RawActivity[] } | null = null;
  const activityZone = process.env.SCHEDULE_ACTIVITY_TZ || "UTC";
  const tagOf = (id: string, nowMs: number): string | null => {
    const c = tagCache.get(id);
    if (c && (c.tag !== null || nowMs - c.at < TAG_RETRY_MS)) return c.tag;
    const tag = briefTagOf(o.buildsDir, id);
    tagCache.set(id, { tag, at: nowMs });
    return tag;
  };
  return {
    builds(since) {
      const nowMs = Date.now();
      // strict: a missing / unreadable ledger throws (an outage), never reads as "no builds".
      return readBuilds(o.buildsDir, since, { includeRunning: true, strict: true }).map((b) => {
        return {
          id: b.id,
          name: b.name,
          agent: b.agent,
          state: b.state,
          created: b.created,
          stateAt: b.stateAt,
          lastEventAt: b.lastEventAt,
          briefTag: tagOf(b.id, nowMs),
        };
      });
    },
    records(build) {
      // No timeline adapter (it failed to start) is an outage, not "no records" — throw so the read is incomplete.
      if (!o.timelines) throw new Error("timelines unavailable");
      const entries: TimelineEntry[] = o.timelines.read(build); // a read error throws — reported, not swallowed
      const out: RawRecord[] = [];
      for (const e of entries) {
        if (e.type !== "record" || !e.record) continue;
        const r = e.record;
        const at = new Date(r.at ?? e.ts);
        if (!Number.isFinite(at.getTime())) continue;
        out.push({ id: r.id, at, kind: r.kind, title: r.title, finished: r.finished, now: r.now, question: r.question });
      }
      return out.sort((a, b) => a.at.getTime() - b.at.getTime());
    },
    review(owner) {
      // No review adapter (the desk failed to start) is an outage, not "no cards" — throw, same as a read error.
      if (!o.reviewItems) throw new Error("review source not wired");
      return o.reviewItems(owner);
    },
    activity(since) {
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(o.activityPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; // no feed file = nothing logged, not an outage
        throw err;
      }
      if (!activityCache || activityCache.mtimeMs !== st.mtimeMs) {
        activityCache = { mtimeMs: st.mtimeMs, items: parseActivityHeadings(readFileSync(o.activityPath, "utf8"), activityZone) };
      }
      return activityCache.items.filter((a) => a.at >= since);
    },
    decisions() {
      return readDecisions(o.decisionsPath); // no file = []; a read error throws
    },
  };
}
