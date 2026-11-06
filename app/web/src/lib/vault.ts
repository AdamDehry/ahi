/**
 * vault.ts — client for the gateway's vault (/app/vault/*).
 *
 * Same-origin cookie auth like lib/api.ts. Every write carries `X-AHI-Vault: 1`
 * (the server's CSRF gate) and a JSON body. The fingerprint is the review
 * desk's: @simplewebauthn/browser hands back the raw authenticator response
 * and we send THAT; the gateway verifies.
 *
 * Nothing here ever holds a full account number except the one `reveal`
 * response, which the view shows once and drops.
 */
import { startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";

export type Owner = "owner" | "business" | "shared" | "unknown";
export const OWNERS: Owner[] = ["owner", "business", "shared", "unknown"];
export const OWNER_LABELS: Record<Owner, string> = {
  owner: "You",
  business: "Your business",
  shared: "Shared",
  unknown: "Unknown owner",
};

export type SourceKind = "feed" | "statement" | "manual" | "bureau" | "seed";

export interface VaultAccount {
  id: string;
  owner: Owner;
  shared_with: Owner[];
  kind: "asset" | "liability" | "contingent" | "tax_attribute";
  subtype: string;
  institution: string;
  last4: string | null;
  amount: number | null;
  as_of: string | null;
  source: SourceKind;
  confidence: "high" | "medium" | "low";
  entered_by: string;
  apr_pct: number | null;
  apr_text: string | null;
  min_payment: number | null;
  secured_by: string | null;
  note: string | null;
  active: boolean;
  connected: boolean;
  has_secret_number: boolean;
  age_days: number | null;
  stale: boolean;
}

export interface VaultItem {
  id: string;
  owner: Owner;
  shared_with: Owner[];
  split: Partial<Record<Owner, number>> | null;
  kind: string;
  side: "asset" | "liability" | "contingent";
  name: string;
  amount: number | null;
  as_of: string | null;
  source: SourceKind;
  confidence: string;
  entered_by: string;
  entered_at: string;
  note: string | null;
  age_days: number | null;
}

export interface Netted {
  owner: Owner;
  assets: number;
  liabilities: number;
  net: number;
  unknown_figures: number;
  known_figures: number;
}

export interface VaultFlag {
  id: string;
  kind: string;
  account_id: string | null;
  owner: Owner;
  title: string;
  detail: string;
  raised_at: string;
  posted_ref: string | null;
}

export interface VaultPicture {
  now: string;
  owners: Array<{ owner: Owner; label: string; accounts: VaultAccount[]; items: VaultItem[]; totals: Netted }>;
  owner: Netted;
  owner_look_through: { label: "look-through"; net: number; shares: Array<{ owner: Owner; pct: number; net: number }> };
  expensive_debts: Array<{ id: string; owner: Owner; institution: string; last4: string | null; amount: number | null; apr_pct: number; interest_per_year: number | null }>;
  cash_flow: {
    minimums_30d: number;
    minimums_counted: number;
    minimums_unknown: number;
    cash_by_owner: Partial<Record<Owner, number>>;
    pressure_by_owner: Partial<Record<Owner, { minimums: number; cash: number; shortfall: number }>>;
  };
  flags: VaultFlag[];
  connections: Array<{ id: string; provider: string; institution: string; owner: Owner; status: string; last_refresh_at: string | null; last_refresh_ok: boolean | null; accounts: number }>;
  staleness: { oldest_as_of: string | null; newest_as_of: string | null; stale_count: number; total_known: number };
  seed: { imported_at: string; rows: number } | null;
  provider: { id: string; name: string; configured: boolean; scopes: string[] };
  passkeys: number;
  documents: Array<{ id: string; kind: string; filename: string; uploaded_at: string; owner: Owner; parsed: { parser: string; summary: string } | null }>;
  initialized: boolean;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; code?: string; status?: number };

async function req<T>(url: string, method: string, body?: unknown, multipart?: FormData): Promise<Result<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: multipart ? { "X-AHI-Vault": "1" } : { "Content-Type": "application/json", "X-AHI-Vault": "1" },
      body: multipart ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: json.error ?? `HTTP ${res.status}`, code: json.code, status: res.status };
    return { ok: true, value: json as T };
  } catch {
    return { ok: false, error: "No connection — nothing was sent.", code: "network" };
  }
}

export async function fetchVault(): Promise<Result<VaultPicture>> {
  try {
    const res = await fetch("/app/vault", { cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: json.error ?? `HTTP ${res.status}`, code: json.code, status: res.status };
    return { ok: true, value: json as VaultPicture };
  } catch {
    return { ok: false, error: "No connection.", code: "network" };
  }
}

export const importSeed = (force = false) => req<{ accounts: number; items: number }>("/app/vault/seed", "POST", { force });
export const refreshFeeds = () => req<{ refreshed: number; failed: number; flags: VaultFlag[] }>("/app/vault/refresh", "POST", {});
export const ackFlag = (id: string) => req<{ ok: true }>(`/app/vault/flags/${encodeURIComponent(id)}/ack`, "POST", {});
export const addItem = (body: Record<string, unknown>) => req<{ item: VaultItem }>("/app/vault/items", "POST", body);
export const editItem = (id: string, body: Record<string, unknown>) => req<{ item: VaultItem }>(`/app/vault/items/${encodeURIComponent(id)}`, "PUT", body);
export const deleteItem = (id: string) => req<{ ok: true }>(`/app/vault/items/${encodeURIComponent(id)}`, "DELETE", {});
export const addAccount = (body: Record<string, unknown>) => req<{ account: VaultAccount }>("/app/vault/accounts", "POST", body);
export const editAccount = (id: string, body: Record<string, unknown>) => req<{ account: VaultAccount }>(`/app/vault/accounts/${encodeURIComponent(id)}`, "PUT", body);
export const deleteAccount = (id: string) => req<{ ok: true }>(`/app/vault/accounts/${encodeURIComponent(id)}`, "DELETE", {});
export const mergeAccount = (id: string, target: string) => req<{ account: VaultAccount }>(`/app/vault/accounts/${encodeURIComponent(id)}/merge-into/${encodeURIComponent(target)}`, "POST", {});
export const disconnect = (id: string) => req<{ token_deleted: boolean; provider_revoked: boolean }>(`/app/vault/connections/${encodeURIComponent(id)}/disconnect`, "POST", {});
export const deleteDoc = (id: string) => req<{ ok: true }>(`/app/vault/docs/${encodeURIComponent(id)}`, "DELETE", {});
export const deleteSecret = (id: string) => req<{ ok: true }>(`/app/vault/accounts/${encodeURIComponent(id)}/secret`, "DELETE", {});

export function uploadDoc(file: File, fields: { kind: string; owner: Owner; institution?: string; as_of?: string; bureau?: string }) {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("kind", fields.kind);
  fd.append("owner", fields.owner);
  if (fields.institution) fd.append("institution", fields.institution);
  if (fields.as_of) fd.append("as_of", fields.as_of);
  if (fields.bureau) fd.append("bureau", fields.bureau);
  return req<{ document: { parsed: { summary: string } | null }; parse_error: string | null }>("/app/vault/docs", "POST", undefined, fd);
}

export function webauthnSupported(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

function fingerprintError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError") return "Fingerprint cancelled or timed out — nothing happened.";
  if (name === "SecurityError") return "Passkeys only work on the app's own address.";
  return "The fingerprint didn't go through — nothing happened.";
}

/** Server challenge → fingerprint → the raw assertion, for connect / secret / reveal. */
async function assertion(purpose: "connect" | "secret" | "reveal" | "unlock", id?: string): Promise<Result<unknown>> {
  const ch = await req<{ options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("/app/vault/passkey/challenge", "POST", { purpose, id });
  if (!ch.ok) return ch;
  try {
    return { ok: true, value: await startAuthentication({ optionsJSON: ch.value.options }) };
  } catch (err) {
    return { ok: false, error: fingerprintError(err), code: "cancelled" };
  }
}

export interface ConnectStart {
  session: string;
  mode: "redirect" | "paste";
  url: string | null;
  link_token: string | null;
  instructions: string;
  scopes: string[];
}

/** Lock the Vault in the app (server-side) until a passkey opens it. */
export const lockVault = () => req<{ ok: true; locked: true }>("/app/vault/lock", "POST", {});
export async function unlockVault(): Promise<Result<{ ok: true; locked: false }>> {
  const a = await assertion("unlock");
  if (!a.ok) return a;
  return req("/app/vault/unlock", "POST", { webauthn: a.value });
}

export async function startConnect(owner: Owner): Promise<Result<ConnectStart>> {
  const a = await assertion("connect");
  if (!a.ok) return a;
  return req<ConnectStart>("/app/vault/connect/start", "POST", { owner, webauthn: a.value });
}

export const completeConnect = (session: string, payload: string) => req<{ connection_id: string; institution: string; accounts: number }>("/app/vault/connect/complete", "POST", { session, payload });

export async function storeSecret(id: string, value: string): Promise<Result<{ ok: true }>> {
  const a = await assertion("secret", id);
  if (!a.ok) return a;
  return req(`/app/vault/accounts/${encodeURIComponent(id)}/secret`, "POST", { value, webauthn: a.value });
}

export async function revealSecret(id: string): Promise<Result<{ value: string }>> {
  const a = await assertion("reveal", id);
  if (!a.ok) return a;
  return req(`/app/vault/accounts/${encodeURIComponent(id)}/reveal`, "POST", { webauthn: a.value });
}

/** Plaid Link, loaded on demand from Plaid's CDN only when a connect starts. */
declare global {
  interface Window {
    Plaid?: { create(cfg: { token: string; onSuccess(public_token: string): void; onExit(err: unknown): void }): { open(): void } };
  }
}

export function openPlaidLink(linkToken: string): Promise<string | null> {
  return new Promise((resolve) => {
    const run = () => {
      if (!window.Plaid) return resolve(null);
      window.Plaid.create({ token: linkToken, onSuccess: (t) => resolve(t), onExit: () => resolve(null) }).open();
    };
    if (window.Plaid) return run();
    const s = document.createElement("script");
    s.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    s.onload = run;
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
}

export function money(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits }).format(n);
  } catch {
    return `$${n.toFixed(digits)}`;
  }
}
