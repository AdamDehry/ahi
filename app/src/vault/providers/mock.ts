/**
 * The mock provider: deterministic, in-memory, no network. It behaves like
 * Plaid in shape (redirect-style link with a public token exchange) and lets
 * a test drive every flow the real adapter has: link, refresh, drift,
 * stopped-reporting, needs-relink, revoke.
 */
import { createHash } from "node:crypto";
import { FORBIDDEN_SCOPES, ProviderError, type LinkResult, type LinkStart, type ProviderAccount, type VaultProvider } from "./types.js";

export interface MockInstitution {
  name: string;
  accounts: ProviderAccount[];
}

export class MockProvider implements VaultProvider {
  readonly id = "mock";
  readonly name = "Mock aggregator";
  /** Scripted institutions by public token. */
  readonly institutions = new Map<string, MockInstitution>();
  /** What `refresh` returns per access token; tests mutate it to simulate moves and dropped accounts. */
  readonly live = new Map<string, MockInstitution>();
  readonly revoked = new Set<string>();
  readonly calls: string[] = [];
  private broken = new Set<string>();

  constructor(private readonly opts: { configured?: boolean } = {}) {}

  scopes(): string[] {
    const s = ["transactions", "liabilities", "investments"];
    for (const x of s) if (FORBIDDEN_SCOPES.has(x)) throw new Error("mock asked for a forbidden scope");
    return s;
  }

  configured(): boolean {
    return this.opts.configured ?? true;
  }

  script(publicToken: string, inst: MockInstitution): void {
    this.institutions.set(publicToken, inst);
  }

  /** Make a token fail with needs-relink (expired login) on the next refresh. */
  breakToken(accessToken: string): void {
    this.broken.add(accessToken);
  }

  async beginLink(input: { user_id: string; owner: string }): Promise<LinkStart> {
    this.calls.push(`beginLink:${input.owner}`);
    if (!this.configured()) throw new ProviderError("not-configured", "mock not configured");
    return { mode: "redirect", link_token: `link-mock-${createHash("sha256").update(input.user_id + input.owner).digest("hex").slice(0, 8)}`, instructions: "Pick the institution and sign in on its own page." };
  }

  async completeLink(input: { user_id: string; payload: string }): Promise<LinkResult> {
    this.calls.push(`completeLink`);
    const inst = this.institutions.get(input.payload);
    if (!inst) throw new ProviderError("link-failed", "unknown public token");
    const access_token = `access-mock-${createHash("sha256").update(input.payload).digest("hex").slice(0, 16)}`;
    this.live.set(access_token, { name: inst.name, accounts: inst.accounts.map((a) => ({ ...a })) });
    return { access_token, provider_item_id: `item-${access_token.slice(-6)}`, institution: inst.name, accounts: inst.accounts.map((a) => ({ ...a })) };
  }

  async refresh(access_token: string): Promise<{ accounts: ProviderAccount[]; institution: string | null }> {
    this.calls.push(`refresh`);
    if (this.revoked.has(access_token)) throw new ProviderError("refresh-failed", "token revoked");
    if (this.broken.has(access_token)) throw new ProviderError("needs-relink", "login expired at the institution");
    const inst = this.live.get(access_token);
    if (!inst) throw new ProviderError("refresh-failed", "unknown access token");
    return { accounts: inst.accounts.map((a) => ({ ...a })), institution: inst.name };
  }

  async revoke(access_token: string): Promise<void> {
    this.calls.push(`revoke`);
    this.revoked.add(access_token);
    this.live.delete(access_token);
  }
}

export function mockAccount(over: Partial<ProviderAccount> & { provider_account_id: string; name: string }): ProviderAccount {
  return {
    last4: null,
    institution: "Mock Bank",
    kind: "asset",
    subtype: "cash",
    balance: 0,
    as_of: "2026-10-15",
    apr_pct: null,
    min_payment: null,
    next_due: null,
    currency: "USD",
    ...over,
  };
}
