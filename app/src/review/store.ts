/**
 * store.ts — review-queue state on disk.
 *
 *   <root>/items.json       current items (whole-file atomic rewrite)
 *   <root>/decisions.jsonl  APPEND-ONLY log: every create, decision, refusal,
 *                           reminder, auto-hold, done, passkey change
 *   <root>/desk.json        seen marks, schedule ledger, digest numbering
 *
 * Default root: <gateway state root>/review (~/ai/state/review), movable with
 * REVIEW_STATE_DIR for isolated runs.
 *
 * Single writer: like every gateway state file, these are cached in memory
 * and rewritten whole, so ONLY the gateway process may write them. Outside
 * tools (Michael, foreman, cron) go through the authenticated endpoints —
 * never edit these files by hand while the gateway runs.
 */
import { appendFileSync, existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { atomicWriteJson, ensureDir, gatewayStateRoot } from "../multi-user-paths.js";
import type { LogRecord, ReviewItem } from "./types.js";

export function defaultReviewRoot(): string {
  const override = process.env.REVIEW_STATE_DIR;
  return override ? resolve(override) : resolve(gatewayStateRoot(), "review");
}

export interface SeenMark {
  current: string | null;
  previous: string | null;
}

export interface ScheduleLedger {
  /** slotKey → ISO time it was delivered. */
  delivered: Record<string, string>;
  /** Slots that fell inside Shabbat/Yom Tov; folded into the next message. */
  skipped: Array<{ slot: string; reason: string; at: string; folded_into: string | null }>;
  last_digest_at: string | null;
  last_close_at: string | null;
  last_motzei_at: string | null;
}

export interface Numbering {
  /** Message that issued the numbers ("review-digest-2026-10-07"). */
  source: string;
  at: string;
  /** "1" → item id. YELLOW only — RED is never numbered. */
  map: Record<string, string>;
}

interface DeskFile {
  version: 1;
  seen: Record<string, SeenMark>;
  schedule: ScheduleLedger;
  numbering: Record<string, Numbering>;
}

function emptyDesk(): DeskFile {
  return {
    version: 1,
    seen: {},
    schedule: { delivered: {}, skipped: [], last_digest_at: null, last_close_at: null, last_motzei_at: null },
    numbering: {},
  };
}

export class ReviewStore {
  readonly root: string;
  private items: ReviewItem[];
  private desk: DeskFile;

  constructor(root: string = defaultReviewRoot()) {
    this.root = root;
    ensureDir(root);
    this.items = this.readItems();
    this.desk = this.readDesk();
  }

  private get itemsPath(): string {
    return join(this.root, "items.json");
  }
  private get logPath(): string {
    return join(this.root, "decisions.jsonl");
  }
  private get deskPath(): string {
    return join(this.root, "desk.json");
  }

  private readItems(): ReviewItem[] {
    if (!existsSync(this.itemsPath)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.itemsPath, "utf8"));
      return Array.isArray(raw?.items) ? raw.items : [];
    } catch (err) {
      // Never silently start empty over a real queue — refuse loudly.
      throw new Error(`[review] items.json unreadable at ${this.itemsPath}: ${(err as Error).message}`);
    }
  }

  private readDesk(): DeskFile {
    if (!existsSync(this.deskPath)) return emptyDesk();
    try {
      const raw = JSON.parse(readFileSync(this.deskPath, "utf8"));
      const base = emptyDesk();
      return {
        version: 1,
        seen: raw.seen ?? base.seen,
        schedule: { ...base.schedule, ...raw.schedule },
        numbering: raw.numbering ?? base.numbering,
      };
    } catch (err) {
      console.error(`[review] desk.json unreadable — schedule ledger reset:`, err);
      return emptyDesk();
    }
  }

  // ── items ──────────────────────────────────────────────────────────────

  all(): ReviewItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  get(id: string): ReviewItem | null {
    const it = this.items.find((i) => i.id === id);
    return it ? { ...it } : null;
  }

  insert(item: ReviewItem): void {
    if (this.items.some((i) => i.id === item.id)) throw new Error(`duplicate item id ${item.id}`);
    this.items.push({ ...item });
    this.flushItems();
  }

  update(id: string, patch: Partial<ReviewItem>): ReviewItem {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx === -1) throw new Error(`no item ${id}`);
    this.items[idx] = { ...this.items[idx], ...patch, id };
    this.flushItems();
    return { ...this.items[idx] };
  }

  private flushItems(): void {
    atomicWriteJson(this.itemsPath, { version: 1, items: this.items });
  }

  // ── append-only log ────────────────────────────────────────────────────

  log(record: LogRecord): void {
    ensureDir(this.root);
    appendFileSync(this.logPath, JSON.stringify(record) + "\n");
  }

  readLog(): LogRecord[] {
    if (!existsSync(this.logPath)) return [];
    return readFileSync(this.logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as LogRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is LogRecord => r !== null);
  }

  // ── desk state ─────────────────────────────────────────────────────────

  seen(userId: string): SeenMark {
    return { ...(this.desk.seen[userId] ?? { current: null, previous: null }) };
  }

  setSeen(userId: string, mark: SeenMark): void {
    this.desk.seen[userId] = mark;
    this.flushDesk();
  }

  schedule(): ScheduleLedger {
    return JSON.parse(JSON.stringify(this.desk.schedule));
  }

  setSchedule(ledger: ScheduleLedger, now: Date = new Date()): void {
    // Keep the ledger bounded: 120 days of slots is plenty for idempotency.
    const cutoff = now.getTime() - 120 * 86_400_000;
    for (const [k, v] of Object.entries(ledger.delivered)) {
      if (Date.parse(v) < cutoff) delete ledger.delivered[k];
    }
    ledger.skipped = ledger.skipped.filter((s) => Date.parse(s.at) >= cutoff);
    this.desk.schedule = ledger;
    this.flushDesk();
  }

  numbering(userId: string): Numbering | null {
    const n = this.desk.numbering[userId];
    return n ? { ...n, map: { ...n.map } } : null;
  }

  setNumbering(userId: string, n: Numbering): void {
    this.desk.numbering[userId] = n;
    this.flushDesk();
  }

  private flushDesk(): void {
    atomicWriteJson(this.deskPath, this.desk);
  }
}
