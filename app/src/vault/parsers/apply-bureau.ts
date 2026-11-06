/**
 * A parsed credit report meets the ledger. Every open tradeline with a
 * balance either updates the account it matches (figure, as-of, minimum,
 * status note; source "bureau", confidence high) or becomes a new account
 * under the owner personally — a consumer report is personal by definition — with
 * a "new_tradeline" flag so the owner can re-tag or merge it. Closed, zero-balance
 * tradelines that match an account mark it inactive; unmatched closed ones
 * are ignored (history, not a debt).
 *
 * Matching is by creditor alias against the ledger's institution text, never
 * by account number (the parser does not read one). When several open
 * tradelines share a creditor (JPMCB CARD ×2), the one with the larger
 * balance takes the larger seeded balance; the rest become new rows.
 */
import { raiseFlag } from "../drift.js";
import { redact } from "../mask.js";
import type { Account, Ledger } from "../types.js";
import type { CreditReport, Tradeline } from "./credit-report.js";

/** creditor substring (upper) → institution substrings (lower) in the ledger. */
export const ALIASES: Array<{ creditor: RegExp; institution: RegExp; subtype?: string }> = [
  { creditor: /DEPT OF ED|GLELSI|USDOE|NELNET/, institution: /dept\. of education|department of education|glelsi|student/, subtype: "student_loan" },
  { creditor: /LIGHTSTREAM/, institution: /lightstream/, subtype: "personal_loan" },
  { creditor: /DISCOVER/, institution: /discover/, subtype: "credit_card" },
  { creditor: /JPMCB CARD|CHASE CARD|JPMCB/, institution: /sapphire|chase card|chase sapphire/, subtype: "credit_card" },
  { creditor: /SERVICEMAC|ROSEGATE|RGT\//, institution: /amerihome|servicemac|rosegate/, subtype: "mortgage" },
  { creditor: /GENESIS|^GF$|HYUNDAI (MOTOR|CAPITAL|FINC)/, institution: /genesis/, subtype: "vehicle_lease" },
  { creditor: /SUMMIT A\*?R|SUMMIT A R/, institution: /summit|sixt/, subtype: "collection" },
  { creditor: /CHRYSLER/, institution: /chrysler/, subtype: "auto_loan" },
  { creditor: /TRUIST/, institution: /truist/, subtype: "mortgage" },
  { creditor: /TD BANK|TD BK/, institution: /td bank/, subtype: "home_equity_loan" },
];

export function subtypeFor(t: Tradeline): string {
  const a = (t.account_type ?? "").toLowerCase();
  const alias = ALIASES.find((x) => x.creditor.test(t.creditor));
  if (alias?.subtype) return alias.subtype;
  if (a.includes("collection")) return "collection";
  if (a.includes("revolving")) return "credit_card";
  if (a.includes("lease")) return "vehicle_lease";
  if (a.includes("mortgage")) return "mortgage";
  if (a.includes("installment")) return "loan";
  return a.replace(/\s+/g, "_") || "unknown";
}

export interface ApplyResult {
  updated: string[];
  created: string[];
  closed: string[];
  ignored: string[];
}

let seq = 0;
function newId(now: Date): string {
  seq = (seq + 1) % 100000;
  return `acc-${now.getTime().toString(36)}b${seq.toString(36)}`;
}

function statusNote(t: Tradeline, bureau: string): string {
  const bits = [`${bureau} ${t.balance_updated ?? ""}`.trim()];
  if (t.status) bits.push(t.status);
  if (t.credit_limit) bits.push(`limit $${t.credit_limit.toLocaleString("en-US")}`);
  if (t.terms) bits.push(t.terms);
  if (t.date_opened) bits.push(`opened ${t.date_opened}`);
  if (t.past_due) bits.push(`past due $${t.past_due.toLocaleString("en-US")}`);
  if (t.late.worst) bits.push(`worst late mark ${t.late.worst}${t.late.last_late ? ` in ${t.late.last_late}` : ""}`);
  return redact(bits.join("; "));
}

export function applyBureau(ledger: Ledger, report: CreditReport, now: Date, enteredBy = `bureau:${report.bureau.toLowerCase()}`): ApplyResult {
  const res: ApplyResult = { updated: [], created: [], closed: [], ignored: [] };
  const at = now.toISOString();
  const asOf = (t: Tradeline) => t.balance_updated ?? report.generated_on ?? at.slice(0, 10);
  const taken = new Set<string>();

  // Open tradelines, largest balance first so a shared creditor maps the big one to the big seed row.
  const open = report.tradelines.filter((t) => t.open_closed === "open" || (t.section === "open" && (t.balance ?? 0) > 0)).sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0));
  for (const t of open) {
    const alias = ALIASES.find((x) => x.creditor.test(t.creditor));
    const candidates = alias
      ? ledger.accounts.filter((a) => a.kind === "liability" && !taken.has(a.id) && alias.institution.test(a.institution.toLowerCase())).sort((x, y) => (y.figure.amount ?? 0) - (x.figure.amount ?? 0))
      : [];
    const target = candidates[0];
    if (target) {
      taken.add(target.id);
      const newer = !target.figure.as_of || asOf(t) >= target.figure.as_of;
      if (newer) {
        target.figure = { amount: t.balance, as_of: asOf(t), source: "bureau", confidence: "high", entered_by: enteredBy, entered_at: at };
        if (t.monthly_payment !== null) target.min_payment = t.monthly_payment;
        target.active = true;
        target.updated_at = at;
      }
      target.note = [target.note, statusNote(t, report.bureau)].filter(Boolean).join(" · ");
      res.updated.push(target.id);
      continue;
    }
    if ((t.balance ?? 0) <= 0) {
      res.ignored.push(t.creditor);
      continue;
    }
    const acc: Account = {
      id: newId(now),
      owner: "owner",
      owner_label: "the owner (personal) — from a consumer credit report",
      shared_with: [],
      split: null,
      kind: "liability",
      subtype: subtypeFor(t),
      institution: redact(t.original_creditor ? `${t.creditor} (for ${t.original_creditor})` : t.creditor),
      last4: null,
      figure: { amount: t.balance, as_of: asOf(t), source: "bureau", confidence: "high", entered_by: enteredBy, entered_at: at },
      apr_pct: null,
      apr_text: null,
      min_payment: t.monthly_payment,
      secured_by: null,
      source_path: null,
      note: statusNote(t, report.bureau),
      connection_id: null,
      provider_account_id: null,
      active: true,
      created_at: at,
      updated_at: at,
      has_secret_number: false,
    };
    ledger.accounts.push(acc);
    taken.add(acc.id);
    res.created.push(acc.id);
    raiseFlag(ledger, now, {
      kind: "new_tradeline",
      account_id: acc.id,
      owner: "owner",
      key: `new_tradeline:${t.fingerprint}`,
      title: `${t.creditor} is on your ${report.bureau} report and not in the vault`,
      detail: `Balance $${Math.round(t.balance ?? 0).toLocaleString("en-US")} as of ${asOf(t)}. Added under the owner; re-tag the owner or merge it into an existing account.`,
    });
  }

  // Closed tradelines: close the matching account; never create.
  // Charge-offs and collections (closed but owed) match before the zero-balance history rows.
  const closed = report.tradelines.filter((t) => t.open_closed === "closed" && !open.includes(t)).sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0));
  for (const t of closed) {
    const alias = ALIASES.find((x) => x.creditor.test(t.creditor));
    const target = alias ? ledger.accounts.find((a) => a.kind === "liability" && !taken.has(a.id) && alias.institution.test(a.institution.toLowerCase())) : null;
    if (!target) {
      res.ignored.push(t.creditor);
      continue;
    }
    taken.add(target.id);
    if ((t.balance ?? 0) === 0) {
      target.active = false;
      target.figure = { amount: 0, as_of: asOf(t), source: "bureau", confidence: "high", entered_by: enteredBy, entered_at: at };
    } else {
      // Closed but owed (a charge-off): the debt is real, the account is not usable.
      target.figure = { amount: t.balance, as_of: asOf(t), source: "bureau", confidence: "high", entered_by: enteredBy, entered_at: at };
      target.active = true;
    }
    target.note = [target.note, statusNote(t, report.bureau)].filter(Boolean).join(" · ");
    target.updated_at = at;
    res.closed.push(target.id);
  }
  return res;
}
