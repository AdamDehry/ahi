/**
 * wakes.ts — approval wakes (approving a review item must START
 * the work, with no chat from him).
 *
 * Every transition to `approved` enqueues ONE wake for Michael — keyed on the
 * item id + the approval's decided_at, so a double tap, a retry or a restart
 * can never send two. The outbox is a file in the review root, written only by
 * the gateway process, and it is drained:
 *   - right after the approval (never awaited — the phone's answer never waits
 *     on Michael's turn),
 *   - on every schedule tick, and on the gateway's own minute timer.
 * Inside Shabbat / Yom Tov (may_execute = no) a wake WAITS for nightfall
 * instead of being dropped. A wake that fails is logged and retried with
 * backoff. The wake goes into Michael's own turn (the foreman's quiet wake
 * path), never into the owner's chat.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { atomicWriteJson } from "../multi-user-paths.js";

export type WakeState = "pending" | "sent" | "skipped";

export interface WakeEntry {
  key: string;
  item_id: string;
  owner: string;
  approved_at: string;
  state: WakeState;
  attempts: number;
  /** Not before this instant (gate deferral or retry backoff). */
  next_at: string;
  /** Why it is waiting: "gate: Shabbat until …" / "retry: <error>". */
  waiting: string | null;
  sent_at: string | null;
  /** The exact text Michael was woken with. */
  text: string | null;
}

/** 1m, 5m, 15m, then hourly. */
export function backoffMs(attempts: number): number {
  return [60_000, 5 * 60_000, 15 * 60_000][attempts - 1] ?? 60 * 60_000;
}

export class WakeOutbox {
  private entries: WakeEntry[];

  constructor(private readonly root: string) {
    this.entries = this.read();
  }

  private get path(): string {
    return join(this.root, "wakes.json");
  }

  private read(): WakeEntry[] {
    if (!existsSync(this.path)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      return Array.isArray(raw?.wakes) ? raw.wakes : [];
    } catch (err) {
      // A lost outbox would silently drop approved work — refuse loudly.
      throw new Error(`[review] wakes.json unreadable at ${this.path}: ${(err as Error).message}`);
    }
  }

  private flush(): void {
    atomicWriteJson(this.path, { version: 1, wakes: this.entries });
  }

  all(): WakeEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /** Idempotent: the same approval enqueues once, however often it is reported. */
  enqueue(e: { item_id: string; owner: string; approved_at: string; now: Date }): { entry: WakeEntry; fresh: boolean } {
    const key = `approve:${e.item_id}:${e.approved_at}`;
    const existing = this.entries.find((x) => x.key === key);
    if (existing) return { entry: { ...existing }, fresh: false };
    const entry: WakeEntry = {
      key,
      item_id: e.item_id,
      owner: e.owner,
      approved_at: e.approved_at,
      state: "pending",
      attempts: 0,
      next_at: e.now.toISOString(),
      waiting: null,
      sent_at: null,
      text: null,
    };
    this.entries.push(entry);
    this.flush();
    return { entry: { ...entry }, fresh: true };
  }

  due(now: Date): WakeEntry[] {
    return this.entries.filter((e) => e.state === "pending" && Date.parse(e.next_at) <= now.getTime()).map((e) => ({ ...e }));
  }

  update(key: string, patch: Partial<WakeEntry>): void {
    const i = this.entries.findIndex((x) => x.key === key);
    if (i === -1) return;
    this.entries[i] = { ...this.entries[i], ...patch, key };
    this.flush();
  }
}
