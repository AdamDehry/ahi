/**
 * Notification sources (the owner's Settings ruling): the reference's "Apps & activity" catalog, one place for
 * the server (enforcement at send time, validation on save) and the app (served with the settings, so the two
 * never drift). An app can be switched off whole; inside it each activity has its own switch.
 */
export interface SourceEvent { id: string; label: string; on: boolean }
export interface Source { id: string; name: string; icon: string; blurb: string; events: SourceEvent[] }

export const SOURCES: Source[] = [
  { id: "messages", name: "Messages", icon: "messages", blurb: "Replies, mentions and conversations", events: [{ id: "reply", label: "New replies", on: true }, { id: "mention", label: "Mentions and direct questions", on: true }, { id: "updates", label: "Proactive agent updates", on: false }] },
  { id: "builds", name: "Builds", icon: "layers", blurb: "Approvals, progress and releases", events: [{ id: "approval", label: "Ready for your decision", on: true }, { id: "failure", label: "Build or deployment failures", on: true }, { id: "progress", label: "Progress and completed builds", on: false }] },
  { id: "review", name: "Review", icon: "shield", blurb: "Requests and decision outcomes", events: [{ id: "requests", label: "New approval requests", on: true }, { id: "outcomes", label: "Decisions and outcomes", on: true }] },
  { id: "feed", name: "Feed", icon: "pulse", blurb: "Ideas and work entering your queue", events: [{ id: "ready", label: "Ideas ready for review", on: true }, { id: "queue", label: "Queue changes", on: false }] },
  { id: "gmail", name: "Gmail", icon: "gmail", blurb: "Mail across your connected inboxes", events: [{ id: "important", label: "Important or starred mail", on: true }, { id: "replies", label: "Replies to your conversations", on: true }, { id: "all", label: "Other new mail", on: false }] },
  { id: "whatsapp", name: "WhatsApp Business", icon: "whatsapp-business", blurb: "Customers and follow-ups", events: [{ id: "hand", label: "Conversations that need a hand", on: true }, { id: "callback", label: "Callback reminders", on: true }, { id: "all", label: "Other customer messages", on: false }] },
  { id: "calendar", name: "Calendar", icon: "today", blurb: "Your schedule and invitations", events: [{ id: "reminders", label: "Upcoming event reminders", on: true }, { id: "changes", label: "Schedule changes", on: true }, { id: "invites", label: "New invitations", on: true }] },
  { id: "finances", name: "Finances", icon: "wallet", blurb: "Bills and operating costs", events: [{ id: "due", label: "Bill reminders", on: true }, { id: "changes", label: "Changes to costs or bills", on: false }] },
  { id: "vault", name: "Vault", icon: "shield", blurb: "Accounts and financial attention", events: [{ id: "attention", label: "Accounts needing attention", on: true }, { id: "connection", label: "Bank feeds needing reconnection", on: true }] },
  { id: "connections", name: "Connections", icon: "plug", blurb: "Access to your connected apps", events: [{ id: "attention", label: "Expired access or connection errors", on: true }, { id: "updates", label: "Successful connection updates", on: false }] },
];

/** Members see only the sources that can concern them (the reference's member view). */
export const MEMBER_SOURCES = new Set(["messages", "calendar"]);

export type SourcePrefs = Record<string, { enabled: boolean; events: Record<string, boolean> }>;

export function defaultSources(): SourcePrefs {
  return Object.fromEntries(SOURCES.map((s) => [s.id, { enabled: true, events: Object.fromEntries(s.events.map((e) => [e.id, e.on])) }]));
}

/** Stored prefs over the defaults; unknown ids are dropped, non-booleans ignored. */
export function mergeSources(base: SourcePrefs, patch: unknown): SourcePrefs {
  const out: SourcePrefs = defaultSources();
  for (const s of SOURCES) {
    const b = base?.[s.id];
    if (b) out[s.id] = { enabled: typeof b.enabled === "boolean" ? b.enabled : true, events: { ...out[s.id].events, ...pickBools(b.events, s) } };
  }
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    for (const s of SOURCES) {
      const p = (patch as Record<string, unknown>)[s.id] as { enabled?: unknown; events?: unknown } | undefined;
      if (!p || typeof p !== "object") continue;
      if (typeof p.enabled === "boolean") out[s.id].enabled = p.enabled;
      Object.assign(out[s.id].events, pickBools(p.events, s));
    }
  }
  return out;
}

function pickBools(events: unknown, s: Source): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!events || typeof events !== "object") return out;
  for (const e of s.events) {
    const v = (events as Record<string, unknown>)[e.id];
    if (typeof v === "boolean") out[e.id] = v;
  }
  return out;
}

/** True when this source and activity may reach the user. */
export function sourceAllows(prefs: SourcePrefs | undefined, source: string, event: string): boolean {
  const s = prefs?.[source];
  if (!s) return true;
  if (!s.enabled) return false;
  return s.events[event] !== false;
}
