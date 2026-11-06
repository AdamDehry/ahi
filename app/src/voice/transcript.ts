/* ============================================================
   transcript.ts — ported from the voice-mode simulator (bug 8).

   WHAT CHANGED IN THE PORT, AND WHY.

   The sim logged per-turn METRICS only and never the words, so a call could
   not be reviewed after the fact. Its fix was to render each session to
   state/transcripts/<sessionId>.txt, rewritten whole on every turn.

   That file must NOT come across. The gateway already persists every voice
   turn — the user's transcribed utterance and the agent's reply — through
   message-store (index.ts broadcasts each turn, and broadcast() calls
   storeMessage()). Adding a second on-disk copy would be a parallel store of
   the same facts, and the whole-file-rewrite pattern the sim used is exactly
   the shape that loses writes here: gateway state files are cached in-process
   and rewritten whole, so anything written alongside the service gets
   silently erased.

   So the durable record IS the message store, and a transcript is a VIEW over
   it. This module renders that view. Nothing here writes.
   ============================================================ */

import { getMessagesForUser } from "../message-store.js";
import type { MessageEvent } from "../websocket.js";

const hhmmss = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "--:--:--" : new Date(t).toISOString().slice(11, 19);
};

export interface TranscriptOptions {
  /** Heading label for the agent side. Defaults to the bot name. */
  agentLabel?: string;
  /** Heading label for the user side. */
  userLabel?: string;
}

/**
 * Render a thread to transcript text. Pure — easy to test.
 *
 * Voice and text turns both appear, tagged, because a voice session routinely
 * mixes them and a transcript that showed only one is a misleading record.
 */
export function renderTranscript(
  messages: MessageEvent[],
  { agentLabel, userLabel }: TranscriptOptions = {},
): string {
  if (!messages.length) return "";

  const bot = messages[0]?.bot ?? "agent";
  const agentName = agentLabel ?? bot;
  const userName = userLabel ?? messages.find((m) => m.direction === "in")?.senderName ?? "user";
  const pad = Math.max(agentName.length, userName.length);

  let voiceTurns = 0;
  let textTurns = 0;

  const body = messages
    .map((m) => {
      const at = hhmmss(m.timestamp);
      const via = m.contentType === "voice" ? "voice" : "text";
      const who = m.direction === "in" ? userName : agentName;
      if (m.direction === "in") {
        if (m.contentType === "voice") voiceTurns++;
        else textTurns++;
      }
      const label = `${who} (${via}):`.padEnd(pad + 9);
      return `[${at}] ${label} ${m.text ?? ""}`.trimEnd();
    })
    .join("\n");

  const started = messages[0]?.timestamp ?? "";
  const head = [
    `AHI Voice Mode — ${bot}`,
    `started ${started}`,
    `turns: ${voiceTurns} voice + ${textTurns} text`,
    "─".repeat(60),
  ].join("\n");

  return `${head}\n${body}\n`;
}

/**
 * Render a user's recent thread with one agent, straight from the message
 * store — the same records the dashboard renders, so the transcript can never
 * disagree with what is on screen.
 */
export function renderThreadTranscript(
  bot: string,
  userId: string,
  limit = 100,
  opts: TranscriptOptions = {},
): string {
  return renderTranscript(getMessagesForUser(bot, userId, limit), opts);
}

/**
 * Just the turns belonging to one voice session.
 *
 * Voice turns are stamped with `meta.turnId` = the PWA's voiceStreamId (the
 * gateway uses it to upsert a text reply into a voice one), which makes it the
 * natural key for "what was said in this call". The user's own utterance is
 * broadcast without a turnId, so it is matched by falling within the session's
 * time span.
 */
export function selectVoiceSession(
  messages: MessageEvent[],
  voiceStreamId: string,
): MessageEvent[] {
  const tagged = messages.filter((m) => m.meta?.turnId === voiceStreamId);
  if (!tagged.length) return [];
  const first = Date.parse(tagged[0].timestamp);
  const last = Date.parse(tagged[tagged.length - 1].timestamp);
  return messages.filter((m) => {
    if (m.meta?.turnId === voiceStreamId) return true;
    if (m.direction !== "in" || m.contentType !== "voice") return false;
    const t = Date.parse(m.timestamp);
    return t >= first - 60_000 && t <= last;
  });
}
