/**
 * Documents: statements and credit reports upload into the vault encrypted
 * (store.ts putDoc). A parser runs where one is cheap; the credit-report
 * text parse is the first. PDFs are untrusted input: text is extracted by
 * `pdftotext -layout` in a child process with the path passed as an
 * argument, never by opening the PDF in-process, and the plaintext never
 * touches disk — it is piped and parsed in memory.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCreditReport, reportFindings, type CreditReport } from "./parsers/credit-report.js";
import { applyBureau, type ApplyResult } from "./parsers/apply-bureau.js";
import type { Ledger, Owner, StoredDocument } from "./types.js";
import { redact, safeDigest } from "./mask.js";

export const MAX_DOC_BYTES = 25 * 1024 * 1024;

export function pdfToText(bytes: Buffer, opts: { bin?: string; scratchDir?: string } = {}): Promise<string> {
  const bin = opts.bin ?? process.env.VAULT_PDFTOTEXT ?? "pdftotext";
  // The scratch copy lives for the length of one call, under a 0700 dir, and is deleted in `finally`.
  const dir = mkdtempSync(join(opts.scratchDir ?? tmpdir(), "ahi-vault-pdf-"));
  const p = join(dir, "in.pdf");
  writeFileSync(p, bytes, { mode: 0o600 });
  return new Promise<string>((resolve, reject) => {
    execFile(bin, ["-layout", "-enc", "UTF-8", p, "-"], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (err, stdout) => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      if (err) reject(new Error(`pdftotext failed: ${err.message}`));
      else resolve(stdout);
    });
  });
}

export function bureauFromName(filename: string): string {
  const l = filename.toLowerCase();
  if (l.includes("equifax")) return "Equifax";
  if (l.includes("experian")) return "Experian";
  if (l.includes("transunion") || l.includes("trans-union")) return "TransUnion";
  return "Bureau";
}

export interface DocInput {
  filename: string;
  mime: string;
  bytes: Buffer;
  kind: StoredDocument["kind"];
  owner: Owner;
  uploaded_by: string;
  institution?: string | null;
  as_of?: string | null;
}

let seq = 0;
export function docId(now: Date): string {
  seq = (seq + 1) % 100000;
  return `doc-${now.getTime().toString(36)}${seq.toString(36)}`;
}

export function describeDoc(input: DocInput, now: Date): StoredDocument {
  return {
    id: docId(now),
    kind: input.kind,
    filename: redact(input.filename).slice(0, 120),
    mime: input.mime.slice(0, 80),
    bytes: input.bytes.length,
    sha256: safeDigest(input.bytes),
    uploaded_at: now.toISOString(),
    uploaded_by: input.uploaded_by,
    owner: input.owner,
    parsed: null,
    institution: input.institution ? redact(input.institution).slice(0, 80) : null,
    as_of: input.as_of ?? null,
  };
}

/** Text for the parser: .txt as is, .pdf through pdftotext. */
export async function textOf(input: Pick<DocInput, "filename" | "mime" | "bytes">, pdf = pdfToText): Promise<string | null> {
  const l = input.filename.toLowerCase();
  if (l.endsWith(".txt") || input.mime.startsWith("text/")) return input.bytes.toString("utf8");
  if (l.endsWith(".pdf") || input.mime === "application/pdf") return pdf(input.bytes);
  return null;
}

export interface ParseOutcome {
  parser: string;
  summary: string;
  report?: CreditReport;
  applied?: ApplyResult;
}

/** Parse + apply a credit report into the ledger. Returns what changed, in plain words. */
export function applyCreditReportText(ledger: Ledger, text: string, bureau: string, now: Date): ParseOutcome {
  const report = parseCreditReport(text, bureau);
  const applied = applyBureau(ledger, report, now);
  const lines = reportFindings(report);
  const summary = `${lines[0] ?? `${bureau}: parsed`} ${report.tradelines.length} tradelines; ${applied.updated.length} updated, ${applied.created.length} new, ${applied.closed.length} closed.`;
  return { parser: "credit-report", summary: redact(summary), report, applied };
}
