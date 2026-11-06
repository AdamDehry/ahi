/**
 * ideas.ts — read-only view of the Idea Vault (IDEAS.md) for the Feed.
 *
 * The vault's own rule: truth is the `- [ ]` / `- [x]` lines; Michael flips
 * them. A card:
 *
 *   ## 2026-06-20 — Mac/VPS → phone bridge
 *   **Tag:** product
 *   **Status:** parked
 *   …
 *   ### Steps
 *   - [x] done thing
 *   - [ ] next thing
 *
 * One idea row per card that is still open (status not done/dropped and at
 * least one unticked step, or no steps at all). Its id is stable across
 * re-renders of the file: `idea-<date>-<slug of the title>`. Nothing here
 * writes; ticking happens in the file, by Michael.
 */
import { existsSync, readFileSync, statSync } from "fs";

export interface IdeaCard {
  id: string;
  date: string;
  title: string;
  tag: string | null;
  status: string | null;
  steps: Array<{ done: boolean; text: string }>;
  /** The first unticked step — what has to happen next. */
  next: string | null;
  /** All steps ticked, or status done/dropped. */
  closed: boolean;
}

const CARD_RE = /^##\s+(\d{4}-\d{2}-\d{2})\s+[—–-]+\s+(.+?)\s*$/;
const FIELD_RE = /^\*\*(Tag|Status):\*\*\s*(.+?)\s*$/;
const STEP_RE = /^\s*-\s*\[([ xX])\]\s+(.+?)\s*$/;
const CLOSED_STATUS = new Set(["done", "dropped"]);

export function ideaSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "untitled"
  );
}

/** Parse the vault text. Never throws; a malformed card is skipped, not fatal. */
export function parseIdeas(text: string): IdeaCard[] {
  const out: IdeaCard[] = [];
  let cur: IdeaCard | null = null;
  const flush = () => {
    if (!cur) return;
    cur.next = cur.steps.find((s) => !s.done)?.text ?? null;
    cur.closed = (cur.status !== null && CLOSED_STATUS.has(cur.status)) || (cur.steps.length > 0 && cur.steps.every((s) => s.done));
    out.push(cur);
    cur = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const card = CARD_RE.exec(line);
    if (card) {
      flush();
      cur = { id: `idea-${card[1]}-${ideaSlug(card[2])}`, date: card[1], title: card[2].slice(0, 160), tag: null, status: null, steps: [], next: null, closed: false };
      continue;
    }
    if (!cur) continue;
    if (/^#\s/.test(line) || /^##\s/.test(line)) {
      flush();
      continue;
    }
    const field = FIELD_RE.exec(line);
    if (field) {
      if (field[1] === "Tag") cur.tag = field[2].toLowerCase();
      else cur.status = field[2].toLowerCase();
      continue;
    }
    const step = STEP_RE.exec(line);
    if (step) cur.steps.push({ done: step[1] !== " ", text: step[2].slice(0, 200) });
  }
  flush();
  // Two cards with the same date + title: keep ids unique so a row never swallows another.
  const seen = new Map<string, number>();
  for (const c of out) {
    const n = (seen.get(c.id) ?? 0) + 1;
    seen.set(c.id, n);
    if (n > 1) c.id = `${c.id}-${n}`;
  }
  return out;
}

export interface IdeasRead {
  cards: IdeaCard[];
  mtime: string | null;
  /** The file is absent or unreadable — the feed says so instead of showing an empty vault. */
  error: string | null;
}

export function readIdeas(path: string | null): IdeasRead {
  if (!path) return { cards: [], mtime: null, error: null };
  if (!existsSync(path)) return { cards: [], mtime: null, error: "idea vault not found" };
  try {
    return { cards: parseIdeas(readFileSync(path, "utf8")), mtime: new Date(statSync(path).mtimeMs).toISOString(), error: null };
  } catch (err) {
    return { cards: [], mtime: null, error: `idea vault unreadable: ${(err as Error).message}` };
  }
}
