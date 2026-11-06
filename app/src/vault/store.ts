/**
 * VaultStore — the on-disk shape, all of it encrypted (crypto.ts):
 *
 *   <root>/ledger.enc.json          one envelope, the whole Ledger (accounts,
 *                                   items, connections, snapshots, flags,
 *                                   document index, settings). Small; rewritten
 *                                   whole, atomically, serialized per store.
 *   <root>/tokens/<conn>.enc.json   one envelope per provider token; disconnect
 *                                   = delete the file.
 *   <root>/secrets/<acct>.enc.json  a full account number the owner chose to keep,
 *                                   one envelope per account, revealed only
 *                                   behind a fresh passkey (routes.ts).
 *   <root>/docs/<doc>.enc.json      an uploaded statement/report, bytes inside
 *                                   the envelope.
 *   <root>/audit.enc.jsonl          append-only; one envelope per line.
 *
 * <root> is the user's business root + "vault" (bills.ts pattern), so it
 * follows the AHI_GATEWAY_BUSINESS_DIR override and is never shared with
 * production by an isolated instance.
 *
 * No plaintext file exists under <root>. A directory listing reveals ids and
 * sizes, nothing else.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, multiUserPaths, safeSegment } from "../multi-user-paths.js";
import { VaultCipher, type Envelope } from "./crypto.js";
import { CURRENT_SCHEMA, emptyLedger, type Ledger } from "./types.js";
import { redact } from "./mask.js";

export interface AuditEntry {
  at: string;
  who: string;
  action: string;
  /** Free text, redacted before it is stored. Never a number shape. */
  detail: string;
  ref?: string | null;
}

export function vaultRoot(userId: string): string {
  return join(multiUserPaths(userId).businessRoot, "vault");
}

/** Ordered migrations: index = the version they produce. v0 → v1 is "seed shape". */
const MIGRATIONS: Array<(l: Ledger) => void> = [
  (l) => {
    l.schema_version = 1;
    l.accounts ??= [];
    l.items ??= [];
    l.connections ??= [];
    l.snapshots ??= [];
    l.flags ??= [];
    l.documents ??= [];
    l.seed ??= null;
    l.settings ??= emptyLedger(l.user_id).settings;
  },
];

export function migrate(ledger: Ledger): { ledger: Ledger; from: number; to: number } {
  const from = ledger.schema_version ?? 0;
  let v = from;
  while (v < CURRENT_SCHEMA) {
    MIGRATIONS[v](ledger);
    v = ledger.schema_version;
  }
  return { ledger, from, to: v };
}

export class VaultStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly userId: string,
    readonly root: string = vaultRoot(userId),
    readonly cipher: VaultCipher = new VaultCipher(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  private ledgerPath(): string {
    return join(this.root, "ledger.enc.json");
  }

  get exists(): boolean {
    return existsSync(this.ledgerPath());
  }

  read(): Ledger {
    const p = this.ledgerPath();
    if (!existsSync(p)) return emptyLedger(this.userId);
    const env = JSON.parse(readFileSync(p, "utf8")) as Envelope;
    const raw = this.cipher.decryptJson<Ledger>("ledger", env);
    const { ledger, from, to } = migrate(raw);
    if (from !== to) this.write(ledger);
    return ledger;
  }

  write(ledger: Ledger): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    atomicWriteJson(this.ledgerPath(), this.cipher.encryptJson("ledger", ledger));
  }

  /** Read-modify-write, serialized, so two requests never lose each other's change. */
  mutate<T>(fn: (ledger: Ledger) => T): Promise<T> {
    const run = () => {
      const ledger = this.read();
      const out = fn(ledger);
      this.write(ledger);
      return out;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  // ── tokens ─────────────────────────────────────────────────────────

  private tokenPath(connId: string): string {
    return join(this.root, "tokens", `${safeSegment(connId, "x")}.enc.json`);
  }

  putToken(connId: string, token: string): void {
    mkdirSync(join(this.root, "tokens"), { recursive: true, mode: 0o700 });
    atomicWriteJson(this.tokenPath(connId), this.cipher.encrypt("token", token));
  }

  getToken(connId: string): string | null {
    const p = this.tokenPath(connId);
    if (!existsSync(p)) return null;
    return this.cipher.decrypt("token", JSON.parse(readFileSync(p, "utf8")) as Envelope).toString("utf8");
  }

  deleteToken(connId: string): boolean {
    const p = this.tokenPath(connId);
    if (!existsSync(p)) return false;
    unlinkSync(p);
    return true;
  }

  hasToken(connId: string): boolean {
    return existsSync(this.tokenPath(connId));
  }

  // ── per-account secret (a full number the owner chose to keep) ──────────

  private secretPath(accountId: string): string {
    return join(this.root, "secrets", `${safeSegment(accountId, "x")}.enc.json`);
  }

  putSecret(accountId: string, value: string): void {
    mkdirSync(join(this.root, "secrets"), { recursive: true, mode: 0o700 });
    atomicWriteJson(this.secretPath(accountId), this.cipher.encrypt("secret", value));
  }

  getSecret(accountId: string): string | null {
    const p = this.secretPath(accountId);
    if (!existsSync(p)) return null;
    return this.cipher.decrypt("secret", JSON.parse(readFileSync(p, "utf8")) as Envelope).toString("utf8");
  }

  deleteSecret(accountId: string): boolean {
    const p = this.secretPath(accountId);
    if (!existsSync(p)) return false;
    unlinkSync(p);
    return true;
  }

  // ── documents ──────────────────────────────────────────────────────

  private docPath(docId: string): string {
    return join(this.root, "docs", `${safeSegment(docId, "x")}.enc.json`);
  }

  putDoc(docId: string, bytes: Buffer): void {
    mkdirSync(join(this.root, "docs"), { recursive: true, mode: 0o700 });
    atomicWriteJson(this.docPath(docId), this.cipher.encrypt("doc", bytes));
  }

  getDoc(docId: string): Buffer | null {
    const p = this.docPath(docId);
    if (!existsSync(p)) return null;
    return this.cipher.decrypt("doc", JSON.parse(readFileSync(p, "utf8")) as Envelope);
  }

  deleteDoc(docId: string): boolean {
    const p = this.docPath(docId);
    if (!existsSync(p)) return false;
    unlinkSync(p);
    return true;
  }

  // ── audit ──────────────────────────────────────────────────────────

  audit(entry: Omit<AuditEntry, "at">): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const line: AuditEntry = { at: this.now().toISOString(), who: entry.who, action: entry.action, detail: redact(entry.detail), ref: entry.ref ?? null };
    appendFileSync(join(this.root, "audit.enc.jsonl"), JSON.stringify(this.cipher.encryptJson("audit", line)) + "\n", { mode: 0o600 });
  }

  readAudit(limit = 200): AuditEntry[] {
    const p = join(this.root, "audit.enc.jsonl");
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => this.cipher.decryptJson<AuditEntry>("audit", JSON.parse(l) as Envelope));
  }

  /** Every file name under the root — for the "nothing plaintext" test. */
  files(): string[] {
    if (!existsSync(this.root)) return [];
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(dir, e.name), r);
        else out.push(r);
      }
    };
    walk(this.root, "");
    return out.sort();
  }
}
