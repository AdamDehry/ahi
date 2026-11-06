/**
 * The Vault's one list ("Everything, in its place."): accounts and items shown as one set of
 * records with a FINAL category tab, a plain kind label, a signed figure (assets +, owed −) and
 * where the figure came from. Pure view logic over the gateway's picture — nothing nets here.
 */
import { OWNER_LABELS, type Owner, type VaultAccount, type VaultFlag, type VaultItem, type VaultPicture } from "../lib/vault";

export type Category = "cash" | "credit" | "loans" | "investments" | "property";
export const CATEGORY_TABS: Array<[Category | "all", string]> = [
  ["all", "See all"],
  ["cash", "Cash"],
  ["credit", "Credit"],
  ["loans", "Loans"],
  ["investments", "Investments"],
  ["property", "Property & assets"],
];

const CASH = new Set(["cash", "checking", "savings", "money_market", "cd", "prepaid", "cash_management", "hsa"]);
const INVEST = new Set(["brokerage", "investment", "retirement", "401k", "403b", "ira", "roth", "crypto", "crypto_exchange", "pension", "529", "stock_plan", "mutual_fund"]);
const CREDIT = new Set(["credit_card", "credit", "card", "credit_report", "collection", "charge_card", "paypal"]);
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "_");

export function accountCategory(a: Pick<VaultAccount, "kind" | "subtype">): Category {
  const st = norm(a.subtype || "");
  if (a.kind === "contingent" || a.kind === "tax_attribute") return "property";
  if (a.kind === "liability") return CREDIT.has(st) || st.includes("card") ? "credit" : "loans";
  if (CASH.has(st) || st.includes("checking") || st.includes("saving")) return "cash";
  if (INVEST.has(st) || /crypto|invest|retire|brokerage/.test(st)) return "investments";
  return st === "receivable" || st === "real_estate" || st === "vehicle" ? "property" : "investments";
}

const KIND_LABELS: Record<string, string> = {
  cash: "Cash", checking: "Checking", savings: "Savings", money_market: "Money market", cd: "Certificate of deposit",
  credit_card: "Credit card", credit_report: "Credit report", collection: "Collection", mortgage: "Mortgage",
  auto_loan: "Auto loan", student_loan: "Student loan", personal_loan: "Personal loan", home_equity_loan: "Home equity loan",
  vehicle_lease: "Vehicle lease", crypto_loan: "Crypto loan", premium_finance: "Premium finance", intercompany: "Intercompany",
  tax: "Tax owed", loan: "Loan", brokerage: "Investment", investment: "Investment", retirement: "Retirement", crypto: "Crypto",
  unknown: "Not reported",
};
export function accountKindLabel(a: Pick<VaultAccount, "kind" | "subtype" | "source">): string {
  if (a.kind === "contingent") return "Guarantee";
  if (a.kind === "tax_attribute") return "Tax attribute";
  const st = norm(a.subtype || "");
  if (a.source === "bureau" && accountCategory(a) === "credit" && st !== "collection") return "Credit report";
  return KIND_LABELS[st] ?? (st ? st.charAt(0).toUpperCase() + st.slice(1).replace(/_/g, " ") : "Account");
}
const ITEM_LABELS: Record<string, string> = {
  real_estate: "Real estate", vehicle: "Vehicle", entity_share: "Entity share", crypto_holding: "Crypto",
  contingent: "Guarantee", receivable: "Receivable", other: "Other asset or debt",
};

export interface VRecord {
  id: string;
  ref: "account" | "item";
  name: string;
  owner: Owner;
  category: Category;
  kind: string;
  last4: string | null;
  value: number | null; // signed
  apr: number | null;
  asOf: string | null;
  ageDays: number | null;
  stale: boolean;
  source: string; // "Linked" | "Manual" | "Statement" | "Credit report" | "Snapshot"
  archived: boolean;
  account?: VaultAccount;
  item?: VaultItem;
}

const SOURCE: Record<string, string> = { feed: "Linked", manual: "Manual", statement: "Statement", bureau: "Credit report", seed: "Snapshot" };
const STALE_DAYS = 45;

export function recordsOf(pic: VaultPicture): VRecord[] {
  const out: VRecord[] = [];
  for (const g of pic.owners) {
    for (const a of g.accounts)
      out.push({
        id: a.id, ref: "account", account: a, owner: a.owner,
        name: a.institution, category: accountCategory(a), kind: accountKindLabel(a), last4: a.last4,
        value: a.amount === null ? null : a.kind === "asset" ? a.amount : -Math.abs(a.amount),
        apr: a.apr_pct, asOf: a.as_of, ageDays: a.age_days, stale: a.stale,
        source: a.connected ? "Linked" : (SOURCE[a.source] ?? "Manual"), archived: !a.active,
      });
    for (const i of g.items)
      out.push({
        id: i.id, ref: "item", item: i, owner: i.owner,
        name: i.name, category: i.kind === "crypto_holding" ? "investments" : "property", kind: ITEM_LABELS[i.kind] ?? "Other asset or debt", last4: null,
        value: i.amount === null ? null : i.side === "asset" ? i.amount : -Math.abs(i.amount),
        apr: null, asOf: i.as_of, ageDays: i.age_days, stale: (i.age_days ?? 0) > STALE_DAYS,
        source: SOURCE[i.source] ?? "Manual", archived: false,
      });
  }
  return out;
}

export type Tone = "urgent" | "watch" | "quiet";
export interface Attention { key: string; tone: Tone; score: number; recordId: string | null; label: string; title: string; body: string; flag?: VaultFlag }

/** The gateway's own flags first (they are the real "needs you" rows), then what the figures show. */
export function attentionOf(pic: VaultPicture, records: VRecord[]): Attention[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  const out: Attention[] = [];
  const flagged = new Set<string>();
  for (const f of pic.flags) {
    const r = f.account_id ? byId.get(f.account_id) : undefined;
    if (f.account_id) flagged.add(f.account_id);
    const tone: Tone = f.kind === "moved" ? "urgent" : f.kind === "stopped_reporting" ? "watch" : "quiet";
    out.push({ key: `f:${f.id}`, tone, score: tone === "urgent" ? 1000 : tone === "watch" ? 800 : 400, recordId: r?.id ?? null, label: `${r?.name ?? "Vault"} · ${OWNER_LABELS[f.owner]}`, title: f.title, body: f.detail, flag: f });
  }
  for (const r of records) {
    if (r.archived || flagged.has(r.id)) continue;
    if (r.owner === "unknown") out.push({ key: `o:${r.id}`, tone: "watch", score: 500, recordId: r.id, label: `${r.name} · ${OWNER_LABELS[r.owner]}`, title: "Assign an owner", body: "This record is left out of your net worth until it has an owner." });
    else if (r.stale && r.ageDays !== null) out.push({ key: `s:${r.id}`, tone: "quiet", score: 300 + r.ageDays, recordId: r.id, label: `${r.name} · ${OWNER_LABELS[r.owner]}`, title: `Figure is ${r.ageDays} days old`, body: "Review a statement or enter a current value." });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function shortDate(iso: string | null): string {
  if (!iso) return "No date";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
