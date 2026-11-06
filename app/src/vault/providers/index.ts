import { MockProvider } from "./mock.js";
import { PlaidProvider } from "./plaid.js";
import type { VaultProvider } from "./types.js";

/**
 * VAULT_PROVIDER picks the live adapter: "plaid" (default) or "mock" (an
 * isolated instance / a demo). The mock is never the default in production:
 * with no Plaid keys the vault reports "provider not configured" rather
 * than inventing accounts.
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): VaultProvider {
  const pick = (env.VAULT_PROVIDER || "plaid").toLowerCase();
  if (pick === "mock") return new MockProvider();
  return new PlaidProvider(env);
}
