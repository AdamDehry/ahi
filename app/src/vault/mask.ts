/**
 * The masking rail (Phase 1 BRIEF.md, carried here): no SSN, DOB, full
 * account number or routing number in ANY output of the vault — API bodies,
 * logs, chat hints, test output, the report.
 *
 * `scanForSecrets` is the detector the tests grep every output with. The
 * rule is digit-shape, not field-name: nine or more digits in a row (a
 * routing number is nine, an SSN nine, a full card/account number more),
 * an SSN with dashes, a card number with spaces or dashes, and the bureau's
 * own partially masked form (digits followed by Xs). Balances pass — a
 * seven-figure balance is seven digits — and so do ISO dates and build ids
 * (eight digits).
 */

import { createHash } from "node:crypto";

export interface SecretHit {
  pattern: string;
  /** The hit itself is NOT returned — only its shape and position. */
  at: number;
  length: number;
}

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "nine-or-more-digits", re: /\d{9,}/g },
  { name: "ssn-dashed", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: "card-spaced", re: /\b(?:\d{4}[ -]){3}\d{1,7}\b/g },
  { name: "bureau-partial", re: /\b[0-9A-Z]{3,}X{3,}\b/g },
];

export function scanForSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      hits.push({ pattern: name, at: m.index, length: m[0].length });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return hits;
}

/** Replace anything secret-shaped with a fixed token. Used on every free-text field before it is stored or shown. */
export function redact(text: string): string {
  let out = text;
  for (const { re } of PATTERNS) out = out.replace(new RegExp(re.source, "g"), "[redacted]");
  return out;
}

/**
 * A hash that can never look like an account number: sha256, hex, with every
 * digit mapped to a letter (0→g … 9→p). Used for seed and document digests
 * and tradeline fingerprints, so a digest never trips the rail above.
 */
export function safeDigest(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex").replace(/\d/g, (d) => "ghijklmnop"[Number(d)]);
}

/** Keep only the last four digits of whatever was given; "" if fewer than two digits. */
export function last4Of(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 2) return null;
  return digits.slice(-4);
}

/** The seed's last4 column may hold "0403/2900" — two accounts. Each half is checked. */
export function cleanLast4(value: string | null | undefined): string | null {
  if (!value) return null;
  const parts = String(value)
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p.length <= 4 && /^[0-9A-Za-z]+$/.test(p) ? p : last4Of(p)))
    .filter((p): p is string => !!p);
  return parts.length ? parts.join("/") : null;
}

/** Never let a log line carry a number shape. Logging helper for the module. */
export function safeLog(prefix: string, text: string): void {
  console.log(`${prefix} ${redact(text)}`);
}
