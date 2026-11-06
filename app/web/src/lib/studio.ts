/* ============================================================
   studio.ts — the live studio, the app half (11/03).

   Avi's decision cards are answered by a TAP on an option. Where that
   answer goes depends on where the owner is:
     - on a live call with that agent → it is DROPPED into the call (the
       picture itself rides along, so Avi sees what was chosen), exactly as
       if he had pasted it on the call screen;
     - otherwise → it is sent as an ordinary chat message.
   The card doesn't own the call (CallHost does) or the composer, so this is
   a little bus, the same shape as search.ts's stage bus: the call screen
   registers a sink for its agent while the call is live.
   ============================================================ */

import { actions, getState } from "../store";
import { flushOutbox } from "./outbox";
import type { StudioCardMeta, StudioOptionMeta } from "./types";
import { callAnswerSink, registerCallAnswerSink, type CallAnswer } from "./studioBus";

export { registerCallAnswerSink, type CallAnswer };

export function callIsLive(bot: string): boolean {
  return callAnswerSink(bot) !== null;
}

/**
 * What a tapped option says. It names its card's question, so a tap on an
 * OLDER card can't be read against the newest one:
 * "Which cabin? → B: two lamps" (no question: "Option B — two lamps").
 */
export function optionAnswer(ask: string, opt: Pick<StudioOptionMeta, "key" | "label">): string {
  const q = ask.trim();
  if (q) return `${q} → ${opt.key}${opt.label ? `: ${opt.label}` : ""}`;
  return opt.label ? `Option ${opt.key} — ${opt.label}` : `Option ${opt.key}`;
}

export function thumbSrc(opt: StudioOptionMeta): string {
  const id = encodeURIComponent(opt.media.id);
  return opt.media.thumbnail ? `/ui/media/${id}/thumb` : `/ui/media/${id}`;
}

/** Send an answer to `bot`: into its live call when there is one, else as a chat message. */
export function sendStudioAnswer(bot: string, answer: CallAnswer): "call" | "chat" | null {
  const sink = callAnswerSink(bot);
  if (sink) {
    sink(answer);
    return "call";
  }
  const user = getState().user;
  if (!user) return null;
  actions.enqueueSend(bot, answer.text, user, answer.mediaId ? [answer.mediaId] : []);
  flushOutbox();
  return "chat";
}

/** Answer a decision (its question) with one of its options. */
export function chooseOption(bot: string, ask: string, opt: StudioOptionMeta): "call" | "chat" | null {
  const still = opt.media.type === "image";
  // In chat the words are the answer (the picture is already in the thread);
  // on a call the picture rides the drop so Avi sees exactly what was chosen.
  if (callIsLive(bot)) return sendStudioAnswer(bot, { text: optionAnswer(ask, opt), ...(still ? { mediaId: opt.media.id, preview: thumbSrc(opt) } : {}) });
  return sendStudioAnswer(bot, { text: optionAnswer(ask, opt) });
}

/** Stop a running job from its card. */
export async function stopJob(jobId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/app/studio/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId }) });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok ? { ok: true } : { ok: false, error: body.error || `Couldn't stop it (${res.status})` };
  } catch {
    return { ok: false, error: "No connection" };
  }
}

// ── Which option he picked, remembered per card on this device ──────────

const PICKS_KEY = "ahi.studio.picks";

function readPicks(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(PICKS_KEY) || "{}");
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function pickedOption(messageId: string): string | null {
  return readPicks()[messageId] ?? null;
}

export function rememberPick(messageId: string, key: string): void {
  try {
    const picks = readPicks();
    picks[messageId] = key;
    const keys = Object.keys(picks);
    for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete picks[k];
    localStorage.setItem(PICKS_KEY, JSON.stringify(picks));
  } catch {
    /* private mode: the pick just isn't remembered */
  }
}

/** "0:42" since the job started. */
export function elapsed(startedAt: string | undefined, now: number): string {
  const ms = startedAt ? now - Date.parse(startedAt) : 0;
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function stateLabel(card: StudioCardMeta): string {
  return card.state === "working" ? "Making" : card.state === "failed" ? "Didn't land" : "Your call";
}
