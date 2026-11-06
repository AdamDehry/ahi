/**
 * feed.ts — client for the Feed (/app/feed/*). The gateway composes the list;
 * this app never reads the foreman, the briefs or the vault itself.
 *
 * Writes carry `X-AHI-Review: 1` + a JSON body — the review desk's CSRF gate.
 * Start is a fingerprint: server challenge → phone → server verifies; the
 * client sends the raw authenticator response and never claims "verified".
 */
import { startAuthentication } from "@simplewebauthn/browser";

/** The one browser call (navigator.credentials.get) — behind an object so a node test can stand in for the phone. */
export const webauthn = { start: startAuthentication };

export type FeedKind = "needs_you" | "parked" | "idea";
export type FeedStatus = "question" | "review" | "your-step" | "hold" | "built" | "stuck" | "queued" | "brief" | "starting" | "running" | "failed" | "idea" | "gone";

export interface StartBrief {
  path: string;
  sha256: string;
  name: string;
  summary: string;
  agent: string;
  runtime: string;
  model: string;
  effort: string;
  pre_approved: boolean;
}

export interface StartInfo {
  ok: boolean;
  why: string | null;
  brief: StartBrief | null;
  launch: { id: string; state: "pending" | "started" | "failed"; build_id: string | null; error: string | null; requested_at: string } | null;
}

export type FeedAction =
  | { kind: "start" }
  | { kind: "brief-needed" }
  | { kind: "close"; file_under: Array<{ id: string; title: string }> }
  | { kind: "open-review"; item: string }
  | { kind: "answer"; build: string | null; question_build?: string | null; question_record?: string | null }
  | { kind: "watch"; build: string }
  | { kind: "ask-brief"; asked_at: string | null };

export interface FeedRow {
  id: string;
  kind: FeedKind;
  status: FeedStatus;
  what: string;
  where: string;
  from: string | null;
  at: string;
  action: FeedAction;
  start: StartInfo | null;
  card: string | null;
  track_ids: string[];
  pre_approved: boolean;
  note: string | null;
}

export interface FeedView {
  now: string;
  tz: string;
  slots: { running: number; cap: number; free: number; builds: Array<{ id: string; name: string; agent: string; since: string; card: string | null }> };
  rows: FeedRow[];
  counts: { needs_you: number; parked: number; ideas: number };
  briefs_invalid: Array<{ path: string; errors: string[] }>;
  restricted: string | null;
  partial: string[];
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; code?: string };

export const FEED_URL = "/app/feed";
const rowUrl = (id: string, verb: string) => `/app/feed/rows/${encodeURIComponent(id)}/${verb}`;

async function post<T>(url: string, body: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-AHI-Review": "1" }, body: JSON.stringify(body ?? {}) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: json.error ?? `HTTP ${res.status}`, code: json.code };
    return { ok: true, value: json as T };
  } catch {
    return { ok: false, error: "No connection — nothing was sent.", code: "network" };
  }
}

function fingerprintError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError") return "Fingerprint cancelled or timed out — nothing was started.";
  if (name === "SecurityError") return "Passkeys only work on the app's own address.";
  return "The fingerprint didn't go through — nothing was started.";
}

/** Start: server challenge → phone fingerprint → server verifies and launches out of process. */
export async function startWithFingerprint(id: string): Promise<Result<{ launch: { id: string; state: string }; fresh: boolean }>> {
  const ch = await post<{ options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>(rowUrl(id, "challenge"), {});
  if (!ch.ok) return ch;
  let assertion;
  try {
    assertion = await webauthn.start({ optionsJSON: ch.value.options });
  } catch (err) {
    return { ok: false, error: fingerprintError(err), code: "cancelled" };
  }
  return post(rowUrl(id, "start"), { webauthn: assertion });
}

export function askForBrief(id: string): Promise<Result<{ asked_at: string; fresh: boolean }>> {
  return post(rowUrl(id, "ask"), {});
}

export function closeRow(id: string, kind: "closed" | "cancelled" = "closed"): Promise<Result<{ closed: string[] }>> {
  return post(rowUrl(id, "close"), { kind });
}

export function fileRow(id: string, track: string): Promise<Result<{ track: string }>> {
  return post(rowUrl(id, "file"), { track });
}

/** The menu badge: rows that need him. */
export function needsYouCount(view: FeedView | null): number {
  return view ? view.counts.needs_you : 0;
}
