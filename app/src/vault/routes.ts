/**
 * HTTP surface of the vault. Two audiences, the review desk's two schemes:
 *
 *   /app/vault/*   the owner in the PWA — the gateway's EXISTING user auth
 *                  (resolveUser: X-AHI-Token / cookie). The vault belongs to
 *                  the users in VAULT_OWNERS (default: owner) and ONLY to
 *                  them: any other session, admin or not, gets 404 on every
 *                  route, so for a family member/Miriam the vault does not exist at
 *                  the route level. Writes need `X-AHI-Vault: 1` (CSRF, the
 *                  session cookie is SameSite=None) and a JSON body, except
 *                  the multipart upload which needs the header.
 *
 *   /api/vault/*   Michael's chat session via scripts/vault.mjs. Bearer
 *                  VAULT_SERVICE_TOKEN; unset = 503, closed. Read the masked
 *                  picture, refresh feeds, and record a figure the owner dictated.
 *                  Nothing on this side can connect, disconnect, reveal,
 *                  upload or delete.
 *
 * RED actions (passkey, server-verified through the review desk's
 * PasskeyService, never a second gate): connecting an account, storing and
 * revealing a full account number. The challenge is bound to the user and a
 * purpose string, single use, five minutes.
 */
import { ownerUserId } from "../users.js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import type { PasskeyService } from "../review/passkeys.js";
import { tokenEquals, VaultLocked } from "./crypto.js";
import { checkDrift, raiseFlag, snapshotAll } from "./drift.js";
import { applyCreditReportText, bureauFromName, describeDoc, MAX_DOC_BYTES, textOf, type DocInput } from "./docs.js";
import { cleanLast4, redact, safeDigest, scanForSecrets } from "./mask.js";
import { derivePicture, derivePlanInput, pictureSummaryLines } from "./picture.js";
import { ProviderError, type VaultProvider } from "./providers/types.js";
import { importSeed, parseAmount } from "./seed.js";
import { VaultStore } from "./store.js";
import { isOwner, type Account, type Flag, type Item, type Ledger, type Owner } from "./types.js";
import { vaultOwners } from "./hint.js";

export interface VaultUser {
  userId: string;
  name: string;
  admin: boolean;
}

export interface VaultRouteDeps {
  resolveUser(c: Context): VaultUser | null;
  /** null = no passkey gate available → every RED action refuses. */
  passkeys: PasskeyService | null;
  provider: VaultProvider;
  stores: (userId: string) => VaultStore;
  serviceToken?: () => string | undefined;
  now?: () => Date;
  /** Posts a flag on the Feed/Reviews path; returns the row's id. */
  postNeedsYou?: (userId: string, flag: Flag) => Promise<string | null>;
  /** Phase 1 CSV, read-only. */
  seedPath?: () => string;
  pdfToText?: (bytes: Buffer) => Promise<string>;
  owners?: () => string[];
}

type Json = Record<string, unknown>;

async function jsonBody(c: Context): Promise<Json | null> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Json) : null;
  } catch {
    return null;
  }
}

function str(v: unknown, max = 200): string | null {
  if (v === null || v === undefined) return null;
  const s = redact(String(v)).trim();
  return s ? s.slice(0, max) : null;
}

function dateOrNull(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : undefined;
}

const ITEM_KINDS = new Set(["real_estate", "vehicle", "entity_share", "crypto_holding", "contingent", "receivable", "other"]);

export function registerVaultRoutes(app: Hono<any>, deps: VaultRouteDeps): void {
  const now = deps.now ?? (() => new Date());
  const serviceToken = deps.serviceToken ?? (() => process.env.VAULT_SERVICE_TOKEN);
  const owners = deps.owners ?? (() => vaultOwners());
  const connectSessions = new Map<string, { userId: string; owner: Owner; expires: number; credential_id: string }>();

  // ── auth ───────────────────────────────────────────────────────────

  /** 404 for anyone who is not a vault owner: the route does not exist for them. */
  function user(c: Context): VaultUser | Response {
    const u = deps.resolveUser(c);
    if (!u || !u.admin || !owners().includes(u.userId)) return c.json({ error: "Not found" }, 404);
    // Locked in the app (Lock button): every app route waits for the passkey, except the way back in.
    if (appLocked(u.userId) && !UNLOCK_PATHS.has(c.req.path))
      return c.json({ error: "Your Vault is locked. Confirm with your passkey to open it.", code: "app-locked", passkeys: deps.passkeys?.count(u.userId) ?? 0 }, 423);
    return u;
  }

  // ── app lock (FINAL "Lock"): a marker beside the ledger, so it survives restarts.
  // It locks the app surface only; Michael's service reads (/api/vault/*) are unaffected.
  const UNLOCK_PATHS = new Set(["/app/vault/unlock", "/app/vault/passkey/challenge"]);
  const lockMarker = (userId: string) => join(deps.stores(userId).root, "app-locked");
  function appLocked(userId: string): boolean {
    try {
      return existsSync(lockMarker(userId));
    } catch {
      return false;
    }
  }

  async function userWrite(c: Context, multipart = false): Promise<{ u: VaultUser; body: Json } | Response> {
    const u = user(c);
    if (u instanceof Response) return u;
    if (c.req.header("x-ahi-vault") !== "1") return c.json({ error: "missing X-AHI-Vault header" }, 403);
    if (multipart) return { u, body: {} };
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) return c.json({ error: "JSON body required" }, 415);
    const body = await jsonBody(c);
    if (!body) return c.json({ error: "JSON object body required" }, 400);
    return { u, body };
  }

  function service(c: Context): Response | null {
    const expected = serviceToken();
    if (!expected) return c.json({ error: "Vault service API disabled (no VAULT_SERVICE_TOKEN)" }, 503);
    const h = c.req.header("authorization");
    if (!h?.startsWith("Bearer ") || !tokenEquals(h.slice(7), expected)) return c.json({ error: "Unauthorized" }, 401);
    return null;
  }

  /** The service side acts for the FIRST vault owner  — it never names a user. */
  function serviceUser(): string {
    return owners()[0] ?? ownerUserId();
  }

  /** VaultLocked → 503, never an empty picture. */
  async function guarded(c: Context, fn: () => Promise<Response> | Response): Promise<Response> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof VaultLocked) return c.json({ error: "Vault locked — the encryption key is missing or wrong", code: "vault-locked", locked: true }, 503);
      if (err instanceof ProviderError) return c.json({ error: err.message, code: err.code }, err.code === "not-configured" ? 503 : 502);
      throw err;
    }
  }

  /** Every JSON leaving the vault passes the masking rail. A hit is a bug; refuse rather than leak. */
  function masked(c: Context, value: unknown, status = 200): Response {
    const text = JSON.stringify(value);
    const hits = scanForSecrets(text);
    if (hits.length) {
      console.error(`[vault] REFUSED a response: ${hits.length} secret-shaped value(s) (${hits.map((h) => h.pattern).join(", ")})`);
      return c.json({ error: "Response withheld: it contained a number shape the vault never shows", code: "masking-rail" }, 500);
    }
    return c.body(text, status as 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  }

  // ── reads  ───────────────────────────────────────────────────

  app.get("/app/vault", (c) =>
    guarded(c, () => {
      const u = user(c);
      if (u instanceof Response) return u;
      const store = deps.stores(u.userId);
      const ledger = store.read();
      const pic = derivePicture(ledger, now());
      return masked(c, { ...pic, provider: { id: deps.provider.id, name: deps.provider.name, configured: deps.provider.configured(), scopes: deps.provider.scopes() }, passkeys: deps.passkeys?.count(u.userId) ?? 0, documents: ledger.documents, initialized: store.exists });
    }),
  );

  app.get("/app/vault/plan", (c) =>
    guarded(c, () => {
      const u = user(c);
      if (u instanceof Response) return u;
      return masked(c, derivePlanInput(deps.stores(u.userId).read(), now()));
    }),
  );

  app.get("/app/vault/audit", (c) =>
    guarded(c, () => {
      const u = user(c);
      if (u instanceof Response) return u;
      return masked(c, { audit: deps.stores(u.userId).readAudit(100) });
    }),
  );

  // ── seed ───────────────────────────────────────────────────────────

  app.post("/app/vault/seed", (c) =>
    guarded(c, async () => {
      const w = await userWrite(c);
      if (w instanceof Response) return w;
      const path = deps.seedPath?.();
      if (!path) return c.json({ error: "No seed path configured (VAULT_SEED_PATH)" }, 503);
      const { readFileSync, existsSync } = await import("node:fs");
      if (!existsSync(path)) return c.json({ error: "Seed file not found" }, 404);
      const csv = readFileSync(path, "utf8");
      const store = deps.stores(w.u.userId);
      const r = await store.mutate((ledger) => {
        const sha = safeDigest(csv);
        if (ledger.seed?.sha256 === sha && w.body.force !== true) return { ok: false as const, error: "This seed was already imported" };
        const res = importSeed(ledger, csv, path, now());
        snapshotAll(ledger, now());
        return { ok: true as const, ...res };
      });
      if (!r.ok) return c.json({ error: r.error }, 409);
      store.audit({ who: `${w.u.userId} (app)`, action: "seed-import", detail: `${r.accounts} accounts, ${r.items} items from the Phase 1 balance sheet` });
      return masked(c, r);
    }),
  );

  // ── manual entries ─────────────────────────────────────────────────

  type ItemInput = Partial<Item> & { amount?: number | null; as_of?: string | null };
  function readItemInput(body: Json, full: boolean): { ok: true; value: ItemInput } | { ok: false; error: string } {
    const out: ItemInput = {};
    if ("owner" in body || full) {
      if (!isOwner(body.owner)) return { ok: false, error: "owner must be one of the owner tags" };
      out.owner = body.owner;
    }
    if ("name" in body || full) {
      const n = str(body.name, 120);
      if (!n) return { ok: false, error: "name is required" };
      out.name = n;
    }
    if ("kind" in body || full) {
      const k = String(body.kind ?? "other");
      if (!ITEM_KINDS.has(k)) return { ok: false, error: "kind is not one of the item kinds" };
      out.kind = k as Item["kind"];
    }
    if ("side" in body || full) {
      const s = String(body.side ?? (out.kind === "contingent" ? "contingent" : "asset"));
      if (!["asset", "liability", "contingent"].includes(s)) return { ok: false, error: "side must be asset, liability or contingent" };
      out.side = s as Item["side"];
    }
    if ("amount" in body) {
      const a = body.amount === null || body.amount === "" ? null : parseAmount(String(body.amount));
      if (a === null && body.amount !== null && body.amount !== "") return { ok: false, error: "amount must be a number" };
      out.amount = a;
    }
    if ("as_of" in body) {
      const d = dateOrNull(body.as_of);
      if (d === undefined) return { ok: false, error: "as_of must be YYYY-MM-DD" };
      out.as_of = d;
    }
    if ("note" in body) out.note = str(body.note, 2000);
    if ("shared_with" in body) {
      const sw = Array.isArray(body.shared_with) ? body.shared_with.filter(isOwner) : [];
      out.shared_with = sw;
    }
    if ("split" in body) {
      const sp = body.split;
      if (sp === null) out.split = null;
      else if (sp && typeof sp === "object") {
        const clean: Partial<Record<Owner, number>> = {};
        for (const [k, v] of Object.entries(sp as Json)) if (isOwner(k) && typeof v === "number" && v >= 0 && v <= 100) clean[k] = v;
        out.split = clean;
      }
    }
    return { ok: true, value: out };
  }

  let seq = 0;
  const newId = (p: string) => `${p}-${now().getTime().toString(36)}${(seq = (seq + 1) % 100000).toString(36)}`;

  function addItem(ledger: Ledger, v: ItemInput, by: string): Item {
    const at = now().toISOString();
    const item: Item = {
      id: newId("itm"),
      owner: v.owner!,
      owner_label: by,
      shared_with: v.shared_with ?? [],
      split: v.split ?? null,
      kind: v.kind ?? "other",
      side: v.side ?? "asset",
      name: v.name!,
      figure: { amount: v.amount ?? null, as_of: v.as_of ?? at.slice(0, 10), source: "manual", confidence: "medium", entered_by: by, entered_at: at },
      note: v.note ?? null,
      created_at: at,
      updated_at: at,
    };
    ledger.items.push(item);
    return item;
  }

  app.post("/app/vault/items", (c) =>
    guarded(c, async () => {
      const w = await userWrite(c);
      if (w instanceof Response) return w;
      const v = readItemInput(w.body, true);
      if (!v.ok) return c.json({ error: v.error }, 400);
      const store = deps.stores(w.u.userId);
      const item = await store.mutate((l) => addItem(l, v.value, `${w.u.userId} (app)`));
      store.audit({ who: `${w.u.userId} (app)`, action: "item-add", detail: `${item.name} [${item.owner}]`, ref: item.id });
      return masked(c, { ok: true, item }, 201);
    }),
  );

  app.put("/app/vault/items/:id", (c) =>
    guarded(c, async () => {
      const w = await userWrite(c);
      if (w instanceof Response) return w;
      const v = readItemInput(w.body, false);
      if (!v.ok) return c.json({ error: v.error }, 400);
      const store = deps.stores(w.u.userId);
      const r = await store.mutate((l) => {
        const item = l.items.find((i) => i.id === c.req.param("id"));
        if (!item) return null;
        const at = now().toISOString();
        const { amount, as_of, ...rest } = v.value;
        Object.assign(item, rest, { updated_at: at });
        if (amount !== undefined || as_of !== undefined) {
          item.figure = { amount: amount !== undefined ? amount : item.figure.amount, as_of: as_of !== undefined ? as_of : item.figure.as_of, source: "manual", confidence: "medium", entered_by: `${w.u.userId} (app)`, entered_at: at };
        }
        return item;
      });
      if (!r) return c.json({ error: "Not found" }, 404);
      store.audit({ who: `${w.u.userId} (app)`, action: "item-edit", detail: r.name, ref: r.id });
      return masked(c, { ok: true, item: r });
    }),
  );

  app.delete("/app/vault/items/:id", (c) =>
    guarded(c, async () => {
      const w = await userWrite(c);
      if (w instanceof Response) return w;
      const store = deps.stores(w.u.userId);
      const ok = await store.mutate((l) => {
        const i = l.items.findIndex((x) => x.id === c.req.param("id"));
        if (i < 0) return false;
        l.items.splice(i, 1);
        return true;
      });
      if (!ok) return c.json({ error: "Not found" }, 404);
      store.audit({ who: `${w.u.userId} (app)`, action: "item-delete", detail: "", ref: c.req.param("id") });
      return c.json({ ok: true });
    }),
  );

  /** Manual account edits: owner re-tag, a figure read off a statement, rate/minimum, active. Fed figures are the feed's. */
  app.put("/app/vault/accounts/:id", (c) =>
    guarded(c, async () => {
      const w = await userWrite(c);
      if (w instanceof Response) return w;
      const store = deps.stores(w.u.userId);
      const r = await store.mutate((l): { ok: true; account: Account } | { ok: false; status: 400 | 404; error: string } => {
        const a = l.accounts.find((x) => x.id === c.req.param("id"));
        if (!a) return { ok: false, status: 404, error: "Not found" };
        const at = now().toISOString();
        const b = w.body;
        if ("owner" in b) {
          if (!isOwner(b.owner)) return { ok: false, status: 400, error: "owner must be one of the owner tags" };
          a.owner = b.owner;
          a.owner_label = `${b.owner} (re-tagged by ${w.u.userId})`;
        }
        if ("shared_with" in b) a.shared_with = Array.isArray(b.shared_with) ? b.shared_with.filter(isOwner) : [];
        if ("apr_pct" in b) {
          const n = b.apr_pct === null ? null : Number(b.apr_pct);
          if (n !== null && !(Number.isFinite(n) && n >= 0 && n < 100)) return { ok: false, status: 400, error: "apr_pct must be 0–100" };
          a.apr_pct = n;
        }
        if ("min_payment" in b) a.min_payment = b.min_payment === null ? null : parseAmount(String(b.min_payment));
        if ("note" in b) a.note = str(b.note, 2000);
        if ("institution" in b && !a.connection_id) a.institution = str(b.institution, 120) ?? a.institution;
        if ("last4" in b) a.last4 = cleanLast4(str(b.last4, 20));
        if ("active" in b) a.active = b.active !== false;
        if ("amount" in b || "as_of" in b) {
          if (a.connection_id) return { ok: false, status: 400, error: "A fed account's balance comes from the feed" };
          const amount = "amount" in b ? (b.amount === null ? null : parseAmount(String(b.amount))) : a.figure.amount;
          const as_of = "as_of" in b ? dateOrNull(b.as_of) : a.figure.as_of;
          if (as_of === undefined) return { ok: false, status: 400, error: "as_of must be YYYY-MM-DD" };
          a.figure = { amount, as_of, source: "manual", confidence: "medium", entered_by: `${w.u.userId} (app)`, entered_at: at };
        }
        a.updated_at = at;
        return { ok: true, account: a };
      });
      if (!r.ok) return c.json({ error: r.error }, r.status);
      store.audit({ who: `${w.u.userId} (app)`, action: "account-edit", detail: r.account.institution, ref: r.account.id });
      return masked(c, { ok: true, account: r.account });
    }),
  );

  app.post("/app/vault/accounts", (c) =>
    guarded(c, async () => {
      const w = await userWrite(c);
      if (w instanceof Response) return w;
      const b = w.body;
      if (!isOwner(b.owner)) return c.json({ error: "owner must be one of the owner tags" }, 400);
      const institution = str(b.institution, 120);
      if (!institution) return c.json({ error: "institution is required" }, 400);
      const kind = b.kind === "liability" ? "liability" : b.kind === "asset" ? "asset" : null;
      if (!kind) return c.json({ error: "kind must be asset or liability" }, 400);
      const as_of = dateOrNull(b.as_of);
      if (as_of === undefined) return c.json({ error: "as_of must be YYYY-MM-DD" }, 400);
      const at = now().toISOString();
      const account: Account = {
        id: newId("acc"),
        owner: b.owner,
        owner_label: `${b.owner} (entered by ${w.u.userId})`,
        shared_with: Array.isArray(b.shared_with) ? b.shared_with.filter(isOwner) : [],
        split: null,
        kind,
        subtype: str(b.subtype, 40) ?? (kind === "asset" ? "cash" : "loan"),
        institution,
        last4: cleanLast4(str(b.last4, 20)),
        figure: { amount: b.amount === undefined || b.amount === null ? null : parseAmount(String(b.amount)), as_of: as_of ?? at.slice(0, 10), source: "manual", confidence: "medium", entered_by: `${w.u.userId} (app)`, entered_at: at },
        apr_pct: b.apr_pct === undefined || b.apr_pct === null ? null : Number(b.apr_pct),
        apr_text: null,
        min_payment: b.min_payment === undefined || b.min_payment === null ? null : parseAmount(String(b.min_payment)),
        secured_by: str(b.secured_by, 200),
        source_path: null,
        note: str(b.note, 2000),
        connection_id: null,
        provider_account_id: null,
        active: true,
        created_at: at,
        updated_at: at,
        has_secret_number: false,
      };
      const store = deps.stores(w.u.userId);
      await store.mutate((l) => l.accounts.push(account));
      store.audit({ who: `${w.u.userId} (app)`, action: "account-add", detail: `${institution} [${account.owner}]`, ref: account.id });
      return masked(c, { ok: true, account }, 201);
    }),
  );

  app.delete("/app/vault/accounts/:id", (c) =>
    guarded(c, async () => {
      const w = await userWrite(c);
      if (w instanceof Response) return w;
      const store = deps.stores(w.u.userId);
      const r = await store.mutate((l) => {
        const i = l.accounts.findIndex((x) => x.id === c.req.param("id"));
        if (i < 0) return "missing";
        if (l.accounts[i].connection_id) return "fed";
        l.accounts.splice(i, 1);
        l.snapshots = l.snapshots.filter((s) => s.account_id !== c.req.param("id"));
        return "ok";
      });
      if (r === "missing") return c.json({ error: "Not found" }, 404);
      if (r === "fed") return c.json({ error: "Disconnect the feed instead of deleting a fed account" }, 409);
      store.deleteSecret(c.req.param("id"));
      store.audit({ who: `${w.u.userId} (app)`, action: "account-delete", detail: "", ref: c.req.param("id") });
      return c.json({ ok: true });
    }),
  );

  /** Merge a bureau-created row into the account it really is (keeps the target's owner, takes the newer figure). */
  app.post("/app/vault/accounts/:id/merge-into/:target", (c) =>
    guarded(c, async () => {
      const w = await userWrite(c);
      if (w instanceof Response) return w;
      const store = deps.stores(w.u.userId);
      const r = await store.mutate((l) => {
        const src = l.accounts.find((x) => x.id === c.req.param("id"));
        const dst = l.accounts.find((x) => x.id === c.req.param("target"));
        if (!src || !dst || src.id === dst.id) return null;
        if (src.connection_id) return null;
        if (!dst.figure.as_of || (src.figure.as_of && src.figure.as_of >= dst.figure.as_of)) {
          dst.figure = src.figure;
          if (src.min_payment !== null) dst.min_payment = src.min_payment;
        }
        dst.note = [dst.note, src.note].filter(Boolean).join(" · ");
        dst.updated_at = now().toISOString();
        l.accounts = l.accounts.filter((x) => x.id !== src.id);
        for (const s of l.snapshots) if (s.account_id === src.id) s.account_id = dst.id;
        for (const f of l.flags) if (f.account_id === src.id) f.account_id = dst.id;
        return dst;
      });
      if (!r) return c.json({ error: "Not found, or a fed account" }, 404);
      store.audit({ who: `${w.u.userId} (app)`, action: "account-merge", detail: `into ${r.institution}`, ref: r.id });
      return masked(c, { ok: true, account: r });
    }),
  );

  // ── passkey challenges (connect / secret / reveal) ─────────────────

  function purposeOf(body: Json): string | null {
    const p = body.purpose;
    if (p === "connect") return "vault:connect";
    if (p === "unlock") return "vault:unlock";
    if ((p === "reveal" || p === "secret") && typeof body.id === "string" && /^[a-z0-9-]{3,60}$/.test(body.id)) return `vault:${p}:${body.id}`;
    return null;
  }

  app.post("/app/vault/passkey/challenge", (c) =>
    guarded(c, async () => {
      const w = await userWrite(c);
      if (w instanceof Response) return w;
      if (!deps.passkeys) return c.json({ error: "No passkey gate available on this gateway", code: "no-gate" }, 503);
      const purpose = purposeOf(w.body);
      if (!purpose) return c.json({ error: "purpose must be connect, secret (+id) or reveal (+id)" }, 400);
      const r = await deps.passkeys.authOptions(w.u.userId, purpose);
      if ("ok" in r && r.ok === false) return c.json({ error: r.reason, code: r.code }, 409);
      return c.json({ options: r });
    }),
  );

  async function assert(c: Context, userId: string, purpose: string, response: unknown): Promise<{ ok: true; credential_id: string } | Response> {
    if (!deps.passkeys) return c.json({ error: "No passkey gate available on this gateway", code: "no-gate" }, 503);
    const r = await deps.passkeys.verifyAssertion(userId, purpose, response);
    if (!r.ok) return c.json({ error: r.reason, code: r.code }, 403);
    return { ok: true, credential_id: r.evidence.credential_id };
  }

  app.post("/app/vault/lock", (c) =>
    guarded(c, async () => {
      const w = await userWrite(c);
      if (w instanceof Response) return w;
      if (!deps.passkeys || deps.passkeys.count(w.u.userId) === 0)
        return c.json({ error: "Add a passkey in Settings first, so you can unlock it again.", code: "no-passkey" }, 409);
      const marker = lockMarker(w.u.userId);
      mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
      writeFileSync(marker, now().toISOString() + "\n", { mode: 0o600 });
      deps.stores(w.u.userId).audit({ who: `${w.u.userId} (app)`, action: "app-lock", detail: "Vault locked in the app" });
      return c.json({ ok: true, locked: true });
    }),
  );

  app.post("/app/vault/unlock", (c) =>
    guarded(c, async () => {
      const w = await userWrite(c);
      if (w instanceof Response) return w;
      const a = await assert(c, w.u.userId, "vault:unlock", w.body.webauthn);
      if (a instanceof Response) return a;
      rmSync(lockMarker(w.u.userId), { force: true });
      deps.stores(w.u.userId).audit({ who: `${w.u.userId} (app, fingerprint)`, action: "app-unlock", detail: "Vault unlocked in the app" });
      return c.json({ ok: true, locked: false });
    }),
  );

  // ── connect / disconnect / refresh ─────────────────────────────────

  app.post("/app/vault/connect/start", (c) =>
    guarded(c, async () => {
      const w = await userWrite(c);
      if (w instanceof Response) return w;
      if (!isOwner(w.body.owner)) return c.json({ error: "Pick the owner this account belongs to" }, 400);
      const a = await assert(c, w.u.userId, "vault:connect", w.body.webauthn);
      if (a instanceof Response) return a;
      if (!deps.provider.configured()) return c.json({ error: `${deps.provider.name} is not configured on this gateway`, code: "not-configured" }, 503);
      const start = await deps.provider.beginLink({ user_id: w.u.userId, owner: w.body.owner, redirect_uri: typeof w.body.redirect_uri === "string" ? w.body.redirect_uri : undefined });
      const session = randomBytes(16).toString("base64url");
      connectSessions.set(session, { userId: w.u.userId, owner: w.body.owner, expires: now().getTime() + 10 * 60_000, credential_id: a.credential_id });
      deps.stores(w.u.userId).audit({ who: `${w.u.userId} (app, fingerprint)`, action: "connect-start", detail: `${deps.provider.name} for owner ${w.body.owner}` });
      return c.json({ ok: true, session, mode: start.mode, url: start.url ?? null, link_token: start.link_token ?? null, instructions: start.instructions, scopes: deps.provider.scopes() });
    }),
  );

  app.post("/app/vault/connect/complete", (c) =>
    guarded(c, async () => {
      const w = await userWrite(c);
      if (w instanceof Response) return w;
      const s = typeof w.body.session === "string" ? connectSessions.get(w.body.session) : undefined;
      if (!s || s.userId !== w.u.userId || s.expires < now().getTime()) return c.json({ error: "No live connect session — start again with your fingerprint", code: "no-session" }, 409);
      connectSessions.delete(String(w.body.session));
      if (typeof w.body.payload !== "string" || !w.body.payload) return c.json({ error: "payload required" }, 400);
      const link = await deps.provider.completeLink({ user_id: w.u.userId, payload: w.body.payload });
      const store = deps.stores(w.u.userId);
      const at = now().toISOString();
      const connId = newId("con");
      store.putToken(connId, link.access_token); // encrypted the moment it exists; never returned
      const created = await store.mutate((l) => {
        l.connections.push({
          id: connId,
          provider: deps.provider.id,
          institution: redact(link.institution).slice(0, 120),
          owner: s.owner,
          scopes: deps.provider.scopes(),
          connected_at: at,
          connected_how: `fingerprint:${s.credential_id}`,
          last_refresh_at: at,
          last_refresh_ok: true,
          last_error: null,
          provider_item_id: link.provider_item_id,
          status: "active",
        });
        const ids: string[] = [];
        // A reconnect re-attaches the records a disconnected connection left behind (same provider
        // account, or one unambiguous same-owner bank + account name + kind + last four)
        // instead of adding duplicates; their owner and notes stay as the owner left them.
        const dead = new Set(l.connections.filter((x) => x.status === "disconnected" && x.provider === deps.provider.id).map((x) => x.id));
        const orphans = l.accounts.filter((x) => x.connection_id && dead.has(x.connection_id));
        // Pass 1 — the same provider account (the same physical account; the record keeps the owner it
        // has, which may differ from the connection's if the owner re-tagged it). Resolved for every incoming
        // account before any fallback runs, so a fallback can never take a record an exact match needs.
        const priorOf = new Map<(typeof link.accounts)[number], Account>();
        for (const pa of link.accounts) {
          const hit = orphans.find((x) => x.provider_account_id === pa.provider_account_id);
          if (hit) { priorOf.set(pa, hit); orphans.splice(orphans.indexOf(hit), 1); }
        }
        // Pass 2 — the fallback, only when unambiguous: exactly one remaining orphan of the owner this
        // connection is for, with the same bank and account name, kind and last four. Anything else
        // gets a new account; another owner's record is never taken by the fallback.
        for (const pa of link.accounts) {
          if (priorOf.has(pa)) continue;
          const last4 = cleanLast4(pa.last4);
          if (last4 === null) continue;
          const label = redact(`${link.institution} — ${pa.name}`).slice(0, 120);
          const fallback = orphans.filter((x) => x.owner === s.owner && x.kind === pa.kind && x.last4 === last4 && x.institution === label);
          if (fallback.length === 1) { priorOf.set(pa, fallback[0]); orphans.splice(orphans.indexOf(fallback[0]), 1); }
        }
        for (const pa of link.accounts) {
          const prior = priorOf.get(pa);
          if (prior) {
            prior.figure = { amount: pa.balance, as_of: pa.as_of, source: "feed", confidence: "high", entered_by: `feed:${deps.provider.id}`, entered_at: at };
            prior.apr_pct = pa.apr_pct ?? prior.apr_pct;
            prior.min_payment = pa.min_payment ?? prior.min_payment;
            prior.connection_id = connId;
            prior.provider_account_id = pa.provider_account_id;
            prior.active = true;
            prior.updated_at = at;
            ids.push(prior.id);
            continue;
          }
          const acc: Account = {
            id: newId("acc"),
            owner: s.owner,
            owner_label: `${s.owner} (chosen at connection)`,
            shared_with: [],
            split: null,
            kind: pa.kind,
            subtype: pa.subtype,
            institution: redact(`${link.institution} — ${pa.name}`).slice(0, 120),
            last4: cleanLast4(pa.last4),
            figure: { amount: pa.balance, as_of: pa.as_of, source: "feed", confidence: "high", entered_by: `feed:${deps.provider.id}`, entered_at: at },
            apr_pct: pa.apr_pct,
            apr_text: null,
            min_payment: pa.min_payment,
            secured_by: null,
            source_path: null,
            note: pa.next_due ? `Next payment due ${pa.next_due}` : null,
            connection_id: connId,
            provider_account_id: pa.provider_account_id,
            active: true,
            created_at: at,
            updated_at: at,
            has_secret_number: false,
          };
          l.accounts.push(acc);
          ids.push(acc.id);
        }
        snapshotAll(l, now(), new Set(ids));
        return ids.length;
      });
      store.audit({ who: `${w.u.userId} (app, fingerprint)`, action: "connect", detail: `${link.institution}: ${created} accounts under ${s.owner}`, ref: connId });
      return masked(c, { ok: true, connection_id: connId, institution: link.institution, accounts: created });
    }),
  );

  app.post("/app/vault/connections/:id/disconnect", (c) =>
    guarded(c, async () => {
      const w = await userWrite(c);
      if (w instanceof Response) return w;
      const store = deps.stores(w.u.userId);
      const id = c.req.param("id");
      const token = store.getToken(id);
      let revokeError: string | null = null;
      if (token) {
        try {
          await deps.provider.revoke(token);
        } catch (err) {
          revokeError = (err as Error).message;
        }
      }
      const deleted = store.deleteToken(id);
      const r = await store.mutate((l) => {
        const conn = l.connections.find((x) => x.id === id);
        if (!conn) return null;
        conn.status = "disconnected";
        conn.last_error = revokeError;
        for (const a of l.accounts) if (a.connection_id === id) {
          a.active = false;
          a.note = [a.note, `Disconnected ${now().toISOString().slice(0, 10)}; last fed figure kept`].filter(Boolean).join(" · ");
        }
        return conn;
      });
      if (!r && !deleted) return c.json({ error: "Not found" }, 404);
      store.audit({ who: `${w.u.userId} (app)`, action: "disconnect", detail: `${r?.institution ?? id}; token deleted ${deleted ? "yes" : "no"}${revokeError ? "; provider revoke failed (local token gone regardless)" : ""}`, ref: id });
      return c.json({ ok: true, token_deleted: deleted, provider_revoked: !revokeError });
    }),
  );

  async function refreshAll(userId: string, by: string): Promise<{ refreshed: number; failed: number; flags: Flag[]; needs_relink: string[] }> {
    const store = deps.stores(userId);
    const ledger = store.read();
    const refreshed = new Set<string>();
    const missing = new Set<string>();
    const results = new Map<string, { ok: true; accounts: Awaited<ReturnType<VaultProvider["refresh"]>>["accounts"]; institution: string | null } | { ok: false; code: string; message: string }>();
    for (const conn of ledger.connections.filter((x) => x.status !== "disconnected")) {
      const token = store.getToken(conn.id);
      if (!token) {
        results.set(conn.id, { ok: false, code: "no-token", message: "token file missing" });
        continue;
      }
      try {
        results.set(conn.id, { ok: true, ...(await deps.provider.refresh(token)) });
      } catch (err) {
        const e = err as ProviderError;
        results.set(conn.id, { ok: false, code: e.code ?? "refresh-failed", message: e.message });
      }
    }
    const t = now();
    const out = await store.mutate((l) => {
      let okCount = 0;
      let failCount = 0;
      const needs_relink: string[] = [];
      const raised: Flag[] = [];
      for (const conn of l.connections) {
        const r = results.get(conn.id);
        if (!r) continue;
        conn.last_refresh_at = t.toISOString();
        if (!r.ok) {
          failCount++;
          conn.last_refresh_ok = false;
          conn.last_error = redact(r.message).slice(0, 200);
          if (r.code === "needs-relink") {
            conn.status = "needs_relink";
            needs_relink.push(conn.id);
            const f = raiseFlag(l, t, { kind: "needs_relink", account_id: null, owner: conn.owner, key: `relink:${conn.id}`, title: `${conn.institution} needs you to sign in again`, detail: "The institution dropped the connection. Reconnect in the Vault tab (fingerprint)." });
            if (f) raised.push(f);
          } else {
            const f = raiseFlag(l, t, { kind: "refresh_failed", account_id: null, owner: conn.owner, key: `refresh-failed:${conn.id}`, title: `${conn.institution} did not refresh`, detail: redact(r.message).slice(0, 200) });
            if (f) raised.push(f);
          }
          continue;
        }
        okCount++;
        conn.last_refresh_ok = true;
        conn.last_error = null;
        conn.status = "active";
        const seen = new Set<string>();
        for (const pa of r.accounts) {
          let a = l.accounts.find((x) => x.connection_id === conn.id && x.provider_account_id === pa.provider_account_id);
          if (!a) {
            a = {
              id: newId("acc"),
              owner: conn.owner,
              owner_label: `${conn.owner} (chosen at connection)`,
              shared_with: [],
              split: null,
              kind: pa.kind,
              subtype: pa.subtype,
              institution: redact(`${conn.institution} — ${pa.name}`).slice(0, 120),
              last4: cleanLast4(pa.last4),
              figure: { amount: null, as_of: null, source: "feed", confidence: "high", entered_by: `feed:${deps.provider.id}`, entered_at: t.toISOString() },
              apr_pct: null,
              apr_text: null,
              min_payment: null,
              secured_by: null,
              source_path: null,
              note: null,
              connection_id: conn.id,
              provider_account_id: pa.provider_account_id,
              active: true,
              created_at: t.toISOString(),
              updated_at: t.toISOString(),
              has_secret_number: false,
            };
            l.accounts.push(a);
          }
          seen.add(a.id);
          a.figure = { amount: pa.balance, as_of: pa.as_of, source: "feed", confidence: "high", entered_by: `feed:${deps.provider.id}`, entered_at: t.toISOString() };
          if (pa.apr_pct !== null) a.apr_pct = pa.apr_pct;
          if (pa.min_payment !== null) a.min_payment = pa.min_payment;
          a.active = true;
          a.updated_at = t.toISOString();
          refreshed.add(a.id);
        }
        for (const a of l.accounts) if (a.connection_id === conn.id && !seen.has(a.id)) missing.add(a.id);
      }
      const flags = [...raised, ...checkDrift({ ledger: l, now: t, refreshed, missing })];
      snapshotAll(l, t, refreshed);
      return { refreshed: okCount, failed: failCount, flags, needs_relink };
    });
    store.audit({ who: by, action: "refresh", detail: `${out.refreshed} connections refreshed, ${out.failed} failed, ${out.flags.length} new flags` });
    if (deps.postNeedsYou && out.flags.length) {
      const openFlags = store.read().flags;
      for (const f of out.flags) {
        try {
          const ref = await deps.postNeedsYou(userId, f);
          if (ref) {
            const open = openFlags.find((x) => x.id === f.id);
            if (open) open.posted_ref = ref;
          }
        } catch (err) {
          console.warn(`[vault] could not post a flag to the review path: ${(err as Error).message}`);
        }
      }
      await store.mutate((l) => {
        for (const f of l.flags) {
          const posted = openFlags.find((x) => x.id === f.id)?.posted_ref;
          if (posted) f.posted_ref = posted;
        }
      });
    }
    return out;
  }

  app.post("/app/vault/refresh", (c) =>
    guarded(c, async () => {
      const w = await userWrite(c);
      if (w instanceof Response) return w;
      return masked(c, { ok: true, ...(await refreshAll(w.u.userId, `${w.u.userId} (app)`)) });
    }),
  );

  app.post("/app/vault/flags/:id/ack", (c) =>
    guarded(c, async () => {
      const w = await userWrite(c);
      if (w instanceof Response) return w;
      const store = deps.stores(w.u.userId);
      const ok = await store.mutate((l) => {
        const f = l.flags.find((x) => x.id === c.req.param("id"));
        if (!f) return false;
        f.acked_at = now().toISOString();
        return true;
      });
      if (!ok) return c.json({ error: "Not found" }, 404);
      return c.json({ ok: true });
    }),
  );

  // ── full account number: store and reveal, each behind a fresh fingerprint ──

  app.post("/app/vault/accounts/:id/secret", (c) =>
    guarded(c, async () => {
      const w = await userWrite(c);
      if (w instanceof Response) return w;
      const id = c.req.param("id");
      const a = await assert(c, w.u.userId, `vault:secret:${id}`, w.body.webauthn);
      if (a instanceof Response) return a;
      const value = typeof w.body.value === "string" ? w.body.value.replace(/\s/g, "") : "";
      if (!/^[0-9A-Za-z-]{4,34}$/.test(value)) return c.json({ error: "value must be 4–34 letters, digits or dashes" }, 400);
      const store = deps.stores(w.u.userId);
      const ok = await store.mutate((l) => {
        const acc = l.accounts.find((x) => x.id === id);
        if (!acc) return false;
        acc.has_secret_number = true;
        acc.last4 = cleanLast4(value) ?? acc.last4;
        acc.updated_at = now().toISOString();
        return true;
      });
      if (!ok) return c.json({ error: "Not found" }, 404);
      store.putSecret(id, value);
      store.audit({ who: `${w.u.userId} (app, fingerprint)`, action: "secret-store", detail: "full account number stored (encrypted)", ref: id });
      return c.json({ ok: true });
    }),
  );

  app.post("/app/vault/accounts/:id/reveal", (c) =>
    guarded(c, async () => {
      const w = await userWrite(c);
      if (w instanceof Response) return w;
      const id = c.req.param("id");
      const a = await assert(c, w.u.userId, `vault:reveal:${id}`, w.body.webauthn);
      if (a instanceof Response) return a;
      const store = deps.stores(w.u.userId);
      const value = store.getSecret(id);
      if (value === null) return c.json({ error: "No full number stored for this account" }, 404);
      store.audit({ who: `${w.u.userId} (app, fingerprint)`, action: "secret-reveal", detail: "full account number shown once", ref: id });
      // The ONE response that carries a number shape, by design: it bypasses `masked` and is never cached or logged.
      return c.body(JSON.stringify({ ok: true, value, shown_at: now().toISOString() }), 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    }),
  );

  app.delete("/app/vault/accounts/:id/secret", (c) =>
    guarded(c, async () => {
      const w = await userWrite(c);
      if (w instanceof Response) return w;
      const id = c.req.param("id");
      const store = deps.stores(w.u.userId);
      const deleted = store.deleteSecret(id);
      await store.mutate((l) => {
        const acc = l.accounts.find((x) => x.id === id);
        if (acc) acc.has_secret_number = false;
      });
      store.audit({ who: `${w.u.userId} (app)`, action: "secret-delete", detail: "", ref: id });
      return c.json({ ok: true, deleted });
    }),
  );

  // ── documents ──────────────────────────────────────────────────────

  app.post("/app/vault/docs", (c) =>
    guarded(c, async () => {
      const w = await userWrite(c, true);
      if (w instanceof Response) return w;
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        return c.json({ error: "multipart form required" }, 415);
      }
      const file = form.get("file");
      if (!(file instanceof File)) return c.json({ error: "file is required" }, 400);
      if (file.size > MAX_DOC_BYTES) return c.json({ error: "file too large" }, 413);
      const kindRaw = String(form.get("kind") ?? "statement");
      const kind: DocInput["kind"] = kindRaw === "credit-report" ? "credit-report" : kindRaw === "other" ? "other" : "statement";
      const ownerRaw = String(form.get("owner") ?? "owner");
      if (!isOwner(ownerRaw)) return c.json({ error: "owner must be one of the owner tags" }, 400);
      const bytes = Buffer.from(await file.arrayBuffer());
      const input: DocInput = { filename: file.name, mime: file.type || "application/octet-stream", bytes, kind, owner: ownerRaw, uploaded_by: `${w.u.userId} (app)`, institution: str(form.get("institution"), 80), as_of: dateOrNull(form.get("as_of") || null) ?? null };
      const store = deps.stores(w.u.userId);
      const doc = describeDoc(input, now());
      store.putDoc(doc.id, bytes);
      let outcome: { parser: string; summary: string } | null = null;
      let parseError: string | null = null;
      if (kind === "credit-report") {
        try {
          const text = await textOf(input, deps.pdfToText);
          if (text) {
            const bureau = str(form.get("bureau"), 20) ?? bureauFromName(file.name);
            outcome = await store.mutate((l) => {
              const o = applyCreditReportText(l, text, bureau, now());
              snapshotAll(l, now(), new Set([...o.applied!.updated, ...o.applied!.created]));
              return { parser: o.parser, summary: o.summary };
            });
          }
        } catch (err) {
          parseError = redact((err as Error).message).slice(0, 200);
        }
      }
      await store.mutate((l) => {
        l.documents.push({ ...doc, parsed: outcome ? { ...outcome, at: now().toISOString() } : null });
      });
      store.audit({ who: `${w.u.userId} (app)`, action: "doc-upload", detail: `${kind} ${doc.filename}${outcome ? ` — ${outcome.summary}` : ""}${parseError ? ` — parse failed: ${parseError}` : ""}`, ref: doc.id });
      return masked(c, { ok: true, document: { ...doc, parsed: outcome }, parse_error: parseError }, 201);
    }),
  );

  app.delete("/app/vault/docs/:id", (c) =>
    guarded(c, async () => {
      const w = await userWrite(c);
      if (w instanceof Response) return w;
      const store = deps.stores(w.u.userId);
      const deleted = store.deleteDoc(c.req.param("id"));
      await store.mutate((l) => {
        l.documents = l.documents.filter((d) => d.id !== c.req.param("id"));
      });
      store.audit({ who: `${w.u.userId} (app)`, action: "doc-delete", detail: "", ref: c.req.param("id") });
      return c.json({ ok: true, deleted });
    }),
  );

  // ── Michael (service token) ────────────────────────────────────────

  app.get("/api/vault/picture", (c) =>
    guarded(c, () => {
      const denied = service(c);
      if (denied) return denied;
      return masked(c, derivePicture(deps.stores(serviceUser()).read(), now()));
    }),
  );

  app.get("/api/vault/summary", (c) =>
    guarded(c, () => {
      const denied = service(c);
      if (denied) return denied;
      return masked(c, { lines: pictureSummaryLines(derivePicture(deps.stores(serviceUser()).read(), now())) });
    }),
  );

  app.get("/api/vault/plan", (c) =>
    guarded(c, () => {
      const denied = service(c);
      if (denied) return denied;
      return masked(c, derivePlanInput(deps.stores(serviceUser()).read(), now()));
    }),
  );

  app.get("/api/vault/flags", (c) =>
    guarded(c, () => {
      const denied = service(c);
      if (denied) return denied;
      return masked(c, { flags: deps.stores(serviceUser()).read().flags.filter((f) => !f.acked_at) });
    }),
  );

  app.post("/api/vault/refresh", (c) =>
    guarded(c, async () => {
      const denied = service(c);
      if (denied) return denied;
      return masked(c, { ok: true, ...(await refreshAll(serviceUser(), "michael (service)")) });
    }),
  );

  /** A figure the owner dictated in chat. Recorded as "the owner said, via Michael, <date>". */
  app.post("/api/vault/say", (c) =>
    guarded(c, async () => {
      const denied = service(c);
      if (denied) return denied;
      const b = await jsonBody(c);
      if (!b) return c.json({ error: "JSON object body required" }, 400);
      const userId = serviceUser();
      const by = `the owner said, via Michael, ${now().toISOString().slice(0, 10)}`;
      const store = deps.stores(userId);
      const amount = b.amount === undefined || b.amount === null ? null : parseAmount(String(b.amount));
      if (amount === null) return c.json({ error: "amount is required" }, 400);
      const as_of = dateOrNull(b.as_of ?? now().toISOString().slice(0, 10));
      if (as_of === undefined || as_of === null) return c.json({ error: "as_of must be YYYY-MM-DD" }, 400);
      const note = str(b.note, 2000);
      if (typeof b.account === "string") {
        const r = await store.mutate((l) => {
          const a = l.accounts.find((x) => x.id === b.account);
          if (!a) return null;
          if (a.connection_id) return "fed";
          a.figure = { amount, as_of, source: "manual", confidence: "medium", entered_by: by, entered_at: now().toISOString() };
          if (note) a.note = [a.note, note].filter(Boolean).join(" · ");
          a.updated_at = now().toISOString();
          return a;
        });
        if (r === null) return c.json({ error: "No such account" }, 404);
        if (r === "fed") return c.json({ error: "A fed account's balance comes from the feed" }, 409);
        store.audit({ who: by, action: "say-account", detail: r.institution, ref: r.id });
        return masked(c, { ok: true, account: r });
      }
      const v = readItemInput({ ...b, side: b.side ?? (b.kind === "contingent" ? "contingent" : "asset"), kind: b.kind ?? "other" }, true);
      if (!v.ok) return c.json({ error: v.error }, 400);
      const item = await store.mutate((l) => addItem(l, { ...v.value, amount, as_of }, by));
      store.audit({ who: by, action: "say-item", detail: `${item.name} [${item.owner}]`, ref: item.id });
      return masked(c, { ok: true, item }, 201);
    }),
  );
}
