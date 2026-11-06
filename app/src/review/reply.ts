/**
 * reply.ts — parse a digest answer typed in the app thread.
 *
 *   "yes 1, 2, no 3, hold 4"   →  approve 1,2 · deny 3 · hold 4
 *
 * Strict on purpose: the WHOLE message must be verbs and numbers, or it is
 * not a reply and goes to Michael as ordinary conversation. "yes" alone, "no
 * thanks", "1 and 2 look fine" — none of these decide anything. Numbers map
 * through the most recent digest's numbering, which only ever contains
 * YELLOW items; the lane rules refuse RED again downstream regardless.
 */
import type { Decision } from "./types.js";

const VERBS: Record<string, Decision> = {
  yes: "approve",
  y: "approve",
  approve: "approve",
  approved: "approve",
  ok: "approve",
  okay: "approve",
  no: "deny",
  n: "deny",
  deny: "deny",
  denied: "deny",
  nope: "deny",
  hold: "hold",
  wait: "hold",
  later: "hold",
};

const FILLER = new Set(["and", "to", "on"]);

export interface ParsedReply {
  decisions: Array<{ n: number; decision: Decision }>;
}

export function parseDigestReply(text: string): ParsedReply | null {
  const s = text.trim().toLowerCase();
  if (!s || s.length > 200) return null;
  if (!/^[a-z0-9\s,;&.!+-]+$/.test(s)) return null;
  const tokens = s.match(/[a-z]+|\d+/g);
  if (!tokens || tokens.length < 2) return null;
  let current: Decision | null = null;
  let sawNumberForVerb = true;
  const decisions: Array<{ n: number; decision: Decision }> = [];
  const seen = new Map<number, Decision>();
  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) {
      if (!current) return null; // must open with a verb
      const n = Number(tok);
      if (n < 1 || n > 999) return null;
      const prior = seen.get(n);
      if (prior && prior !== current) return null; // "yes 2, no 2" — contradictory
      if (!prior) {
        seen.set(n, current);
        decisions.push({ n, decision: current });
      }
      sawNumberForVerb = true;
      continue;
    }
    if (FILLER.has(tok)) continue;
    const verb = VERBS[tok];
    if (!verb) return null; // any other word → it's conversation, not a reply
    if (!sawNumberForVerb) return null; // "yes no 3"
    current = verb;
    sawNumberForVerb = false;
  }
  if (!sawNumberForVerb || decisions.length === 0) return null;
  return { decisions };
}
