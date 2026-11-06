/**
 * Gmail in the app: every connected Gmail account in one
 * place — folders, the list, the reader, search across all accounts / this account / this folder —
 * and "Connect another account" through Google's own sign-in (OAuth 2.0 with PKCE, in the browser).
 *
 * Real, over the Gmail API:
 *   - read (gmail.readonly) and drafts (gmail.compose: "Save draft" puts the draft in that Gmail
 *     account's Drafts). Nothing is SENT from the app — sending is a
 *     separate feature; the composer says so.
 *   - refresh tokens are encrypted at rest with the vault cipher (AES-256-GCM, kind "token"); access
 *     tokens live in memory only; no token, mail body or address is ever logged.
 * Rails: owner only; every response no-store; the OAuth state is single-use, 10 minutes, bound to the
 * user who started it, with a PKCE verifier; a Google error or a missing client says so plainly.
 *
 * Configuration (names only; values are the owner's to set): GOOGLE_OAUTH_CLIENT_ID,
 * GOOGLE_OAUTH_CLIENT_SECRET, optional GMAIL_REDIRECT_URL (else this origin + /app/gmail/oauth/callback).
 * GOOGLE_AUTH_URL / GOOGLE_TOKEN_URL / GOOGLE_USERINFO_URL / GMAIL_API_BASE exist for the isolated
 * preview's Google stand-in (redesign/preview/stand-in-google.mjs) and tests.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { VaultCipher, VaultLocked, type Envelope } from "../vault/crypto.js";

export interface GmailUser {
  userId: string;
  admin?: boolean;
}

interface StoredAccount {
  id: string;
  email: string;
  name: string;
  color: string;
  added: string;
  token: Envelope;
}
export interface PublicAccount {
  id: string;
  email: string;
  name: string;
  color: string;
}

export type Folder = "inbox" | "starred" | "sent" | "drafts" | "archive" | "all" | "spam" | "trash";
export const FOLDERS: Folder[] = ["inbox", "starred", "sent", "drafts", "archive", "all", "spam", "trash"];
const FOLDER_Q: Record<Folder, string> = {
  inbox: "in:inbox",
  starred: "is:starred",
  sent: "in:sent",
  drafts: "in:draft",
  archive: "-in:inbox -in:sent -in:draft -in:spam -in:trash",
  all: "",
  spam: "in:spam",
  trash: "in:trash",
};
const FOLDER_LABEL: Partial<Record<Folder, string>> = { inbox: "INBOX", starred: "STARRED", sent: "SENT", drafts: "DRAFT", spam: "SPAM", trash: "TRASH" };
const COLORS = ["#d4b780", "#88cbae", "#9bbcf2", "#b9b5ed", "#e7a38f", "#c7dfd0"];
const SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"];

export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  redirectUrl: string | null;
  authUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  apiBase: string;
}
export function gmailConfig(env: NodeJS.ProcessEnv = process.env): GmailConfig {
  return {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? "",
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? "",
    redirectUrl: env.GMAIL_REDIRECT_URL?.trim() || null,
    authUrl: env.GOOGLE_AUTH_URL?.trim() || "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: env.GOOGLE_TOKEN_URL?.trim() || "https://oauth2.googleapis.com/token",
    userinfoUrl: env.GOOGLE_USERINFO_URL?.trim() || "https://openidconnect.googleapis.com/v1/userinfo",
    apiBase: (env.GMAIL_API_BASE?.trim() || "https://gmail.googleapis.com/gmail/v1").replace(/\/$/, ""),
  };
}

const b64url = (b: Buffer) => b.toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url");

/** The account list on disk (0600 in a 0700 dir); the refresh token inside each is a vault envelope. */
class AccountStore {
  constructor(private readonly dir: string) {}
  private file(userId: string) {
    return join(this.dir, `${userId.replace(/[^a-z0-9_-]/gi, "_")}.json`);
  }
  list(userId: string): StoredAccount[] {
    try {
      return JSON.parse(readFileSync(this.file(userId), "utf8")) as StoredAccount[];
    } catch {
      return [];
    }
  }
  save(userId: string, accounts: StoredAccount[]): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const f = this.file(userId);
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify(accounts, null, 2), { mode: 0o600 });
    renameSync(tmp, f);
    chmodSync(f, 0o600);
  }
}

export class GmailError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface ThreadRow {
  account: string;
  id: string;
  from: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  at: string;
  unread: boolean;
  starred: boolean;
  count: number;
  attachments: boolean;
  label: string | null;
}
export interface Letter {
  id: string;
  from: string;
  fromEmail: string;
  to: string;
  cc: string;
  at: string;
  body: string;
  attachments: Array<{ name: string; size: number }>;
}

type GPart = { mimeType?: string; filename?: string; body?: { data?: string; size?: number; attachmentId?: string }; parts?: GPart[]; headers?: Array<{ name: string; value: string }> };
type GMessage = { id: string; threadId: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: GPart };

const header = (m: GMessage, name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
function parseFrom(v: string): { name: string; email: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(v);
  return m ? { name: m[1].trim() || m[2], email: m[2] } : { name: v.trim(), email: v.trim() };
}
function walk(p: GPart | undefined, out: GPart[] = []): GPart[] {
  if (!p) return out;
  out.push(p);
  for (const c of p.parts ?? []) walk(c, out);
  return out;
}
/** Plain text of a message: text/plain if there is one, else the HTML with tags stripped (never rendered as HTML). */
export function bodyText(m: GMessage): string {
  const parts = walk(m.payload);
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plain) return fromB64url(plain.body!.data!).toString("utf8");
  const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
  if (html)
    return fromB64url(html.body!.data!)
      .toString("utf8")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  return m.snippet ?? "";
}
const attachmentsOf = (m: GMessage) => walk(m.payload).filter((p) => p.filename && p.body?.attachmentId).map((p) => ({ name: p.filename!, size: p.body?.size ?? 0 }));

export class GmailService {
  private readonly store: AccountStore;
  private readonly pending = new Map<string, { userId: string; verifier: string; redirect: string; at: number }>();
  private readonly access = new Map<string, { token: string; until: number }>();
  private readonly refreshing = new Map<string, Promise<string>>();
  constructor(
    stateDir: string,
    private readonly cfg: GmailConfig = gmailConfig(),
    private readonly cipher: VaultCipher = new VaultCipher(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.store = new AccountStore(join(stateDir, "gmail"));
  }

  /** The isolated preview's Google stand-in (loopback), so the page can say the mail is sample mail. */
  standIn(): boolean {
    return /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(this.cfg.apiBase);
  }
  configured(): boolean {
    return !!(this.cfg.clientId && this.cfg.clientSecret);
  }
  accounts(userId: string): PublicAccount[] {
    return this.store.list(userId).map(({ id, email, name, color }) => ({ id, email, name, color }));
  }

  /** The Google sign-in URL for "Continue with Google": single-use state + PKCE, bound to this user. */
  start(userId: string, origin: string): string {
    if (!this.configured()) throw new GmailError(503, "Gmail isn't set up on this server yet — it needs the owner's Google sign-in client (GOOGLE_OAUTH_CLIENT_ID / _SECRET).");
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.at > 10 * 60_000) this.pending.delete(k);
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    const redirect = this.cfg.redirectUrl ?? `${origin}/app/gmail/oauth/callback`;
    this.pending.set(state, { userId, verifier, redirect, at: now });
    const u = new URL(this.cfg.authUrl);
    u.search = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: redirect,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: "true",
      state,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
    }).toString();
    return u.toString();
  }

  /** Google sent him back: exchange the code, learn which account it is, keep the refresh token encrypted. */
  async finish(userId: string, state: string, code: string): Promise<PublicAccount> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.userId !== userId || Date.now() - p.at > 10 * 60_000) throw new GmailError(400, "That sign-in expired or didn't start here — connect again.");
    const tok = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: p.redirect, code_verifier: p.verifier });
    if (!tok.refresh_token) throw new GmailError(502, "Google didn't return lasting access — remove AHI in your Google account's third-party access, then connect again.");
    const who = await this.json(this.cfg.userinfoUrl, tok.access_token);
    const email = String(who.email ?? "").toLowerCase();
    if (!email) throw new GmailError(502, "Google didn't say which account this is.");
    const id = createHash("sha256").update(`${userId}:${email}`).digest("hex").slice(0, 12);
    const list = this.store.list(userId).filter((a) => a.id !== id);
    const acct: StoredAccount = { id, email, name: String(who.name ?? email.split("@")[0]), color: COLORS[list.length % COLORS.length], added: new Date().toISOString(), token: this.seal(tok.refresh_token) };
    this.store.save(userId, [...list, acct]);
    this.remember(id, tok);
    return { id, email, name: acct.name, color: acct.color };
  }

  private seal(refresh: string): Envelope {
    try {
      return this.cipher.encrypt("token", refresh);
    } catch (e) {
      throw e instanceof VaultLocked ? new GmailError(503, "The vault key isn't on this server, so the Gmail sign-in can't be kept safely.") : e;
    }
  }

  disconnect(userId: string, id: string): boolean {
    const list = this.store.list(userId);
    if (!list.some((a) => a.id === id)) return false;
    this.store.save(userId, list.filter((a) => a.id !== id));
    this.access.delete(id);
    return true;
  }

  private async tokenRequest(body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
    const r = await this.fetchImpl(this.cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...body, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }).toString(),
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok || typeof j.access_token !== "string") throw new GmailError(502, `Google refused the sign-in (${typeof j.error === "string" ? j.error : r.status}).`);
    return j as { access_token: string; refresh_token?: string; expires_in?: number };
  }
  private remember(id: string, tok: { access_token: string; expires_in?: number }): void {
    this.access.set(id, { token: tok.access_token, until: Date.now() + Math.max(60, Number(tok.expires_in ?? 3600) - 60) * 1000 });
  }
  /** Parallel callers (the six folder counts, the bell, the list) share one refresh per account. */
  private async token(userId: string, id: string): Promise<string> {
    const hit = this.access.get(id);
    if (hit && hit.until > Date.now()) return hit.token;
    const key = `${userId}\0${id}`;
    const running = this.refreshing.get(key);
    if (running) return running;
    const p = this.refreshToken(userId, id).finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, p);
    return p;
  }
  private async refreshToken(userId: string, id: string): Promise<string> {
    const acct = this.store.list(userId).find((a) => a.id === id);
    if (!acct) throw new GmailError(404, "That account isn't connected.");
    let refresh: string;
    try {
      refresh = this.cipher.decrypt("token", acct.token).toString("utf8");
    } catch (e) {
      throw e instanceof VaultLocked ? new GmailError(503, "The vault key isn't available, so the Gmail sign-in can't be read.") : e;
    }
    const tok = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: refresh });
    this.remember(id, tok);
    return tok.access_token;
  }
  private async json(url: string, bearer: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const r = await this.fetchImpl(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${bearer}` } });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new GmailError(r.status === 401 || r.status === 403 || r.status >= 500 ? 502 : r.status, r.status === 401 ? "Google signed this account out — connect it again." : `Gmail answered ${r.status}.`);
    return j;
  }
  private api = async (userId: string, account: string, path: string, init?: RequestInit) => this.json(`${this.cfg.apiBase}/users/me/${path}`, await this.token(userId, account), init);

  /** Unread / total per folder for one account (the folder column's counts). */
  async counts(userId: string, account: string): Promise<Partial<Record<Folder, number>>> {
    const out: Partial<Record<Folder, number>> = {};
    await Promise.all(
      (Object.entries(FOLDER_LABEL) as Array<[Folder, string]>).map(async ([f, label]) => {
        const l = await this.api(userId, account, `labels/${label}`).catch(() => null);
        if (l) out[f] = Number((f === "inbox" || f === "spam" ? l.threadsUnread : l.threadsTotal) ?? 0);
      }),
    );
    return out;
  }

  /** Threads for one folder (or all mail), filtered by a Gmail search; newest first; one page. */
  /** Newest first across the accounts; `limit` (1–25, default 25) is per account, so a short list costs fewer detail reads. */
  async threads(userId: string, accounts: string[], folder: Folder, q: string, unread: boolean, limit = 25): Promise<ThreadRow[]> {
    const query = [FOLDER_Q[folder], unread ? "is:unread" : "", q.trim()].filter(Boolean).join(" ");
    const per = await Promise.all(
      accounts.map(async (account) => {
        const list = await this.api(userId, account, `threads?maxResults=${limit}${folder === "spam" || folder === "trash" ? "&includeSpamTrash=true" : ""}&q=${encodeURIComponent(query)}`);
        const ids = ((list.threads as Array<{ id: string }> | undefined) ?? []).map((t) => t.id);
        const rows = await Promise.all(ids.map((id) => this.api(userId, account, `threads/${id}?format=full&fields=${encodeURIComponent("id,messages(id,labelIds,snippet,internalDate,payload(headers,filename,body/attachmentId,parts(filename,mimeType,body/attachmentId,body/size,parts(filename,mimeType,body/attachmentId,body/size))))")}`).catch(() => null)));
        return rows.filter(Boolean).map((t) => {
          const msgs = ((t!.messages as GMessage[] | undefined) ?? []).filter(Boolean);
          const last = msgs[msgs.length - 1];
          const from = parseFrom(header(last, "From"));
          const labels = new Set(msgs.flatMap((m) => m.labelIds ?? []));
          const user = [...labels].find((l) => l.startsWith("Label_") || /^CATEGORY_(PERSONAL|SOCIAL|PROMOTIONS|UPDATES|FORUMS)$/.test(l)) ?? null;
          return {
            account,
            id: String(t!.id),
            from: last.labelIds?.includes("SENT") ? "You" : from.name,
            fromEmail: from.email,
            subject: header(msgs[0], "Subject") || "(no subject)",
            snippet: (last.snippet ?? "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
            at: new Date(Number(last.internalDate ?? Date.now())).toISOString(),
            unread: labels.has("UNREAD"),
            starred: labels.has("STARRED"),
            count: msgs.length,
            attachments: msgs.some((m) => attachmentsOf(m).length > 0),
            label: user ? user.replace(/^CATEGORY_/, "").replace(/^Label_\d+$/, "Label").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : null,
          } satisfies ThreadRow;
        });
      }),
    );
    return per.flat().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }

  async thread(userId: string, account: string, id: string): Promise<{ account: string; id: string; subject: string; letters: Letter[] }> {
    if (!/^[0-9a-zA-Z_-]{6,64}$/.test(id)) throw new GmailError(404, "Not found");
    const t = await this.api(userId, account, `threads/${id}?format=full`);
    const msgs = (t.messages as GMessage[] | undefined) ?? [];
    return {
      account,
      id,
      subject: (msgs[0] && header(msgs[0], "Subject")) || "(no subject)",
      letters: msgs.map((m) => {
        const f = parseFrom(header(m, "From"));
        return { id: m.id, from: f.name, fromEmail: f.email, to: header(m, "To"), cc: header(m, "Cc"), at: new Date(Number(m.internalDate ?? Date.now())).toISOString(), body: bodyText(m), attachments: attachmentsOf(m) };
      }),
    };
  }

  /** "Save draft": the draft goes into that account's Gmail Drafts. Nothing is sent. */
  async draft(userId: string, account: string, d: { to: string; cc?: string; subject: string; body: string; threadId?: string }): Promise<{ id: string }> {
    const acct = this.store.list(userId).find((a) => a.id === account);
    if (!acct) throw new GmailError(404, "That account isn't connected.");
    const clean = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
    const mime = [`From: ${acct.email}`, d.to.trim() ? `To: ${clean(d.to)}` : "", d.cc?.trim() ? `Cc: ${clean(d.cc)}` : "", `Subject: ${clean(d.subject)}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "", d.body]
      .filter((l, i, a) => l !== "" || i === a.length - 2)
      .join("\r\n");
    const r = await this.api(userId, account, "drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { raw: b64url(Buffer.from(mime, "utf8")), ...(d.threadId ? { threadId: d.threadId } : {}) } }),
    });
    return { id: String(r.id ?? "") };
  }
}

export function registerGmailRoutes(app: Hono<any>, deps: { resolveUser: (c: Context) => GmailUser | null; stateDir: string; service?: GmailService }): GmailService {
  const svc = deps.service ?? new GmailService(deps.stateDir);
  app.use("/app/gmail/*", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "no-store");
  });
  const owner = (c: Context): GmailUser | Response => {
    const u = deps.resolveUser(c);
    if (!u) return c.json({ error: "Unauthorized" }, 401);
    if (!u.admin) return c.json({ error: "Forbidden" }, 403);
    return u;
  };
  const fail = (c: Context, err: unknown) => {
    if (err instanceof GmailError) return c.json({ error: err.message }, err.status as 400);
    console.error("[gmail] request failed:", err instanceof Error ? err.name : "unknown");
    return c.json({ error: "Gmail didn't answer — try again in a moment." }, 502);
  };
  const accountsFor = (u: GmailUser, which: string | undefined): string[] => {
    const all = svc.accounts(u.userId).map((a) => a.id);
    if (!which || which === "all") return all;
    if (!all.includes(which)) throw new GmailError(404, "That account isn't connected.");
    return [which];
  };
  const folderOf = (v: string | undefined): Folder => (FOLDERS as string[]).includes(v ?? "") ? (v as Folder) : "inbox";

  app.get("/app/gmail/status", (c) => {
    const u = owner(c);
    if (u instanceof Response) return u;
    return c.json({ configured: svc.configured(), standIn: svc.standIn(), accounts: svc.accounts(u.userId) });
  });
  app.get("/app/gmail/oauth/start", (c) => {
    const u = owner(c);
    if (u instanceof Response) return u;
    try {
      const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
      const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? new URL(c.req.url).host;
      return c.redirect(svc.start(u.userId, `${proto}://${host}`), 302);
    } catch (err) {
      return c.redirect(`/?gmail_error=${encodeURIComponent(err instanceof GmailError ? err.message : "Couldn't start the Google sign-in.")}#/gmail`, 302);
    }
  });
  app.get("/app/gmail/oauth/callback", async (c) => {
    const u = owner(c);
    if (u instanceof Response) return u;
    const err = c.req.query("error");
    if (err) return c.redirect(`/?gmail_error=${encodeURIComponent(err === "access_denied" ? "You cancelled the Google sign-in — nothing was connected." : `Google said: ${err.slice(0, 60)}`)}#/gmail`, 302);
    try {
      const a = await svc.finish(u.userId, c.req.query("state") ?? "", c.req.query("code") ?? "");
      return c.redirect(`/?gmail_connected=${encodeURIComponent(a.id)}#/gmail`, 302);
    } catch (e) {
      return c.redirect(`/?gmail_error=${encodeURIComponent(e instanceof GmailError ? e.message : "The Google sign-in didn't finish.")}#/gmail`, 302);
    }
  });
  app.get("/app/gmail/counts", async (c) => {
    const u = owner(c);
    if (u instanceof Response) return u;
    try {
      const [account] = accountsFor(u, c.req.query("account"));
      return c.json({ counts: account ? await svc.counts(u.userId, account) : {} });
    } catch (e) {
      return fail(c, e);
    }
  });
  app.get("/app/gmail/threads", async (c) => {
    const u = owner(c);
    if (u instanceof Response) return u;
    try {
      const accounts = accountsFor(u, c.req.query("account"));
      const q = (c.req.query("q") ?? "").slice(0, 300);
      const limit = Math.min(25, Math.max(1, Math.trunc(Number(c.req.query("limit") ?? 25)) || 25));
      return c.json({ threads: await svc.threads(u.userId, accounts, folderOf(c.req.query("folder")), q, c.req.query("unread") === "1", limit) });
    } catch (e) {
      return fail(c, e);
    }
  });
  app.get("/app/gmail/thread", async (c) => {
    const u = owner(c);
    if (u instanceof Response) return u;
    try {
      const [account] = accountsFor(u, c.req.query("account") ?? "");
      return c.json(await svc.thread(u.userId, account, c.req.query("id") ?? ""));
    } catch (e) {
      return fail(c, e);
    }
  });
  app.post("/app/gmail/drafts", async (c) => {
    const u = owner(c);
    if (u instanceof Response) return u;
    if (c.req.header("x-ahi-review") !== "1") return c.json({ error: "missing X-AHI-Review header" }, 403);
    try {
      const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
      const s = (k: string, max: number) => (typeof b[k] === "string" ? (b[k] as string).slice(0, max) : "");
      const [account] = accountsFor(u, s("account", 40));
      if (!s("subject", 300).trim() && !s("body", 50_000).trim()) throw new GmailError(400, "Write something first.");
      return c.json({ ok: true, ...(await svc.draft(u.userId, account, { to: s("to", 2000), cc: s("cc", 2000), subject: s("subject", 300), body: s("body", 50_000), threadId: s("threadId", 64) || undefined })) });
    } catch (e) {
      return fail(c, e);
    }
  });
  app.post("/app/gmail/accounts/:id/disconnect", (c) => {
    const u = owner(c);
    if (u instanceof Response) return u;
    if (c.req.header("x-ahi-review") !== "1") return c.json({ error: "missing X-AHI-Review header" }, 403);
    return svc.disconnect(u.userId, c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
  });
  return svc;
}

