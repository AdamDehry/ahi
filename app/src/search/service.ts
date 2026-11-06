/**
 * Inline search — the gateway half: a query in, a results card
 * in the chat thread out.
 *
 * Searches cost money (Serper: 2,500 free, then about $1 per 1,000), so the
 * rails are the point:
 *   - cache 24 h by (kind, normalized query); a cache hit costs nothing and
 *     counts against nothing
 *   - 30 upstream searches per user per hour
 *   - when the month has a known allowance (the provider's own account, or
 *     SEARCH_MONTHLY_LIMIT) a month at it stops spending (cache still serves)
 *   - one request at a time per query (a double tap is one search)
 *   - 10 s timeout
 * Every upstream search appends one line to the usage log (no key, ever), and
 * the month's count rides on each card's footer.
 *
 * The card is an ordinary out-message carrying `meta.search` — the same
 * "presence is the discriminator" pattern as the call-log card — written
 * through the injected broadcast (production: websocket.broadcast →
 * storeMessage), never by touching the thread files. Its `text` is the true
 * plain-text version, so Telegram, retrieval and the agent's thread tail
 * read something sensible.
 */
import { AI_ROOT } from "../ai-root.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { homedir } from "os";
import type { MessageEvent } from "../websocket.js";
import {
  SearchUpstreamError,
  type AccountUsage,
  type ImageResult,
  type ProviderName,
  type SearchKind,
  type SearchProvider,
  type SearchResults,
  type WebResult,
} from "./providers.js";

export const MAX_QUERY_CHARS = 200;

/** What a search card stores in `meta.search`. Bounded: ≤8 rows / ≤10 pictures. */
export interface SearchCardMeta {
  kind: SearchKind;
  query: string;
  /** Who ran it: the user's id ("owner") or the agent's name ("michael"). */
  by: string;
  at: string;
  web?: WebResult[];
  images?: ImageResult[];
  /** The month's search count when the card was made (limit when known). */
  usage?: MonthUsage;
  /** Which service answered. */
  provider?: ProviderName;
  /** Served from the 24 h cache — no search spent. */
  cached?: boolean;
}

export interface MonthUsage {
  used: number;
  limit?: number;
}

export interface SearchOptions {
  rateMax: number;
  rateWindowMs: number;
  cacheMs: number;
  cacheMax: number;
  timeoutMs: number;
  /** A monthly stop when the provider reports none (SEARCH_MONTHLY_LIMIT). */
  monthlyLimit?: number;
  /** How long a read of the account endpoint is trusted. */
  accountTtlMs: number;
}

export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): SearchOptions {
  const num = (k: string, d: number) => {
    const n = Number(env[k]);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    rateMax: num("SEARCH_RATE_MAX", 30),
    rateWindowMs: num("SEARCH_RATE_WINDOW_MIN", 60) * 60_000,
    cacheMs: num("SEARCH_CACHE_HOURS", 24) * 3_600_000,
    cacheMax: 500,
    timeoutMs: 10_000,
    monthlyLimit: Number(env.SEARCH_MONTHLY_LIMIT) > 0 ? Number(env.SEARCH_MONTHLY_LIMIT) : undefined,
    accountTtlMs: 10 * 60_000,
  };
}

export function defaultUsageLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SEARCH_USAGE_LOG ? resolve(env.SEARCH_USAGE_LOG) : resolve(AI_ROOT, "builds/gateway/logs/search-usage.jsonl");
}

export interface UsageRecord {
  ts: string;
  /** Did this search count against the month (what the provider bills)? Replay trusts this. */
  counted: boolean;
  provider: ProviderName;
  user: string;
  by: string;
  kind: SearchKind;
  query: string;
  results: number;
  ms: number;
  ok: boolean;
  error?: string;
}

export interface SearchServiceDeps {
  /** The search provider, or null when there is no key (feature off). */
  provider(): SearchProvider | null;
  now?: () => number;
  /** Append one usage line. Default: the JSONL usage log. */
  logUsage?: (rec: UsageRecord) => void;
  /** Upstream searches already logged this month (boot-time seed). */
  loggedThisMonth?: () => number;
}

export type SearchOutcome =
  | { ok: true; results: SearchResults; cached: boolean; usage: MonthUsage; provider: ProviderName }
  | { ok: false; status: 400 | 429 | 502 | 503 | 504; error: string; retryAfterSec?: number };

export function normalizeQuery(q: string): string {
  return q.replace(/\s+/g, " ").trim().toLowerCase();
}

function monthKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

export class SearchService {
  private readonly opts: SearchOptions;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; results: SearchResults }>();
  private readonly inflight = new Map<string, Promise<SearchOutcome>>();
  private readonly calls = new Map<string, number[]>();
  private account: { at: number; usage: AccountUsage } | null = null;
  private accountLoading: Promise<void> | null = null;
  /** Upstream searches since the last account read (same month). */
  private sinceAccount = 0;
  /** Every upstream search this process has counted, ever (monotonic). */
  private spentTotal = 0;
  private local: { month: string; count: number } | null = null;
  /** Upstream searches in flight: held against a monthly limit until they settle. */
  private reserved = 0;

  constructor(
    private readonly deps: SearchServiceDeps,
    opts: Partial<SearchOptions> = {},
  ) {
    this.opts = { ...optionsFromEnv(), ...opts };
    this.now = deps.now ?? Date.now;
  }

  enabled(): boolean {
    return this.deps.provider() !== null;
  }

  limits(): { perHour: number; windowMin: number; cacheHours: number } {
    return {
      perHour: this.opts.rateMax,
      windowMin: Math.round(this.opts.rateWindowMs / 60_000),
      cacheHours: Math.round(this.opts.cacheMs / 3_600_000),
    };
  }

  providerName(): ProviderName | null {
    return this.deps.provider()?.name ?? null;
  }

  /** The month's count as best known: the provider's own, plus what we spent since; else our log. */
  usage(): MonthUsage {
    const now = this.now();
    const month = monthKey(now);
    if (this.account && monthKey(this.account.at) === month) {
      return { used: this.account.usage.used + this.sinceAccount, limit: this.account.usage.limit };
    }
    const used = this.localCount(month);
    return this.opts.monthlyLimit ? { used, limit: this.opts.monthlyLimit } : { used };
  }

  private localCount(month: string): number {
    if (!this.local || this.local.month !== month) {
      this.local = { month, count: this.deps.loggedThisMonth?.() ?? 0 };
    }
    return this.local.count;
  }

  /** Refresh the provider's own month count when stale (SerpApi only; free). Never throws. */
  refreshAccount(force = false): Promise<void> {
    const f = this.deps.provider();
    if (!f?.account) return Promise.resolve();
    if (!force && this.account && this.now() - this.account.at < this.opts.accountTtlMs) return Promise.resolve();
    if (this.accountLoading) return this.accountLoading;
    this.accountLoading = (async () => {
      try {
        // A search that completes between asking and hearing back is NOT in the
        // snapshot: keep it, by counting from when the request started.
        const mark = this.spentTotal;
        const usage: AccountUsage | null = await f.account!(AbortSignal.timeout(this.opts.timeoutMs));
        if (usage) {
          this.account = { at: this.now(), usage };
          this.sinceAccount = this.spentTotal - mark;
        }
      } catch {
        /* keep the last read or the local count */
      } finally {
        this.accountLoading = null;
      }
    })();
    return this.accountLoading;
  }

  /** Seconds until this user may search upstream again; 0 = now. */
  private rateWait(userId: string): number {
    const now = this.now();
    const recent = (this.calls.get(userId) ?? []).filter((t) => now - t < this.opts.rateWindowMs);
    this.calls.set(userId, recent);
    if (recent.length < this.opts.rateMax) return 0;
    return Math.max(1, Math.ceil((recent[0] + this.opts.rateWindowMs - now) / 1000));
  }

  private cached(key: string): SearchResults | null {
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (this.now() - hit.at >= this.opts.cacheMs) {
      this.cache.delete(key);
      return null;
    }
    return hit.results;
  }

  private remember(key: string, results: SearchResults): void {
    this.cache.delete(key);
    this.cache.set(key, { at: this.now(), results });
    while (this.cache.size > this.opts.cacheMax) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /**
   * Run one search for `userId` (rate-limited per user; `by` is who asked —
   * the user or an agent acting for them). The query keeps its own casing in
   * the results; the cache key is normalized.
   */
  async search(userId: string, kind: SearchKind, rawQuery: string, by: string = userId): Promise<SearchOutcome> {
    const query = String(rawQuery ?? "").replace(/\s+/g, " ").trim();
    if (!query) return { ok: false, status: 400, error: "Type something to search for" };
    if (query.length > MAX_QUERY_CHARS) return { ok: false, status: 400, error: `Search is over ${MAX_QUERY_CHARS} characters` };
    if (kind !== "web" && kind !== "images") return { ok: false, status: 400, error: "kind must be web or images" };
    const provider = this.deps.provider();
    if (!provider) return { ok: false, status: 503, error: "Search is not set up on this gateway" };

    const key = `${kind}:${normalizeQuery(query)}`;
    const hit = this.cached(key);
    if (hit) return { ok: true, results: { ...hit, query }, cached: true, usage: this.usage(), provider: provider.name };

    const running = this.inflight.get(key);
    if (running) return running;

    const wait = this.rateWait(userId);
    if (wait) {
      const mins = Math.ceil(wait / 60);
      return {
        ok: false,
        status: 429,
        error: `That's ${this.opts.rateMax} searches this hour. Next one in ${mins} minute${mins === 1 ? "" : "s"}.`,
        retryAfterSec: wait,
      };
    }
    void this.refreshAccount();
    const before = this.usage();
    // Reserve synchronously: parallel distinct queries can't all pass the check
    // before the first of them is counted.
    if (before.limit !== undefined && before.used + this.reserved >= before.limit) {
      return { ok: false, status: 429, error: `This month's ${before.limit} searches are used up. Repeats of recent searches still work.` };
    }

    // The slot is taken BEFORE the request: ten fast taps are ten, not
    // eleven because the first hadn't come back yet.
    this.calls.get(userId)!.push(this.now());
    this.reserved += 1;
    const p = this.runUpstream(provider, userId, by, kind, query, key).finally(() => {
      this.reserved -= 1;
    });
    this.inflight.set(key, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async runUpstream(provider: SearchProvider, userId: string, by: string, kind: SearchKind, query: string, key: string): Promise<SearchOutcome> {
    const started = this.now();
    const log = (ok: boolean, counted: boolean, results: number, error?: string) => {
      try {
        (this.deps.logUsage ?? appendUsageLine)({ ts: new Date(started).toISOString(), counted, provider: provider.name, user: userId, by, kind, query, results, ms: this.now() - started, ok, ...(error ? { error } : {}) });
      } catch (err) {
        console.warn(`[search] usage log write failed: ${(err as Error).message}`);
      }
    };
    try {
      const results = await provider.search(kind, query, AbortSignal.timeout(this.opts.timeoutMs));
      this.spent();
      const n = (results.web ?? results.images ?? []).length;
      log(true, true, n);
      this.remember(key, results);
      return { ok: true, results, cached: false, usage: this.usage(), provider: provider.name };
    } catch (err) {
      const e = err instanceof SearchUpstreamError ? err : new SearchUpstreamError("Search failed", 502);
      // A refused request still may have been billed; only count what the provider
      // would: anything that reached it and wasn't a timeout or a bad key.
      const counted = e.status === 502;
      if (counted) this.spent();
      log(false, counted, 0, e.message);
      console.warn(`[search] ${kind} search failed for ${userId}: ${e.message}`);
      return { ok: false, status: e.status, error: e.message };
    }
  }

  private spent(): void {
    this.sinceAccount += 1;
    this.spentTotal += 1;
    const month = monthKey(this.now());
    this.localCount(month);
    if (this.local) this.local.count += 1;
  }
}

// ── The usage log ─────────────────────────────────────────────────────────

export function appendUsageLine(rec: UsageRecord, path = defaultUsageLogPath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, JSON.stringify(rec) + "\n");
}

/** Upstream searches logged in the current calendar month (UTC). */
export function countLoggedThisMonth(path = defaultUsageLogPath(), now = Date.now()): number {
  if (!existsSync(path)) return 0;
  const month = monthKey(now);
  let n = 0;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const r = JSON.parse(line) as Partial<UsageRecord>;
      // The line says whether it counted; a line written before the flag existed counts when it succeeded.
      if (typeof r.ts === "string" && r.ts.startsWith(month) && (r.counted ?? r.ok === true)) n++;
    } catch {
      /* a torn line costs that line */
    }
  }
  return n;
}

// ── The card ──────────────────────────────────────────────────────────────

/** The plain-text twin of a card: what every non-app reader sees. */
export function cardText(meta: SearchCardMeta, byName: string): string {
  const head = `${meta.kind === "images" ? "Pictures" : "Web results"} for “${meta.query}” (searched by ${byName})`;
  if (meta.kind === "images") {
    const imgs = meta.images ?? [];
    if (!imgs.length) return `${head}: nothing came back.`;
    return [`${head}: ${imgs.length} pictures.`, ...imgs.slice(0, 3).map((i) => `- ${i.title || i.domain} — ${i.link}`)].join("\n");
  }
  const rows = meta.web ?? [];
  if (!rows.length) return `${head}: nothing came back.`;
  return [`${head}:`, ...rows.slice(0, 5).map((r, i) => `${i + 1}. ${r.title} — ${r.link}`)].join("\n");
}

export function buildCardEvent(opts: {
  bot: string;
  user: { userId: string; name: string; telegramChatId: number | null };
  by: string;
  byName: string;
  outcome: Extract<SearchOutcome, { ok: true }>;
  now?: Date;
}): MessageEvent {
  const { results, cached, usage, provider } = opts.outcome;
  const at = (opts.now ?? new Date()).toISOString();
  const meta: SearchCardMeta = {
    kind: results.kind,
    query: results.query,
    by: opts.by,
    at,
    ...(results.kind === "web" ? { web: results.web ?? [] } : { images: results.images ?? [] }),
    usage,
    provider,
    ...(cached ? { cached: true } : {}),
  };
  return {
    type: "message",
    bot: opts.bot,
    direction: "out",
    contentType: "text",
    text: cardText(meta, opts.byName),
    timestamp: at,
    chatId: opts.user.telegramChatId ?? 0,
    userId: opts.user.userId,
    senderName: opts.user.name,
    source: "app",
    meta: { search: meta },
  };
}

/** Find a search card in a thread by its message id. */
export function findCard(thread: MessageEvent[], messageId: string): SearchCardMeta | null {
  for (let i = thread.length - 1; i >= 0; i--) {
    const m = thread[i];
    if (m.meta?.messageId === messageId) return m.meta?.search ?? null;
  }
  return null;
}
