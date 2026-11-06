import { voiceModelFor, type BotConfig } from "../config.js";
import { voiceScopedChatId } from "./session-scope.js";

/**
 * The invoke options every voice-mode turn shares — cold and speculative
 * alike, so the two can never answer as different agents.
 *
 * One Michael:
 *  - same brain: the chat model (unless explicitly overridden), at the voice
 *    effort — see voiceModelFor / VOICE_MODE_EFFORT_DEFAULT;
 *  - same memory: the call's first turn opens with the main chat thread's
 *    tail (the selection chat uses), and the call is retrieved as the person
 *    it is with — `principalUserId`, because the per-call chatId maps to
 *    nobody. The prompt is spoken, not stored, so nothing in the thread is
 *    excluded as "the message being answered".
 *
 * The call still runs in its OWN Claude session (voiceScopedChatId): two
 * turns resuming the chat session at once would fork it.
 */
export function voiceTurnInvokeOptions(
  bot: Pick<BotConfig, "name" | "model" | "voiceModeModel" | "voiceModeEffort">,
  user: { userId: string },
  voiceStreamId: string,
) {
  return {
    chatId: voiceScopedChatId(user.userId, voiceStreamId),
    botName: bot.name,
    model: voiceModelFor(bot),
    effort: bot.voiceModeEffort,
    telegramUser: user.userId,
    principalUserId: user.userId,
    voiceStreamId,
    thread: { userId: user.userId, promptInThread: false },
  };
}

/**
 * One rule for a call turn whose line both asks for work and asks or says
 * something ("yeah, launch it — how does a tap work?"): the spoken
 * answer comes BEFORE the first tool call. The sentence before a tool call is
 * flushed at once (answer-before-work), so it can be a whole short answer,
 * not just "On it." (ElevenLabs calls; eleven-talk-while-working.)
 */
export const ANSWER_BEFORE_WORK_HINT = [
  "[CALL: TALK BEFORE WORK]",
  "When his line both asks you to do something and asks a question or makes",
  "conversation, say the conversational answer FIRST, in full (one to three",
  "spoken sentences), and only then make your first tool call. Do not save the",
  "answer for after the work; he hears what you say before the tools run.",
].join(" ");

/**
 * The talk lane's own rules (voice/eleven/brain.ts): a turn that answers him
 * while another turn of yours does the work. It has no tools and is not the
 * call's session — the call so far rides in its message.
 */
export const TALK_LANE_HINT = [
  "[CALL: TALK LANE]",
  "You are the talking half of yourself on this call: another turn of yours is",
  "doing the work he asked for, right now, and will report when it lands. You",
  "have NO tools here. Answer him from what you already know, in one to three",
  "short spoken sentences, the answer first. Never claim to have done, checked",
  "or started anything, never report on the work's progress, never say when it",
  `will be done. If answering truly needs a tool, a lookup, a file, live data or`,
  "an action, write exactly [[needs-hands]] and nothing else: it is handed to the",
  "work and done after it.",
].join(" ");

/** A call turn's options with the talk-before-work rule. */
export function callTurnInvokeOptions(
  bot: Pick<BotConfig, "name" | "model" | "voiceModeModel" | "voiceModeEffort">,
  user: { userId: string },
  voiceStreamId: string,
) {
  return { ...voiceTurnInvokeOptions(bot, user, voiceStreamId), extraSystemHint: ANSWER_BEFORE_WORK_HINT };
}

/**
 * The talk lane's options: same brain, effort, principal and retrieval as
 * the call's turn — but one-shot (never the call's session, which the work
 * turn is using) and with no tools at all.
 */
export function talkLaneInvokeOptions(
  bot: Pick<BotConfig, "name" | "model" | "voiceModeModel" | "voiceModeEffort">,
  user: { userId: string },
  voiceStreamId: string,
  model?: string,
) {
  const base = voiceTurnInvokeOptions(bot, user, voiceStreamId);
  return {
    ...base,
    model: model || base.model,
    ephemeral: true as const,
    noTools: true as const,
    extraSystemHint: TALK_LANE_HINT,
  };
}
