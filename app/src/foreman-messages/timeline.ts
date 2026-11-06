/**
 * timeline.ts — per-build timeline store + once-only claims.
 *
 *   <root>/timeline/<build-id>.jsonl   APPEND-ONLY, one entry per line
 *   <root>/claims/<sha256(key)>        empty marker, created O_EXCL
 *
 * Default root: <gateway state root>/foreman (FOREMAN_MESSAGES_STATE_DIR moves it).
 *
 * Nothing here is cached in memory and nothing is rewritten whole, so this
 * store does not have the message-store hazard (a cached file rewritten by
 * the service erasing a line written from outside). Every read goes to disk.
 *
 * Claims are how "once" survives two processes, a retry, and a restart: the
 * first O_EXCL create wins, every later one sees EEXIST. A failed delivery
 * releases its claim so the next path can try.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { createHash } from "crypto";
import { join, resolve } from "path";
import { gatewayStateRoot } from "../multi-user-paths.js";
import { BUILD_ID_RE, type StatusRecord } from "./record.js";
import type { ShipEntry } from "./ship.js";

export function defaultForemanMessagesRoot(): string {
  const override = process.env.FOREMAN_MESSAGES_STATE_DIR;
  return override ? resolve(override) : resolve(gatewayStateRoot(), "foreman");
}

export type TimelineEntry =
  | {
      ts: string;
      type: "record";
      record: StatusRecord;
      /** True only for the one entry whose message went to the owner's chat. */
      chat: boolean;
      /** Exact chat bytes when chat=true. */
      rendered: string | null;
      /** Set when a chat kind was held back because its key had already been said. */
      dedupedBy: string | null;
      textErrors: Record<string, string[]>;
    }
  | { ts: string; type: "michael-reply"; text: string }
  | { ts: string; type: "michael-wake"; bytes: number; ok: boolean; error?: string }
  /** One stage of the build's ship (ship.ts). */
  | ShipEntry;

export class ForemanTimeline {
  readonly root: string;

  constructor(root: string = defaultForemanMessagesRoot()) {
    this.root = root;
    mkdirSync(join(root, "timeline"), { recursive: true });
    mkdirSync(join(root, "claims"), { recursive: true });
  }

  private file(build: string): string {
    if (!BUILD_ID_RE.test(build)) throw new Error(`bad build id: ${build}`);
    return join(this.root, "timeline", `${build}.jsonl`);
  }

  append(build: string, entry: TimelineEntry): void {
    appendFileSync(this.file(build), JSON.stringify(entry) + "\n");
  }

  /** Entries in write order. A torn trailing line (crash mid-append) is skipped, not fatal. */
  read(build: string): TimelineEntry[] {
    const f = this.file(build);
    if (!existsSync(f)) return [];
    const out: TimelineEntry[] = [];
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as TimelineEntry);
      } catch {
        /* torn line */
      }
    }
    return out;
  }

  /** Builds with a timeline, newest file first. */
  builds(): Array<{ build: string; updated: string; entries: number }> {
    const dir = join(this.root, "timeline");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl") && BUILD_ID_RE.test(f.slice(0, -6)))
      .map((f) => {
        const build = f.slice(0, -6);
        const st = statSync(join(dir, f));
        return { build, updated: st.mtime.toISOString(), entries: this.read(build).length, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime || (a.build < b.build ? 1 : -1))
      .map(({ mtime: _m, ...rest }) => rest);
  }

  private claimPath(key: string): string {
    return join(this.root, "claims", createHash("sha256").update(key).digest("hex"));
  }

  /** True for the first caller with this key, ever; false for every later one. */
  claim(key: string): boolean {
    try {
      closeSync(openSync(this.claimPath(key), "wx"));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  }

  release(key: string): void {
    try {
      unlinkSync(this.claimPath(key));
    } catch {
      /* already gone */
    }
  }
}
