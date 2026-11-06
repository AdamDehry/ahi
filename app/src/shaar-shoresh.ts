/**
 * שערים/שרשים address book — TS port for the gateway runtime.
 *
 * CANONICAL source: `~/ai/infra/sessions/scripts/shaar_shoresh_address_book.mjs`.
 * This file is intentionally duplicated so:
 *   - the gateway build (`tsc`) does NOT need to reach outside its source tree
 *   - the enrichment script (`enrich_shaar_shoresh.mjs`) does NOT need to load
 *     from a dist/ artifact
 *
 * Both versions MUST be kept in sync. If you edit one, edit the other and
 * leave a note in ACTIVITY_FEED.md so the next reader sees the divergence
 * is intentional / aligned.
 *
 * Read by:
 *   - the UserPromptSubmit hook helper (`retrieval-cli.ts`) — translates
 *     English keywords from the user's turn into the gate coordinates
 *     surfaced to the agent.
 *   - any future TS consumer in the gateway.
 */

import { readFileSync, statSync } from "fs";
import { resolve } from "path";
import { ahiSessionsRoot } from "./multi-user-paths.js";

export interface AddressBucket {
  shaar: string;
  default_shoresh: string;
  meaning: string;
  keywords: ReadonlyArray<readonly [string, string]>;
}

export interface GateHit {
  shaar: string;
  shoresh: string;
  meaning: string;
  keyword: string;
  category: string;
}

// Same payload as the canonical .mjs. Frozen so accidental mutation throws.
export const ADDRESS_BOOK: Readonly<Record<string, AddressBucket>> = Object.freeze({
  "ahi-infrastructure": {
    shaar: "בנ",
    default_shoresh: "בנה",
    meaning: "build / construct / infrastructure",
    keywords: [
      ["voice",     "קלט"],
      ["tts",       "קול"],
      ["audio",     "קול"],
      ["retrieval", "זכר"],
      ["memory",    "זכר"],
      ["session",   "זכר"],
      ["hook",      "אחז"],
      ["skill",     "כשר"],
      ["gateway",   "שער"],
      ["router",    "שער"],
      ["telegram",  "שלח"],
      ["deploy",    "שלח"],
      ["agent",     "מלך"],
      ["soul",      "נפש"],
      ["identity",  "שמה"],
      ["design",    "צור"],
      ["schema",    "צור"],
      ["ui",        "צור"],
      ["pwa",       "צור"],
      ["frontend",  "צור"],
      ["dashboard", "צור"],
    ] as const,
  },
  "torah-learning": {
    shaar: "תו",
    default_shoresh: "למד",
    meaning: "Torah / learning",
    keywords: [
      ["tanya",     "תני"],
      ["rashi",     "פרש"],
      ["rambam",    "פסק"],
      ["halach",    "פסק"],
      ["tehilim",   "תהל"],
      ["psalm",     "תהל"],
      ["daven",     "פלל"],
      ["tefil",     "פלל"],
      ["parsha",    "פרש"],
      ["parasha",   "פרש"],
      ["chumash",   "פרש"],
      ["omer",      "ספר"],
      ["count",     "ספר"],
      ["sefirot",   "ספר"],
      ["kabbal",    "סוד"],
      ["chassid",   "סוד"],
      ["mashiach",  "משח"],
      ["messianic", "משח"],
      ["gemara",    "שלם"],
      ["talmud",    "שלם"],
      ["rebbe",     "רבב"],
      ["ginsburg",  "רבב"],
      ["tzimtzum",  "צמצ"],
      ["keter",     "כתר"],
    ] as const,
  },
  business: {
    shaar: "קנ",
    default_shoresh: "קנה",
    meaning: "acquire / commerce",
    keywords: [
      ["lease",   "שכר"],
      ["rent",    "שכר"],
      ["dealer",  "סחר"],
      ["trade",   "סחר"],
      ["vehicle", "רכב"],
      ["car",     "רכב"],
      ["auto",    "רכב"],
      ["crm",     "כתב"],
      ["data",    "כתב"],
      ["scrape",  "כתב"],
      ["payment", "שלם"],
      ["price",   "שלם"],
      ["rate",    "שלם"],
      ["call",    "קרא"],
      ["voice",   "קרא"],
      ["ad",      "קרא"],
      ["twilio",  "קרא"],
    ] as const,
  },
  personal: {
    shaar: "אה",
    default_shoresh: "אהב",
    meaning: "love / personal / family",
    keywords: [
      ["wife",     "אשה"],
      ["family",   "בית"],
      ["home",     "בית"],
      ["kid",      "ילד"],
      ["child",    "ילד"],
      ["mother",   "אמם"],
      ["brother",  "אחה"],
      ["friend",   "רעה"],
      ["feel",     "רגש"],
      ["relation", "חבר"],
    ] as const,
  },
  "voice-work": {
    shaar: "קל",
    default_shoresh: "קול",
    meaning: "voice / sound",
    keywords: [
      ["tts",    "דבר"],
      ["stt",    "שמע"],
      ["listen", "שמע"],
      ["speak",  "דבר"],
      ["twilio", "קרא"],
      ["phone",  "קרא"],
    ] as const,
  },
  tax: {
    shaar: "מס",
    default_shoresh: "מסס",
    meaning: "tax / count",
    keywords: [
      ["book",   "ספר"],
      ["ledger", "ספר"],
      ["cpa",    "חשב"],
      ["audit",  "בדק"],
    ] as const,
  },
  general: {
    shaar: "כל",
    default_shoresh: "כלל",
    meaning: "general / all",
    keywords: [
      ["plan",     "יעץ"],
      ["strategy", "יעץ"],
      ["decide",   "פסק"],
      ["review",   "בדק"],
      ["status",   "פקד"],
      ["update",   "פקד"],
    ] as const,
  },
  _unknown: {
    shaar: "כל",
    default_shoresh: "כלל",
    meaning: "unclassified",
    keywords: [] as const,
  },
});

// Short keywords (<= 3 chars) need word-boundary matching to avoid
// false positives — e.g. "ui" lighting up inside "build". Longer keywords
// match as substrings so stems like "schedul" catch "schedule"/"scheduling"
// without us having to enumerate every form.
const SHORT_KW_MAX_LEN = 3;

/**
 * Hook pre-pass — translate the user's English-ish prompt into the set of
 * {Sha'ar, Shoresh} addresses likely to be relevant. Cheap (substring
 * scan, no spawn). First match per (gate, root) wins, deduped.
 *
 * Designed to be sub-100ms even for long prompts (single-pass over the
 * keyword array; total entries ~120).
 */
export function gatesForQuery(query: string): GateHit[] {
  const text = (query ?? "").toLowerCase();
  if (!text) return [];

  // Split once for short-keyword word-boundary checks. \W+ keeps it cheap
  // and catches both spaces and punctuation as boundaries (e.g. "stt,").
  const tokens = new Set(text.split(/[^a-z0-9א-ת]+/).filter(Boolean));

  const hits: GateHit[] = [];
  const seen = new Set<string>();
  for (const [bucketKey, bucket] of Object.entries(ADDRESS_BOOK)) {
    if (bucketKey === "_unknown") continue;
    for (const [kw, root] of bucket.keywords) {
      const matches =
        kw.length <= SHORT_KW_MAX_LEN ? tokens.has(kw) : text.includes(kw);
      if (!matches) continue;
      const addr = `${bucket.shaar}/${root}`;
      if (!seen.has(addr)) {
        seen.add(addr);
        hits.push({
          shaar: bucket.shaar,
          shoresh: root,
          meaning: bucket.meaning,
          keyword: kw,
          category: bucketKey,
        });
      }
    }
  }
  return hits;
}

// ─────────────────────────────────────────────────────────────────────────────
// H-042 — episode injection at the detected address.
//
// The prepass used to name a coordinate and stop, so the memory sat inert
// unless the agent spent a `Skill(memory-fetch)` round-trip it usually didn't.
// Below: open the distiller's index, pick the episodes filed at the detected
// gates, rank them, and inject the top few summaries directly into the
// <retrieval-gates> block. Pure local read — no spawn, no LLM, no network.
// ─────────────────────────────────────────────────────────────────────────────

/** One distilled episode, as written by `infra/sessions/scripts/distill.py`. */
export interface EpisodeEntry {
  session_id?: string;
  agent?: string;
  episode_name?: string;
  category?: string;
  summary?: string;
  date?: string;
  started_at?: string;
  shaar?: string | null;
  shoresh?: string | null;
}

/** An episode selected for injection, with the score that got it there. */
export interface RankedEpisode {
  entry: EpisodeEntry;
  score: number;
  /** true when the episode matched shoresh exactly, not just the shaar. */
  exact: boolean;
  address: string;
}

export const EPISODE_INDEX_PATH = resolve(
  ahiSessionsRoot(),
  "index.json",
);

/** Default number of episodes injected per turn. Spec: top-K 3, hard cap 5. */
export const EPISODE_TOP_K = 3;
export const EPISODE_MAX_K = 5;

/** Summary truncation, in words, before the ellipsis. */
const SUMMARY_WORD_CAP = 50;

/**
 * Agents whose turns get episode injection. v1 is Michael-only by spec
 * ("wire Michael first, generalize after"); adding a bot here is the whole
 * generalization step.
 */
export const EPISODE_INJECTION_AGENTS: ReadonlySet<string> = new Set(["michael"]);

// ── Index cache ──────────────────────────────────────────────────────────────
// The distiller rewrites index.json hourly; the hook runs every turn. Parse
// once and hold it, re-reading only when mtime moves. ~550KB / 477 entries.

interface IndexCache {
  mtimeMs: number;
  size: number;
  entries: EpisodeEntry[];
}

let indexCache: IndexCache | null = null;

/** Counters for degraded paths — surfaced in hook stderr, never thrown. */
export const episodeStats = {
  loads: 0,
  cacheHits: 0,
  errors: 0,
  lastError: "" as string,
};

/**
 * Load the episode index, memoised against (mtimeMs, size). Returns [] on any
 * failure — a missing or malformed index must degrade the turn to gate-hints
 * only, never break it (the .bashrc principle).
 */
export function loadEpisodeIndex(indexPath: string = EPISODE_INDEX_PATH): EpisodeEntry[] {
  try {
    const st = statSync(indexPath);
    if (
      indexCache &&
      indexCache.mtimeMs === st.mtimeMs &&
      indexCache.size === st.size
    ) {
      episodeStats.cacheHits++;
      return indexCache.entries;
    }
    const parsed = JSON.parse(readFileSync(indexPath, "utf-8"));
    if (!Array.isArray(parsed)) throw new Error("index is not an array");
    indexCache = { mtimeMs: st.mtimeMs, size: st.size, entries: parsed };
    episodeStats.loads++;
    return parsed;
  } catch (err) {
    episodeStats.errors++;
    episodeStats.lastError = (err as Error).message;
    // Deliberately do NOT poison the cache — a transient half-written index
    // (the distiller writes atomically, but be defensive) should recover on
    // the next turn rather than stay broken for the life of the process.
    return [];
  }
}

/** Test seam — drop the memo so a test can swap index files. */
export function resetEpisodeIndexCache(): void {
  indexCache = null;
}

// ── Ranking ──────────────────────────────────────────────────────────────────

/**
 * Recency is the v1 mitigation for superseded episode summaries: when an old
 * episode says "Michael on ElevenLabs" and a newer one says "on Cartesia", the
 * newer one takes the slot. Match precision (shoresh-exact) outranks recency,
 * because a precisely-addressed older episode beats a vaguely-addressed recent
 * one — but within the same precision tier, latest wins.
 *
 * NOTE for the atomic-facts layer: facts become a second source ranked ABOVE
 * episodes by giving them a higher `base`. Nothing here needs rewriting —
 * merge the two ranked lists and slice. Do not build that here.
 */
const SCORE_SHORESH_EXACT = 1000;
const SCORE_SHAAR_ONLY = 500;
const SCORE_AGENT_MATCH = 250;

function recencyScore(entry: EpisodeEntry): number {
  const raw = entry.started_at || entry.date || "";
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return 0;
  // Days since epoch — monotonic, small, and keeps ties resolvable without
  // dominating the precision tiers above.
  return t / 86_400_000;
}

/**
 * Select and rank episodes filed at the detected gates.
 *
 * Agent scoping per spec: the requesting agent's own episodes come first;
 * cross-agent episodes are admitted only to fill remaining slots, so a dense
 * shared gate can't crowd out the agent's own memory.
 */
export function episodesForGates(
  hits: GateHit[],
  opts: {
    agent?: string;
    topK?: number;
    index?: EpisodeEntry[];
    indexPath?: string;
  } = {},
): RankedEpisode[] {
  if (!hits || hits.length === 0) return [];
  const topK = Math.min(opts.topK ?? EPISODE_TOP_K, EPISODE_MAX_K);
  if (topK <= 0) return [];

  const entries = opts.index ?? loadEpisodeIndex(opts.indexPath);
  if (!entries.length) return [];

  const agent = (opts.agent ?? "").trim().toLowerCase();
  const wantShoresh = new Set(hits.map((hit) => `${hit.shaar}/${hit.shoresh}`));
  const wantShaar = new Set(hits.map((hit) => hit.shaar));

  const ranked: RankedEpisode[] = [];
  for (const entry of entries) {
    const shaar = entry.shaar;
    if (!shaar || !wantShaar.has(shaar)) continue;
    // An entry with no summary carries nothing worth injecting — the whole
    // point is handing over what we know, not a bare title.
    if (!(entry.summary ?? "").trim()) continue;

    const address = `${shaar}/${entry.shoresh ?? "?"}`;
    const exact = entry.shoresh ? wantShoresh.has(address) : false;
    const agentMatch = agent ? (entry.agent ?? "").toLowerCase() === agent : false;

    const score =
      (exact ? SCORE_SHORESH_EXACT : SCORE_SHAAR_ONLY) +
      (agentMatch ? SCORE_AGENT_MATCH : 0) +
      recencyScore(entry);

    ranked.push({ entry, score, exact, address });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, topK);
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** First N words of a summary, with an ellipsis when truncated. */
export function truncateSummary(text: string, words = SUMMARY_WORD_CAP): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const parts = clean.split(" ");
  if (parts.length <= words) return clean;
  return parts.slice(0, words).join(" ") + "…";
}

// Imported here rather than in the header block on purpose: the header imports
// are being edited by a separate uncommitted change, and keeping this line out
// of that hunk lets both merge cleanly. ES imports are hoisted either way.
import { historicalEpisodeDate, historicalLabelContext, type HistoricalLabelContext } from "./temporal-labels.js";

function formatEpisodeLine(r: RankedEpisode, historical: HistoricalLabelContext | null = null): string {
  const e = r.entry;
  const name = (e.episode_name ?? "").trim() || "(unnamed episode)";
  // With the temporal envelope on, date the episode by the day the user lived
  // it and mark it historical (UTC slicing mis-dated ~19% of the corpus).
  const date = historical
    ? historicalEpisodeDate(e, historical)
    : (e.date ?? e.started_at ?? "").slice(0, 10) || "????-??-??";
  const head = truncateSummary(e.summary ?? "");
  const id8 = (e.session_id ?? "").slice(0, 8) || "????????";
  return `- [${r.address}] ${name} (${date}) — ${head}  · session ${id8}`;
}

/**
 * Format the gate hits as a compact human-and-LLM-readable hint block. Used
 * by the hook to surface what the pre-pass found alongside the recent-
 * context retrieval. Empty string when there are no hits.
 *
 * When `episodes` are supplied they are injected inline, so the agent sees
 * what it already knows at that address without spending a tool call. The
 * lazy-load pointer is kept as the route to the long tail beyond top-K.
 */
export function formatGateHints(
  hits: GateHit[],
  episodes: RankedEpisode[] = [],
): string {
  if (!hits || hits.length === 0) return "";
  const lines = hits
    .slice(0, 8) // cap to avoid bloating the hook output
    .map(
      (h) =>
        `- ${h.shaar}/${h.shoresh}  (${h.meaning}; matched "${h.keyword}")`,
    );

  const out = [
    `<retrieval-gates source="ahi-retrieval-prepass">`,
    `Detected gate(s) for this turn (Sha'ar/Shoresh — letters as coordinates):`,
    ...lines,
  ];

  // The hook runs with AHI_AGENT set; this formatter is only used there.
  const historical = episodes.length ? historicalLabelContext(process.env.AHI_AGENT?.trim() ?? "") : null;
  if (episodes.length > 0) {
    out.push(
      ``,
      `What you already know at these addresses (${episodes.length} most relevant, newest first within precision):`,
      ...episodes.map((ep) => formatEpisodeLine(ep, historical)),
    );
  }

  out.push(
    `Lazy-load deeper material via \`Skill(memory-fetch)\` { gate, root }.`,
    `</retrieval-gates>`,
  );
  return out.join("\n");
}
