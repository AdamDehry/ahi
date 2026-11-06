/**
 * retrieval-passages.ts — the passage layer (H-044).
 *
 * The session store embeds one vector per conversation over its three-sentence
 * summary. That makes a conversation findable by what it was ABOUT, and makes
 * every detail the summariser didn't mention unfindable by construction — no
 * amount of re-ranking recovers a fact that was never indexed. This module
 * indexes the conversations themselves: ~28k dialogue passages of ~1,100
 * characters, same model and dimension as the session store so one query
 * vector scores against both.
 *
 * Built by `infra/sessions/scripts/{extract,embed}-passages.mjs`.
 *
 * Layout is chosen for a hook that runs per turn in a COLD process:
 *
 *   passages.bin    float32 N × 512, L2-normalised   (~57 MB, one read)
 *   passages.json   row metadata, no text            (~1 MB, one parse)
 *   passages.txt    the prose, read by seek ONLY for the rows we quote
 *
 * Loading the text file whole would triple the cost of every turn to quote two
 * paragraphs, so we never do.
 *
 * Like every other layer on this path, it fails open: a missing, stale or
 * corrupt store returns null and retrieval carries on with session vectors,
 * BM25 and gates exactly as before.
 */

import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from "fs";
import { resolve } from "path";
import { ahiSessionsRoot } from "./multi-user-paths.js";

const VECTOR_DIR = resolve(ahiSessionsRoot(), "vectors");
const BIN_PATH = `${VECTOR_DIR}/passages.bin`;
const META_PATH = `${VECTOR_DIR}/passages.json`;
const TXT_PATH = `${VECTOR_DIR}/passages.txt`;

const EMBED_MODEL = "text-embedding-3-small";
const EMBED_DIM = 512;

/** Per-session rollup of the passage layer's opinion about one query. */
export interface PassageHit {
  /** Cosine of the single best-matching passage in this session. */
  score: number;
  /** Rows of the best few passages, best first — the evidence to quote. */
  rows: number[];
}

export interface PassageStore {
  dim: number;
  count: number;
  sessionCount: number;
  /** Best passages per session for one query, keyed by session_id. */
  scoreSessions(query: Float32Array): Map<string, PassageHit>;
  /**
   * Same rollup, but over externally-computed per-row scores — used by the
   * BM25 passage layer, which produces sparse row scores rather than a dense
   * cosine scan. Keeping the rollup here means both passage layers agree about
   * what "the session's best passage" means and which row gets quoted.
   */
  rollupRows(rowScores: Map<number, number>): Map<string, PassageHit>;
  /** The prose of one row. Seeks into passages.txt; never loads it whole. */
  text(row: number): string;
  /**
   * The next passage in the same conversation, or null at its end.
   *
   * Needed because the passage that MATCHES and the passage that ANSWERS are
   * often not the same one: the owner sets up the situation, and the number lands a
   * turn or two later. Rows are written in manifest order — session by session,
   * position ascending — so the successor is simply row+1 when it belongs to
   * the same session.
   */
  nextRow(row: number): number | null;
  has(sessionId: string): boolean;
}

interface Meta {
  model: string;
  dim: number;
  count: number;
  sessions: string[];
  row_session: number[];
  row_pos: number[];
  row_off: number[];
  row_len: number[];
}

interface Cache {
  mtimeMs: number;
  size: number;
  store: PassageStore;
}
let cache: Cache | null = null;

/** How many passages per session we keep as quotable evidence. */
const EVIDENCE_PER_SESSION = 2;

export function loadPassageStore(): PassageStore | null {
  try {
    if (!existsSync(META_PATH) || !existsSync(BIN_PATH)) return null;
    const st = statSync(BIN_PATH);
    if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.store;

    const meta = JSON.parse(readFileSync(META_PATH, "utf-8")) as Meta;
    if (meta.model !== EMBED_MODEL || meta.dim !== EMBED_DIM) return null;

    const buf = readFileSync(BIN_PATH);
    const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const dim = meta.dim;
    const rowCount = Math.min(meta.count, Math.floor(vectors.length / dim));

    // Parallel arrays into typed arrays — a 28k-element JS number[] costs more
    // to walk than the dot products do.
    const rowSession = Int32Array.from(meta.row_session);
    const rowOff = Float64Array.from(meta.row_off);
    const rowLen = Int32Array.from(meta.row_len);
    const sessions = meta.sessions;
    const sessionRows = new Set(rowSession);

    const store: PassageStore = {
      dim,
      count: rowCount,
      sessionCount: sessions.length,

      scoreSessions(query) {
        if (query.length !== dim) return new Map();
        // Best and second-best row per session, tracked as flat arrays — a Map
        // lookup per row costs more than the dot product does at this size.
        const bestScore = new Float64Array(sessions.length).fill(-Infinity);
        const bestRow = new Int32Array(sessions.length).fill(-1);
        const secondScore = new Float64Array(sessions.length).fill(-Infinity);
        const secondRow = new Int32Array(sessions.length).fill(-1);

        for (let r = 0; r < rowCount; r++) {
          const off = r * dim;
          // Both sides are L2-normalised at build time, so cosine is a dot.
          let s = 0;
          for (let d = 0; d < dim; d++) s += query[d] * vectors[off + d];
          const si = rowSession[r];
          if (s > bestScore[si]) {
            secondScore[si] = bestScore[si];
            secondRow[si] = bestRow[si];
            bestScore[si] = s;
            bestRow[si] = r;
          } else if (s > secondScore[si]) {
            secondScore[si] = s;
            secondRow[si] = r;
          }
        }

        const out = new Map<string, PassageHit>();
        for (let si = 0; si < sessions.length; si++) {
          if (bestRow[si] < 0) continue;
          const id = sessions[si];
          if (!id) continue;
          const rows = [bestRow[si]];
          if (EVIDENCE_PER_SESSION > 1 && secondRow[si] >= 0) rows.push(secondRow[si]);
          out.set(id, { score: bestScore[si], rows });
        }
        return out;
      },

      rollupRows(rowScores) {
        const bestScore = new Map<number, number>();
        const bestRow = new Map<number, number>();
        const secondRow = new Map<number, number>();
        const secondScore = new Map<number, number>();
        for (const [row, s] of rowScores) {
          if (row < 0 || row >= rowCount) continue;
          const si = rowSession[row];
          const cur = bestScore.get(si);
          if (cur === undefined || s > cur) {
            if (cur !== undefined) {
              secondScore.set(si, cur);
              secondRow.set(si, bestRow.get(si)!);
            }
            bestScore.set(si, s);
            bestRow.set(si, row);
          } else if (s > (secondScore.get(si) ?? -Infinity)) {
            secondScore.set(si, s);
            secondRow.set(si, row);
          }
        }
        const out = new Map<string, PassageHit>();
        for (const [si, score] of bestScore) {
          const id = sessions[si];
          if (!id) continue;
          const rows = [bestRow.get(si)!];
          const second = secondRow.get(si);
          if (EVIDENCE_PER_SESSION > 1 && second !== undefined) rows.push(second);
          out.set(id, { score, rows });
        }
        return out;
      },

      nextRow(row) {
        const n = row + 1;
        if (row < 0 || n >= rowCount) return null;
        return rowSession[n] === rowSession[row] ? n : null;
      },

      text(row) {
        if (row < 0 || row >= rowCount) return "";
        let fd: number | null = null;
        try {
          fd = openSync(TXT_PATH, "r");
          const len = rowLen[row];
          const b = Buffer.allocUnsafe(len);
          readSync(fd, b, 0, len, rowOff[row]);
          return b.toString("utf-8");
        } catch {
          return "";
        } finally {
          if (fd !== null) closeSync(fd);
        }
      },

      has(sessionId) {
        const i = sessions.indexOf(sessionId);
        return i >= 0 && sessionRows.has(i);
      },
    };

    cache = { mtimeMs: st.mtimeMs, size: st.size, store };
    return store;
  } catch {
    return null;
  }
}
