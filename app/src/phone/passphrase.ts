/* ============================================================
   phone/passphrase.ts — the spoken second factor for inbound calls.

   Caller ID is spoofable, so a call that merely CLAIMS to be from the owner's cell
   does not open Michael's OS context. At the top of every inbound call the
   caller says the passphrase; only then do turns reach the agent.

   Only a salted scrypt hash is stored (plus the phrase's word count, so the
   check knows which run of spoken words to hash). The phrase itself is never
   written anywhere: not to disk, not to a log, not to the call's transcript —
   phone/stream.ts consumes those turns before the call core records them.

   Matching is on NORMALIZED words: lower case, punctuation dropped, digits
   kept. Speech recognition adds words around it ("it's blue heron"), so every
   contiguous run of the right length in what was heard is tried.

   The hash lives in the gateway state dir (phone/passphrase.json, mode 600).
   Set it with scripts/phone-passphrase.mjs, which reads the phrase from the
   terminal without echo.
   ============================================================ */

import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PassphraseRecord {
  v: 1;
  /** scrypt params, so a later change can still verify old records. */
  N: number;
  salt: string;
  hash: string;
  words: number;
  setAt: string;
}

const N = 16_384;
const KEYLEN = 32;
/**
 * An answer to "passphrase?" is short; bound the work per attempt. Each window
 * is one scrypt (~50 ms, on the libuv pool, never the event loop).
 */
export const MAX_PASSPHRASE_WORDS = 16;
const MAX_HEARD_WORDS = MAX_PASSPHRASE_WORDS;

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
};

/** What is compared: words, lower case, no punctuation, number words as digits. */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => NUMBER_WORDS[w] ?? w);
}

const SCRYPT_OPTS = (n: number) => ({ N: n, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

function digest(words: string[], salt: Buffer, n: number): Buffer {
  return scryptSync(words.join(" "), salt, KEYLEN, SCRYPT_OPTS(n));
}

function digestAsync(words: string[], salt: Buffer, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(words.join(" "), salt, KEYLEN, SCRYPT_OPTS(n), (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export function hashPassphrase(phrase: string, now: Date = new Date()): PassphraseRecord {
  const words = normalizeWords(phrase);
  if (words.length < 2) throw new Error("a passphrase needs at least two words");
  // The check only ever looks at the last 16 words heard: a longer phrase
  // would install and then never match.
  if (words.length > MAX_PASSPHRASE_WORDS) throw new Error(`a passphrase can have at most ${MAX_PASSPHRASE_WORDS} words`);
  const salt = randomBytes(16);
  return {
    v: 1,
    N,
    salt: salt.toString("base64"),
    hash: digest(words, salt, N).toString("base64"),
    words: words.length,
    setAt: now.toISOString(),
  };
}

/** Did `heard` contain the passphrase, as a run of consecutive words? */
export async function matchesPassphrase(heard: string, rec: PassphraseRecord): Promise<boolean> {
  const words = normalizeWords(heard).slice(0, MAX_HEARD_WORDS);
  if (words.length < rec.words) return false;
  const salt = Buffer.from(rec.salt, "base64");
  const want = Buffer.from(rec.hash, "base64");
  const windows: string[][] = [];
  for (let i = 0; i + rec.words <= words.length; i++) windows.push(words.slice(i, i + rec.words));
  // Every window is hashed (no early exit), so timing does not say where it matched.
  const got = await Promise.all(windows.map((w) => digestAsync(w, salt, rec.N)));
  return got.some((g) => g.length === want.length && timingSafeEqual(g, want));
}

export function readPassphrase(file: string): PassphraseRecord | null {
  try {
    if (!existsSync(file)) return null;
    const rec = JSON.parse(readFileSync(file, "utf8")) as PassphraseRecord;
    if (rec?.v !== 1 || !rec.salt || !rec.hash || !(rec.words >= 2) || rec.words > MAX_PASSPHRASE_WORDS || !(rec.N > 0)) return null;
    return rec;
  } catch {
    return null;
  }
}

export function writePassphrase(file: string, rec: PassphraseRecord): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
