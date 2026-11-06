/**
 * Search providers — Google web + Google Images results as data.
 *
 * PRIMARY: Serper (google.serper.dev), key `SERPER_API_KEY`:
 *   POST /search  { q, num, gl, hl }   header X-API-KEY
 *   POST /images  { q, num, gl, hl }
 * FALLBACK (only when there is no Serper key): SerpApi, key `SERPAPI_API_KEY`:
 *   GET serpapi.com/search.json?engine=google|google_images&q=…&api_key=…
 *   GET serpapi.com/account.json (free — the month's usage and allowance)
 *
 * Keys come from the gateway env, read at call time. Serper's rides in a
 * header; SerpApi's rides in the query string, so a request URL is NEVER
 * logged, thrown or returned: every error out of this file is built from the
 * status and the provider's own error text, neither of which echoes a key.
 *
 * Results are normalized into the small, bounded shape the chat card stores
 * (SearchResults): only http(s) links survive, text is clipped, at most 8 web
 * rows and 10 pictures.
 */

export type SearchKind = "web" | "images";
export type ProviderName = "serper" | "serpapi";

export interface WebResult {
  title: string;
  link: string;
  snippet: string;
  /** "example.com" — shown in place of a full URL. */
  domain: string;
  /** A favicon URL; served to the app through the image proxy only. */
  favicon?: string;
  date?: string;
}

export interface ImageResult {
  title: string;
  /** Full-size original on the source site. */
  imageUrl: string;
  /** Google's thumbnail — fast, small, reliable. */
  thumbnailUrl: string;
  width?: number;
  height?: number;
  /** Where the picture lives ("subaru.com"). */
  domain: string;
  /** The page the picture came from. */
  link: string;
}

export interface SearchResults {
  kind: SearchKind;
  query: string;
  web?: WebResult[];
  images?: ImageResult[];
}

export interface AccountUsage {
  /** Searches used this month. */
  used: number;
  /** The plan's monthly allowance. */
  limit: number;
}

export interface SearchProvider {
  name: ProviderName;
  search(kind: SearchKind, query: string, signal: AbortSignal): Promise<SearchResults>;
  /** The provider's own month count, when it has one (SerpApi). */
  account?(signal: AbortSignal): Promise<AccountUsage | null>;
}

export class SearchUpstreamError extends Error {
  constructor(
    message: string,
    /** HTTP status the route should answer with. */
    readonly status: 429 | 502 | 503 | 504,
  ) {
    super(message);
    this.name = "SearchUpstreamError";
  }
}

export const MAX_WEB = 8;
export const MAX_IMAGES = 10;

// ── Shared normalizing ────────────────────────────────────────────────────

function clip(s: unknown, n: number): string {
  const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/** Only absolute http(s) URLs leave this file — a `javascript:` link from a
 *  hostile result must never reach an <a href>. */
export function safeHttpUrl(u: unknown): string | null {
  if (typeof u !== "string" || u.length > 2048) return null;
  try {
    const url = new URL(u);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function domainOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Serper returns no favicons; Google's favicon service has one for any domain. */
export function faviconFor(domain: string): string | undefined {
  return domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64` : undefined;
}

function posInt(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

function webRow(r: Record<string, unknown>, favicon: unknown): WebResult | null {
  const link = safeHttpUrl(r?.link);
  if (!link) return null;
  const domain = domainOf(link);
  const icon = safeHttpUrl(favicon) ?? faviconFor(domain);
  const date = clip(r.date, 40) || undefined;
  return {
    title: clip(r.title, 200) || domain,
    link,
    snippet: clip(r.snippet, 300),
    domain,
    ...(icon ? { favicon: icon } : {}),
    ...(date ? { date } : {}),
  };
}

function imageRow(r: Record<string, unknown>, f: { thumb: string; full: string; w: string; h: string; site: string }): ImageResult | null {
  const thumb = safeHttpUrl(r?.[f.thumb]);
  const original = safeHttpUrl(r?.[f.full]) ?? thumb;
  if (!thumb || !original) return null;
  const link = safeHttpUrl(r.link) ?? original;
  const width = posInt(r[f.w]);
  const height = posInt(r[f.h]);
  return {
    title: clip(r.title, 200),
    imageUrl: original,
    thumbnailUrl: thumb,
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    domain: domainOf(link) || clip(r[f.site], 60),
    link,
  };
}

function collect<T>(rows: unknown, make: (r: Record<string, unknown>) => T | null, max: number): T[] {
  const out: T[] = [];
  for (const r of Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []) {
    const v = r && typeof r === "object" ? make(r) : null;
    if (v) out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/** Serper body → the card's shape. Tolerates missing fields. */
export function normalizeSerper(kind: SearchKind, query: string, raw: unknown): SearchResults {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (kind === "web") return { kind, query, web: collect(body.organic, (r) => webRow(r, undefined), MAX_WEB) };
  return {
    kind,
    query,
    images: collect(body.images, (r) => imageRow(r, { thumb: "thumbnailUrl", full: "imageUrl", w: "imageWidth", h: "imageHeight", site: "domain" }), MAX_IMAGES),
  };
}

/** SerpApi body → the card's shape. */
export function normalizeSerpApi(kind: SearchKind, query: string, raw: unknown): SearchResults {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (kind === "web") return { kind, query, web: collect(body.organic_results, (r) => webRow(r, r.favicon), MAX_WEB) };
  return {
    kind,
    query,
    images: collect(body.images_results, (r) => imageRow(r, { thumb: "thumbnail", full: "original", w: "original_width", h: "original_height", site: "source" }), MAX_IMAGES),
  };
}

export function normalizeSerpApiAccount(raw: unknown): AccountUsage | null {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (typeof b.this_month_usage !== "number" || typeof b.searches_per_month !== "number") return null;
  return { used: b.this_month_usage, limit: b.searches_per_month };
}

// ── Transport ─────────────────────────────────────────────────────────────

async function call(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> | null }> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new SearchUpstreamError("Search timed out", 504);
    throw new SearchUpstreamError("Search service unreachable", 502);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, body };
}

/**
 * Upstream text with the key gone: the literal key anywhere in it, and any
 * `api_key=` / `apikey=` / `X-API-KEY:` value (SerpApi echoes its request URL
 * in some errors). Runs before the text is clipped, kept or shown.
 */
export function redactKey(text: string, key: string): string {
  let t = String(text ?? "");
  if (key) {
    // The key as it may come back: literal, JSON-escaped (quotes, backslashes,
    // and "\/" for a slash), URL-encoded (both spellings of a space).
    const json = JSON.stringify(key).slice(1, -1);
    const forms = new Set([key, json, json.replace(/\//g, "\\/"), encodeURIComponent(key), new URLSearchParams({ k: key }).toString().slice(2)]);
    for (const f of [...forms].filter(Boolean).sort((a, b) => b.length - a.length)) t = t.split(f).join("[redacted]");
  }
  // Any named value, with the name optionally closed by a quote: api_key=…, apikey: …,
  // X-API-KEY: …, and JSON's {"X-API-KEY":"…"}.
  return t.replace(/\b(api_?key|x-api-key)("?)(\s*[=:]\s*)("?)[^\s&"',;}]+/gi, "$1$2$3$4[redacted]");
}

/** One failure → the status the app sees. `said` must already be redacted (errText). */
function failure(status: number, said: string): SearchUpstreamError {
  if (status === 429 || /run out of searches|not enough credits|rate limit|quota/i.test(said)) return new SearchUpstreamError(`Search limit reached: ${said}`, 429);
  if (status === 401 || status === 403 || /api key|unauthori[sz]ed/i.test(said)) return new SearchUpstreamError("Search key was refused", 503);
  return new SearchUpstreamError(`Search failed: ${said}`, 502);
}

const errText = (body: Record<string, unknown> | null, status: number, key: string): string =>
  typeof body?.message === "string"
    ? clip(redactKey(body.message, key), 160)
    : typeof body?.error === "string"
      ? clip(redactKey(body.error, key), 160)
      : `HTTP ${status}`;

export function serperProvider(key: string, fetchImpl: typeof fetch = fetch): SearchProvider {
  return {
    name: "serper",
    async search(kind, query, signal) {
      const { status, body } = await call(fetchImpl, `https://google.serper.dev/${kind === "web" ? "search" : "images"}`, {
        method: "POST",
        signal,
        headers: { "X-API-KEY": key, "Content-Type": "application/json", accept: "application/json" },
        // num 10 = one credit (11–100 costs two).
        body: JSON.stringify({ q: query, num: 10, gl: "us", hl: "en" }),
      });
      if (status !== 200 || !body) throw failure(status, errText(body, status, key));
      return normalizeSerper(kind, query, body);
    },
  };
}

export function serpApiProvider(key: string, fetchImpl: typeof fetch = fetch): SearchProvider {
  const get = (path: string, params: Record<string, string>, signal: AbortSignal) =>
    call(fetchImpl, `https://serpapi.com/${path}?${new URLSearchParams({ ...params, api_key: key })}`, { signal, headers: { accept: "application/json" } });
  return {
    name: "serpapi",
    async search(kind, query, signal) {
      const params: Record<string, string> = kind === "web" ? { engine: "google", q: query, num: "10", hl: "en", gl: "us" } : { engine: "google_images", q: query, hl: "en", gl: "us" };
      const { status, body } = await get("search.json", params, signal);
      const said = errText(body, status, key);
      // "Google hasn't returned any results for this query." is an empty answer, not a failure.
      if (status === 200 && body && (typeof body.error !== "string" || /hasn't returned any results/i.test(said))) return normalizeSerpApi(kind, query, body);
      throw failure(status, said);
    },
    async account(signal) {
      const { status, body } = await get("account.json", {}, signal);
      return status === 200 ? normalizeSerpApiAccount(body) : null;
    },
  };
}

/** Serper when its key is set; else SerpApi when ITS key is set; else none. */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): SearchProvider | null {
  const serper = env.SERPER_API_KEY?.trim();
  if (serper) return serperProvider(serper);
  const serpapi = env.SERPAPI_API_KEY?.trim();
  if (serpapi) return serpApiProvider(serpapi);
  return null;
}
