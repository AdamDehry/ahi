/**
 * Seed import: Phase 1's balance-sheet.csv becomes the vault's day-one
 * picture, as-of dates intact, so the first screen is honestly stale and
 * every refresh improves it.
 *
 * Rows become either an Account (anything with an institution: cash, cards,
 * loans, brokerage, exchange crypto, intercompany) or an Item (real estate,
 * self-custody crypto, receivables, contingent exposures, tax attributes).
 */
import { cleanLast4, redact, safeDigest } from "./mask.js";
import { tagOwner } from "./owners.js";
import type { Account, AccountKind, Confidence, Item, ItemKind, Ledger, Money, SourceKind } from "./types.js";

export interface SeedRow {
  type: string;
  owner: string;
  institution: string;
  last4: string;
  figure: string;
  as_of: string;
  APR: string;
  min_payment: string;
  secured_by: string;
  source_path: string;
  confidence: string;
  note: string;
}

/** RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function readSeedRows(csv: string): SeedRow[] {
  const rows = parseCsv(csv);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
    return o as unknown as SeedRow;
  });
}

export function parseAmount(s: string | null | undefined): number | null {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/[$,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function parseApr(s: string | null | undefined): { pct: number | null; text: string | null } {
  const t = (s ?? "").trim();
  if (!t) return { pct: null, text: null };
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(t);
  return { pct: m ? Number(m[1]) : null, text: t };
}

function confidenceOf(s: string): Confidence {
  const l = s.toLowerCase();
  return l === "high" || l === "medium" || l === "low" ? l : "low";
}

/** The seed's source column tells us HOW the figure was known. */
export function sourceKindOf(sourcePath: string, note: string): SourceKind {
  const s = `${sourcePath} ${note}`.toLowerCase();
  if (s.includes("report-10-14-26") || s.includes("tri-bureau")) return "bureau";
  if (/^owner \((voice note|message|call)/.test(sourcePath.toLowerCase()) || sourcePath.toLowerCase().startsWith("owner (")) return "manual";
  if (sourcePath.trim()) return "statement";
  return "seed";
}

function dateOrNull(s: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

const ITEM_TYPES: Record<string, { kind: ItemKind; side: Item["side"] }> = {
  "asset/real_estate": { kind: "real_estate", side: "asset" },
  "asset/receivable": { kind: "receivable", side: "asset" },
  "contingent/tax": { kind: "contingent", side: "contingent" },
  tax_attribute: { kind: "other", side: "contingent" },
};

function isSelfCustody(institution: string): boolean {
  const l = institution.toLowerCase();
  return l.includes("ledger") || l.includes("hardware wallet") || l.includes("coinbase wallet");
}

export function kindOf(type: string): { kind: AccountKind; subtype: string } {
  const [head, ...rest] = type.split("/");
  const subtype = rest.join("/") || head;
  const kind: AccountKind = head === "asset" ? "asset" : head === "liability" ? "liability" : head === "contingent" ? "contingent" : "tax_attribute";
  return { kind, subtype };
}

export interface SeedImportResult {
  accounts: number;
  items: number;
  skipped: Array<{ row: number; why: string }>;
}

let seq = 0;
function id(prefix: string): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36).padStart(4, "0")}`;
}

/**
 * Idempotent on the file: a second import of the same CSV (same sha256) is
 * refused by the caller; a different CSV REPLACES only seed-sourced rows
 * (entered_by "seed"), never the owner's manual entries or fed accounts.
 */
export function importSeed(ledger: Ledger, csv: string, sourcePath: string, now: Date): SeedImportResult {
  const rows = readSeedRows(csv);
  const at = now.toISOString();
  const res: SeedImportResult = { accounts: 0, items: 0, skipped: [] };
  ledger.accounts = ledger.accounts.filter((a) => a.figure.entered_by !== "seed");
  ledger.items = ledger.items.filter((i) => i.figure.entered_by !== "seed");
  rows.forEach((r, i) => {
    if (!r.type || !r.institution) {
      res.skipped.push({ row: i + 2, why: "no type or institution" });
      return;
    }
    const tag = tagOwner(r.owner);
    const money: Money = {
      amount: parseAmount(r.figure),
      as_of: dateOrNull(r.as_of),
      source: sourceKindOf(r.source_path, r.note),
      confidence: confidenceOf(r.confidence),
      entered_by: "seed",
      entered_at: at,
    };
    const note = r.note ? redact(r.note) : null;
    const itemType = ITEM_TYPES[r.type] ?? (r.type === "asset/crypto" && isSelfCustody(r.institution) ? { kind: "crypto_holding" as ItemKind, side: "asset" as const } : null);
    if (itemType) {
      ledger.items.push({
        id: id("itm"),
        owner: tag.owner,
        owner_label: redact(r.owner),
        shared_with: tag.shared_with,
        split: tag.split,
        kind: itemType.kind,
        side: itemType.side,
        name: redact(r.institution),
        figure: money,
        note: [note, r.secured_by ? `Secured by / against: ${redact(r.secured_by)}` : null, r.source_path ? `Source: ${redact(r.source_path)}` : null].filter(Boolean).join(" · ") || null,
        created_at: at,
        updated_at: at,
      });
      res.items++;
      return;
    }
    const { kind, subtype } = kindOf(r.type);
    const apr = parseApr(r.APR);
    ledger.accounts.push({
      id: id("acc"),
      owner: tag.owner,
      owner_label: redact(r.owner),
      shared_with: tag.shared_with,
      split: tag.split,
      kind,
      subtype,
      institution: redact(r.institution),
      last4: cleanLast4(r.last4),
      figure: money,
      apr_pct: apr.pct,
      apr_text: apr.text ? redact(apr.text) : null,
      min_payment: parseAmount(r.min_payment),
      secured_by: r.secured_by ? redact(r.secured_by) : null,
      source_path: r.source_path ? redact(r.source_path) : null,
      note,
      connection_id: null,
      provider_account_id: null,
      active: true,
      created_at: at,
      updated_at: at,
      has_secret_number: false,
    });
    res.accounts++;
  });
  ledger.seed = { imported_at: at, source_path: sourcePath, rows: rows.length, sha256: safeDigest(csv) };
  return res;
}
