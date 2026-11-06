/**
 * Provider interface. The vault talks to ONE aggregator through this shape,
 * so the whole build is testable with the mock and no key, and so a second
 * provider (SimpleFIN for a cheap statement-grade feed, say) is an adapter,
 * not a rewrite.
 *
 * Read-only by construction: the interface has no method that could move
 * money, and an adapter's `scopes()` is the exact list it asks the provider
 * for — the test "no write scopes" pins each adapter's list against the
 * provider's own write/money-movement products.
 */
export interface ProviderAccount {
  /** Provider-side opaque id — stable across refreshes. */
  provider_account_id: string;
  name: string;
  /** Last four digits the PROVIDER gives (it never gives more); null when it gives none. */
  last4: string | null;
  institution: string;
  /** Our kind, from the provider's type/subtype. */
  kind: "asset" | "liability";
  subtype: string;
  /** Positive balance magnitude (owed for liabilities, held for assets); null if unknown. */
  balance: number | null;
  as_of: string | null;
  apr_pct: number | null;
  min_payment: number | null;
  next_due: string | null;
  currency: string;
}

export interface LinkStart {
  /** "redirect": open `url` (hosted consent flow, e.g. Plaid Link). "paste": the owner pastes a setup token the provider gave him. */
  mode: "redirect" | "paste";
  url?: string;
  /** Short-lived provider token the client needs to open the flow (Plaid link_token). */
  link_token?: string;
  /** Plain words for the screen: what the owner is about to do. */
  instructions: string;
}

export interface LinkResult {
  /** The long-lived read-only credential. Encrypted at rest the moment it is returned; never logged, never shown. */
  access_token: string;
  provider_item_id: string | null;
  institution: string;
  accounts: ProviderAccount[];
}

export interface VaultProvider {
  readonly id: string;
  readonly name: string;
  /** Exactly the scopes/products this adapter asks for. */
  scopes(): string[];
  /** True when the real key is present; false = the adapter will refuse everything but `scopes()`. */
  configured(): boolean;
  beginLink(input: { user_id: string; owner: string; redirect_uri?: string }): Promise<LinkStart>;
  /** `payload` is what the client hands back (Plaid public_token; a pasted setup token). */
  completeLink(input: { user_id: string; payload: string }): Promise<LinkResult>;
  refresh(access_token: string): Promise<{ accounts: ProviderAccount[]; institution: string | null }>;
  /** Revoke on the provider side (best effort); the local token is deleted regardless. */
  revoke(access_token: string): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    readonly code: "not-configured" | "link-failed" | "refresh-failed" | "needs-relink" | "revoke-failed",
    message: string,
  ) {
    super(message);
  }
}

/** Products that can move money or expose full account/routing numbers. No adapter may list these. */
export const FORBIDDEN_SCOPES = new Set([
  "transfer",
  "payment_initiation",
  "standing_orders",
  "auth", // Plaid Auth returns full account + routing numbers
  "investments_auth",
  "identity",
  "identity_verification",
  "write",
  "payments",
  "move_money",
]);
