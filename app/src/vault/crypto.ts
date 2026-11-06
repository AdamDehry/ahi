/**
 * Encryption at rest for everything the vault stores: the ledger (balances,
 * owners, notes), provider tokens, uploaded statements, the audit trail.
 *
 * Scheme (written down, as the brief asks):
 *   AES-256-GCM from node:crypto — no new dependency, hardware-accelerated,
 *   authenticated (a flipped byte fails to decrypt instead of decrypting to
 *   garbage). One 32-byte key for the vault; a fresh 12-byte random nonce per
 *   envelope; the envelope's `kind` (ledger / token / doc / audit) is bound
 *   as additional authenticated data, so a token blob cannot be replayed as
 *   a ledger. Envelope on disk, JSON:
 *     { v: 1, alg: "aes-256-gcm", kind, nonce, ct, tag }   (base64url fields)
 *
 * Key placement: VAULT_KEY_FILE, default ~/.config/ahi/vault/vault.key —
 *   deliberately NOT in the repo, NOT under ~/ai/state (the gateway's state
 *   dir), and NOT under ~/AHI, ~/.claude or ~/.secrets, which are the three
 *   roots the nightly restic job backs up (mission-control/scheduled/
 *   offsite-backup.sh). The ciphertext lives under the user's business root
 *   (~/business/owner/vault → ~/AHI/AHI_OS/state/owner/vault), which IS backed
 *   up. So: the backup holds the ciphertext and never the key. The owner keeps a
 *   copy of the key off the box (as with the restic password): box death
 *   without the key = vault death, by design.
 *
 * Fail closed: no key, an unreadable key, a key of the wrong length, a wrong
 * key, or a tampered envelope all throw VaultLocked. Nothing in this module
 * ever falls back to plaintext, and the callers turn VaultLocked into a 503
 * ("vault locked") rather than an empty picture.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export class VaultLocked extends Error {
  readonly code = "vault-locked";
  constructor(reason: string) {
    super(`vault locked: ${reason}`);
  }
}

export type EnvelopeKind = "ledger" | "token" | "doc" | "audit" | "secret";

export interface Envelope {
  v: 1;
  alg: "aes-256-gcm";
  kind: EnvelopeKind;
  nonce: string;
  ct: string;
  tag: string;
}

export function defaultKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.VAULT_KEY_FILE ? resolve(env.VAULT_KEY_FILE) : resolve(homedir(), ".config/ahi/vault/vault.key");
}

const KEY_BYTES = 32;

/**
 * The key file holds 64 hex characters (32 bytes). Hex, not raw bytes, so a
 * human can copy it to a password manager without a binary-safe channel.
 */
export function loadKey(path = defaultKeyPath()): Buffer {
  if (!existsSync(path)) throw new VaultLocked(`no key file at ${path}`);
  let st;
  try {
    st = statSync(path);
  } catch (err) {
    throw new VaultLocked(`key file unreadable: ${(err as Error).message}`);
  }
  if ((st.mode & 0o077) !== 0) throw new VaultLocked(`key file ${path} is group/world readable — chmod 600 it`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch (err) {
    throw new VaultLocked(`key file unreadable: ${(err as Error).message}`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new VaultLocked("key file must hold exactly 64 hex characters");
  const key = Buffer.from(raw, "hex");
  if (key.length !== KEY_BYTES) throw new VaultLocked("key is not 32 bytes");
  return key;
}

/** Create a fresh key (mode 600, dir 700). Refuses to overwrite. Used by `vault.mjs key-init`. */
export function createKeyFile(path = defaultKeyPath()): string {
  if (existsSync(path)) throw new Error(`refusing to overwrite existing key at ${path}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, randomBytes(KEY_BYTES).toString("hex") + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export class VaultCipher {
  private key: Buffer | null = null;
  constructor(private readonly keyPath: string = defaultKeyPath()) {}

  /** Re-read on every call site that cares; cheap, and a rotated key is picked up without a restart. */
  private k(): Buffer {
    if (!this.key) this.key = loadKey(this.keyPath);
    return this.key;
  }

  forget(): void {
    if (this.key) this.key.fill(0);
    this.key = null;
  }

  get locked(): boolean {
    try {
      this.k();
      return false;
    } catch {
      return true;
    }
  }

  encrypt(kind: EnvelopeKind, plaintext: Buffer | string): Envelope {
    const key = this.k();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(`ahi-vault:${kind}`));
    const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
    const ct = Buffer.concat([cipher.update(data), cipher.final()]);
    return { v: 1, alg: "aes-256-gcm", kind, nonce: nonce.toString("base64url"), ct: ct.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
  }

  decrypt(expectedKind: EnvelopeKind, env: Envelope): Buffer {
    const key = this.k();
    if (!env || env.v !== 1 || env.alg !== "aes-256-gcm") throw new VaultLocked("not a vault envelope");
    if (env.kind !== expectedKind) throw new VaultLocked(`envelope kind ${env.kind} where ${expectedKind} was expected`);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(env.nonce, "base64url"));
    decipher.setAAD(Buffer.from(`ahi-vault:${env.kind}`));
    decipher.setAuthTag(Buffer.from(env.tag, "base64url"));
    try {
      return Buffer.concat([decipher.update(Buffer.from(env.ct, "base64url")), decipher.final()]);
    } catch {
      throw new VaultLocked("decryption failed — wrong key or tampered data");
    }
  }

  encryptJson(kind: EnvelopeKind, value: unknown): Envelope {
    return this.encrypt(kind, JSON.stringify(value));
  }

  decryptJson<T>(kind: EnvelopeKind, env: Envelope): T {
    return JSON.parse(this.decrypt(kind, env).toString("utf8")) as T;
  }
}

/** Constant-time compare for service tokens. */
export function tokenEquals(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
