/**
 * review.ts — client for the gateway's review desk (/app/review/*).
 *
 * Same-origin cookie auth like the rest of lib/api.ts. Every write carries
 * `X-AHI-Review: 1` (the server's CSRF gate — the session cookie is
 * SameSite=None) and a JSON body.
 *
 * The fingerprint: @simplewebauthn/browser drives navigator.credentials and
 * hands back the raw authenticator response. We send THAT and nothing else —
 * the client never claims "verified"; the gateway verifies the signature.
 */
import { startAuthentication, startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";

export type Lane = "GREEN" | "YELLOW" | "RED";
export type ItemStatus = "waiting" | "approved" | "denied" | "held" | "done";
export type Decision = "approve" | "deny" | "hold";

export interface ReviewItem {
  id: string;
  lane: Lane;
  desk: string;
  title: string;
  brief: string;
  cost_risk: string;
  created: string;
  created_by: string;
  status: ItemStatus;
  decided_at: string | null;
  decided_how: string | null;
  ref: string | null;
  done_at: string | null;
  done_note: string | null;
  reminded_at: string | null;
  passkey: { credential_id: string; verified: boolean } | null;
}

/** Review → System: one entry per alert class, repeats collapsed (gateway src/review/alerts.ts). */
export interface SystemAlert {
  class: string;
  source: string;
  severity: "hard" | "soft";
  title: string;
  detail: string;
  first_seen: string;
  last_seen: string;
  count: number;
  acked_at: string | null;
  acked_by: string | null;
  pushed_at: string | null;
  resolved_at: string | null;
}

export interface ReviewView {
  now: string;
  since: string;
  first_visit: boolean;
  tz: string;
  waiting: ReviewItem[];
  holding: ReviewItem[];
  done: ReviewItem[];
  builds: Array<{ id: string; name: string; agent: string; state: string; at: string | null }>;
  passkeys: number;
  enroll_open_until: string | null;
  next: Array<{ kind: string; at: string; label: string }>;
  /** Absent on a gateway older than the System feed. */
  alerts?: SystemAlert[];
}

export interface Passkey {
  id: string;
  label: string;
  created: string;
  last_used: string | null;
  device_type: string;
  backed_up: boolean;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; code?: string };

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function post<T>(url: string, body: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AHI-Review": "1" },
      body: JSON.stringify(body ?? {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: json.error ?? `HTTP ${res.status}`, code: json.code };
    return { ok: true, value: json as T };
  } catch {
    return { ok: false, error: "No connection — nothing was sent.", code: "network" };
  }
}

export function fetchReview(mark: boolean): Promise<ReviewView | null> {
  return getJson<ReviewView>(`/app/review${mark ? "?mark=1" : ""}`);
}

export async function fetchWaitingCount(): Promise<number | null> {
  const r = await getJson<{ waiting: number }>("/app/review/summary");
  return r ? r.waiting : null;
}

/** YELLOW (any decision) and RED No / Hold — one tap. */
/** "Got it" on a system alert: nobody gets pushed about it again this episode. */
export function ackAlert(cls: string): Promise<Result<{ alert: SystemAlert }>> {
  return post(`/app/review/alerts/${encodeURIComponent(cls)}/ack`, {});
}

export function decide(id: string, decision: Decision): Promise<Result<{ item: ReviewItem }>> {
  return post(`/app/review/items/${encodeURIComponent(id)}/decide`, { decision });
}

export function webauthnSupported(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/** `what` names the action that didn't happen ("approved", "shipped", …). */
export function fingerprintError(err: unknown, what = "approved"): string {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError") return `Fingerprint cancelled or timed out — nothing was ${what}.`;
  if (name === "SecurityError") return "Passkeys only work on the app's own address.";
  if (name === "InvalidStateError") return "This phone already has a passkey here.";
  return `The fingerprint didn't go through — nothing was ${what}.`;
}

/** RED approve: server challenge → phone fingerprint → server verifies. */
export async function approveWithFingerprint(id: string): Promise<Result<{ item: ReviewItem }>> {
  const ch = await post<{ options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>(
    `/app/review/items/${encodeURIComponent(id)}/challenge`,
    {},
  );
  if (!ch.ok) return ch;
  let assertion;
  try {
    assertion = await startAuthentication({ optionsJSON: ch.value.options });
  } catch (err) {
    return { ok: false, error: fingerprintError(err), code: "cancelled" };
  }
  return post(`/app/review/items/${encodeURIComponent(id)}/decide`, { decision: "approve", webauthn: assertion });
}

// ── passkeys (Settings) ────────────────────────────────────────────────

export function fetchPasskeys(): Promise<{ passkeys: Passkey[]; enroll_open_until: string | null; rp_id: string } | null> {
  return getJson("/app/review/passkeys");
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const model = /;\s*(SM-[A-Z0-9]+|Pixel [^;)]+)/.exec(ua)?.[1];
  if (model?.startsWith("SM-S93")) return "Galaxy S25";
  if (model) return model.trim();
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return "Android phone";
  if (/Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  return "This device";
}

/**
 * Add this phone. If a passkey already exists, the server first wants a
 * fingerprint from it (so a stolen session can't enroll its own device).
 */
export async function addThisDevice(hasExisting: boolean, enrollOpen: boolean): Promise<Result<{ passkey: Passkey }>> {
  let proof: unknown;
  if (hasExisting && !enrollOpen) {
    const ch = await post<{ options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("/app/review/passkeys/challenge", { purpose: "enroll" });
    if (!ch.ok) return ch;
    try {
      proof = await startAuthentication({ optionsJSON: ch.value.options });
    } catch (err) {
      return { ok: false, error: fingerprintError(err), code: "cancelled" };
    }
  }
  const opts = await post<{ options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>("/app/review/passkeys/options", proof ? { proof } : {});
  if (!opts.ok) return opts;
  let reg;
  try {
    reg = await startRegistration({ optionsJSON: opts.value.options });
  } catch (err) {
    return { ok: false, error: fingerprintError(err, "added"), code: "cancelled" };
  }
  return post("/app/review/passkeys/register", { response: reg, label: deviceLabel() });
}

export async function removePasskey(id: string): Promise<Result<{ ok: true }>> {
  const ch = await post<{ options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("/app/review/passkeys/challenge", { purpose: "remove", id });
  if (!ch.ok) return ch;
  let proof;
  try {
    proof = await startAuthentication({ optionsJSON: ch.value.options });
  } catch (err) {
    return { ok: false, error: fingerprintError(err, "removed"), code: "cancelled" };
  }
  return post(`/app/review/passkeys/${encodeURIComponent(id)}/remove`, { proof });
}

export function fetchItem(id: string): Promise<{ item: ReviewItem; passkeys: number } | null> {
  return getJson(`/app/review/items/${encodeURIComponent(id)}`);
}
