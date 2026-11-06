/**
 * The picture: what the Vault tab shows and what Michael reads. Derived from
 * the ledger on every call, never stored. Everything in it is already masked
 * (the ledger holds last4 at most), and nothing here nets across owners.
 */
import { lookThrough, netPerOwner, round2, type LookThrough, type NettableLine, type Netted } from "./owners.js";
import { OWNERS, OWNER_LABELS, type Account, type Flag, type Item, type Ledger, type Owner, type SourceKind } from "./types.js";

export interface PictureAccount {
  id: string;
  owner: Owner;
  shared_with: Owner[];
  kind: Account["kind"];
  subtype: string;
  institution: string;
  last4: string | null;
  amount: number | null;
  as_of: string | null;
  source: SourceKind;
  confidence: Account["figure"]["confidence"];
  entered_by: string;
  apr_pct: number | null;
  apr_text: string | null;
  min_payment: number | null;
  secured_by: string | null;
  note: string | null;
  active: boolean;
  connected: boolean;
  has_secret_number: boolean;
  /** Days since as_of, or null. */
  age_days: number | null;
  stale: boolean;
}

export interface PictureItem {
  id: string;
  owner: Owner;
  shared_with: Owner[];
  split: Item["split"];
  kind: Item["kind"];
  side: Item["side"];
  name: string;
  amount: number | null;
  as_of: string | null;
  source: SourceKind;
  confidence: Item["figure"]["confidence"];
  entered_by: string;
  entered_at: string;
  note: string | null;
  age_days: number | null;
}

export interface OwnerGroup {
  owner: Owner;
  label: string;
  accounts: PictureAccount[];
  items: PictureItem[];
  totals: Netted;
}

export interface ExpensiveDebt {
  id: string;
  owner: Owner;
  institution: string;
  last4: string | null;
  amount: number | null;
  apr_pct: number;
  /** amount × apr, when both known. */
  interest_per_year: number | null;
}

export interface CashFlow {
  /** Sum of known minimum payments across liabilities (the next 30 days: every monthly minimum is due once). */
  minimums_30d: number;
  minimums_counted: number;
  minimums_unknown: number;
  /** Cash across every cash account, all owners, listed per owner — never summed across owners. */
  cash_by_owner: Partial<Record<Owner, number>>;
  /** Per owner: minimums due minus that owner's cash. Positive = pressure. */
  pressure_by_owner: Partial<Record<Owner, { minimums: number; cash: number; shortfall: number }>>;
}

export interface Picture {
  now: string;
  owners: OwnerGroup[];
  /** the owner's own pool only. */
  owner: Netted;
  /** The one labelled exception: the owner + his documented share of entities. */
  owner_look_through: LookThrough;
  expensive_debts: ExpensiveDebt[];
  cash_flow: CashFlow;
  flags: Flag[];
  connections: Array<{ id: string; provider: string; institution: string; owner: Owner; status: string; last_refresh_at: string | null; last_refresh_ok: boolean | null; accounts: number }>;
  staleness: { oldest_as_of: string | null; newest_as_of: string | null; stale_count: number; total_known: number };
  seed: Ledger["seed"];
  locked: false;
}

const DAY = 86_400_000;

export function ageDays(asOf: string | null, now: Date): number | null {
  if (!asOf) return null;
  const t = Date.parse(`${asOf}T12:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY));
}

export function isStale(source: SourceKind, age: number | null, staleDays: Ledger["settings"]["stale_days"]): boolean {
  if (age === null) return true;
  const limit = staleDays[source] || 0;
  return limit > 0 ? age > limit : age > 45;
}

function toLine(a: { owner: Owner; split: Account["split"] }, side: NettableLine["side"], amount: number | null): NettableLine {
  return { owner: a.owner, side, amount, split: a.split };
}

export function derivePicture(ledger: Ledger, now: Date): Picture {
  const staleDays = ledger.settings.stale_days;
  // "Connected" means a live connection still feeds it; after Disconnect the figure is a saved snapshot.
  const liveConnections = new Set(ledger.connections.filter((c) => c.status !== "disconnected").map((c) => c.id));
  const accounts: PictureAccount[] = ledger.accounts.map((a) => {
    const age = ageDays(a.figure.as_of, now);
    return {
      id: a.id,
      owner: a.owner,
      shared_with: a.shared_with,
      kind: a.kind,
      subtype: a.subtype,
      institution: a.institution,
      last4: a.last4,
      amount: a.figure.amount,
      as_of: a.figure.as_of,
      source: a.figure.source,
      confidence: a.figure.confidence,
      entered_by: a.figure.entered_by,
      apr_pct: a.apr_pct,
      apr_text: a.apr_text,
      min_payment: a.min_payment,
      secured_by: a.secured_by,
      note: a.note,
      active: a.active,
      connected: !!a.connection_id && liveConnections.has(a.connection_id),
      has_secret_number: a.has_secret_number,
      age_days: age,
      stale: isStale(a.figure.source, age, staleDays),
    };
  });
  const items: PictureItem[] = ledger.items.map((i) => ({
    id: i.id,
    owner: i.owner,
    shared_with: i.shared_with,
    split: i.split,
    kind: i.kind,
    side: i.side,
    name: i.name,
    amount: i.figure.amount,
    as_of: i.figure.as_of,
    source: i.figure.source,
    confidence: i.figure.confidence,
    entered_by: i.figure.entered_by,
    entered_at: i.figure.entered_at,
    note: i.note,
    age_days: ageDays(i.figure.as_of, now),
  }));

  const lines: NettableLine[] = [
    ...ledger.accounts.map((a) => toLine(a, a.kind === "asset" ? "asset" : a.kind === "liability" ? "liability" : "contingent", a.figure.amount)),
    ...ledger.items.map((i) => toLine(i, i.side, i.figure.amount)),
  ];
  const per = netPerOwner(lines);

  const owners: OwnerGroup[] = OWNERS.map((o) => ({
    owner: o,
    label: OWNER_LABELS[o],
    accounts: accounts.filter((a) => a.owner === o).sort(sortAccounts),
    items: items.filter((i) => i.owner === o),
    totals: per[o],
  })).filter((g) => g.accounts.length || g.items.length);

  const expensive_debts: ExpensiveDebt[] = ledger.accounts
    .filter((a) => a.kind === "liability" && a.apr_pct !== null && a.active && (a.figure.amount ?? 0) > 0)
    .map((a) => ({
      id: a.id,
      owner: a.owner,
      institution: a.institution,
      last4: a.last4,
      amount: a.figure.amount,
      apr_pct: a.apr_pct!,
      interest_per_year: a.figure.amount === null ? null : round2((a.figure.amount * a.apr_pct!) / 100),
    }))
    .sort((x, y) => y.apr_pct - x.apr_pct || (y.amount ?? 0) - (x.amount ?? 0))
    .slice(0, 5);

  const cash_by_owner: CashFlow["cash_by_owner"] = {};
  for (const a of ledger.accounts) {
    if (a.kind !== "asset" || a.subtype !== "cash" || a.figure.amount === null) continue;
    cash_by_owner[a.owner] = round2((cash_by_owner[a.owner] ?? 0) + a.figure.amount);
  }
  let minimums_30d = 0;
  let minimums_counted = 0;
  let minimums_unknown = 0;
  const minsByOwner: Partial<Record<Owner, number>> = {};
  for (const a of ledger.accounts) {
    if (a.kind !== "liability" || !a.active) continue;
    if (a.min_payment === null) {
      if ((a.figure.amount ?? 0) > 0) minimums_unknown++;
      continue;
    }
    minimums_30d += a.min_payment;
    minimums_counted++;
    minsByOwner[a.owner] = round2((minsByOwner[a.owner] ?? 0) + a.min_payment);
  }
  const pressure_by_owner: CashFlow["pressure_by_owner"] = {};
  for (const o of OWNERS) {
    const m = minsByOwner[o] ?? 0;
    const c = cash_by_owner[o] ?? 0;
    if (m === 0 && !(o in cash_by_owner)) continue;
    pressure_by_owner[o] = { minimums: round2(m), cash: round2(c), shortfall: round2(m - c) };
  }

  const known = [...ledger.accounts.map((a) => a.figure), ...ledger.items.map((i) => i.figure)].filter((f) => f.amount !== null && f.as_of);
  const asOfs = known.map((f) => f.as_of!).sort();
  const stale_count = accounts.filter((a) => a.amount !== null && a.stale).length;

  return {
    now: now.toISOString(),
    owners,
    owner: per.owner,
    owner_look_through: lookThrough(lines, "owner"),
    expensive_debts,
    cash_flow: { minimums_30d: round2(minimums_30d), minimums_counted, minimums_unknown, cash_by_owner, pressure_by_owner },
    flags: ledger.flags.filter((f) => !f.acked_at),
    connections: ledger.connections
      .filter((c) => c.status !== "disconnected")
      .map((c) => ({
        id: c.id,
        provider: c.provider,
        institution: c.institution,
        owner: c.owner,
        status: c.status,
        last_refresh_at: c.last_refresh_at,
        last_refresh_ok: c.last_refresh_ok,
        accounts: ledger.accounts.filter((a) => a.connection_id === c.id).length,
      })),
    staleness: { oldest_as_of: asOfs[0] ?? null, newest_as_of: asOfs[asOfs.length - 1] ?? null, stale_count, total_known: known.length },
    seed: ledger.seed,
    locked: false,
  };
}

function sortAccounts(a: PictureAccount, b: PictureAccount): number {
  if (a.kind !== b.kind) return a.kind === "asset" ? -1 : a.kind === "liability" ? (b.kind === "asset" ? 1 : -1) : 1;
  return (b.amount ?? -1) - (a.amount ?? -1);
}

/**
 * What the payoff plan needs, in one call: every liability with balance,
 * rate, minimum and owner — nothing more, nothing netted.
 */
export interface PlanInput {
  now: string;
  liabilities: Array<{
    id: string;
    owner: Owner;
    shared_with: Owner[];
    institution: string;
    last4: string | null;
    subtype: string;
    balance: number | null;
    as_of: string | null;
    apr_pct: number | null;
    min_payment: number | null;
    secured_by: string | null;
    source: SourceKind;
    confidence: Account["figure"]["confidence"];
    active: boolean;
  }>;
  cash_by_owner: CashFlow["cash_by_owner"];
}

export function derivePlanInput(ledger: Ledger, now: Date): PlanInput {
  const pic = derivePicture(ledger, now);
  return {
    now: pic.now,
    liabilities: ledger.accounts
      .filter((a) => a.kind === "liability")
      .map((a) => ({
        id: a.id,
        owner: a.owner,
        shared_with: a.shared_with,
        institution: a.institution,
        last4: a.last4,
        subtype: a.subtype,
        balance: a.figure.amount,
        as_of: a.figure.as_of,
        apr_pct: a.apr_pct,
        min_payment: a.min_payment,
        secured_by: a.secured_by,
        source: a.figure.source,
        confidence: a.figure.confidence,
        active: a.active,
      }))
      .sort((x, y) => (y.apr_pct ?? -1) - (x.apr_pct ?? -1)),
    cash_by_owner: pic.cash_flow.cash_by_owner,
  };
}

/** Plain lines for Michael's chat (no markup, no number shapes beyond money). */
export function pictureSummaryLines(p: Picture): string[] {
  const money = (n: number | null) => (n === null ? "unknown" : `$${Math.round(n).toLocaleString("en-US")}`);
  const out: string[] = [];
  for (const g of p.owners) {
    const t = g.totals;
    out.push(`${g.label}: assets ${money(t.assets)}, liabilities ${money(t.liabilities)}, net ${money(t.net)}${t.unknown_figures ? ` (${t.unknown_figures} figure${t.unknown_figures > 1 ? "s" : ""} unknown)` : ""}`);
  }
  const lt = p.owner_look_through;
  if (lt.shares.length) out.push(`the owner look-through (his documented share of entities added, labelled as such): net ${money(lt.net)}`);
  if (p.expensive_debts.length) {
    out.push("Most expensive debts by rate:");
    for (const d of p.expensive_debts) out.push(`  ${d.institution}${d.last4 ? ` (${d.last4})` : ""} — ${d.apr_pct}% on ${money(d.amount)} [${d.owner}]`);
  }
  out.push(`Minimum payments due in the next 30 days (known): ${money(p.cash_flow.minimums_30d)} across ${p.cash_flow.minimums_counted} accounts; ${p.cash_flow.minimums_unknown} liabilities have no known minimum.`);
  for (const [o, pr] of Object.entries(p.cash_flow.pressure_by_owner)) out.push(`  ${o}: minimums ${money(pr!.minimums)} vs cash ${money(pr!.cash)} → ${pr!.shortfall > 0 ? `short ${money(pr!.shortfall)}` : "covered"}`);
  out.push(`Staleness: ${p.staleness.stale_count} of ${p.staleness.total_known} known figures are past their freshness window; oldest as-of ${p.staleness.oldest_as_of ?? "none"}, newest ${p.staleness.newest_as_of ?? "none"}.`);
  if (p.flags.length) out.push(`${p.flags.length} open flag${p.flags.length > 1 ? "s" : ""} need the owner.`);
  return out;
}
