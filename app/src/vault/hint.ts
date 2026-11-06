/**
 * What Michael is told each turn about the vault (claude-invoke.ts adds it
 * beside the bills hint). The hint carries HOW to read, never the picture
 * itself: every turn's system prompt lands in a session transcript, and the
 * transcript corpus is a retrieval surface (G2/F-32). Balances enter a
 * transcript only when the owner asks and Michael runs the tool.
 */
import { ownerUserId } from "../users.js";
import { resolve } from "node:path";

export function vaultAgents(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.VAULT_AGENTS ?? "michael").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function vaultOwners(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.VAULT_OWNERS ?? ownerUserId()).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function vaultScriptPath(): string {
  return resolve(import.meta.dirname, "../../scripts/vault.mjs");
}

export function vaultAgentHint(bot: string, userId: string | null | undefined, userName: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!userId || userId === "unknown") return "";
  if (!vaultAgents(env).includes(bot.toLowerCase()) || !vaultOwners(env).includes(userId)) return "";
  const tool = vaultScriptPath();
  return [
    `[VAULT — ${userName}'s financial picture, read-only, in the AHI app's Vault tab]`,
    `When ${userName} asks about balances, debts, rates, minimums, what moved, or anything the payoff plan needs, answer from the vault — run the tool, do not guess and do not ask him to open the tab:`,
    `  node ${tool} summary        plain lines per owner: assets, liabilities, net, the most expensive debts, cash-flow pressure, staleness`,
    `  node ${tool} picture        the full masked picture as JSON (accounts grouped by owner with as-of, source, confidence)`,
    `  node ${tool} plan           every liability with balance, rate, minimum and owner — the payoff plan's input, one call`,
    `  node ${tool} flags          what needs him (a balance that moved, a feed that stopped, a new tradeline)`,
    `  node ${tool} refresh        pull every connected feed now (otherwise weekly)`,
    `Owners never net together: you, your business, shared, unknown. Say which owner a number belongs to. "look-through" is the only line that adds a documented entity share, and it is always labelled.`,
    `The only write from chat is a figure ${userName} dictates (a property value, a vehicle, a balance read off a statement):`,
    `  node ${tool} say --owner owner --name "Home value" --amount 450000 --as-of 2026-10-15 [--kind real_estate|vehicle|entity_share|crypto_holding|contingent|other] [--side asset|liability] [--note "…"]`,
    `  node ${tool} say --account <id> --amount 11397 --as-of 2026-10-15      (an existing account's balance)`,
    `It is recorded as "the owner said, via Michael, <date>". Nothing else is writable from here; connecting an account and revealing a full number need his fingerprint in the app.`,
    `Never ask for, repeat or write down a full account number, SSN, date of birth or routing number. Last four digits only, and only when he needs them to tell accounts apart.`,
  ].join("\n");
}
