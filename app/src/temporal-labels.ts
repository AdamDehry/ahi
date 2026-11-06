/**
 * temporal-labels.ts — historical labelling for retrieved memory (§4.6).
 *
 * The retrieval layer used to head every injected session with
 * `started_at.slice(0, 10)` — the UTC date. For a large share of sessions that
 * is not the date the owner lived them: anything late in the evening west of
 * UTC is already "tomorrow" in UTC. And nothing told the model that "tonight" inside a memory meant that
 * night, not this one.
 *
 * This wraps each retrieved session in a tag carrying its start/end instants
 * rendered in the user's zone, how long ago that was, and an explicit
 * `temporal-status="historical"`. The memory text itself is never rewritten.
 * Timestamps come from the gateway's own index, but are still validated
 * (untrusted input, §11): anything unparseable renders as unknown.
 */

import { formatShortDay, localDateKey, relativeDayLabel, toLocalIso } from "./local-time.js";
import { temporalEnvelopeEnabledFor, userEffectiveZone } from "./time-context.js";

export interface HistoricalLabelContext {
  zone: string;
  now: Date;
}

/** Labelling context for this process's user (AHI_USER_ID), or null when the flag is off for `agent`. */
export function historicalLabelContext(agent: string, now = new Date()): HistoricalLabelContext | null {
  if (!temporalEnvelopeEnabledFor(agent)) return null;
  const userId = process.env.AHI_USER_ID?.trim() || process.env.AHI_USER?.trim() || null;
  return { zone: userEffectiveZone(userId, now).zone, now };
}

function instant(value: string | null | undefined): Date | null {
  if (!value || typeof value !== "string") return null;
  // Date-only values carry no time; they cannot be placed in a day-part.
  if (!/T\d{2}:\d{2}/.test(value)) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t) : null;
}

function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** The local date to print in a session header (falls back to the stored date). */
export function sessionLocalDate(entry: { started_at?: string; date?: string }, ctx: HistoricalLabelContext): string {
  const start = instant(entry.started_at);
  if (start) return localDateKey(start, ctx.zone);
  return (entry.date || entry.started_at || "").slice(0, 10) || "unknown";
}

/** Wrap a formatted session block. Body text is passed through unchanged. */
export function labelRetrievedSession(
  entry: { started_at?: string; ended_at?: string; date?: string },
  body: string,
  ctx: HistoricalLabelContext,
): string {
  const start = instant(entry.started_at);
  const end = instant(entry.ended_at);
  const attrs: string[] = [];
  if (start) attrs.push(`started-at="${toLocalIso(start, ctx.zone)}"`);
  if (end) attrs.push(`ended-at="${toLocalIso(end, ctx.zone)}"`);
  if (start) {
    attrs.push(`local="${attr(`${formatShortDay(start, ctx.zone)} — ${relativeDayLabel(start, ctx.now, ctx.zone)}`)}"`);
  } else {
    attrs.push(`local="unknown time${entry.date ? ` (dated ${attr(entry.date.slice(0, 10))})` : ""}"`);
  }
  attrs.push(`temporal-status="historical"`);
  attrs.push(`note="relative words inside (tonight, tomorrow, earlier) refer to this session's time, not now"`);
  return `<retrieved-session ${attrs.join(" ")}>\n${body}\n</retrieved-session>`;
}

/** "2026-10-06, historical: last night, 10:30 PM EDT" — for one-line episode hints. */
export function historicalEpisodeDate(entry: { started_at?: string | null; date?: string | null }, ctx: HistoricalLabelContext): string {
  const start = instant(entry.started_at ?? undefined);
  if (!start) return `${(entry.date ?? "").slice(0, 10) || "date unknown"}, historical`;
  return `${localDateKey(start, ctx.zone)}, historical: ${relativeDayLabel(start, ctx.now, ctx.zone)}`;
}
