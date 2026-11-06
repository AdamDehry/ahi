/**
 * Vault — the owner's whole financial picture, live, read-only, behind his
 * fingerprint (brief: foreman/briefs/finance-vault-20261015.md).
 *
 * The hard rule of this module is the OWNER TAG. Every account, holding and
 * manual figure carries exactly one owner, and nothing nets across owners
 * unless a caller asks for the labelled look-through explicitly. Four pools
 * of money sit in the owner's name or accounts and must never blur: the owner himself,
 * the business (the business), a second business (a documented split), and third
 * parties.
 *
 * Nothing here can move money. There is no write path to any provider.
 */

export const OWNERS = ["owner", "business", "shared", "unknown"] as const;
export type Owner = (typeof OWNERS)[number];

export const OWNER_LABELS: Record<Owner, string> = {
  owner: "You",
  business: "Your business",
  shared: "Shared",
  unknown: "Unknown owner",
};

/** Where a figure came from. The UI and Michael always say which. */
export type SourceKind = "feed" | "statement" | "manual" | "bureau" | "seed";
export type Confidence = "high" | "medium" | "low";

export type AccountKind = "asset" | "liability" | "contingent" | "tax_attribute";

/** The seed's `type` column, second half (asset/cash → "cash"). Free text, lower-case. */
export type Subtype = string;

export interface Money {
  /** Positive magnitude; the account kind says which side. null = unknown. */
  amount: number | null;
  /** YYYY-MM-DD the figure is true as of. null = never known. */
  as_of: string | null;
  source: SourceKind;
  confidence: Confidence;
  /** "owner (app)", "owner via michael", "seed", "feed:plaid", "bureau:experian" … */
  entered_by: string;
  entered_at: string;
}

export interface Account {
  id: string;
  owner: Owner;
  /** The owner text exactly as the seed or the owner wrote it ("Acme LLC (75/25 split)"). */
  owner_label: string;
  /** Other parties with a stake, for the honest note — never used for netting. */
  shared_with: Owner[];
  /** Entity split, when documented. Used ONLY by the explicit look-through. */
  split: Partial<Record<Owner, number>> | null;
  kind: AccountKind;
  subtype: Subtype;
  institution: string;
  /** Last four digits (or two last-fours joined by "/"), never more. */
  last4: string | null;
  figure: Money;
  /** Annual rate as a percentage (22.74), or null. */
  apr_pct: number | null;
  apr_text: string | null;
  min_payment: number | null;
  secured_by: string | null;
  source_path: string | null;
  note: string | null;
  /** A provider connection this account belongs to, if it is fed. */
  connection_id: string | null;
  /** Provider-side account id (opaque), for refresh matching. */
  provider_account_id: string | null;
  /** True while a feed still reports it; false once it stopped. */
  active: boolean;
  created_at: string;
  updated_at: string;
  /** Encrypted-only secret fields live beside the account, never in the picture. */
  has_secret_number: boolean;
}

/** Non-account items: real estate, vehicles, entity percentages, contingent exposures. */
export type ItemKind = "real_estate" | "vehicle" | "entity_share" | "crypto_holding" | "contingent" | "receivable" | "other";

export interface Item {
  id: string;
  owner: Owner;
  owner_label: string;
  shared_with: Owner[];
  split: Partial<Record<Owner, number>> | null;
  kind: ItemKind;
  /** Asset or liability side for netting; contingent never nets. */
  side: "asset" | "liability" | "contingent";
  name: string;
  figure: Money;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface Connection {
  id: string;
  provider: string;
  institution: string;
  owner: Owner;
  /** Products / scopes the integration asked for — read-only by construction. */
  scopes: string[];
  connected_at: string;
  connected_how: string;
  last_refresh_at: string | null;
  last_refresh_ok: boolean | null;
  last_error: string | null;
  /** Provider-side item/enrollment id (opaque, not a secret). */
  provider_item_id: string | null;
  status: "active" | "needs_relink" | "disconnected";
}

export interface BalanceSnapshot {
  at: string;
  account_id: string;
  amount: number | null;
  as_of: string | null;
  source: SourceKind;
}

export type FlagKind = "moved" | "stopped_reporting" | "stale" | "new_tradeline" | "refresh_failed" | "needs_relink";

export interface Flag {
  id: string;
  kind: FlagKind;
  account_id: string | null;
  owner: Owner;
  title: string;
  detail: string;
  raised_at: string;
  /** Stable key so a repeat of the same condition collapses onto one row. */
  key: string;
  acked_at: string | null;
  /** Review-desk item id once posted on the Feed/Reviews path. */
  posted_ref: string | null;
}

export interface StoredDocument {
  id: string;
  kind: "credit-report" | "statement" | "other";
  filename: string;
  mime: string;
  bytes: number;
  sha256: string;
  uploaded_at: string;
  uploaded_by: string;
  owner: Owner;
  /** Parser result summary, if a parser ran. */
  parsed: { parser: string; at: string; summary: string } | null;
  institution: string | null;
  as_of: string | null;
}

export interface Ledger {
  schema_version: number;
  user_id: string;
  accounts: Account[];
  items: Item[];
  connections: Connection[];
  snapshots: BalanceSnapshot[];
  flags: Flag[];
  documents: StoredDocument[];
  seed: { imported_at: string; source_path: string; rows: number; sha256: string } | null;
  settings: VaultSettings;
}

export interface VaultSettings {
  /** A move bigger than BOTH of these raises a flag. */
  drift_abs: number;
  drift_pct: number;
  /** Days of silence per source kind before "stopped reporting" / "stale". */
  stale_days: Record<SourceKind, number>;
}

export const DEFAULT_SETTINGS: VaultSettings = {
  drift_abs: 500,
  drift_pct: 10,
  stale_days: { feed: 10, statement: 45, bureau: 120, manual: 400, seed: 0 },
};

export const CURRENT_SCHEMA = 1;

export function emptyLedger(userId: string): Ledger {
  return {
    schema_version: CURRENT_SCHEMA,
    user_id: userId,
    accounts: [],
    items: [],
    connections: [],
    snapshots: [],
    flags: [],
    documents: [],
    seed: null,
    settings: { ...DEFAULT_SETTINGS, stale_days: { ...DEFAULT_SETTINGS.stale_days } },
  };
}

export function isOwner(x: unknown): x is Owner {
  return typeof x === "string" && (OWNERS as readonly string[]).includes(x);
}
