/**
 * builds.ts — client for the Builds panel (/app/builds/*). The gateway
 * composes the board; this app never calls /foreman/*.
 *
 * Writes carry `X-AHI-Review: 1` + a JSON body — the same CSRF gate as Review.
 */

export type SectionKey = "needs_you" | "ready" | "moving" | "stuck" | "queued" | "closed_week";
export const SECTION_ORDER: SectionKey[] = ["needs_you", "ready", "moving", "stuck", "queued", "closed_week"];
export type Kicker = "your-step" | "question" | "in-review" | "ship" | "shipping" | "rolled-back" | "now" | "started" | "built" | "stuck" | "queued" | "closed";
import { attentionItems, type AttentionItem, type RestartChoice, type ShipState } from "./ship";
import { startAuthentication } from "@simplewebauthn/browser";
import { fingerprintError } from "./review";

export interface CardRun {
  build: string;
  agent: string;
  started: string;
  state: string;
  cause: string | null;
  counted: boolean;
  /** "codex" → the card shows the live transcript (views/CodexLive.tsx). */
  runtime?: string;
}

export interface Card {
  id: string;
  title: string;
  order: number | null;
  kicker: Kicker;
  from: "michael" | "zali" | "avi" | "foreman" | null;
  opened_at: string;
  last_activity_at: string | null;
  ask: string | null;
  /** The run that asked — sent with his answer so the card's question clears. */
  ask_build?: string | null;
  /** The needs_operator record that asked — the answer clears this question only. */
  ask_record?: string | null;
  review_item: { id: string; lane: "GREEN" | "YELLOW" | "RED"; title: string } | null;
  done: string;
  left: string;
  steps: Array<{ label: string; state: "done" | "now" | "you" | "left"; who: string | null }> | null;
  now: { text: string; at: string } | null;
  checks: { passed: number; total: number } | null;
  close_note: string | null;
  runs: CardRun[];
  closed: { at: string; how: string } | null;
  track_ids: string[];
  /** The ship lane (lib/ship.ts), or null when nothing was ever readied. */
  ship: ShipState | null;
}

export interface BuildsView {
  now: string;
  tz: string;
  tally: { open: number; needs_you: number; oldest: { days: number; ms: number; id: string; title: string } | null };
  sections: Record<SectionKey, Card[]>;
  partial: string[];
}

export interface TimelineItem {
  kind: "progress" | "needs_operator" | "closed" | "failed" | "note" | "ship";
  at: string;
  finished: string | null;
  now: string | null;
  question: string | null;
  checks: { passed: number; total: number } | null;
  cause: string | null;
}

export interface BuildDetail extends Card {
  section: SectionKey;
  timeline: Array<{ run: string; agent: string; started: string; state: string; cause: string | null; counted: boolean; entries: TimelineItem[] }>;
}

/** The run whose Codex session the card shows live: the newest Codex run that launched. */
export function liveCodexRun(card: Pick<Card, "runs">): CardRun | null {
  const codex = card.runs.filter((r) => r.runtime === "codex" && r.cause !== "never-launched");
  return codex.reduce<CardRun | null>((m, r) => (!m || Date.parse(r.started) > Date.parse(m.started) ? r : m), null);
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const BUILDS_URL = "/app/builds";
export const buildUrl = (id: string) => `/app/builds/${encodeURIComponent(id)}`;

async function post<T>(url: string, body: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AHI-Review": "1" },
      body: JSON.stringify(body ?? {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: json.error ?? `HTTP ${res.status}` };
    return { ok: true, value: json as T };
  } catch {
    return { ok: false, error: "No connection — nothing was closed." };
  }
}

export function closeBuild(id: string, kind: "closed" | "cancelled" = "closed"): Promise<Result<{ closed: string[] }>> {
  return post(`${buildUrl(id)}/close`, { kind });
}

export function fileBuild(id: string, track: string): Promise<Result<{ track: { id: string } }>> {
  return post(`${buildUrl(id)}/file`, { track });
}

/**
 * Ship update (FINAL): server challenge → his fingerprint → the ship, verified on the server.
 * With no passkey registered the server answers `options: null` and the ship is a tap, as before.
 * Records the approval with the restart choice and wakes Michael. Safe to tap twice.
 */
export async function shipBuild(id: string, restart: RestartChoice): Promise<Result<{ build: string; state: ShipState; woke: boolean; already: boolean; fingerprint: boolean }>> {
  const ch = await post<{ options: Parameters<typeof startAuthentication>[0]["optionsJSON"] | null }>(`${buildUrl(id)}/ship/challenge`, {});
  if (!ch.ok) return ch;
  let webauthn: unknown = undefined;
  if (ch.value.options) {
    try {
      webauthn = await startAuthentication({ optionsJSON: ch.value.options });
    } catch (err) {
      return { ok: false, error: fingerprintError(err, "shipped") };
    }
  }
  const r = await post<{ build: string; state: ShipState; woke: boolean; already: boolean }>(`${buildUrl(id)}/ship`, { restart, webauthn });
  return r.ok ? { ok: true, value: { ...r.value, fingerprint: !!ch.value.options } } : r;
}

/** The badge (C11): open questions and his own steps — never a review item, Review counts those. */
export function needsYouBadge(view: BuildsView | null): number {
  return view ? view.sections.needs_you.filter((c) => c.kicker === "question" || c.kicker === "your-step" || c.kicker === "ship" || c.kicker === "rolled-back").length : 0;
}

export async function fetchBuildsBadge(): Promise<number | null> {
  return (await fetchBuildsAttention())?.needYou ?? null;
}

/** One read for the badge AND the attention bar: the board's Needs-you section, reduced. */
export async function fetchBuildsAttention(): Promise<{ needYou: number; items: AttentionItem[]; view: BuildsView } | null> {
  try {
    const res = await fetch(BUILDS_URL, { cache: "no-store" });
    if (!res.ok) return null;
    const view = (await res.json()) as BuildsView;
    return { needYou: needsYouBadge(view), items: attentionItems(view.sections.needs_you), view };
  } catch {
    return null;
  }
}

/** The gateway's build identity from /health — "back on <sha>" is measured against it. */
export async function fetchGatewayBuild(): Promise<{ sha: string | null; started: string | null; calls: number } | null> {
  try {
    const res = await fetch("/health", { cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as { build?: { sha?: string | null; started?: string | null }; calls?: number };
    return { sha: j.build?.sha ?? null, started: j.build?.started ?? null, calls: typeof j.calls === "number" ? j.calls : 0 };
  } catch {
    return null;
  }
}
