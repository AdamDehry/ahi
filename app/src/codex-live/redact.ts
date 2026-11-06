/**
 * redact.ts — nothing secret-shaped leaves the gateway in a live transcript.
 *
 * Two layers, both applied to every string the live view sends:
 *
 *   1. EXACT VALUES. Every credential the gateway itself can see — its own
 *      environment (which includes .env), plus the KEY=VALUE files under
 *      ~/.secrets — is matched literally and replaced. A Codex build that runs
 *      `env` or cats a config file cannot echo a live value past this layer,
 *      whatever its shape. Values are held in memory only, never logged.
 *   2. SHAPES. Known token formats (sk-…, ghp_…, xox…-, AKIA…, AIza…, JWTs,
 *      Bearer/Basic headers, private-key blocks, user:pass@ in URLs, long
 *      random runs) and `SECRET_NAME=value` assignments.
 *
 * Over-redacting a long hash is an accepted cost; under-redacting is not.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

export const REDACTED = "[redacted]";

/** A variable name that holds a secret: OPENAI_API_KEY, token, clientSecret — not "passed" or "author". */
export function isSecretName(name: string): boolean {
  return (
    /(?:^|_)(?:API_?KEY|KEYS?|TOKENS?|SECRETS?|PASS|PASSWD|PASSWORD|PASSPHRASE|AUTH|CREDENTIALS?|COOKIE|PRIVATE|SID|DSN|WEBHOOK|SIGNATURE|SIG)(?:_|$)/i.test(name) ||
    /[a-z](?:Key|Token|Secret|Password|Passphrase|Auth)$/.test(name)
  );
}

const SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{12,}/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /\b(?:AC|SK)[0-9a-f]{32}\b/g,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g, // telegram bot tokens
];

/** `Bearer xyz`, `Basic xyz`, `token xyz` in headers. */
const AUTH_HEADER = /\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
/** scheme://user:password@host */
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;
/** ?token=…&key=… */
const URL_PARAM = /([?&](?:[a-z_]*(?:token|key|secret|sig|signature|password|auth)[a-z_]*)=)[^&\s"']+/gi;
/** NAME=value · NAME: value · "NAME": "value" — NAME secret-shaped. */
const ASSIGN = /(\b[A-Za-z_][A-Za-z0-9_]*\b)(["']?\s*(?:=|:)\s*["']?)([^\s"'`,;}]{4,})/g;
/** A long run mixing upper, lower and digits (random tokens), or a long hex run. */
const RANDOM_RUN = /[A-Za-z0-9_=.-]{32,}/g;
const HEX_RUN = /\b[0-9a-f]{48,}\b/gi;

/**
 * A run that reads like a generated token, not like a file name: plenty of
 * upper, lower AND digits, with one long unbroken stretch (real tokens are not
 * hyphenated words — "rollout-2026-10-14T05-56-08" and "CODEX-REVIEW-R2" are not secrets).
 */
function looksRandom(s: string): boolean {
  const count = (re: RegExp) => (s.match(re) ?? []).length;
  if (count(/[A-Z]/g) < 3 || count(/[a-z]/g) < 3 || count(/[0-9]/g) < 3) return false;
  return Math.max(...s.split(/[-_.]/).map((x) => x.length)) >= 20;
}

/** Values in `name=value` that are code, not credentials (`key=lambda …`, `token: string`). */
const CODE_VALUE = /^(?:lambda|function|str|string|int|number|bool|boolean|none|null|true|false|undefined|self|this|os\.environ.*|process\.env.*|env\..*|REDACTED|\[redacted\])$/i;

export class Redactor {
  private values: string[] = [];
  private loadedAt = 0;

  constructor(
    private readonly opts: {
      env?: NodeJS.ProcessEnv;
      secretDirs?: string[];
      envFiles?: string[];
      /** How long a loaded value set is trusted before it is re-read. */
      ttlMs?: number;
      now?: () => number;
    } = {},
  ) {}

  /** Literal values to strip. Longest first so a value containing another wins. */
  private exactValues(): string[] {
    const now = (this.opts.now ?? Date.now)();
    if (this.loadedAt && now - this.loadedAt < (this.opts.ttlMs ?? 5 * 60_000)) return this.values;
    const set = new Set<string>();
    const add = (name: string, value: string | undefined) => {
      if (!value) return;
      const v = value.trim().replace(/^["']|["']$/g, "");
      if (v.length < 8) return;
      // Secret-named values always; other env values only when they look random
      // (never PATH-like strings, which would shred every transcript).
      if (isSecretName(name) || (v.length >= 20 && !/\s/.test(v) && !v.includes("/") && looksRandom(v))) set.add(v);
    };
    for (const [k, v] of Object.entries(this.opts.env ?? process.env)) add(k, v);
    const files: string[] = [...(this.opts.envFiles ?? [])];
    for (const dir of this.opts.secretDirs ?? []) {
      try {
        for (const f of readdirSync(dir)) {
          const p = join(dir, f);
          if (/\.(?:bak|lock)\b|\.jsonl/.test(f)) continue;
          try {
            if (statSync(p).isFile() && statSync(p).size < 256 * 1024) files.push(p);
          } catch {
            /* unreadable — skip */
          }
        }
      } catch {
        /* no dir */
      }
    }
    for (const p of files) {
      try {
        if (!existsSync(p)) continue;
        for (const raw of readFileSync(p, "utf8").split("\n")) {
          const line = raw.trim();
          if (!line || line.startsWith("#")) continue;
          const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*)$/.exec(line);
          if (m) add(m[1], m[2]);
          else add("SECRET", line); // a bare password file
        }
      } catch {
        /* unreadable — skip */
      }
    }
    this.values = [...set].sort((a, b) => b.length - a.length);
    this.loadedAt = now;
    return this.values;
  }

  redact(text: string): string {
    if (!text) return text;
    let out = text;
    for (const v of this.exactValues()) if (out.includes(v)) out = out.split(v).join(REDACTED);
    for (const re of SHAPES) out = out.replace(re, REDACTED);
    out = out.replace(AUTH_HEADER, (_m, scheme: string, sp: string) => `${scheme}${sp}${REDACTED}`);
    out = out.replace(URL_USERINFO, (_m, head: string) => `${head}${REDACTED}@`);
    out = out.replace(URL_PARAM, (_m, head: string) => `${head}${REDACTED}`);
    out = out.replace(ASSIGN, (m, name: string, sep: string, value: string) =>
      isSecretName(name) && !value.startsWith("$") && !CODE_VALUE.test(value)
        ? `${name}${sep}${REDACTED}`
        : m,
    );
    out = out.replace(HEX_RUN, REDACTED);
    out = out.replace(RANDOM_RUN, (m) => (looksRandom(m) ? REDACTED : m));
    return out;
  }
}

/** The gateway's redactor: its own env + .env + ~/.secrets. */
export function defaultRedactor(): Redactor {
  return new Redactor({
    secretDirs: [process.env.CODEX_LIVE_SECRETS_DIR ? resolve(process.env.CODEX_LIVE_SECRETS_DIR) : join(homedir(), ".secrets")],
    envFiles: [fileURLToPath(new URL("../../.env", import.meta.url))],
  });
}
