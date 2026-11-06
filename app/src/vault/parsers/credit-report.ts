/**
 * Credit-report text parser — the first "feed" (quarterly, manual upload).
 *
 * Input: the text of a consumer credit report as `pdftotext -layout` renders
 * it (the Phase-1 work/credit/*.txt shape: an "At a glance" page, a personal
 * information page, "Open accounts", "Closed accounts", "Public records",
 * "Inquiries", "Credit scores"). Each account is a block: a header line
 * (creditor and balance), a status line, an "Account info" table laid out in
 * two label/value columns, a payment-history grid, a contact block.
 *
 * What is NEVER read: the personal information section (name, addresses,
 * year of birth, employers) and the account-number line. The parser skips
 * them by construction, so no full or partial account number, DOB or address
 * can reach the ledger. Creditor contact addresses are skipped too.
 *
 * Covered by test/vault-credit-report.test.ts.
 */
import { safeDigest } from "../mask.js";

export interface LateMarks {
  m30: number;
  m60: number;
  m90: number;
  m120: number;
  co: number;
  /** Worst mark seen: "30" | "60" | "90" | "120" | "CO" | null. */
  worst: string | null;
  /** "YYYY-MM" of the most recent late mark. */
  last_late: string | null;
}

export interface Tradeline {
  creditor: string;
  section: "open" | "closed";
  negative: boolean;
  balance: number | null;
  balance_updated: string | null;
  original_balance: number | null;
  credit_limit: number | null;
  highest_balance: number | null;
  paid_off_pct: number | null;
  credit_usage_pct: number | null;
  account_type: string | null;
  monthly_payment: number | null;
  past_due: number | null;
  date_opened: string | null;
  open_closed: "open" | "closed" | null;
  status: string | null;
  status_updated: string | null;
  terms: string | null;
  responsibility: string | null;
  original_creditor: string | null;
  late: LateMarks;
  /** sha256 of creditor + date opened + original balance/limit — stable across bureaus, reveals nothing. */
  fingerprint: string;
}

export interface CreditReport {
  bureau: string;
  generated_on: string | null;
  score: number | null;
  score_source: string | null;
  summary: {
    open_accounts: number | null;
    accounts_ever_late: number | null;
    closed_accounts: number | null;
    collections: number | null;
    card_debt: number | null;
    loan_debt: number | null;
    collections_debt: number | null;
    total_debt: number | null;
    credit_used: number | null;
    credit_limit: number | null;
  };
  tradelines: Tradeline[];
  inquiries: Array<{ name: string; date: string | null }>;
  public_records: string;
}

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

export function parseDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})/.exec(s);
  if (m) {
    const mm = MONTHS[m[1].toLowerCase()];
    return mm ? `${m[3]}-${mm}-${m[2].padStart(2, "0")}` : null;
  }
  return null;
}

export function parseMonth(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = /([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(s);
  if (!m) return null;
  const mm = MONTHS[m[1].toLowerCase()];
  return mm ? `${m[2]}-${mm}` : null;
}

export function money(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /-?\$\s?([\d,]+(?:\.\d+)?)/.exec(s);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? (m[0].startsWith("-") ? -n : n) : null;
}

function pct(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(s);
  return m ? Number(m[1]) : null;
}

function dash(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return !t || t === "-" ? null : t;
}

const LEFT_LABELS = ["Account name", "Account number", "Original creditor", "Company sold", "Account type", "Date opened", "Open/closed", "Status", "Status updated"];
const RIGHT_LABELS = ["Balance", "Balance updated", "Original balance", "Credit limit", "Paid off", "Credit usage", "Monthly payment", "Past due amount", "Highest balance", "Terms", "Responsibility", "Your statement"];
const LABELS = new Set([...LEFT_LABELS, ...RIGHT_LABELS]);
const DROPPED = new Set(["Account number", "Your statement"]);

/** "  Account name     DEPT OF ED      Balance     $1,514" → [{col, text}] split on 3+ spaces, keeping column offsets. */
function tokens(line: string): Array<{ col: number; text: string }> {
  // A token is a run of words separated by at most two spaces; three or more spaces is a column gap.
  const out: Array<{ col: number; text: string }> = [];
  const re = /\S+(?:\s{1,2}\S+)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) out.push({ col: m.index, text: m[0] });
  return out;
}

const MARK = /^(30|60|90|120|150|180|CO|ND|KD|RF|FC|VS|-)$/;

function emptyLate(): LateMarks {
  return { m30: 0, m60: 0, m90: 0, m120: 0, co: 0, worst: null, last_late: null };
}

const RANK: Record<string, number> = { "30": 1, "60": 2, "90": 3, "120": 4, "150": 4, "180": 4, CO: 5 };

export function parseCreditReport(text: string, bureau: string): CreditReport {
  // pdftotext leaves page breaks and icon glyphs (private-use code points) in front of headings.
  const lines = text.split(/\r?\n/).map((l) => l.replace(/[\uE000-\uF8FF\f\u00a0]/g, " "));
  const report: CreditReport = {
    bureau,
    generated_on: null,
    score: null,
    score_source: null,
    summary: { open_accounts: null, accounts_ever_late: null, closed_accounts: null, collections: null, card_debt: null, loan_debt: null, collections_debt: null, total_debt: null, credit_used: null, credit_limit: null },
    tradelines: [],
    inquiries: [],
    public_records: "",
  };

  // ── pass 1: section boundaries ────────────────────────────────────
  type Section = "glance" | "personal" | "open" | "closed" | "public" | "inquiries" | "scores" | "other";
  let section: Section = "other";
  const sectionAt: Section[] = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (/^At a glance$/.test(t)) section = "glance";
    else if (/^Personal information$/.test(t)) section = "personal";
    else if (/^Open accounts$/.test(t)) section = "open";
    else if (/^Closed accounts$/.test(t)) section = "closed";
    else if (/^Public records$/.test(t)) section = "public";
    else if (/^Inquiries$/.test(t)) section = "inquiries";
    else if (/^Credit scores$/.test(t)) section = "scores";
    sectionAt.push(section);
  }

  // ── glance ────────────────────────────────────────────────────────
  for (let i = 0; i < lines.length; i++) {
    if (sectionAt[i] !== "glance") continue;
    const l = lines[i];
    const gen = /Date generated:\s*([A-Za-z]{3} \d{1,2}, \d{4})/.exec(l);
    if (gen && !report.generated_on) report.generated_on = parseDate(gen[1]);
    const sc = /^\s+(\d{3})\s{2,}([A-Za-z]+) data ([A-Za-z]{3} \d{1,2}, \d{4})/.exec(l);
    if (sc) {
      report.score = Number(sc[1]);
      report.score_source = sc[2];
    }
    const pick = (re: RegExp) => {
      const m = re.exec(l);
      return m ? m[1] : null;
    };
    const num = (s: string | null) => (s === null ? null : Number(s.replace(/,/g, "")));
    if (/^\s*Open accounts\s{2,}\d/.test(l)) report.summary.open_accounts = num(pick(/Open accounts\s{2,}(\d+)/));
    if (/Accounts ever late\s{2,}\d/.test(l)) report.summary.accounts_ever_late = num(pick(/Accounts ever late\s{2,}(\d+)/));
    if (/^\s*Closed accounts\s{2,}\d/.test(l)) report.summary.closed_accounts = num(pick(/Closed accounts\s{2,}(\d+)/));
    if (/^\s*Collections\s{2,}\d/.test(l)) report.summary.collections = num(pick(/^\s*Collections\s{2,}(\d+)/));
    if (/Credit card and credit line\s{2,}\$/.test(l)) report.summary.card_debt = money(pick(/Credit card and credit line\s{2,}(\$[\d,]+)/));
    if (/Loan debt\s{2,}\$/.test(l)) report.summary.loan_debt = money(pick(/Loan debt\s{2,}(\$[\d,]+)/));
    if (/Collections debt\s{2,}\$/.test(l)) report.summary.collections_debt = money(pick(/Collections debt\s{2,}(\$[\d,]+)/));
    if (/Total debt\s{2,}\$/.test(l)) report.summary.total_debt = money(pick(/Total debt\s{2,}(\$[\d,]+)/));
    if (/Credit used:\s*\$/.test(l)) report.summary.credit_used = money(pick(/Credit used:\s*(\$[\d,]+)/));
    if (/Credit limit:\s*\$/.test(l)) report.summary.credit_limit = money(pick(/Credit limit:\s*(\$[\d,]+)/));
  }

  // ── accounts ──────────────────────────────────────────────────────
  for (let i = 0; i < lines.length; i++) {
    const sec = sectionAt[i];
    if (sec !== "open" && sec !== "closed") continue;
    const l = lines[i];
    // Header: creditor on the left, a balance on the far right, next non-blank line is the status line.
    // Two header shapes: "CREDITOR        $1,514" and, for a closed zero-balance account, a bare "CREDITOR".
    let h = /^\s{0,3}([A-Z0-9][A-Z0-9 .,*'&\/()-]{1,60}?)\s{3,}(-?\$[\d,]+)\s*$/.exec(l);
    if (!h) {
      const bare = /^\s{0,3}([A-Z][A-Z0-9 .,*'&\/()-]{1,60}?)\s*$/.exec(l);
      if (!bare || LABELS.has(bare[1]) || /^(Open accounts|Closed accounts|Account info|Payment history|Contact info)$/.test(bare[1])) continue;
      h = [bare[0], bare[1], ""] as unknown as RegExpExecArray;
    }
    if (/^(Account name|Balance)/.test(h[1])) continue;
    const creditor = h[1].trim();
    const headerBalance = h[2] ? money(h[2]) : null;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    const statusLine = lines[j] ?? "";
    const negative = /potentially negative/i.test(statusLine);
    // Find "Account info"
    let k = j;
    while (k < lines.length && !/^\s*Account info\s*$/.test(lines[k]) && k - i < 12) k++;
    if (!/^\s*Account info\s*$/.test(lines[k] ?? "")) continue;
    const fields: Record<string, string> = {};
    // Two-column table: a label token is a label wherever it sits; the token
    // after it is its value. A line with no label is a wrapped value: it joins
    // the label from the previous line whose value sat nearest its column.
    let prevLine: Array<{ label: string; col: number }> = [];
    let m = k + 1;
    for (; m < lines.length; m++) {
      const row = lines[m];
      if (/^\s*(Payment history|Contact info)\s*$/.test(row)) break;
      if (sectionAt[m] !== sec) break;
      if (!row.trim()) continue;
      const toks = tokens(row);
      const thisLine: Array<{ label: string; col: number }> = [];
      let pending: string | null = null;
      let sawLabel = false;
      for (const t of toks) {
        if (LABELS.has(t.text)) {
          if (pending && !(pending in fields)) fields[pending] = "";
          pending = t.text;
          sawLabel = true;
          if (!(t.text in fields)) fields[t.text] = "";
          continue;
        }
        if (pending) {
          if (!DROPPED.has(pending)) fields[pending] = t.text; // the account-number value is never kept
          thisLine.push({ label: pending, col: t.col });
          pending = null;
          continue;
        }
        if (!sawLabel && prevLine.length) {
          let best = prevLine[0];
          for (const pl of prevLine) if (Math.abs(pl.col - t.col) < Math.abs(best.col - t.col)) best = pl;
          if (!DROPPED.has(best.label)) fields[best.label] = fields[best.label] ? `${fields[best.label]} ${t.text}` : t.text;
        }
      }
      if (sawLabel) prevLine = thisLine;
    }
    // Payment history grid
    const late = emptyLate();
    let p = m;
    for (; p < lines.length; p++) {
      const row = lines[p];
      if (/^\s*Contact info\s*$/.test(row)) break;
      if (sectionAt[p] !== sec) break;
      const yr = /^\s+(20\d\d)\s+(.*)$/.exec(row);
      if (!yr) continue;
      const marks = yr[2].trim().split(/\s+/).filter((x) => MARK.test(x));
      const year = yr[1];
      // Month index is lost in the layout; record the year only.
      for (const mk of marks) {
        if (mk === "30") late.m30++;
        else if (mk === "60") late.m60++;
        else if (mk === "90") late.m90++;
        else if (mk === "120" || mk === "150" || mk === "180") late.m120++;
        else if (mk === "CO") late.co++;
        else continue;
        if (!late.worst || RANK[mk] > RANK[late.worst]) late.worst = mk;
        if (!late.last_late || year > late.last_late) late.last_late = year;
      }
      // Stop at the legend.
      if (/On Time|Data Unavailable/.test(row)) break;
    }
    const openClosed = (fields["Open/closed"] ?? "").toLowerCase();
    const t: Tradeline = {
      creditor,
      section: sec,
      negative,
      balance: money(fields["Balance"]) ?? headerBalance,
      balance_updated: parseDate(fields["Balance updated"]),
      original_balance: money(fields["Original balance"]),
      credit_limit: money(fields["Credit limit"]),
      highest_balance: money(fields["Highest balance"]),
      paid_off_pct: pct(fields["Paid off"]),
      credit_usage_pct: pct(fields["Credit usage"]),
      account_type: dash(fields["Account type"]),
      monthly_payment: money(fields["Monthly payment"]),
      past_due: money(fields["Past due amount"]),
      date_opened: parseDate(fields["Date opened"]),
      open_closed: openClosed.startsWith("open") ? "open" : openClosed.startsWith("closed") ? "closed" : null,
      status: dash(fields["Status"]),
      status_updated: parseMonth(fields["Status updated"]),
      terms: dash(fields["Terms"]),
      responsibility: dash(fields["Responsibility"]),
      original_creditor: dash(fields["Original creditor"]),
      late,
      fingerprint: "",
    };
    if (t.open_closed === null) t.open_closed = sec;
    t.fingerprint = safeDigest([creditor.replace(/[^A-Z0-9]/g, "").slice(0, 6), t.date_opened ?? "", String(t.original_balance ?? t.credit_limit ?? "")].join("|")).slice(0, 16);
    report.tradelines.push(t);
    i = Math.max(i, m - 1);
  }

  // ── inquiries + public records ────────────────────────────────────
  for (let i = 0; i < lines.length; i++) {
    const sec = sectionAt[i];
    if (sec === "public") {
      const t = lines[i].trim();
      if (/^No public records/i.test(t)) report.public_records = "none";
      else if (/^(Bankruptcy|Judgment|Lien|Tax lien)/i.test(t)) report.public_records = report.public_records ? `${report.public_records}; ${t}` : t;
    }
    if (sec === "inquiries") {
      const l = lines[i];
      const next = lines[i + 1] ?? "";
      // Names sit on one line, "Inquired on <date>" directly below, in up to three columns.
      if (/Inquired on/.test(next) && !/Inquired on/.test(l)) {
        const names = tokens(l);
        const dates = tokens(next);
        for (const n of names) {
          if (!/^[A-Z0-9][A-Z0-9 .,*'&\/-]+$/.test(n.text) || /^Inquiries$/.test(n.text)) continue;
          const d = dates.find((x) => Math.abs(x.col - n.col) < 4);
          report.inquiries.push({ name: n.text, date: parseDate(d?.text ?? null) });
        }
      }
    }
  }
  return report;
}

/** Plain-words findings, in plain words. */
export function reportFindings(r: CreditReport): string[] {
  const out: string[] = [];
  const m = (n: number | null) => (n === null ? "unknown" : `$${Math.round(n).toLocaleString("en-US")}`);
  if (r.score !== null) out.push(`${r.bureau}: FICO 8 ${r.score}${r.score_source ? ` (${r.score_source} data)` : ""} on ${r.generated_on ?? "unknown date"}; total debt ${m(r.summary.total_debt)}, ${r.summary.open_accounts ?? "?"} open accounts, ${r.summary.collections ?? 0} collection(s).`);
  for (const t of r.tradelines) {
    if (t.section === "open" || (t.balance ?? 0) > 0 || t.negative) {
      const bits = [m(t.balance)];
      if (t.monthly_payment) bits.push(`${m(t.monthly_payment)}/mo`);
      if (t.credit_limit) bits.push(`limit ${m(t.credit_limit)}`);
      if (t.date_opened) bits.push(`opened ${t.date_opened}`);
      if (t.terms) bits.push(t.terms);
      if (t.status) bits.push(t.status);
      if (t.late.worst) bits.push(`worst late mark ${t.late.worst}${t.late.last_late ? ` (${t.late.last_late})` : ""}`);
      out.push(`${t.creditor} [${t.section}${t.negative ? ", negative" : ""}]: ${bits.join(", ")}`);
    }
  }
  return out;
}
