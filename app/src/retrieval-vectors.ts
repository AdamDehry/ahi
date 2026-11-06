/**
 * retrieval-vectors.ts — the semantic layer's storage and query path.
 *
 * Deliberately not a vector database. The archive is ~660 conversations at 512
 * dimensions: 1.3 MB of float32 that memory-maps in a single read, and a
 * brute-force scan over it costs well under a millisecond. A vector DB here
 * would be a dependency, a daemon, and a migration in exchange for nothing.
 *
 * The store is built by `infra/sessions/scripts/embed-sessions.mjs`, which is
 * incremental (re-embeds only rows whose text hash changed) and runs alongside
 * the hourly distiller.
 *
 * Everything in this module fails open. If the store is missing, stale, or the
 * embedding API is down, retrieval silently drops to lexical + gates.
 */
import { AI_ROOT } from "./ai-root.js";

import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { ahiSessionsRoot } from "./multi-user-paths.js";

const VECTOR_DIR = resolve(ahiSessionsRoot(), "vectors");
const META_PATH = `${VECTOR_DIR}/vectors.json`;
const BIN_PATH = `${VECTOR_DIR}/vectors.bin`;
const QUERY_CACHE_PATH = `${VECTOR_DIR}/query-cache.json`;

const EMBED_MODEL = "text-embedding-3-small";
const EMBED_DIM = 512;

export interface VectorStore {
  dim: number;
  count: number;
  /** Cosine between a query vector and one stored session. 0 if unknown. */
  similarity(query: Float32Array, sessionId: string): number;
  /** Cosine between two stored sessions. Used for result de-duplication. */
  pairwise(aId: string, bId: string): number;
  /**
   * Whether this session has a vector at all. A session logged since the last
   * embedder run has none — and "no vector" must not be scored as "semantically
   * distant", or every brand-new conversation would be unreachable until the
   * next embedding pass.
   */
  has(sessionId: string): boolean;
}

interface Cache {
  mtimeMs: number;
  size: number;
  store: VectorStore;
}
let cache: Cache | null = null;

export function loadVectorStore(): VectorStore | null {
  try {
    if (!existsSync(META_PATH) || !existsSync(BIN_PATH)) return null;
    const st = statSync(BIN_PATH);
    if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.store;

    const meta = JSON.parse(readFileSync(META_PATH, "utf-8")) as {
      model: string;
      dim: number;
      ids: string[];
    };
    if (meta.model !== EMBED_MODEL) return null;

    const buf = readFileSync(BIN_PATH);
    const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const dim = meta.dim;
    const rows = new Map<string, number>();
    meta.ids.forEach((id, i) => rows.set(id, i));

    const dot = (aOff: number, bOff: number): number => {
      let s = 0;
      for (let d = 0; d < dim; d++) s += vectors[aOff + d] * vectors[bOff + d];
      return s;
    };

    const store: VectorStore = {
      dim,
      count: meta.ids.length,
      similarity(query, sessionId) {
        const row = rows.get(sessionId);
        if (row === undefined || query.length !== dim) return 0;
        let s = 0;
        const off = row * dim;
        // Stored rows are L2-normalised at build time; the query is normalised
        // in embedQuery. So cosine is a plain dot product.
        for (let d = 0; d < dim; d++) s += query[d] * vectors[off + d];
        return s;
      },
      pairwise(aId, bId) {
        const a = rows.get(aId);
        const b = rows.get(bId);
        if (a === undefined || b === undefined) return 0;
        return dot(a * dim, b * dim);
      },
      has(sessionId) {
        return rows.has(sessionId);
      },
    };

    cache = { mtimeMs: st.mtimeMs, size: st.size, store };
    return store;
  } catch {
    return null;
  }
}

// ── Query embedding ───────────────────────────────────────────────────────────

function apiKey(): string | null {
  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim();
  for (const p of [resolve(AI_ROOT, "gateway/.env"), resolve(homedir(), ".config/ahi/ahi.env")]) {
    try {
      const m = readFileSync(p, "utf-8").match(/^OPENAI_API_KEY\s*=\s*(.+)$/m);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    } catch { /* next */ }
  }
  return null;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

// Disk-backed query cache. The owner repeats himself more than he thinks, and a hit
// removes the only network call on the retrieval path entirely.
let queryCache: Record<string, number[]> | null = null;
function loadQueryCache(): Record<string, number[]> {
  if (queryCache) return queryCache;
  try {
    queryCache = JSON.parse(readFileSync(QUERY_CACHE_PATH, "utf-8"));
  } catch {
    queryCache = {};
  }
  return queryCache!;
}

function persistQueryCache(): void {
  try {
    if (!existsSync(VECTOR_DIR)) mkdirSync(VECTOR_DIR, { recursive: true });
    const c = queryCache ?? {};
    const keys = Object.keys(c);
    // Bounded — drop the oldest half rather than growing without limit.
    if (keys.length > 4000) for (const k of keys.slice(0, 2000)) delete c[k];
    writeFileSync(QUERY_CACHE_PATH, JSON.stringify(c));
  } catch {
    // The cache is an optimisation, never a hard dependency.
  }
}

/**
 * Embed one query and return it L2-normalised, so downstream similarity is a
 * plain dot product. Returns null on any failure — callers degrade to lexical.
 */
export async function embedQuery(text: string): Promise<Float32Array | null> {
  const input = text.slice(0, 6000);
  const cacheKey = sha(input);
  const c = loadQueryCache();
  if (c[cacheKey]) return Float32Array.from(c[cacheKey]);

  const key = apiKey();
  if (!key) return null;

  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input, dimensions: EMBED_DIM }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    const raw = json.data?.[0]?.embedding;
    if (!raw) return null;

    let n = 0;
    for (const v of raw) n += v * v;
    n = Math.sqrt(n) || 1;
    const normalised = raw.map((v) => v / n);

    c[cacheKey] = normalised;
    persistQueryCache();
    return Float32Array.from(normalised);
  } catch {
    return null;
  }
}
