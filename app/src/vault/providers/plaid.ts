/**
 * Plaid adapter (the pick — see REPORT.md "Provider").
 *
 * Products requested: transactions (balances + the connection itself),
 * liabilities (APR, minimum payment, next due for cards, mortgages, student
 * loans), investments (Robinhood, M1, Coinbase holdings). NEVER auth
 * (account + routing numbers), transfer or payment_initiation. The scope
 * test pins this list.
 *
 * Keys: PLAID_CLIENT_ID + PLAID_SECRET from the gateway's env (the .env the
 * box already treats as secret), PLAID_ENV = sandbox | production (the Trial
 * plan runs on production keys). Nothing in this file is exercised by tests
 * — the mock stands in; without keys `configured()` is false and every call
 * refuses with not-configured.
 *
 * Link flow: /link/token/create → the web app opens Plaid Link with the
 * link_token (hosted, the owner signs in at his bank; we never see a password) →
 * Link returns a public_token → /item/public_token/exchange → access_token,
 * encrypted at rest. Refresh = /accounts/balance/get + /liabilities/get.
 * Disconnect = /item/remove (also tells Plaid to stop updating the Item).
 */
import { FORBIDDEN_SCOPES, ProviderError, type LinkResult, type LinkStart, type ProviderAccount, type VaultProvider } from "./types.js";

const HOSTS: Record<string, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

interface PlaidAccount {
  account_id: string;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  balances: { current?: number | null; available?: number | null; iso_currency_code?: string | null; last_updated_datetime?: string | null };
}

interface PlaidLiabilities {
  credit?: Array<{ account_id: string; aprs?: Array<{ apr_percentage: number; apr_type: string }>; minimum_payment_amount?: number | null; next_payment_due_date?: string | null }>;
  mortgage?: Array<{ account_id: string; interest_rate?: { percentage?: number | null } | null; next_monthly_payment?: number | null; next_payment_due_date?: string | null }>;
  student?: Array<{ account_id: string; interest_rate_percentage?: number | null; minimum_payment_amount?: number | null; next_payment_due_date?: string | null }>;
}

export class PlaidProvider implements VaultProvider {
  readonly id = "plaid";
  readonly name = "Plaid";

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  scopes(): string[] {
    const s = ["transactions", "liabilities", "investments"];
    for (const x of s) if (FORBIDDEN_SCOPES.has(x)) throw new Error(`plaid adapter asked for forbidden scope ${x}`);
    return s;
  }

  configured(): boolean {
    return !!(this.env.PLAID_CLIENT_ID && this.env.PLAID_SECRET);
  }

  private host(): string {
    const env = (this.env.PLAID_ENV || "production").toLowerCase();
    // Isolated previews/tests only: a Plaid stand-in on this machine. Never anything but loopback,
    // so a stray setting cannot send the keys elsewhere.
    if (env === "fixture") {
      const u = (this.env.PLAID_FIXTURE_URL ?? "").trim();
      if (/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(u)) return u;
      throw new ProviderError("not-configured", "PLAID_FIXTURE_URL must be a loopback http URL");
    }
    return HOSTS[env] ?? HOSTS.production;
  }

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    if (!this.configured()) throw new ProviderError("not-configured", "PLAID_CLIENT_ID / PLAID_SECRET not set");
    const res = await this.fetchImpl(`${this.host()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: this.env.PLAID_CLIENT_ID, secret: this.env.PLAID_SECRET, ...body }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = String(json.error_code ?? "");
      if (code === "ITEM_LOGIN_REQUIRED" || code === "PENDING_EXPIRATION") throw new ProviderError("needs-relink", code);
      throw new ProviderError("refresh-failed", `plaid ${path} ${res.status} ${code || ""}`.trim());
    }
    return json as T;
  }

  async beginLink(input: { user_id: string; owner: string; redirect_uri?: string }): Promise<LinkStart> {
    const r = await this.call<{ link_token: string }>("/link/token/create", {
      user: { client_user_id: `${input.user_id}:${input.owner}` },
      client_name: "AHI Vault",
      products: this.scopes(),
      // Liabilities and investments are "best effort": a bank without them still links.
      country_codes: ["US"],
      language: "en",
      ...(input.redirect_uri ? { redirect_uri: input.redirect_uri } : {}),
    });
    return { mode: "redirect", link_token: r.link_token, instructions: "Plaid opens your bank's own sign-in. Your password never reaches this app." };
  }

  async completeLink(input: { user_id: string; payload: string }): Promise<LinkResult> {
    const ex = await this.call<{ access_token: string; item_id: string }>("/item/public_token/exchange", { public_token: input.payload });
    const { accounts, institution } = await this.refresh(ex.access_token);
    return { access_token: ex.access_token, provider_item_id: ex.item_id, institution: institution ?? "Unknown institution", accounts };
  }

  async refresh(access_token: string): Promise<{ accounts: ProviderAccount[]; institution: string | null }> {
    const bal = await this.call<{ accounts: PlaidAccount[]; item: { institution_name?: string | null; institution_id?: string | null } }>("/accounts/balance/get", { access_token });
    let liab: PlaidLiabilities = {};
    try {
      liab = (await this.call<{ liabilities: PlaidLiabilities }>("/liabilities/get", { access_token })).liabilities ?? {};
    } catch (err) {
      if ((err as ProviderError).code === "needs-relink") throw err;
      // Not every institution supports Liabilities; balances alone are still worth having.
    }
    const institution = bal.item?.institution_name ?? null;
    const accounts = bal.accounts.map((a) => toAccount(a, liab, institution ?? "Unknown institution"));
    return { accounts, institution };
  }

  async revoke(access_token: string): Promise<void> {
    try {
      await this.call("/item/remove", { access_token });
    } catch (err) {
      throw new ProviderError("revoke-failed", (err as Error).message);
    }
  }
}

export function toAccount(a: PlaidAccount, liab: PlaidLiabilities, institution: string): ProviderAccount {
  const isLiability = a.type === "credit" || a.type === "loan";
  const subtype = (a.subtype ?? a.type).replace(/\s+/g, "_");
  let apr: number | null = null;
  let min: number | null = null;
  let due: string | null = null;
  const c = liab.credit?.find((x) => x.account_id === a.account_id);
  if (c) {
    const purchase = c.aprs?.find((x) => x.apr_type === "purchase_apr") ?? c.aprs?.[0];
    apr = purchase?.apr_percentage ?? null;
    min = c.minimum_payment_amount ?? null;
    due = c.next_payment_due_date ?? null;
  }
  const m = liab.mortgage?.find((x) => x.account_id === a.account_id);
  if (m) {
    apr = m.interest_rate?.percentage ?? apr;
    min = m.next_monthly_payment ?? min;
    due = m.next_payment_due_date ?? due;
  }
  const s = liab.student?.find((x) => x.account_id === a.account_id);
  if (s) {
    apr = s.interest_rate_percentage ?? apr;
    min = s.minimum_payment_amount ?? min;
    due = s.next_payment_due_date ?? due;
  }
  const current = a.balances.current ?? a.balances.available ?? null;
  return {
    provider_account_id: a.account_id,
    name: a.official_name || a.name,
    last4: a.mask ? a.mask.slice(-4) : null,
    institution,
    kind: isLiability ? "liability" : "asset",
    subtype: isLiability ? (a.type === "credit" ? "credit_card" : subtype) : subtype === "checking" || subtype === "savings" ? "cash" : subtype,
    balance: current === null ? null : Math.abs(Math.round(current * 100) / 100),
    as_of: (a.balances.last_updated_datetime ?? new Date().toISOString()).slice(0, 10),
    apr_pct: apr,
    min_payment: min,
    next_due: due,
    currency: a.balances.iso_currency_code ?? "USD",
  };
}
