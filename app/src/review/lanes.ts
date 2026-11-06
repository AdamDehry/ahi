/**
 * lanes.ts — the one place that decides whether a decision is allowed.
 *
 * Every path (app tap, fingerprint, chat reply) asks `canDecide` first and
 * does nothing on a refusal. The rules, verbatim from the mandate + brief:
 *   - GREEN never waits, so there is nothing to decide.
 *   - YELLOW: one tap, or a digest reply in the thread.
 *   - RED: approval ONLY through a server-verified fingerprint. Never by
 *     chat text (no decision of any kind), never by a plain tap. No and Hold
 *     in the app stay one tap — saying no to money moving is never the risk.
 */
import type { Channel, Decision, ItemStatus, Lane } from "./types.js";

export type LaneVerdict = { ok: true } | { ok: false; code: string; reason: string };

const OPEN: ItemStatus[] = ["waiting", "held"];

export function canDecide(item: { lane: Lane; status: ItemStatus }, decision: Decision, channel: Channel): LaneVerdict {
  if (!OPEN.includes(item.status)) {
    return { ok: false, code: "closed", reason: `already ${item.status}` };
  }
  if (decision === "hold" && item.status === "held") {
    return { ok: false, code: "noop", reason: "already on hold" };
  }
  switch (item.lane) {
    case "GREEN":
      return { ok: false, code: "green", reason: "GREEN items run without approval" };
    case "YELLOW":
      return { ok: true };
    case "RED":
      if (channel === "chat") {
        return { ok: false, code: "red-chat", reason: "RED is never decided by chat — open Review and use your fingerprint" };
      }
      if (decision === "approve" && channel !== "fingerprint") {
        return { ok: false, code: "red-needs-fingerprint", reason: "RED approval requires your fingerprint" };
      }
      return { ok: true };
  }
}

export function statusFor(decision: Decision): ItemStatus {
  return decision === "approve" ? "approved" : decision === "deny" ? "denied" : "held";
}
