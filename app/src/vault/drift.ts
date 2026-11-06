/**
 * Drift: after every refresh, compare each account's new figure with its
 * last snapshot. A move bigger than BOTH the absolute and the percentage
 * threshold raises "moved"; a fed account that stopped coming back raises
 * "stopped_reporting"; a figure older than its source's freshness window
 * raises "stale". Flags are keyed so a repeat collapses onto the open row.
 *
 * Flags land on the Feed/Reviews path as "needs you" rows through the
 * `postNeedsYou` dep (index.ts wires it to the review desk); this module
 * only decides WHAT to raise.
 */
import { ageDays, isStale } from "./picture.js";
import type { Account, BalanceSnapshot, Flag, Ledger, Owner } from "./types.js";

export interface DriftInput {
  ledger: Ledger;
  now: Date;
  /** Accounts a refresh just touched (by id). Others are judged on staleness only. */
  refreshed: Set<string>;
  /** Fed accounts the provider did not return this time. */
  missing: Set<string>;
}

let seq = 0;
function flagId(now: Date): string {
  seq = (seq + 1) % 1_000_000;
  return `flg-${now.getTime().toString(36)}${seq.toString(36).padStart(3, "0")}`;
}

export function previousSnapshot(ledger: Ledger, accountId: string, before: string): BalanceSnapshot | null {
  let best: BalanceSnapshot | null = null;
  for (const s of ledger.snapshots) {
    if (s.account_id !== accountId || s.at >= before) continue;
    if (!best || s.at > best.at) best = s;
  }
  return best;
}

export function moved(prev: number | null, next: number | null, abs: number, pct: number): { yes: boolean; delta: number | null; delta_pct: number | null } {
  if (prev === null || next === null) return { yes: false, delta: null, delta_pct: null };
  const delta = Math.round((next - prev) * 100) / 100;
  const base = Math.abs(prev) < 1 ? 1 : Math.abs(prev);
  const delta_pct = Math.round((Math.abs(delta) / base) * 10000) / 100;
  return { yes: Math.abs(delta) > abs && delta_pct > pct, delta, delta_pct };
}

function money(n: number | null): string {
  return n === null ? "unknown" : `$${Math.round(n).toLocaleString("en-US")}`;
}

function label(a: Account): string {
  return `${a.institution}${a.last4 ? ` (${a.last4})` : ""}`;
}

/** Record the current figure of every account as a snapshot (called after a refresh or import). */
export function snapshotAll(ledger: Ledger, now: Date, only?: Set<string>): number {
  const at = now.toISOString();
  let n = 0;
  for (const a of ledger.accounts) {
    if (only && !only.has(a.id)) continue;
    ledger.snapshots.push({ at, account_id: a.id, amount: a.figure.amount, as_of: a.figure.as_of, source: a.figure.source });
    n++;
  }
  // Keep the file small: at most 60 snapshots per account (a year of weekly refreshes).
  const byAcc = new Map<string, BalanceSnapshot[]>();
  for (const s of ledger.snapshots) (byAcc.get(s.account_id) ?? byAcc.set(s.account_id, []).get(s.account_id)!).push(s);
  ledger.snapshots = [...byAcc.values()].flatMap((list) => list.sort((x, y) => x.at.localeCompare(y.at)).slice(-60));
  return n;
}

function raise(ledger: Ledger, now: Date, f: Omit<Flag, "id" | "raised_at" | "acked_at" | "posted_ref">): Flag | null {
  const open = ledger.flags.find((x) => x.key === f.key && !x.acked_at);
  if (open) {
    open.detail = f.detail;
    open.title = f.title;
    return null; // collapsed onto the open row
  }
  const flag: Flag = { ...f, id: flagId(now), raised_at: now.toISOString(), acked_at: null, posted_ref: null };
  ledger.flags.push(flag);
  return flag;
}

export function checkDrift(input: DriftInput): Flag[] {
  const { ledger, now, refreshed, missing } = input;
  const raised: Flag[] = [];
  const { drift_abs, drift_pct, stale_days } = ledger.settings;
  const nowIso = now.toISOString();
  for (const a of ledger.accounts) {
    if (refreshed.has(a.id)) {
      const prev = previousSnapshot(ledger, a.id, nowIso);
      if (prev) {
        const m = moved(prev.amount, a.figure.amount, drift_abs, drift_pct);
        if (m.yes) {
          const f = raise(ledger, now, {
            kind: "moved",
            account_id: a.id,
            owner: a.owner,
            key: `moved:${a.id}:${a.figure.as_of ?? "na"}`,
            title: `${label(a)} moved ${m.delta! > 0 ? "up" : "down"} ${money(Math.abs(m.delta!))}`,
            detail: `Was ${money(prev.amount)} as of ${prev.as_of ?? "unknown"}, now ${money(a.figure.amount)} as of ${a.figure.as_of ?? "unknown"} (${m.delta_pct}%). Owner: ${a.owner}.`,
          });
          if (f) raised.push(f);
        }
      }
    }
    if (missing.has(a.id) && a.connection_id) {
      const f = raise(ledger, now, {
        kind: "stopped_reporting",
        account_id: a.id,
        owner: a.owner,
        key: `stopped:${a.id}`,
        title: `${label(a)} stopped reporting`,
        detail: `The feed did not return this account on the last refresh. Last figure ${money(a.figure.amount)} as of ${a.figure.as_of ?? "unknown"}.`,
      });
      if (f) raised.push(f);
    }
    const conn = a.connection_id ? ledger.connections.find((c) => c.id === a.connection_id) : null;
    const connFailed = !!conn && (conn.status === "needs_relink" || conn.last_refresh_ok === false);
    if (!refreshed.has(a.id) && a.active && a.figure.amount !== null && !connFailed) {
      const age = ageDays(a.figure.as_of, now);
      if (isStale(a.figure.source, age, stale_days) && a.figure.source !== "seed") {
        // Stale is noise if everything is stale (day one). Only raise once the account has ever been refreshed.
        const everRefreshed = ledger.snapshots.some((s) => s.account_id === a.id && s.source === "feed");
        if (everRefreshed) {
          const f = raise(ledger, now, {
            kind: "stale",
            account_id: a.id,
            owner: a.owner,
            key: `stale:${a.id}`,
            title: `${label(a)} is ${age ?? "?"} days old`,
            detail: `Source ${a.figure.source}; freshness window ${stale_days[a.figure.source]} days.`,
          });
          if (f) raised.push(f);
        }
      }
    }
  }
  return raised;
}

export function raiseFlag(ledger: Ledger, now: Date, f: { kind: Flag["kind"]; account_id: string | null; owner: Owner; key: string; title: string; detail: string }): Flag | null {
  return raise(ledger, now, f);
}
