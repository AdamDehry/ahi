/**
 * decisions.ts — the calls Michael made on his own, each one overrulable.
 *
 *   $SCHEDULE_DIR/decisions.jsonl   APPEND-ONLY
 *     {"type":"decision","id":"d-…","at":ISO,"tag":"sales","decision":"…","why":"…","by":"michael"}
 *     {"type":"overrule","id":"d-…","at":ISO,"by":"owner","note":"…"}
 *     {"type":"overrule-delivered","id":"d-…","at":ISO}   Michael's wake for that overrule landed
 *
 * An overrule without its delivered line is owed a wake: the next Overrule
 * tap, and the gateway's retry sweep, try it again until one lands.
 * Michael adds a line with scripts/schedule.mjs decide; the owner's Overrule tap
 * appends the second kind. Nothing is ever rewritten, so the gateway and the
 * script can both append without the whole-file-rewrite hazard. Every read
 * goes to disk; a torn line is skipped.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { randomBytes } from "crypto";
import { dirname } from "path";

export const DECISION_CAP = 200;

export interface Decision {
  id: string;
  at: string;
  tag: string | null;
  decision: string;
  why: string;
  by: string;
  overruled: { at: string; by: string; note: string | null; delivered: boolean } | null;
}

export function newDecisionId(now: Date): string {
  return `d-${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z-${randomBytes(3).toString("hex")}`;
}

const DECISION_ID = /^d-[0-9TZ]+-[0-9a-f]{6}$/;
export const isDecisionId = (id: string) => DECISION_ID.test(id);

/** One plain line: no newlines, no markup, capped. */
export function plainLine(s: unknown, cap = DECISION_CAP): string {
  const t = String(s ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>`*_#[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return [...t].length > cap ? `${[...t].slice(0, cap - 1).join("").trimEnd()}…` : t;
}

export function readDecisions(path: string): Decision[] {
  if (!existsSync(path)) return [];
  const byId = new Map<string, Decision>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const id = typeof rec.id === "string" ? rec.id : "";
    if (!id) continue;
    if (rec.type === "decision" && typeof rec.decision === "string" && typeof rec.at === "string" && !byId.has(id)) {
      byId.set(id, {
        id,
        at: rec.at,
        tag: typeof rec.tag === "string" && rec.tag ? rec.tag : null,
        decision: plainLine(rec.decision),
        why: plainLine(rec.why ?? ""),
        by: typeof rec.by === "string" ? rec.by : "michael",
        overruled: null,
      });
    } else if (rec.type === "overrule") {
      const d = byId.get(id);
      if (d && !d.overruled) d.overruled = { at: String(rec.at ?? ""), by: String(rec.by ?? "owner"), note: rec.note ? plainLine(rec.note) : null, delivered: false };
    } else if (rec.type === "overrule-delivered") {
      const d = byId.get(id);
      if (d?.overruled) d.overruled.delivered = true;
    }
  }
  return [...byId.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
}

export function appendDecision(path: string, input: { tag?: string | null; decision: string; why?: string; by?: string }, now = new Date()): Decision {
  const decision = plainLine(input.decision);
  if (!decision) throw new Error("decision text is empty");
  const rec = {
    type: "decision",
    id: newDecisionId(now),
    at: now.toISOString(),
    tag: input.tag ? plainLine(input.tag, 40).toLowerCase() : null,
    decision,
    why: plainLine(input.why ?? ""),
    by: input.by ?? "michael",
  };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(rec) + "\n");
  return { ...rec, overruled: null };
}

export function appendOverrule(path: string, id: string, by: string, note: string | null, now = new Date()): { ok: true; decision: Decision; already: boolean } | { ok: false; reason: string } {
  const d = readDecisions(path).find((x) => x.id === id);
  if (!d) return { ok: false, reason: "no such decision" };
  if (d.overruled) return { ok: true, decision: d, already: true };
  const rec = { type: "overrule", id, at: now.toISOString(), by, note: note ? plainLine(note) : null };
  appendFileSync(path, JSON.stringify(rec) + "\n");
  return { ok: true, decision: { ...d, overruled: { at: rec.at, by, note: rec.note, delivered: false } }, already: false };
}

/** Michael's wake for this overrule landed — recorded once, append-only. */
export function appendOverruleDelivered(path: string, id: string, now = new Date()): void {
  appendFileSync(path, JSON.stringify({ type: "overrule-delivered", id, at: now.toISOString() }) + "\n");
}
