/**
 * The Vault's one list ("Everything, in its place."): accounts and items shown as one set of
 * records with a FINAL category tab, a plain kind label, a signed figure (assets +, owed −) and
 * where the figure came from. Pure view logic over the gateway's picture — nothing nets here.
 */
import { locale, t, type Key } from "../i18n";
import { ownerLabel, type Owner, type VaultAccount, type VaultFlag, type VaultItem, type VaultPicture } from "../lib/vault";

export type Category = "cash" | "credit" | "loans" | "investments" | "property";
/** [tab, catalog key] — translated at render. */
export const CATEGORY_TABS: Array<[Category | "all", Key]> = [
  ["all", "vault.tab.all"],
  ["cash", "vault.tab.cash"],
  ["credit", "vault.tab.credit"],
  ["loans", "vault.tab.loans"],
  ["investments", "vault.tab.investments"],
  ["property", "vault.tab.property"],
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

const KIND_LABELS: Record<string, Key> = {
  cash: "vault.kind.cash", checking: "vault.kind.checking", savings: "vault.kind.savings", money_market: "vault.kind.moneyMarket", cd: "vault.kind.cd",
  credit_card: "vault.kind.creditCard", credit_report: "vault.kind.creditReport", collection: "vault.kind.collection", mortgage: "vault.kind.mortgage",
  auto_loan: "vault.kind.autoLoan", student_loan: "vault.kind.studentLoan", personal_loan: "vault.kind.personalLoan", home_equity_loan: "vault.kind.homeEquityLoan",
  vehicle_lease: "vault.kind.vehicleLease", crypto_loan: "vault.kind.cryptoLoan", premium_finance: "vault.kind.premiumFinance", intercompany: "vault.kind.intercompany",
  tax: "vault.kind.tax", loan: "vault.kind.loan", brokerage: "vault.kind.investment", investment: "vault.kind.investment", retirement: "vault.kind.retirement", crypto: "vault.kind.crypto",
  unknown: "vault.kind.unknown",
};
/** The kind label in the current language (call at render; recordsOf is memoized on the language). */
export function accountKindLabel(a: Pick<VaultAccount, "kind" | "subtype" | "source">): string {
  if (a.kind === "contingent") return t("vault.kind.guarantee");
  if (a.kind === "tax_attribute") return t("vault.kind.taxAttribute");
  const st = norm(a.subtype || "");
  if (a.source === "bureau" && accountCategory(a) === "credit" && st !== "collection") return t("vault.kind.creditReport");
  const key = KIND_LABELS[st];
  return key ? t(key) : st ? st.charAt(0).toUpperCase() + st.slice(1).replace(/_/g, " ") : t("vault.kind.account");
}
const ITEM_LABELS: Record<string, Key> = {
  real_estate: "vault.kind.realEstate", vehicle: "vault.kind.vehicle", entity_share: "vault.kind.entityShare", crypto_holding: "vault.kind.crypto",
  contingent: "vault.kind.guarantee", receivable: "vault.kind.receivable", other: "vault.kind.otherItem",
};

export interface VRecord {
  id: string;
  ref: "account" | "item";
  name: string;
  owner: Owner;
  category: Category;
  kind: string; // translated label
  last4: string | null;
  value: number | null; // signed
  apr: number | null;
  asOf: string | null;
  ageDays: number | null;
  stale: boolean;
  source: string; // translated: "Linked" | "Manual" | "Statement" | "Credit report" | "Snapshot"
  archived: boolean;
  account?: VaultAccount;
  item?: VaultItem;
}

const SOURCE: Record<string, Key> = { feed: "vault.source.linked", manual: "vault.source.manual", statement: "vault.source.statement", bureau: "vault.kind.creditReport", seed: "vault.source.snapshot" };
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
        source: t(a.connected ? "vault.source.linked" : (SOURCE[a.source] ?? "vault.source.manual")), archived: !a.active,
      });
    for (const i of g.items)
      out.push({
        id: i.id, ref: "item", item: i, owner: i.owner,
        name: i.name, category: i.kind === "crypto_holding" ? "investments" : "property", kind: t(ITEM_LABELS[i.kind] ?? "vault.kind.otherItem"), last4: null,
        value: i.amount === null ? null : i.side === "asset" ? i.amount : -Math.abs(i.amount),
        apr: null, asOf: i.as_of, ageDays: i.age_days, stale: (i.age_days ?? 0) > STALE_DAYS,
        source: t(SOURCE[i.source] ?? "vault.source.manual"), archived: false,
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
    out.push({ key: `f:${f.id}`, tone, score: tone === "urgent" ? 1000 : tone === "watch" ? 800 : 400, recordId: r?.id ?? null, label: `${r?.name ?? t("vault.vault")} · ${ownerLabel(f.owner)}`, title: f.title, body: f.detail, flag: f });
  }
  for (const r of records) {
    if (r.archived || flagged.has(r.id)) continue;
    if (r.owner === "unknown") out.push({ key: `o:${r.id}`, tone: "watch", score: 500, recordId: r.id, label: `${r.name} · ${ownerLabel(r.owner)}`, title: t("vault.assignOwner"), body: t("vault.assignOwnerBody") });
    else if (r.stale && r.ageDays !== null) out.push({ key: `s:${r.id}`, tone: "quiet", score: 300 + r.ageDays, recordId: r.id, label: `${r.name} · ${ownerLabel(r.owner)}`, title: t("vault.figureDaysOld", { n: String(r.ageDays) }), body: t("vault.staleBody") });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function shortDate(iso: string | null): string {
  if (!iso) return t("vault.noDate");
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(locale(), { month: "short", day: "numeric" });
}
