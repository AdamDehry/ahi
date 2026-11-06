/**
 * retrieval-passages-lex.ts — BM25 over passages (H-045).
 *
 * The vector passage layer took detail recall from 0/26 to 13/26. Seven of the
 * thirteen remaining misses are opaque identifiers: process IDs, event IDs,
 * nanosecond timestamps, version strings. A 512-dimension embedding cannot
 * represent a random digit string — "98423" and "61302" land in nearly the same
 * place, and neither lands near the question asking about them.
 *
 * What makes those questions answerable anyway: the owner never types the
 * identifier. He is asking BECAUSE he forgot it. What he types is the rare
 * anchor around it — "that p2-rc-e2e build", "the R10 verification run", "when
 * we set up the VPS". Low-document-frequency tokens are precisely what BM25's
 * IDF rewards and what an averaged embedding washes out. So this layer is not a
 * better semantic search; it is the complementary failure mode.
 *
 * Store: `vectors/passages-lex.bin`, built by build-passage-lexicon.mjs. One
 * ~9 MB readFileSync and then binary search over a sorted term blob — there is
 * deliberately no JSON on this path, because it runs per turn in a cold process
 * and parsing an 83,000-key object would cost more than the retrieval it feeds.
 *
 * Fails open like every other layer here: a missing or malformed index returns
 * null and retrieval proceeds without it.
 */

import { readFileSync, existsSync, statSync } from "fs";
import { resolve } from "path";
import { ahiSessionsRoot } from "./multi-user-paths.js";

const LEX_PATH = resolve(ahiSessionsRoot(), "vectors/passages-lex.bin");

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const HEADER = 32;

export interface PassageLexicon {
  termCount: number;
  passageCount: number;
  /** BM25 score per matching passage row. Sparse: only rows that matched. */
  scoreRows(tokens: string[]): Map<number, number>;
}

interface Cache {
  mtimeMs: number;
  size: number;
  lex: PassageLexicon;
}
let cache: Cache | null = null;

/**
 * Tokeniser. MUST stay identical to `lexTokens` in
 * `infra/sessions/scripts/build-passage-lexicon.mjs` — a build/query mismatch
 * yields an index that silently matches nothing, which looks exactly like a
 * feature that does not help.
 *
 * Deliberately NOT the tokeniser retrieval.ts uses for summaries. That one
 * stems and drops anything under three characters, which would destroy "p2",
 * "R10" and "1.3.14" — the whole reason this index exists.
 */
export function lexTokens(text: string | null | undefined): string[] {
  const out = new Set<string>();
  const raw = (text ?? "").toLowerCase().match(/[a-z0-9][a-z0-9._-]*[a-z0-9]|[a-z0-9]/g) ?? [];
  for (const m of raw) {
    if (m.length >= 2) out.add(m);
    if (/[._\-]/.test(m)) {
      for (const part of m.split(/[._\-]+/)) if (part.length >= 2) out.add(part);
    }
  }
  return [...out];
}

export function loadPassageLexicon(): PassageLexicon | null {
  try {
    if (!existsSync(LEX_PATH)) return null;
    const st = statSync(LEX_PATH);
    if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.lex;

    const buf = readFileSync(LEX_PATH);
    if (buf.length < HEADER || buf.toString("ascii", 0, 4) !== "AHLX") return null;
    if (buf.readUInt32LE(4) !== 1) return null;

    const termCount = buf.readUInt32LE(8);
    const passageCount = buf.readUInt32LE(12);
    const termBlobLen = buf.readUInt32LE(16);
    const totalPostings = buf.readUInt32LE(20);
    const avgdl = buf.readFloatLE(24) || 1;

    const pad4 = (n: number) => (n + 3) & ~3;
    let o = HEADER;
    const blobStart = o;
    o += pad4(termBlobLen);
    const termOffsets = new Uint32Array(buf.buffer, buf.byteOffset + o, termCount + 1);
    o += (termCount + 1) * 4;
    const postingStarts = new Uint32Array(buf.buffer, buf.byteOffset + o, termCount + 1);
    o += (termCount + 1) * 4;
    const idf = new Float32Array(buf.buffer, buf.byteOffset + o, termCount);
    o += termCount * 4;
    const docLen = new Uint16Array(buf.buffer, buf.byteOffset + o, passageCount);
    o += pad4(passageCount * 2);
    const postings = new Uint32Array(buf.buffer, buf.byteOffset + o, totalPostings);

    // Terms are stored sorted and newline-separated; termOffsets[i+1] - 1 is
    // the end of term i (the separator position).
    const termAt = (i: number): string =>
      buf.toString("utf-8", blobStart + termOffsets[i], blobStart + termOffsets[i + 1] - 1);

    /** Sorted in JS code-unit order at build time, so plain < / > is correct. */
    const findTerm = (needle: string): number => {
      let lo = 0, hi = termCount - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const t = termAt(mid);
        if (t === needle) return mid;
        if (t < needle) lo = mid + 1;
        else hi = mid - 1;
      }
      return -1;
    };

    const lex: PassageLexicon = {
      termCount,
      passageCount,
      scoreRows(tokens) {
        const scores = new Map<number, number>();
        for (const tok of tokens) {
          const id = findTerm(tok);
          if (id < 0) continue;
          const w = idf[id];
          if (!(w > 0)) continue;
          const start = postingStarts[id];
          const end = postingStarts[id + 1];
          for (let p = start; p < end; p++) {
            const packed = postings[p];
            const row = packed >>> 4;
            const f = packed & 0xf;
            if (row >= passageCount) continue;
            const norm = 1 - BM25_B + BM25_B * (docLen[row] / avgdl);
            const contrib = w * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * norm));
            scores.set(row, (scores.get(row) ?? 0) + contrib);
          }
        }
        return scores;
      },
    };

    cache = { mtimeMs: st.mtimeMs, size: st.size, lex };
    return lex;
  } catch {
    return null;
  }
}
