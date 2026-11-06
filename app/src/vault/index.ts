/**
 * Vault — production wiring. installVault() never throws: a bad env or a
 * missing key leaves the gateway booting without the vault (its routes
 * answer 503 "locked" or 404), never down.
 */
import type { Context, Hono } from "hono";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { ReviewDesk } from "../review/desk.js";
import { registerVaultRoutes, type VaultUser } from "./routes.js";
import { VaultStore, vaultRoot } from "./store.js";
import { VaultCipher, defaultKeyPath } from "./crypto.js";
import { providerFromEnv } from "./providers/index.js";
import type { Flag } from "./types.js";

export function defaultSeedPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.VAULT_SEED_PATH ? resolve(env.VAULT_SEED_PATH) : resolve(homedir(), "AHI/personal/finance/snapshot-2026-10/out/balance-sheet.csv");
}

export function installVault(app: Hono<any>, resolveUser: (c: Context) => VaultUser | null, reviewDesk: ReviewDesk | null): boolean {
  try {
    const cipher = new VaultCipher(defaultKeyPath());
    const stores = new Map<string, VaultStore>();
    const provider = providerFromEnv();
    registerVaultRoutes(app, {
      resolveUser,
      passkeys: reviewDesk?.passkeys ?? null,
      provider,
      stores: (userId) => stores.get(userId) ?? stores.set(userId, new VaultStore(userId, vaultRoot(userId), cipher)).get(userId)!,
      seedPath: () => defaultSeedPath(),
      postNeedsYou: reviewDesk
        ? async (userId: string, flag: Flag) => {
            const r = await reviewDesk.create(
              { lane: "YELLOW", desk: "Finance", title: flag.title, brief: `## What\n${flag.detail}\n\n## Why\nThe vault's weekly drift check raised it (${flag.kind}).\n\n## Risk\nNone from acknowledging; the figure stands until a feed or a statement replaces it.`, owner: userId, ref: `vault:${flag.id}` },
              "vault",
            );
            return r.ok ? r.item.id : null;
          }
        : undefined,
    });
    console.log(`[vault] installed: provider=${provider.id}${provider.configured() ? "" : " (not configured)"} key=${cipher.locked ? "MISSING (vault locked)" : "ok"} passkeys=${reviewDesk ? "review-desk" : "none (connect/reveal refuse)"}`);
    return true;
  } catch (err) {
    console.error(`[vault] NOT installed: ${(err as Error).message}`);
    return false;
  }
}
