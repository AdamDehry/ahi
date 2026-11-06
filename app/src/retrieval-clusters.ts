/**
 * retrieval-clusters.ts — duplicate-cluster awareness (H-046).
 *
 * The archive contains several session IDs that are records of the SAME
 * material: the gateway's background summarizer logged 92 copies of
 * conversations it was summarising, and a handful of real conversations were
 * split across IDs by a resume or a crash. Without this, retrieval can spend
 * two of its three slots telling one story twice — and with only three slots,
 * the duplicate costs a different memory its place.
 *
 * What this module does NOT do, deliberately: it does not merge, rewrite or
 * hide anything. `index.json` is untouched, every session remains individually
 * retrievable, and the cluster file is marks only. At query time a cluster
 * collapses to whichever member scores best FOR THAT QUESTION, so there is no
 * fixed winner and no member is unreachable. A conversation is only ever
 * suppressed in favour of a sibling that the ranker preferred on this turn.
 *
 * Membership is built from verbatim evidence only — a "**Session:** <uuid>"
 * provenance header, or byte-identical shared passages. Similar summaries,
 * similar titles and adjacent dates are explicitly NOT evidence: measured
 * against the eight wrong-session misses this was aimed at, every pair shared
 * zero verbatim passages and sat months apart. Those are different
 * conversations that read alike.
 *
 * Fails open: a missing or malformed file means no collapsing at all.
 */

import { readFileSync, existsSync, statSync } from "fs";
import { resolve } from "path";
import { ahiSessionsRoot } from "./multi-user-paths.js";

const CLUSTERS_PATH = resolve(ahiSessionsRoot(), "passages/clusters.json");

export interface ClusterMap {
  clusterCount: number;
  clusteredSessions: number;
  /** Cluster id for a session, or null when it belongs to none. */
  clusterOf(sessionId: string): number | null;
  /**
   * Whether this session is machine-generated rather than a conversation —
   * a background-summarizer or session-cataloguing call. Its episode name and
   * summary describe the conversation it was FED, so returning it injects a
   * real memory under the wrong title and date.
   */
  isMachinery(sessionId: string): boolean;
}

interface Cache {
  mtimeMs: number;
  size: number;
  map: ClusterMap;
}
let cache: Cache | null = null;

export function loadClusterMap(): ClusterMap | null {
  try {
    if (!existsSync(CLUSTERS_PATH)) return null;
    const st = statSync(CLUSTERS_PATH);
    if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.map;

    const parsed = JSON.parse(readFileSync(CLUSTERS_PATH, "utf-8")) as {
      clusters?: { members?: string[] }[];
      machinery?: string[];
    };
    if (!Array.isArray(parsed.clusters)) return null;

    const of = new Map<string, number>();
    parsed.clusters.forEach((c, i) => {
      for (const m of c.members ?? []) of.set(m, i);
    });
    const machinery = new Set(parsed.machinery ?? []);

    const map: ClusterMap = {
      clusterCount: parsed.clusters.length,
      clusteredSessions: of.size,
      clusterOf(sessionId) {
        const c = of.get(sessionId);
        return c === undefined ? null : c;
      },
      isMachinery(sessionId) {
        return machinery.has(sessionId);
      },
    };
    cache = { mtimeMs: st.mtimeMs, size: st.size, map };
    return map;
  } catch {
    return null;
  }
}
