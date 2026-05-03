import { readFileSync, existsSync } from "fs";
import { spawn } from "child_process";
import { atomicWriteJson, multiUserPaths } from "./multi-user-paths.js";
// Re-exported for external callers that want a retrieval-safe view of the
// message store. The scoring pipeline below operates on the sessions index,
// not the raw message store — but we re-export this helper so any future
// corpus-load path has an obvious, filter-applied entry point.
export { getMessagesForRetrieval } from "./message-store.js";

const PRIMARY_INDEX_PATH = multiUserPaths("primary").sessionsIndex;

export interface IndexEntry {
  session_id: string;
  agent: string;
  category: string | null;
  episode_name: string | null;
  started_at: string;
  transcript_path_md?: string;
  // Pre-computed session summary (populated on session-log path going
  // forward). When present, retrieval uses this directly instead of spawning
  // a per-turn Haiku summarize call — saving ~2-8s per retrieved session on
  // the pre-first-byte path.
  summary?: string;
  // When true, the session JSONL was contaminated by something other than a
  // real user turn (e.g. /ui/send test injection) and its contents must
  // never be scored or summarized into retrieval context.
  tainted?: boolean;
  tainted_reason?: string;
}

// ── Access control ────────────────────────────────────────────────────────────

const ALL_CATEGORIES = [
  "ahi-infrastructure",
  "personal",
  "voice-work",
  "general",
];

// Strict allowlist per agent. Restricted agents see ONLY their own category —
// "general" is deliberately excluded for restricted agents to prevent
// classifier slop from leaking cross-context content. Michael and Tzali
// legitimately see everything. Unknown agents deny by default.
export function agentAllowedCategories(agent: string): string[] {
  switch (agent.toLowerCase()) {
    case "michael":
    case "tzali":
      return ALL_CATEGORIES;
    case "avi":
      return ["ahi-infrastructure"];
    case "eliyahu":
      return ["personal"];
    case "miriam":
      return ["personal"];
    default:
      return [];
  }
}

// ── Scoring ───────────────────────────────────────────────────────────────────

// Keywords that suggest a given category in the incoming message. Generic
// shell uses minimal categories; users can extend in their own deployment.
const CATEGORY_SIGNALS: Record<string, string[]> = {
  "ahi-infrastructure": ["gateway", "streaming", "telegram", "agent", "session", "deployment", "claude", "soul", "mission control"],
  "personal": ["family", "personal", "feeling", "relationship"],
  "voice-work": ["voice", "tts", "audio", "speech"],
};

// Short stopwords we want to ignore when tokenizing the query/episode name.
// Stays at ≥3 chars so real content words like "bot" survive.
const STOPWORDS = new Set([
  "the", "and", "for", "but", "not", "you", "any", "are", "can", "did",
  "was", "with", "how", "what", "when", "where", "why", "our", "out", "all",
  "has", "had", "his", "her", "its", "let", "this", "that", "from", "been",
  "have", "were", "who", "use", "get", "one", "two", "about", "into", "over",
  "just", "than", "then", "your", "will", "they", "them",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// Exponential recency decay. Half-life = 3 days, peak weight = 6.
//   today → ~6.0
//   3 days → 3.0
//   7 days → ~1.0
//   14 days → ~0.26
// A same-day session beats a week-old session by ~5 points — enough to
// dominate a single category-signal hit (now +1) or one episode keyword
// (+2) on its own, but not enough to swamp a strong multi-keyword match.
function recencyScore(startedAt: string | undefined): number {
  if (!startedAt) return 0;
  const days = (Date.now() - new Date(startedAt).getTime()) / 86_400_000;
  if (!Number.isFinite(days) || days < 0) return 0;
  return 6 * Math.pow(0.5, days / 3);
}

export interface ScoreBreakdown {
  total: number;
  recency: number;
  relevance: number; // episode-name matches + category-signal, i.e. everything non-recency
}

export function scoreEntryDetailed(entry: IndexEntry, message: string): ScoreBreakdown {
  const msgLower = message.toLowerCase();

  // Recency (exponential, half-life 3 days, peak ~6)
  const recency = recencyScore(entry.started_at);

  // Episode-name keyword overlap — first-class component. A literal word
  // overlap between the query and the episode name beats a fuzzy category
  // signal almost every time.
  const msgTokens = new Set(tokenize(message));
  const epTokens = tokenize(entry.episode_name ?? "");
  let epScore = 0;
  let epMatches = 0;
  for (const tok of epTokens) {
    if (msgTokens.has(tok)) {
      epScore += 3;
      epMatches++;
    }
  }
  // Two or more episode-name keyword hits is a strong relevance signal —
  // give an extra bump so it pulls clearly ahead of single-signal rivals.
  if (epMatches >= 2) epScore += 2;

  // Category-signal boost: reduced from +2 to +1. Still useful for
  // tie-breaking inside a category, but no longer strong enough to make a
  // topically-adjacent session outrank one with a real episode-name match.
  let catScore = 0;
  const signals = entry.category ? CATEGORY_SIGNALS[entry.category] ?? [] : [];
  for (const sig of signals) {
    if (msgLower.includes(sig)) {
      catScore = 1;
      break; // one boost per category match
    }
  }

  // Penalize unfiled fallbacks
  const penalty = (entry.episode_name ?? "").includes("Unclassified") ? -5 : 0;

  const relevance = epScore + catScore + penalty;
  return { total: recency + relevance, recency, relevance };
}

export function scoreEntry(entry: IndexEntry, message: string): number {
  return scoreEntryDetailed(entry, message).total;
}

// Minimum TOTAL score to surface a session — floor below which we prefer
// silence over noise. Calibrated against the recency curve: a session from
// today scores ~6 on recency alone, so 4 admits sessions roughly up to
// 4-5 days old that also carry a non-recency signal.
export const MIN_SCORE_THRESHOLD = 5;

// Minimum non-recency score required on top of the recency component. A
// pure-recency hit (today's sessions with no topical match) would otherwise
// ride in on timestamp alone and surface "everything from today" — not
// useful. Requiring ≥1 relevance point means at minimum a category-signal
// hit; pure recency is rejected.
export const MIN_RELEVANCE_SCORE = 1;

// ── Claude CLI helper ────────────────────────────────────────────────────────

function callHaiku(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      ["-p", "--model", "claude-haiku-4-5-20251001", "--output-format", "text"],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => proc.kill("SIGTERM"), 30_000);

    proc.stdin.write(prompt);
    proc.stdin.end();
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`haiku exit ${code}: ${stderr.slice(0, 200)}`));
    });
    proc.on("error", reject);
  });
}

function buildSummarizePrompt(entry: IndexEntry): string | null {
  const mdPath = entry.transcript_path_md;
  if (!mdPath || !existsSync(mdPath)) return null;
  let content: string;
  try {
    content = readFileSync(mdPath, "utf-8");
  } catch {
    return null;
  }
  const capped = content.slice(0, 4000);
  return `Summarize this AI conversation session as 3-5 bullet points for context injection.
Focus on: what was worked on or decided, and any open threads.

Session: ${entry.episode_name}

Transcript:
${capped}

Format (bullets only, no preamble):
- [point]
- open: [open thread, only if genuinely unresolved]`;
}

// Background-summarize queue: dedupe by session_id so we don't fire N Haiku
// spawns for the same session across overlapping turns. Result is persisted
// back to index.json for future turns to hit the cache.
const inFlightSummaries = new Set<string>();

function scheduleBackgroundSummarize(entry: IndexEntry, indexPath: string): void {
  if (!entry.session_id || inFlightSummaries.has(entry.session_id)) return;
  const prompt = buildSummarizePrompt(entry);
  if (!prompt) return;
  inFlightSummaries.add(entry.session_id);
  callHaiku(prompt)
    .then((summary) => {
      if (!summary || !summary.trim()) return;
      // Re-read the index to avoid clobbering writes from a concurrent path.
      try {
        const current = JSON.parse(readFileSync(indexPath, "utf-8")) as IndexEntry[];
        const idx = current.findIndex((e) => e.session_id === entry.session_id);
        if (idx === -1) return;
        current[idx].summary = summary.trim();
        atomicWriteJson(indexPath, current);
        console.log(`[retrieval] Background-summarized ${entry.session_id.slice(0, 8)} → cached (${summary.trim().length} chars)`);
      } catch (err) {
        console.warn(`[retrieval] Failed to persist background summary for ${entry.session_id.slice(0, 8)}: ${(err as Error).message}`);
      }
    })
    .catch((err) => {
      console.warn(`[retrieval] Background summarize failed for ${entry.session_id.slice(0, 8)}: ${(err as Error).message}`);
    })
    .finally(() => {
      inFlightSummaries.delete(entry.session_id);
    });
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function getRelevantContext(_agent: string, message: string): Promise<string> {
  const indexPath = PRIMARY_INDEX_PATH;
  if (!existsSync(indexPath)) return "";

  let entries: IndexEntry[];
  try {
    entries = JSON.parse(readFileSync(indexPath, "utf-8")) as IndexEntry[];
  } catch {
    return "";
  }

  const allowed = agentAllowedCategories(_agent);

  const eligible = entries.filter(
    (e) =>
      e.episode_name &&
      e.category &&
      allowed.includes(e.category) &&
      e.transcript_path_md &&
      existsSync(e.transcript_path_md) &&
      // Exclude tainted sessions — see IndexEntry.tainted comment.
      !e.tainted,
  );

  if (eligible.length === 0) return "";

  const top3 = eligible
    .map((e) => ({ entry: e, breakdown: scoreEntryDetailed(e, message) }))
    .sort((a, b) => b.breakdown.total - a.breakdown.total)
    .filter(
      (s) =>
        s.breakdown.total >= MIN_SCORE_THRESHOLD &&
        s.breakdown.relevance >= MIN_RELEVANCE_SCORE,
    )
    .slice(0, 3);

  if (top3.length === 0) return "";

  // Pre-first-byte path must not block on Haiku spawns. Only inject entries
  // whose summaries are already cached on the index. Entries without a
  // cached summary are skipped here and queued for background summarization
  // so a subsequent turn hits a warm cache.
  const blocks: string[] = [];
  for (const { entry } of top3) {
    const date = (entry.started_at ?? "").slice(0, 10) || "unknown";
    if (entry.summary && entry.summary.trim()) {
      blocks.push(`### ${entry.episode_name} — ${date}\n${entry.summary.trim()}`);
    } else {
      console.log(`[retrieval] No cached summary for ${entry.session_id.slice(0, 8)} (${entry.episode_name}) — skipping on fast path, scheduling background summarize`);
      scheduleBackgroundSummarize(entry, indexPath);
    }
  }

  if (blocks.length === 0) return "";

  return `## Recent Context\n\n${blocks.join("\n\n")}`;
}
