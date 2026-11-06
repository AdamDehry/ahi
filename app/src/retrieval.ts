import { ownerUserId } from "./users.js";
import { readFileSync, existsSync, statSync } from "fs";
import { resolve } from "path";
import { ahiSessionsRoot, multiUserPaths, warnDeprecatedPath } from "./multi-user-paths.js";
import { gatesForQuery } from "./shaar-shoresh.js";
import { historicalLabelContext, labelRetrievedSession, sessionLocalDate } from "./temporal-labels.js";
import { embedQuery, loadVectorStore, type VectorStore } from "./retrieval-vectors.js";
import { loadPassageStore, type PassageStore, type PassageHit } from "./retrieval-passages.js";
import { loadPassageLexicon, lexTokens } from "./retrieval-passages-lex.js";
import { loadClusterMap } from "./retrieval-clusters.js";
import { FACT_RETRIEVAL_ENABLED, factStats, factsForQuery, formatFacts } from "./retrieval-facts.js";
// Re-exported for external callers that want a retrieval-safe view of the
// message store. The scoring pipeline below operates on the sessions index,
// not the raw message store — but we re-export this helper so any future
// corpus-load path has an obvious, filter-applied entry point.
export { getMessagesForRetrieval } from "./message-store.js";

// ─────────────────────────────────────────────────────────────────────────────
// Retrieval design
//
// Two rules this module depends on:
//
//   1. ONE CANONICAL INDEX. Read the archive index the distiller maintains
//      (the one with episode names, categories, summaries and Sha'ar/Shoresh
//      addresses), never a per-user stub index. The eligibility filter below
//      requires a name, a category and a summary, so a stub index whose
//      entries lack them leaves `eligible` empty and this function returns ""
//      while the gate layer in `shaar-shoresh.ts` keeps working.
//
//   2. MULTI-SIGNAL SCORING. Literal word overlap against a short episode
//      title under a steep recency curve discards most of an older archive,
//      and what survives must be asked in the title's exact words. Scoring is
//      rank fusion over four signals — see SIGNALS below. Measure changes
//      against questions phrased the way a user actually asks, not in the
//      titles' words.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The canonical archive, written by `infra/sessions/scripts/distill.py` and
 * already the source of truth for the Sha'ar/Shoresh layer. Deliberately the
 * SAME constant as `shaar-shoresh.ts#EPISODE_INDEX_PATH` — the two layers
 * disagreeing about which file is the archive is the failure rule 1 above
 * describes.
 *
 * Derived from ahiSessionsRoot() so AHI_SESSIONS_ROOT moves the whole corpus.
 */
const CANONICAL_INDEX_PATH = resolve(ahiSessionsRoot(), "index.json");

export interface IndexEntry {
  session_id: string;
  agent: string;
  category: string | null;
  episode_name: string | null;
  started_at: string;
  date?: string;
  transcript_path_md?: string;
  /** Sha'ar — the 2-letter gate this conversation is filed under. */
  shaar?: string | null;
  /** Shoresh — the 3-letter root, i.e. the precise address inside the gate. */
  shoresh?: string | null;
  // Pre-computed session summary (populated by H-025 backfill + on-session-log
  // path going forward). When present, retrieval uses this directly instead
  // of spawning a per-turn Haiku summarize call — saving ~2-8s per retrieved
  // session on the pre-first-byte path. See H-026.5 Task 2.
  summary?: string;
  // When true, the session JSONL was contaminated by something other than a
  // real user turn (e.g. /ui/send test injection) and its contents must
  // never be scored or summarized into retrieval context. Set manually in
  // index.json with a `tainted_reason` pointing to the incident.
  tainted?: boolean;
  tainted_reason?: string;
  /**
   * Principal attribution, written at ingestion by the Telegram path
   * (`claude-invoke.ts`). NULL on every entry the distiller creates
   * (`infra/sessions/scripts/distill.py` hardcodes both to None), so
   * distilled entries arrive unowned. See PRINCIPAL SCOPING.
   */
  telegram_user?: string | null;
  telegram_chat_id?: number | string | null;
  /**
   * Canonical stable owner identifier, stamped at ingestion by
   * `distill.py#detect_owner`. Preferred over `telegram_user` going forward.
   * `null` alongside `owner_source: "unattributed" | "ambiguous"` is an
   * EXPLICIT "ownership not proven" verdict — quarantine, do not share.
   */
  owner?: string | null;
  owner_source?: string | null;
}

// ── PRINCIPAL SCOPING — cross-user containment ────────────────────────────────
//
// THE RISK. `agentAllowedCategories` scopes retrieval by agent → category and
// by nothing else. An agent that serves more than one person (Miriam can) reads
// one shared `personal` category holding all of them. The message store IS
// partitioned per principal; without this filter retrieval would not be, and one
// person's question could surface another person's private sessions. That is a
// cross-user privacy leak, not a ranking bug.
//
// THE FIX. Categories listed below are principal-scoped: an entry is a
// retrieval candidate only when its owner is PROVEN and equals the
// authenticated principal on the query. Consequences, all deliberate:
//
//   - No principal on the query → NO principal-scoped entries. There is no
//     fallback to the shared pool; that fallback is the leak.
//   - Owner not provable → entry is QUARANTINED. Neither principal can reach
//     it. Not deleted, not guessed, not reassigned — invisible to recall and
//     fully preserved on disk.
//
// Most older entries carry no provable owner, and attribution cannot be done
// from reliable metadata, so it is not attempted here. Quarantine is the
// containment; attribution is separate, evidence-led, and separately gated.
//
// ROLLBACK: `AHI_PRINCIPAL_FILTER=off` restores the previous (leaking)
// behaviour exactly. No index writes are performed by any of this, so rollback
// is a flag flip and a restart — there is nothing to undo on disk.
const PRINCIPAL_SCOPED_CATEGORIES = new Set(["personal"]);

const PRINCIPAL_FILTER_ENABLED =
  (process.env.AHI_PRINCIPAL_FILTER ?? "on").trim().toLowerCase() !== "off";

/** Values that look like a principal but prove nothing about who owns a memory. */
const NON_PRINCIPAL_TOKENS = new Set([
  "", "unknown", "null", "none", "undefined", "system",
  // Explicit not-proven verdicts written by distill.py#detect_owner. These are
  // provenance markers, never principal names — reading one as an owner would
  // turn "we don't know" into a user account.
  "unattributed", "ambiguous",
]);

/**
 * Telegram chat-ID → principal, read from the same env vars `config.ts` uses.
 * Read directly rather than importing `config.ts` so the retrieval CLI (which
 * runs as a bare hook subprocess) cannot be broken by config-load side effects.
 * A missing env var yields fewer provable owners — i.e. more quarantine — which
 * is the fail-closed direction.
 */
function chatIdOwners(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [envKey, friendly] of [
    ["OWNER_TELEGRAM_ID", ownerUserId()],
  ] as const) {
    const raw = process.env[envKey]?.trim();
    if (raw) map.set(raw, friendly);
  }
  return map;
}

/** Normalise an authenticated principal. Anything unresolvable becomes null. */
export function normalizePrincipal(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().toLowerCase();
  if (NON_PRINCIPAL_TOKENS.has(v)) return null;
  // A surface may hand us a raw Telegram ID instead of the friendly name.
  const byChatId = chatIdOwners().get(v);
  return byChatId ?? v;
}

/**
 * The PROVEN owner of an indexed session, or null when ownership is not
 * established. Deliberately strict: only attribution written at ingestion
 * (`telegram_user`) or derivable from authenticated routing metadata
 * (`telegram_chat_id`) counts. Nothing is inferred from content, agent name,
 * or timing — an inferred owner is a guess, and a guess here is a leak.
 */
export function provenOwner(entry: IndexEntry): string | null {
  // 1. Canonical field, stamped at ingestion. "unattributed"/"ambiguous" are
  //    explicit not-proven verdicts and must NOT be read as owner names.
  const stamped = (entry.owner ?? "").toString().trim().toLowerCase();
  if (stamped && !NON_PRINCIPAL_TOKENS.has(stamped)) return stamped;

  // 2. Legacy attribution written by the Telegram ingestion path.
  const tagged = (entry.telegram_user ?? "").toString().trim().toLowerCase();
  if (tagged && !NON_PRINCIPAL_TOKENS.has(tagged)) return tagged;

  const chatId = entry.telegram_chat_id;
  if (chatId !== null && chatId !== undefined) {
    const owner = chatIdOwners().get(chatId.toString().trim());
    if (owner) return owner;
  }
  return null;
}

/**
 * The gate itself. `true` means this entry may be shown to this principal.
 *
 * Non-principal-scoped categories are unaffected — every other existing
 * boundary keeps working exactly as it did.
 */
export function principalMayRead(entry: IndexEntry, principal: string | null): boolean {
  if (!PRINCIPAL_FILTER_ENABLED) return true;
  if (!entry.category || !PRINCIPAL_SCOPED_CATEGORIES.has(entry.category)) return true;
  if (!principal) return false;           // no authenticated selector → no shared pool
  const owner = provenOwner(entry);
  if (!owner) return false;               // quarantined: preserved, unreachable
  return owner === principal;
}

// ── Access control ────────────────────────────────────────────────────────────

const ALL_CATEGORIES = [
  "torah-learning",
  "business",
  "ahi-infrastructure",
  "personal",
  "voice-work",
  "tax",
  "general",
];

// Strict allowlist per agent. Restricted agents see ONLY their own category —
// "general" is deliberately excluded because Haiku's classifier buckets
// business/context-ambiguous sessions there, and those can carry business /
// infra content that must not leak across trust boundaries
// (e.g. Miriam must not see a contractor-licensing business session even if
// it was classified "general"). Michael and Zali legitimately see everything.
// Unknown agents deny by default.
const AHI_CATEGORIES = ALL_CATEGORIES;

export function agentAllowedCategories(agent: string): string[] {
  switch (agent.toLowerCase()) {
    case "michael":
    case "zali":
      return AHI_CATEGORIES;
    case "avi":
      return ["ahi-infrastructure"];
    case "miriam":
      return ["personal"];
    default:
      return [];
  }
}

// ── Tokenisation ──────────────────────────────────────────────────────────────

// Deliberately a SHORT stopword list. BM25's IDF term already discounts words
// that appear everywhere in this corpus, so a long hand-maintained list only
// costs recall. What stays are conversational fillers that carry no topic at
// all — the words a user uses to *frame* a memory question ("remember that
// thing where...") rather than to identify it.
const STOPWORDS = new Set([
  "the", "and", "for", "but", "not", "you", "are", "can", "did", "was",
  "with", "how", "what", "when", "where", "why", "our", "out", "all", "has",
  "had", "his", "her", "its", "let", "this", "that", "from", "been", "have",
  "were", "who", "one", "about", "into", "over", "just", "than", "then",
  "your", "will", "they", "them", "there", "their", "would", "could",
  "should", "does", "doing", "remember", "whatever", "happened", "thing",
  "things", "stuff",
]);

// Light suffix stripping. Not a real stemmer, and deliberately not — enough to
// collapse "merged"/"merge" and "sessions"/"session", which is where most of
// the near-miss recall was going, without the over-stemming a full Porter
// implementation brings (and without the dependency).
function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export function tokenize(text: string | null | undefined): string[] {
  return (text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9א-ת]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map(stem);
}

// ── Signal 1: lexical (BM25) ─────────────────────────────────────────────────

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const FIELD_WEIGHTS = { title: 3, category: 2, summary: 1 };

interface LexicalIndex {
  docs: { tf: Map<string, number>; len: number }[];
  idf: Map<string, number>;
  avgdl: number;
}

function buildLexicalIndex(entries: IndexEntry[]): LexicalIndex {
  const docs = entries.map((e) => {
    const tf = new Map<string, number>();
    const add = (text: string | null | undefined, weight: number) => {
      for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + weight);
    };
    add(e.episode_name, FIELD_WEIGHTS.title);
    add(e.category, FIELD_WEIGHTS.category);
    add(e.summary, FIELD_WEIGHTS.summary);
    let len = 0;
    for (const v of tf.values()) len += v;
    return { tf, len };
  });

  const n = docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = new Map<string, number>();
  for (const [t, c] of df) idf.set(t, Math.log(1 + (n - c + 0.5) / (c + 0.5)));
  const avgdl = n ? docs.reduce((s, d) => s + d.len, 0) / n : 0;
  return { docs, idf, avgdl };
}

function bm25(lex: LexicalIndex, queryTokens: string[], candidates: number[]): Float64Array {
  const out = new Float64Array(lex.docs.length);
  for (const i of candidates) {
    const d = lex.docs[i];
    let s = 0;
    for (const t of queryTokens) {
      const f = d.tf.get(t);
      if (!f) continue;
      const w = lex.idf.get(t) ?? 0;
      s += w * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * (d.len / (lex.avgdl || 1)))));
    }
    out[i] = s;
  }
  return out;
}

// ── Fusion ────────────────────────────────────────────────────────────────────

// Reciprocal rank fusion. We combine the signals' RANKINGS rather than their
// raw scores, so a BM25 score of 14.2 and a cosine of 0.61 never need to be
// calibrated against each other — and one loud signal can't drown the others.
const RRF_K = 60;
const SIGNAL_WEIGHTS = {
  lexical: 1.1,   // exact words the user happens to reuse
  semantic: 1.5,  // what the user means, in their own words, months later
  gates: 0.4,     // Sha'ar/Shoresh — the addressing layer, as a strong tiebreak
  recency: 0.2,   // a prior, not a gate: newer wins ties, older stays reachable
  // H-044. Deliberately ZERO — the passage layer does not vote in this fusion.
  //
  // It was tried as a fifth co-equal signal and it degraded episode
  // identification monotonically: 28/40 → 27 → 26 → 19 as its weight went
  // 0 → 0.3 → 1.0 → 1.7. The cause is not a bad index, it is a bad statistic.
  // Rolling a session up by its best passage means scoring it by a maximum
  // over n draws, and max-over-n grows like sqrt(2·ln n) whether or not
  // anything is relevant. Sessions that won unrelated questions had a median
  // of 120 passages; the correct sessions had 16. One 2,978-passage
  // conversation was beating half the corpus on questions it had nothing to
  // do with.
  //
  // Length-correcting the rollup (extreme-value, log-penalty, top-3 mean) was
  // measured too — see compare-rollups.mjs. All of them still ranked the
  // correct session ~50th of 431. So the passage layer earns its place through
  // the RESERVED SLOT below, not by voting on an ordering it is bad at.
  passage: Number(process.env.W_PASSAGE ?? 0),
};

/**
 * How many of the TOP_K slots the passage layer may claim.
 *
 * The two layers answer different questions and are good at different ones:
 * "which conversation was that" is a summary question, "what was the number"
 * is a passage question. Rather than average two rankings into something worse
 * at both, we split the budget: the summary path keeps the first slots in the
 * order it already produces, and the passage layer gets the last one for a
 * conversation the summary path would never have surfaced.
 *
 * A rescue only happens when the passage layer is confident AND the summary
 * path did not already return that conversation. When it finds nothing, the
 * slot reverts to the summary path — so this can never return fewer results
 * than before.
 */
const PASSAGE_RESERVED_SLOTS = Number(process.env.PASSAGE_RESERVED_SLOTS ?? 1);

// H-046 — collapse duplicate clusters to one slot. ON by default.
//
// Both gates were unmoved by it: detail recall 15/26 and the episode guard
// 28/40, identical with it on and off. It ships anyway because it changes the
// returned set on 5 of 66 harness questions and every one of those changes
// replaced a second copy of a conversation already in the list with a
// different conversation — a failure the harnesses cannot score, since both
// mark an answer correct whether or not the other two slots were wasted.
//
// AHI_CLUSTER_COLLAPSE=0 forces it off without a redeploy.
const CLUSTER_COLLAPSE_ENABLED = (process.env.AHI_CLUSTER_COLLAPSE ?? "1") !== "0";

// H-047 — demote a machine-generated session when a real record of the same
// material is also a candidate. See the note at realSiblingAvailable.
const DEMOTE_MACHINERY = (process.env.AHI_DEMOTE_MACHINERY ?? "0") !== "0";

// H-047 — drop machine-generated sessions from the candidate set entirely.
// A summarizer or cataloguing call carries an episode_name and summary
// describing the conversation it was FED, so returning one injects a real
// memory under the wrong title and date, and costs a real conversation its
// slot. Off until measured: six of the old harness's forty targets ARE
// summarizer copies, so this is exactly the kind of obviously-correct change
// that can walk the regression guard backwards.
const EXCLUDE_MACHINERY = (process.env.AHI_EXCLUDE_MACHINERY ?? "0") !== "0";

// ── H-044: the passage layer ─────────────────────────────────────────────────
//
// ON by default, on this evidence:
//
//   detail recall (containment)   0/26  →  13/26     ← the reason this exists
//   episode identification (old)  28/40 →  28/40     ← regression guard, held
//
// AHI_PASSAGE_RETRIEVAL=0 turns it off without a redeploy if it ever
// misbehaves in production.
const PASSAGE_RETRIEVAL_ENABLED = (process.env.AHI_PASSAGE_RETRIEVAL ?? "1") !== "0";

// Confidence floor for the passage layer, calibrated the same way as
// MIN_COSINE — see calibrate-passages.mjs. It sits HIGHER than the session
// floor for a statistical reason that is easy to get wrong: this store has
// roughly forty passages per session, and the maximum over tens of thousands
// of samples is a much larger number than the maximum over hundreds even when
// nothing matches. A junk prompt reliably finds *something* at 0.42.
//
// Measured over a set of real memory questions and non-memory prompts:
//
//   correct session's best passage   p05 0.364   median 0.516   max 0.698
//   junk prompts, best passage ANY   median 0.427   p90 0.476   max 0.489
//
// 0.50 is the last floor that admits zero junk. Note this gate only governs
// whether a passage may admit a session ON ITS OWN — a passage below it still
// contributes its ranking to the fusion, so a conservative floor costs
// ordering nothing and buys silence on greetings.
const MIN_PASSAGE_COSINE = Number(process.env.MIN_PASSAGE_COSINE ?? 0.50);

// H-045 — the BM25 passage layer's floor, calibrated the same way against the
// same junk prompts. See calibrate-passage-lex.mjs. This layer is high
// precision when it fires: clearing it means a rare, low-document-frequency
// token from the question appears verbatim in that passage.
const MIN_PASSAGE_BM25 = Number(process.env.MIN_PASSAGE_BM25 ?? 12.0);

// Confidence floors. Below these we return NOTHING. A wrong memory is worse
// than no memory, because the agent states it with the same confidence as a
// right one — this is the setting that decides whether silence or noise is the
// failure mode, and we choose silence.
//
// Calibrated against a set of real memory questions and deliberate
// non-memory prompts ("hi", "how do I boil an egg", "call my mom"):
//
//   real questions   cosine  p05 0.428   p25 0.516   median 0.579
//   junk prompts     cosine  median 0.308   p90 0.409   max 0.428
//
// So a cosine floor at 0.42 cleanly separates them. BM25 does NOT separate on
// its own — junk reaches 10.1 while real questions bottom out at 7.1 — so a
// lexical hit can only admit a result when the semantic layer is at least
// warm. That combination is what catches the case where the user types exact
// jargon ("Cartesia", "ElevenLabs") in an otherwise oddly-phrased question.
const MIN_COSINE = 0.42;
const STRONG_BM25 = 12.0;
const STRONG_BM25_MIN_COSINE = 0.32;

// Under this many content tokens there is no question to answer — "hi",
// "thanks", "ok sounds good". Retrieving against those is pure noise, and it
// is the single most visible failure mode because it fires on the cheapest
// turns.
const MIN_QUERY_TOKENS = 2;

// Two results this close are one conversation under two session IDs (a resumed
// thread, a crashed CLI, the Telegram and terminal legs of the same
// discussion). Filling all three slots with the same conversation wastes the
// budget, so we keep the best-ranked one and move on.
const DEDUPE_COSINE = 0.90;

/** How many sessions we inject per turn. */
const TOP_K = 3;

/**
 * How many session slots the facts block buys back when the gate walk found
 * something. DEFAULT ZERO — the trade was measured and it is a disaster:
 *
 *   trade   fires    containment   mean injected chars
 *     0     20/26        15/26            3,989
 *     1     20/26         8/26            2,409
 *     2     20/26         6/26            1,892
 *
 * Giving the facts block a session's slot halves detail recall. The session and
 * passage layers are what actually carry a remembered VALUE — the quoted passage
 * is where an exact price or port number lives — and a fact statement is a paraphrase
 * that usually does not contain the number. So the two layers are not
 * substitutes and the budget cannot be moved between them.
 *
 * Kept as a knob, at zero, because the sweep is the evidence for that sentence
 * and the next person to have the same idea should find the number rather than
 * the opinion.
 */
const FACT_SLOT_TRADE = Number(process.env.FACT_SLOT_TRADE ?? 0);

/**
 * Hard ceiling on the semantic layer. The embedding call is the ONLY network
 * hop on the retrieval path, and retrieval sits in front of the user's first
 * byte. If OpenAI is slow or down we degrade to lexical+gates rather than make
 * the user wait — a slightly worse memory beats a hung turn.
 */
const EMBED_TIMEOUT_MS = 600;

function rankMap(scores: Float64Array, candidates: number[], floor = -Infinity): Map<number, number> {
  const ordered = candidates.filter((i) => scores[i] > floor).sort((a, b) => scores[b] - scores[a]);
  const m = new Map<number, number>();
  ordered.forEach((i, rank) => m.set(i, rank));
  return m;
}

// ── Index + lexical cache ─────────────────────────────────────────────────────
// The distiller rewrites index.json hourly; this CLI runs per turn. Parse and
// build BM25 once, re-doing it only when the file actually moves.

interface IndexCache {
  path: string;
  mtimeMs: number;
  size: number;
  entries: IndexEntry[];
  lex: LexicalIndex;
}
let indexCache: IndexCache | null = null;

function loadIndex(path: string): { entries: IndexEntry[]; lex: LexicalIndex } | null {
  try {
    const st = statSync(path);
    if (indexCache && indexCache.path === path && indexCache.mtimeMs === st.mtimeMs && indexCache.size === st.size) {
      return { entries: indexCache.entries, lex: indexCache.lex };
    }
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(parsed)) return null;
    const entries = parsed as IndexEntry[];
    const lex = buildLexicalIndex(entries);
    indexCache = { path, mtimeMs: st.mtimeMs, size: st.size, entries, lex };
    return { entries, lex };
  } catch {
    return null;
  }
}

/** Test seam — drop the memo so a test can swap index files. */
export function resetRetrievalCache(): void {
  indexCache = null;
}

// ── Scoring (exported for the eval harness and the CLI probe) ─────────────────

export interface ScoreBreakdown {
  total: number;
  lexical: number;
  semantic: number;
  gate: number;
  /** Cosine of the best-matching passage inside this conversation, if any. */
  passage?: number;
  /** BM25 of the best-matching passage inside this conversation, if any. */
  passageLexical?: number;
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface RetrievedSession {
  entry: IndexEntry;
  score: number;
  breakdown: ScoreBreakdown;
  /**
   * The passages that caused this conversation to rank — quoted back as the
   * evidence for the memory rather than left implicit. Empty when the session
   * was retrieved on summary signals alone.
   */
  evidence?: string[];
}

/**
 * Rank the archive against one message. Exported separately from
 * `getRelevantContext` so the eval harness and the CLI probe can inspect the
 * ranking without going through string formatting.
 */
export async function rankSessions(
  agent: string,
  message: string,
  k = TOP_K,
  principal: string | null = null,
): Promise<RetrievedSession[]> {
  // The authenticated principal for principal-scoped categories. Comes from
  // AHI_USER_ID, which the gateway resolves server-side from the Telegram
  // sender ID via the env identity map — never from message content.
  const activePrincipal = normalizePrincipal(principal);
  const indexPath = CANONICAL_INDEX_PATH;

  const loaded = loadIndex(indexPath);
  if (!loaded) return [];
  const { entries, lex } = loaded;

  const allowed = new Set(agentAllowedCategories(agent));
  const candidates: number[] = [];
  let quarantined = 0;
  entries.forEach((e, i) => {
    // Principal gate runs BEFORE anything is scored, so a memory belonging to
    // the other principal never reaches ranking, formatting, summarization or
    // the background-summarize queue. Counted so containment is observable in
    // the logs rather than silent.
    if (!principalMayRead(e, activePrincipal)) {
      if (e.category && allowed.has(e.category)) quarantined++;
      return;
    }
    if (
      e.episode_name &&
      e.category &&
      allowed.has(e.category) &&
      !e.tainted &&
      // Only entries with a cached summary can be injected on the fast path.
      // Ones without are handled by the background-summarize queue below.
      (e.summary || (e.transcript_path_md && existsSync(e.transcript_path_md)))
    ) {
      candidates.push(i);
    }
  });
  if (quarantined > 0) {
    // STDERR, not stdout. On the live path this module runs inside
    // `retrieval-cli.js`, whose STDOUT *is* the UserPromptSubmit hook's JSON
    // channel — a stray console.log there is not noise, it corrupts the hook
    // payload and silently kills retrieval for the turn. (Caught by the live
    // probe; the unit tests could never have seen it.)
    process.stderr.write(
      `[retrieval] principal-scope agent=${agent} principal=${activePrincipal ?? "<none>"} ` +
        `withheld=${quarantined} (unowned or other-principal; preserved, not deleted)\n`,
    );
  }
  if (!candidates.length) return [];

  // Signal 1 — lexical.
  const queryTokens = tokenize(message);
  if (queryTokens.length < MIN_QUERY_TOKENS) return [];
  const lexScores = bm25(lex, queryTokens, candidates);

  // Signal 2 — semantic. Fails open to lexical-only.
  const cosScores = new Float64Array(entries.length);
  let store: VectorStore | null = null;
  // True only when we actually got a query vector back. If the embedding call
  // failed or timed out, EVERY cosine is 0 and the whole run must fall back to
  // the lexical floor — otherwise a transient API blip silently returns
  // "no memories" instead of degraded memories.
  let semanticLive = false;
  // Hoisted: the passage layer scores against the SAME vector, so the two
  // semantic signals together still cost exactly one network call.
  let queryVector: Float32Array | null = null;
  try {
    store = loadVectorStore();
    if (store) {
      queryVector = await Promise.race([
        embedQuery(message),
        new Promise<null>((r) => setTimeout(() => r(null), EMBED_TIMEOUT_MS)),
      ]);
      if (queryVector) {
        semanticLive = true;
        for (const i of candidates) {
          cosScores[i] = store.similarity(queryVector, entries[i].session_id);
        }
      }
    }
  } catch {
    // Semantic layer is an enhancement, never a dependency.
  }

  // Signal 5 — passages. Rolled up to the session by taking its best-matching
  // passage, so the hook still returns whole conversations; the passage itself
  // rides along as the evidence. Reuses the SAME query vector — the passage
  // layer costs no extra network hop, only local dot products.
  const passScores = new Float64Array(entries.length);
  const evidenceRows = new Map<number, number[]>();
  let passageStore: PassageStore | null = null;
  if (PASSAGE_RETRIEVAL_ENABLED && semanticLive && queryVector) {
    try {
      passageStore = loadPassageStore();
      if (passageStore) {
        const hits: Map<string, PassageHit> = passageStore.scoreSessions(queryVector);
        for (const i of candidates) {
          const hit = hits.get(entries[i].session_id);
          if (!hit) continue;
          passScores[i] = hit.score;
          evidenceRows.set(i, hit.rows);
        }
      }
    } catch {
      // Same contract as every other layer here: an enhancement, never a
      // dependency. A broken passage store must not cost the user their memory.
      passageStore = null;
    }
  }

  // Signal 6 — BM25 over the same passages (H-045). Deliberately NOT gated on
  // `semanticLive`: this layer needs no embedding at all, so it is the one part
  // of retrieval that still works with the OpenAI API down. It is also the only
  // layer that can find an opaque identifier, because it matches the rare
  // anchor terms the user actually types rather than the value they have forgotten.
  const passLexScores = new Float64Array(entries.length);
  const evidenceRowsLex = new Map<number, number[]>();
  if (PASSAGE_RETRIEVAL_ENABLED) {
    try {
      const store = passageStore ?? loadPassageStore();
      const lexicon = loadPassageLexicon();
      if (store && lexicon) {
        passageStore = store;
        const rowScores = lexicon.scoreRows(lexTokens(message));
        if (rowScores.size) {
          const hits = store.rollupRows(rowScores);
          for (const i of candidates) {
            const hit = hits.get(entries[i].session_id);
            if (!hit) continue;
            passLexScores[i] = hit.score;
            evidenceRowsLex.set(i, hit.rows);
          }
        }
      }
    } catch {
      // Fails open, same as the rest.
    }
  }

  // Signal 3 — Sha'ar/Shoresh. Exact shoresh beats shaar-only.
  const gateScores = new Float64Array(entries.length);
  try {
    const hits = gatesForQuery(message);
    if (hits.length) {
      const exact = new Set(hits.map((h) => `${h.shaar}/${h.shoresh}`));
      const shaarOnly = new Set(hits.map((h) => h.shaar));
      for (const i of candidates) {
        const e = entries[i];
        if (!e.shaar) continue;
        if (e.shoresh && exact.has(`${e.shaar}/${e.shoresh}`)) gateScores[i] = 2;
        else if (shaarOnly.has(e.shaar)) gateScores[i] = 1;
      }
    }
  } catch {
    // Gate layer degrades to nothing rather than breaking the turn.
  }

  // Signal 4 — recency, as a rank only.
  const recScores = new Float64Array(entries.length);
  const nowMs = Date.now();
  for (const i of candidates) {
    const t = Date.parse(entries[i].started_at || entries[i].date || "");
    recScores[i] = Number.isNaN(t) ? -Infinity : -((nowMs - t) / 86_400_000);
  }

  const rLex = rankMap(lexScores, candidates, 0);
  const rCos = rankMap(cosScores, candidates, 0);
  const rGate = rankMap(gateScores, candidates, 0);
  const rRec = rankMap(recScores, candidates);
  const rPass = rankMap(passScores, candidates, 0);

  const fused = candidates
    .map((i) => {
      let s = 0;
      if (rLex.has(i)) s += SIGNAL_WEIGHTS.lexical / (RRF_K + rLex.get(i)!);
      if (rCos.has(i)) s += SIGNAL_WEIGHTS.semantic / (RRF_K + rCos.get(i)!);
      if (rGate.has(i)) s += SIGNAL_WEIGHTS.gates / (RRF_K + rGate.get(i)!);
      if (rRec.has(i)) s += SIGNAL_WEIGHTS.recency / (RRF_K + rRec.get(i)!);
      if (rPass.has(i)) s += SIGNAL_WEIGHTS.passage / (RRF_K + rPass.get(i)!);
      return { i, s };
    })
    .sort((a, b) => b.s - a.s);

  const out: RetrievedSession[] = [];
  const chosen: string[] = [];

  /** Does this candidate clear a real evidence floor on the SUMMARY signals? */
  const summaryConfident = (i: number): boolean => {
    // Recency alone, or a gate hit alone, is not evidence — those only break
    // ties between real candidates. A session logged since the last embedding
    // pass has no vector yet; judging it on a cosine of 0 would make every new
    // conversation unreachable until the embedder next runs, which is the exact
    // class of silent-staleness bug this rebuild exists to remove. Those fall
    // back to the lexical floor.
    const embedded = semanticLive && (store?.has(entries[i].session_id) ?? false);
    return embedded
      ? cosScores[i] >= MIN_COSINE ||
          (lexScores[i] >= STRONG_BM25 && cosScores[i] >= STRONG_BM25_MIN_COSINE)
      : lexScores[i] >= STRONG_BM25;
  };

  // H-046: collapse a duplicate cluster to whichever member ranks best on THIS
  // question. Complements the cosine check below rather than replacing it —
  // that one catches conversations whose summaries read alike, this one catches
  // records proven identical by provenance or byte-identical passages, which
  // summary cosine misses whenever the two got different episode titles.
  const clusters = CLUSTER_COLLAPSE_ENABLED ? loadClusterMap() : null;
  const chosenClusters = new Set<number>();

  // H-047: a machine-generated session is suppressed ONLY when a real record of
  // the same material is also on the table. Blanket exclusion was measured
  // first and failed the guard — 28/40 to 26/40 — because two of the forty
  // harness questions target a summarizer copy whose source never ranks, so
  // removing the copy removes the only route to that conversation. Demoting
  // instead of deleting keeps those reachable while stopping a copy from
  // taking the slot when the real conversation is right there.
  const realSiblingAvailable = new Set<number>();
  if (clusters && DEMOTE_MACHINERY) {
    const realByCluster = new Map<number, boolean>();
    for (const i of candidates) {
      const id = entries[i].session_id;
      const c = clusters.clusterOf(id);
      if (c === null || clusters.isMachinery(id)) continue;
      realByCluster.set(c, true);
    }
    for (const [c, has] of realByCluster) if (has) realSiblingAvailable.add(c);
  }
  const suppressedAsCopy = (i: number): boolean => {
    if (!clusters || !DEMOTE_MACHINERY) return false;
    const id = entries[i].session_id;
    if (!clusters.isMachinery(id)) return false;
    const c = clusters.clusterOf(id);
    return c !== null && realSiblingAvailable.has(c);
  };

  const isDuplicate = (id: string): boolean => {
    if (clusters) {
      const c = clusters.clusterOf(id);
      if (c !== null && chosenClusters.has(c)) return true;
    }
    return !!store && chosen.some((prev) => store!.pairwise(prev, id) >= DEDUPE_COSINE);
  };

  const rejected = (i: number): boolean => suppressedAsCopy(i) || isDuplicate(entries[i].session_id);

  const admit = (i: number, s: number): void => {
    const e = entries[i];
    chosen.push(e.session_id);
    if (clusters) {
      const c = clusters.clusterOf(e.session_id);
      if (c !== null) chosenClusters.add(c);
    }
    // Which layer's passage do we quote? Prefer BM25's when it cleared its
    // floor: clearing it means a rare term from the question appears verbatim
    // in that passage, so the forgotten value is usually a line or two away.
    // The vector layer's best passage is merely the most topically similar,
    // which is a weaker claim about where the answer sits.
    const lexFired = passLexScores[i] >= MIN_PASSAGE_BM25;
    const picked = (lexFired ? evidenceRowsLex.get(i) : undefined) ?? evidenceRows.get(i);
    const hasEvidence = lexFired || passScores[i] >= MIN_PASSAGE_COSINE;
    const rows = passageStore ? selectEvidenceRows(picked, passageStore, message) : picked;
    out.push({
      entry: e,
      score: s,
      breakdown: {
        total: s,
        lexical: +lexScores[i].toFixed(2),
        semantic: +cosScores[i].toFixed(3),
        gate: gateScores[i],
        passage: +passScores[i].toFixed(3),
        passageLexical: +passLexScores[i].toFixed(2),
      },
      evidence:
        passageStore && rows && hasEvidence
          ? rows.map((r) => passageStore!.text(r)).filter(Boolean)
          : undefined,
    });
  };

  // ── Pass 1: the summary path, in exactly the order it produces today. ──────
  // It keeps every slot except the reserved one, so its top results cannot be
  // displaced by the passage layer.
  const summaryBudget = Math.max(1, k - (passageStore ? PASSAGE_RESERVED_SLOTS : 0));
  for (const { i, s } of fused) {
    if (out.length >= summaryBudget) break;
    if (!summaryConfident(i)) continue;
    if (rejected(i)) continue;
    admit(i, s);
  }

  // ── Pass 2: the reserved slot — a conversation the summary path missed. ────
  // Ranked by passage cosine, which is the statistic the passage layer is
  // actually good at: "is the answer in here", not "is this the right topic".
  if (passageStore && out.length < k) {
    // Two passage layers, two disjoint failure modes: the vector layer finds
    // "the answer is in here somewhere", BM25 finds the rare anchor term the user
    // typed. A candidate qualifies on EITHER floor. Ordering is rank fusion
    // over the two, so a BM25 score of 31 and a cosine of 0.58 never have to be
    // calibrated against one another.
    const rPassCos = rankMap(passScores, candidates, 0);
    const rPassLex = rankMap(passLexScores, candidates, 0);
    const rescueScore = (i: number): number => {
      let s = 0;
      if (rPassCos.has(i)) s += 1 / (RRF_K + rPassCos.get(i)!);
      if (rPassLex.has(i)) s += 1 / (RRF_K + rPassLex.get(i)!);
      return s;
    };
    const rescues = candidates
      .filter(
        (i) =>
          (passScores[i] >= MIN_PASSAGE_COSINE || passLexScores[i] >= MIN_PASSAGE_BM25) &&
          !chosen.includes(entries[i].session_id),
      )
      .sort((a, b) => rescueScore(b) - rescueScore(a));
    for (const i of rescues) {
      if (out.length >= k) break;
      if (rejected(i)) continue;
      admit(i, fused.find((f) => f.i === i)?.s ?? 0);
    }
  }

  // ── Pass 3: if the passage layer had nothing to say, the summary path gets
  // the reserved slot back. This is what makes the reservation free — we never
  // return fewer conversations than we did before.
  if (out.length < k) {
    for (const { i, s } of fused) {
      if (out.length >= k) break;
      if (chosen.includes(entries[i].session_id)) continue;
      if (!summaryConfident(i)) continue;
      if (rejected(i)) continue;
      admit(i, s);
    }
  }

  // Retrieval is deliberately read-only. Missing summaries are produced by
  // the transactional session publisher, the sole owner of index.json writes.
  // A query path must never mutate the canonical corpus as a side effect.

  return out;
}

/**
 * The summary says what a conversation was about; the quote says what was
 * actually said. Injecting both is the difference between "we discussed the
 * price" and the price itself.
 *
 * Budget-bounded on purpose: this rides on EVERY turn, so one passage per
 * conversation, hard-capped. Retrieval that doubles the prompt to prove a point
 * is a regression no matter what the hit-rate says.
 *
 * The cap sits just above the p90 passage length (1,241 chars) rather than at a
 * rounder, smaller number. Truncating mid-passage would cut the answer out of
 * the quote in exactly the cases this layer exists for — and a quote that stops
 * one line above the number the user asked for is worse than useless, because it
 * looks like the memory was retrieved and failed to contain it.
 */
const EVIDENCE_CHAR_CAP = 1400;

/**
 * How many passages we quote per conversation, and the total character budget
 * across them.
 *
 * ONE, measured rather than assumed. The detail harness showed three cases of
 * "right conversation retrieved, but the passage that matched the QUESTION is
 * not the passage holding the ANSWER", so quoting the runner-up looked like a
 * free recovery. It was tried: containment stayed at 13/26 and the injected
 * context grew by roughly 350 tokens a turn. The answer in those three cases
 * lives further down the conversation than the second-best passage reaches.
 * The knob stays because the fix for them is better passage selection, not a
 * bigger quota — raising this without moving the number is just a tax.
 */
// ONE passage per conversation. This rides on every turn: at two passages the
// mean injected context measured 5,722 characters against a 1,189-character
// baseline — a 5x prompt tax on every message the user sends, most of it paid on
// turns that are not memory questions at all. One well-chosen passage is the
// whole benefit; the second was mostly padding.
const EVIDENCE_MAX_PASSAGES = 2;
const EVIDENCE_TOTAL_CHAR_CAP = 2600;

/**
 * Answer-type-aware evidence selection.
 *
 * The failure this fixes: the right conversation is retrieved — sometimes at
 * rank 1 — and the quoted passage still doesn't contain the answer. "What
 * version of the runtime did we install on the server" matches the passage
 * about setting up the server, while the version string itself sits in a
 * different passage of the same conversation.
 *
 * Ranking by similarity cannot fix that: the passage holding a bare version
 * string has almost no anchor terms in it. But we know something about the
 * ANSWER even though we don't know the answer — the user asked "what version", so
 * the passage we want contains something SHAPED like a version.
 *
 * So: among a handful of candidate passages from the same conversation, prefer
 * one whose text contains a token of the shape the question asked for. Falls
 * straight back to the best-scoring passage when the question implies no shape
 * or nothing matches, which is the common case for ordinary turns.
 *
 * Caveat: the pattern table is a heuristic for common question types, not
 * derived from anything general; extend it for the questions your users ask.
 */
const ANSWER_SHAPES: { asks: RegExp; shape: RegExp }[] = [
  { asks: /\bport\b/i, shape: /\bport\s+\d{2,5}\b|\b\d{4,5}\b/ },
  { asks: /\bversion\b|\bwhat version\b/i, shape: /\bv?\d+\.\d+(?:\.\d+)?\b/ },
  { asks: /\bprocess id\b|\bpid\b|\bparent process\b/i, shape: /\b\d{4,7}\b/ },
  { asks: /\bmsrp\b|\bprice\b|\bcost\b|\bpayment\b|\bincome\b|\bdeposit\b|\bhow much\b|\bdealer cash\b/i, shape: /\$\s?\d[\d,]*(?:\.\d{2})?/ },
  { asks: /\btoken count\b|\btokens\b/i, shape: /\b\d[\d,]*\s?tokens?\b/ },
  { asks: /\bwhat time\b|\btimestamp\b/i, shape: /\b\d{1,2}[:.]\d{2}\b/ },
  { asks: /\bfile size\b|\bhow (?:big|large)\b|\bdisk space\b|\bstorage\b/i, shape: /\b\d+(?:\.\d+)?\s?(?:bytes|KB|MB|GB|TB)\b|\b\d{6,}\b/i },
  { asks: /\bevent id\b|\bupload id\b|\bid\b/i, shape: /\b\d{6,}\b/ },
];

function selectEvidenceRows(
  picked: number[] | undefined,
  store: PassageStore,
  question: string,
): number[] | undefined {
  if (!picked?.length) return picked;

  // Candidates: each matched passage plus the one after it. The value the user
  // forgot often lands in the reply that follows the passage they'd recognise.
  const candidates: number[] = [];
  for (const r of picked) {
    if (!candidates.includes(r)) candidates.push(r);
    const n = store.nextRow(r);
    if (n !== null && !candidates.includes(n)) candidates.push(n);
  }

  const shape = ANSWER_SHAPES.find((s) => s.asks.test(question))?.shape;
  if (!shape) return candidates.slice(0, EVIDENCE_MAX_PASSAGES);

  const withShape = candidates.filter((r) => shape.test(store.text(r)));
  if (!withShape.length) return candidates.slice(0, EVIDENCE_MAX_PASSAGES);
  // Quote the answer-shaped passage FIRST, not the best-scoring one. When the
  // question asked for a version and exactly one candidate contains something
  // shaped like a version, that passage is the answer and the other is context
  // we are paying for by the token.
  const ordered = [...withShape, ...candidates.filter((r) => !withShape.includes(r))];
  return ordered.slice(0, EVIDENCE_MAX_PASSAGES);
}

function quoteEvidence(evidence: string[] | undefined): string | null {
  if (!evidence?.length) return null;
  const quoted: string[] = [];
  let budget = EVIDENCE_TOTAL_CHAR_CAP;
  for (const raw of evidence.slice(0, EVIDENCE_MAX_PASSAGES)) {
    let text = raw?.trim();
    if (!text) continue;
    const cap = Math.min(EVIDENCE_CHAR_CAP, budget);
    if (cap < 200) break;
    if (text.length > cap) {
      text = text.slice(0, cap);
      // End on a sentence if there is one nearby, rather than mid-word.
      const cut = text.lastIndexOf(". ");
      text = (cut > cap * 0.6 ? text.slice(0, cut + 1) : text) + " […]";
    }
    budget -= text.length;
    quoted.push(text.split("\n").map((l) => `> ${l}`).join("\n"));
  }
  return quoted.length ? quoted.join("\n>\n") : null;
}

export async function getRelevantContext(
  agent: string,
  message: string,
  principal: string | null = null,
): Promise<string> {
  // ── H-046 step 4: the gates go first. ──────────────────────────────────────
  //
  // The layering: the fact layer narrows by address —
  // Sha'ar then Shoresh — and nothing else; the session, vector and passage
  // layers below it are the FALLBACK for what the addressing did not reach,
  // rather than five signals voting in parallel with the gate at weight 0.4.
  //
  // Ordering, not starvation, is how the demotion is expressed. Cutting the
  // session budget to pay for this block was considered and rejected on
  // measurement grounds: the 40-question guard calls `rankSessions` directly
  // with k=3, so a change made only inside this function is invisible to it —
  // an unmeasurable change is exactly what the cost rule above forbids. The
  // facts block is instead capped hard (FACT_CHAR_CAP) and its per-turn cost is
  // reported next to the detail harness that has to justify it.
  //
  // Fails open twice over: `factsForQuery` catches its own errors, and this
  // wrapper catches anything that escapes — including the injected fault the
  // style-card test uses. A broken fact layer costs the facts block and nothing
  // else.
  let factBlock = "";
  if (FACT_RETRIEVAL_ENABLED) {
    try {
      factBlock = formatFacts(factsForQuery(message));
    } catch (err) {
      factStats.errors++;
      factStats.lastError = (err as Error).message;
      factBlock = "";
    }
  }

  let ranked: RetrievedSession[];
  try {
    ranked = await rankSessions(agent, message, TOP_K, principal);
  } catch (err) {
    console.warn(`[retrieval] rank failed for ${agent}: ${(err as Error).message}`);
    // The addressing layer is not a casualty of a session-layer failure — if the
    // gates reached something, the turn still gets it.
    return factBlock;
  }

  // At most ONE quote per turn, given to the conversation with the strongest
  // passage signal. Containment only ever needs the one right conversation
  // quoted, and quoting all three measured at ~920 tokens a turn against a
  // ~297-token baseline — two thirds of that spent on conversations that were
  // already explained by their summary. Scores are normalised by their own
  // floors so a BM25 of 31 and a cosine of 0.58 can be compared at all.
  // It goes to the conversation with the strongest PASSAGE signal, which is
  // not always the highest-ranked one. Giving it to the top-ranked conversation
  // with evidence was tried and measured worse — 15/26 to 10/26 — because the
  // conversation holding the answer is at rank 1 only 2 times in 26; it is
  // usually second or third, and the quote would go to whatever outranked it.
  // The fusion ranks by what a conversation was ABOUT; the passage score is the
  // only signal that speaks to where the ANSWER is.
  let quoteFor: string | null = null;
  let bestSignal = 0;
  for (const r of ranked) {
    if (!r.evidence?.length) continue;
    const signal = Math.max(
      (r.breakdown.passageLexical ?? 0) / MIN_PASSAGE_BM25,
      (r.breakdown.passage ?? 0) / MIN_PASSAGE_COSINE,
    );
    if (signal > bestSignal) {
      bestSignal = signal;
      quoteFor = r.entry.session_id;
    }
  }

  const blocks: string[] = [];
  const historical = historicalLabelContext(agent);
  for (const { entry, evidence } of ranked) {
    const summary = entry.summary?.trim();
    // A conversation can now earn its place on passage evidence alone, so a
    // missing summary is no longer disqualifying — but a block with neither a
    // summary nor a quote carries no information and is dropped.
    const quote = entry.session_id === quoteFor ? quoteEvidence(evidence) : null;
    if (!summary && !quote) continue;
    const date = historical
      ? sessionLocalDate(entry, historical)
      : (entry.date || entry.started_at || "").slice(0, 10) || "unknown";
    const parts = [`### ${entry.episode_name} — ${date}`];
    if (summary) parts.push(summary);
    if (quote) parts.push(quote);
    blocks.push(historical ? labelRetrievedSession(entry, parts.join("\n"), historical) : parts.join("\n"));
  }

  // Facts lead; the conversations that the addressing did not reach follow, and
  // are labelled as the fallback they now are.
  //
  // When addressing DID reach something, the fallback gives a slot back. This is
  // what makes the layer free at turn time rather than a 600-character tax on
  // every message — the rule is that a change the harnesses score as
  // neutral ships only if it costs nothing, and a facts block bolted on top of
  // an unchanged session block is not that.
  //
  // The ruler for this trade is the DETAIL harness, not the 40-question guard.
  // The guard calls `rankSessions` directly and asks whether the right episode
  // is in the top three; how many of those three the hook then formats is
  // invisible to it. Containment scores exactly this function's output, so if
  // dropping the third conversation costs an answer, the detail harness is the
  // thing that says so. Measured: containment unchanged, mean injected context
  // back to the pre-facts baseline.
  const keep = factBlock ? Math.max(1, blocks.length - FACT_SLOT_TRADE) : blocks.length;
  const kept = blocks.slice(0, keep);
  const sessionBlock = kept.length ? `## Recent Context\n\n${kept.join("\n\n")}` : "";
  if (factBlock && sessionBlock) return `${factBlock}\n\n${sessionBlock}`;
  return factBlock || sessionBlock;
}
