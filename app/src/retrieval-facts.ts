/**
 * retrieval-facts.ts — H-046 Lane C. Step 4 of the brief: retrieval walks the
 * gates FIRST.
 *
 * The design constraint: the four capabilities are layered into the
 * Sha'ar/Shoresh structure so retrieval happens in a calculated, fixed
 * sequence rather than by chance. Elsewhere the gate signal
 * is one of five fused signals at weight 0.4 — it influences the ranking, it does
 * not decide it. That is parallel, not layered.
 *
 * This module is where the gate DECIDES. The narrowing is:
 *
 *     query → Sha'ar (gate) → Shoresh (root) → open facts → rank
 *
 * A fact that is not filed at a gate the query names is never scored, never
 * compared, never seen. Lexical similarity only orders what addressing already
 * admitted, and the vector and BM25 passage layers are not consulted at all —
 * they run afterwards in `retrieval.ts` as the fallback for what the addressing
 * did not reach. Sha'ar narrows, Shoresh pinpoints.
 *
 * WHY THIS IS CHEAP ENOUGH TO RUN ON EVERY TURN
 *
 * The standing rule: a change the harnesses score as neutral ships only if it
 * is free at turn time, and anything with a per-turn cost must show a number.
 * A store of several thousand facts (~10 MB) parses in ~100 ms — far too much for a
 * hook that sits in front of the user's first byte. So the store is written as one
 * shard per address pair and a turn reads only the shards its gates name:
 * usually one or two of 59, the largest of which parses in ~4 ms. The gate-first
 * architecture is not just faithful to the brief, it is what makes the layer
 * affordable.
 *
 * FAIL-OPEN, like every other layer on this path. A missing, corrupt or
 * unreadable store degrades the turn to the session and passage layers. It never
 * throws into the turn — `factStats.errors` is what surfaces instead, the same
 * contract `episodeStats` already has, and the style-card regression test drives
 * a real corrupt store through it to prove the voice card survives.
 */

import { existsSync, readFileSync, statSync } from "fs";
import { resolve } from "path";

import { gatesForQuery, type GateHit } from "./shaar-shoresh.js";
import { ahiSessionsRoot } from "./multi-user-paths.js";

/**
 * OFF by default for the whole of this build, so the live hook served the
 * unchanged path while the layer was measured — the same discipline H-044 used
 * for the passage layer. Flipped at cutover, once the detail harness, the
 * style-card test and the 40-question guard have all been read.
 */
export const FACT_RETRIEVAL_ENABLED = (process.env.AHI_FACT_RETRIEVAL ?? "0") !== "0";

// AHI_FACT_STORE is a fine-grained override for the facts store specifically.
// When unset, the default derives from ahiSessionsRoot() so that AHI_SESSIONS_ROOT
// moves the whole corpus including facts without needing a second override.
const STORE_DIR =
  process.env.AHI_FACT_STORE ?? resolve(ahiSessionsRoot(), "facts-v2/store");

/** How many facts a turn may inject. */
const TOP_FACTS = Number(process.env.FACT_TOP_K ?? 4);

/**
 * A fact has to actually answer something to be worth its tokens. This is the
 * floor on lexical agreement between the query and the fact, measured only
 * WITHIN the gate's candidates — it orders, it does not admit. Set so that a
 * greeting at a matching gate injects nothing: "hi" tokenises to nothing and
 * never reaches here, but "how are the kids" would otherwise pull four family
 * facts on overlap of a single stopword-adjacent term.
 */
const MIN_FACT_SCORE = Number(process.env.MIN_FACT_SCORE ?? 1.5);

/** Total characters of fact text a turn may carry. */
const FACT_CHAR_CAP = Number(process.env.FACT_CHAR_CAP ?? 900);

export interface StoredFact {
  fact_id: string;
  statement: string;
  kind: string;
  opened_at: string | null;
  closed_at: string | null;
  session_id: string | null;
  episode: string | null;
  learned_count: number;
}

export interface RankedFact extends StoredFact {
  score: number;
  weight: number;
  gate: string;
}

/** Mirrors `episodeStats`: the CLI logs these so a silent degradation is visible. */
export const factStats = {
  loads: 0,
  cacheHits: 0,
  errors: 0,
  lastError: "" as string,
};

interface ShardCache {
  mtimeMs: number;
  size: number;
  rows: StoredFact[];
  /** Document frequency WITHIN this gate — see `scoreFact`. */
  df: Map<string, number>;
  terms: Map<string, Set<string>>;
}
const shardCache = new Map<string, ShardCache>();

interface MapCache {
  mtimeMs: number;
  size: number;
  value: Record<string, string>;
}
let shardMap: MapCache | null = null;

interface WeightCache {
  mtimeMs: number;
  size: number;
  value: Record<string, { weight: number }>;
}
let weightCache: WeightCache | null = null;

export function resetFactCache(): void {
  shardCache.clear();
  shardMap = null;
  weightCache = null;
}

function loadShardMap(): Record<string, string> | null {
  const path = resolve(STORE_DIR, "shards.json");
  const st = statSync(path);
  if (shardMap && shardMap.mtimeMs === st.mtimeMs && shardMap.size === st.size) return shardMap.value;
  const value = JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
  shardMap = { mtimeMs: st.mtimeMs, size: st.size, value };
  return value;
}

function loadShard(file: string): ShardCache {
  const path = resolve(STORE_DIR, "gates", file);
  const st = statSync(path);
  const cached = shardCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    factStats.cacheHits++;
    return cached;
  }
  const rows = readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as StoredFact);
  // Document frequency is computed per SHARD, not per store, and that is the
  // point: inside the gate for infrastructure, "gateway" is in half the facts
  // and carries no information, while "61302" is in one. A global IDF would
  // rate "gateway" rare because most of the corpus is not infrastructure, which
  // is the opposite of what this layer needs.
  const df = new Map<string, number>();
  const terms = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = new Set(termsOf(row.statement));
    terms.set(row.fact_id, set);
    for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const entry: ShardCache = { mtimeMs: st.mtimeMs, size: st.size, rows, df, terms };
  shardCache.set(file, entry);
  factStats.loads++;
  return entry;
}

/**
 * Capability 4's read path. A missing weight is 1.0, so the file may be absent
 * and the layer behaves exactly as it did before feedback existed.
 */
function weightFor(id: string): number {
  try {
    const path = resolve(STORE_DIR, "weights.json");
    if (!existsSync(path)) return 1;
    const st = statSync(path);
    if (!weightCache || weightCache.mtimeMs !== st.mtimeMs || weightCache.size !== st.size) {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as { weights?: Record<string, { weight: number }> };
      weightCache = { mtimeMs: st.mtimeMs, size: st.size, value: parsed.weights ?? {} };
    }
    return weightCache.value[id]?.weight ?? 1;
  } catch {
    return 1;
  }
}

const STOPWORDS = new Set(
  ("a an the and or but if then than that this these those is are was were be been being am to of in on at by for " +
    "with from into over under after before during as it its his her their he she they we you i not no so such only " +
    "just also very can could should would will shall may might must do does did done have has had there here when " +
    "where which who what how why all any both each few more most other some same too what's whats did what did").split(/\s+/),
);

function termsOf(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9א-ת]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Answer-shape preference, the same trick `retrieval.ts` uses to pick which
 * passage to quote, and it earns its place here for the same measured reason:
 * we do not know the answer, but the question tells us its SHAPE. "What process
 * id" wants a fact containing something shaped like a pid. Inside a gate holding
 * 1,400 facts about the gateway, that is most of the discrimination there is —
 * the first cut ranked by word overlap alone and the fact carrying PID 61302
 * did not make the top four, because every fact in that shard says "gateway".
 */
const ANSWER_SHAPES: { asks: RegExp; shape: RegExp }[] = [
  { asks: /\bport\b/i, shape: /\bport\s+\d{2,5}\b|\b\d{4,5}\b/ },
  { asks: /\bversion\b/i, shape: /\bv?\d+\.\d+(?:\.\d+)?\b/ },
  { asks: /\bprocess id\b|\bpid\b|\bparent process\b/i, shape: /\b\d{4,7}\b/ },
  { asks: /\bmsrp\b|\bprice\b|\bcost\b|\bpayment\b|\bincome\b|\bdeposit\b|\bhow much\b/i, shape: /\$\s?\d[\d,]*(?:\.\d{2})?/ },
  { asks: /\btoken count\b|\btokens\b/i, shape: /\b\d[\d,]*\s?tokens?\b/ },
  { asks: /\bwhat time\b|\btimestamp\b/i, shape: /\b\d{1,2}[:.]\d{2}\b/ },
  { asks: /\bfile size\b|\bhow (?:big|large)\b|\bdisk space\b/i, shape: /\b\d+(?:\.\d+)?\s?(?:bytes|KB|MB|GB|TB)\b/i },
  { asks: /\bevent id\b|\bupload id\b/i, shape: /\b\d{6,}\b/ },
];

const SHAPE_BONUS = 1.8;

/**
 * Rank inside the gate. This is ORDERING, not admission — the gate already
 * decided who is in the room. IDF is computed within the shard so that a term
 * which is everywhere at this address counts for nothing and a term which
 * appears once counts for a lot.
 */
function scoreFact(queryTerms: string[], fact: StoredFact, shard: ShardCache, shape: RegExp | null): number {
  if (!queryTerms.length) return 0;
  const hay = shard.terms.get(fact.fact_id);
  if (!hay) return 0;
  const n = shard.rows.length;
  let score = 0;
  for (const t of queryTerms) {
    if (!hay.has(t)) continue;
    score += Math.log(1 + n / (shard.df.get(t) ?? 1));
  }
  if (score === 0) return 0;
  if (shape && shape.test(fact.statement)) score *= SHAPE_BONUS;
  // A fact the user arrived at twice in different conversations is more load-bearing
  // than one said once in passing.
  return score * (1 + Math.min(0.3, 0.1 * (fact.learned_count - 1)));
}

/**
 * The gate walk. Returns the facts this query addresses, most relevant first.
 *
 * Narrowing is two-stage on purpose, and the stages are the brief's two words:
 *   Sha'ar narrows  — exact gate/root pairs the query names.
 *   Shoresh pinpoints — if no exact pair is filed, fall back to every root under
 *                       the gates that matched, which is a wider room but still
 *                       a room addressing chose.
 * If neither reaches anything, this layer returns nothing and says so, and the
 * passage and lexical layers carry the turn.
 */
export function factsForQuery(query: string, gateHits?: GateHit[]): RankedFact[] {
  if (!FACT_RETRIEVAL_ENABLED) return [];
  // Fault injection. The brief's gate list requires fail-open to be VERIFIED by
  // fault injection rather than argued from the shape of the code, and a
  // corrupt-store test only proves the internal catch works. `AHI_FACT_FAULT=throw`
  // makes this layer fail the way a future bug would — out of the function,
  // past its own handler — so the style-card test can prove the voice card and
  // the turn survive even then. Never set in production.
  if (process.env.AHI_FACT_FAULT === "throw") {
    throw new Error("injected fact-layer fault");
  }
  try {
    const hits = gateHits ?? gatesForQuery(query);
    if (!hits.length) return [];

    const map = loadShardMap();
    if (!map) return [];

    // Stage 1 — exact Sha'ar/Shoresh.
    const pairs = new Set<string>();
    for (const h of hits) {
      const pair = `${h.shaar}/${h.shoresh}`;
      if (map[pair]) pairs.add(pair);
    }
    // Stage 2 — the gate alone, when no exact pairing is filed.
    if (!pairs.size) {
      const shaarim = new Set(hits.map((h) => h.shaar));
      for (const pair of Object.keys(map)) {
        if (shaarim.has(pair.split("/")[0])) pairs.add(pair);
      }
    }
    if (!pairs.size) return [];

    const queryTerms = termsOf(query);
    const shape = ANSWER_SHAPES.find((s) => s.asks.test(query))?.shape ?? null;
    const bestById = new Map<string, RankedFact>();
    for (const pair of pairs) {
      const shard = loadShard(map[pair]);
      for (const fact of shard.rows) {
        // Capability 2: history is preserved in the store, retrieval only sees
        // what is current. A closed fact is never a candidate.
        if (fact.closed_at) continue;
        const base = scoreFact(queryTerms, fact, shard, shape);
        if (base <= 0) continue;
        const weight = weightFor(fact.fact_id);
        const score = base * weight;
        if (score < MIN_FACT_SCORE) continue;
        // Capability 3: one fact can be reached through several gates. It is
        // still one fact, so it takes its best gate and one slot, not several.
        const prev = bestById.get(fact.fact_id);
        if (!prev || score > prev.score) bestById.set(fact.fact_id, { ...fact, score, weight, gate: pair });
      }
    }

    return [...bestById.values()]
      .sort((a, b) => b.score - a.score || String(b.opened_at).localeCompare(String(a.opened_at)))
      .slice(0, TOP_FACTS);
  } catch (err) {
    factStats.errors++;
    factStats.lastError = (err as Error).message;
    return [];
  }
}

/**
 * The block that goes into the turn. Facts lead, because they are the layer that
 * was addressed rather than the layer that was searched — and each one carries
 * the gate it was reached through, so a wrong answer can be traced to a wrong
 * address instead of to "retrieval".
 */
export function formatFacts(facts: RankedFact[]): string {
  if (!facts.length) return "";
  const lines: string[] = [];
  let budget = FACT_CHAR_CAP;
  for (const f of facts) {
    const when = f.opened_at ? ` (${f.opened_at})` : "";
    const line = `- [${f.gate}] ${f.statement}${when}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.push(line);
  }
  if (!lines.length) return "";
  return `<facts source="shaar-shoresh" note="filed facts reached by walking the gate; current only">\n${lines.join("\n")}\n</facts>`;
}
