import { ECHO_AHEAD_S, ECHO_BACK_S, ECHO_SHARE, echoShare, echoWords } from "./echo-rule.js";

/* ============================================================
   server-barge.ts — "wait, stop" stops him, on the app as on the phone
   (voice step 5, the owner's 10/27 test call).

   On the phone the gateway decides a barge-in itself: real words heard while
   Michael is audible cut him (phone/stream.ts maybeBargeIn). The app left it
   to the client, which cuts only when a LIVE PREVIEW of his words arrives
   while Michael is audible. The OpenAI recognizer's preview needs 0.7 s of
   speech and a round trip, and is thrown away once the utterance closes — so
   a short "wait, stop" never had one. On the 10/27 app call it ducked the
   reply, the duck lifted 2 s later, and Michael talked on. Two rules now:

   1. THE APP BARGES LIKE THE PHONE. The gateway judges his words — each live
      preview and each closed utterance — while the call's mouth is audible:
      one real word (not a backchannel, not Michael's own words coming back
      through the mic, voice/echo-rule.ts) cuts, exactly the phone's rule. The
      cut is the existing one: the turn is interrupted (websocket.ts
      interruptSession) and the app is told `voice-interrupt-ack`, which
      already settles the turn and stops its audio. CALL_SERVER_BARGE=off.

   2. A STOP IS NOT A TURN. A short utterance that is only a stop ("wait",
      "stop", "hold on", "hang on a sec", "okay stop") heard while Michael was
      audible, just after, or right after a barge-in, interrupts and is
      consumed: shown and recorded, never answered. It reached the fast voice
      as a turn on 10/27 and got "Go ahead whenever you're ready" — the
      words of a man who did not hear "stop". CALL_STOP_INTERRUPT=off.

   The recognizer heard "wait, stop" as French ("Oui, top.", "Oui, c'est.")
   on both doors; Michael's recognizer is pinned to English now
   (stt-select.ts voiceSttLanguage).
   ============================================================ */

/**
 * Said under someone who is talking, these do not mean "stop": the phone's
 * set and the app's (web/src/lib/barge.ts — a lone "Awesome." cut a
 * 15-second reply, part seven). A word in either is not a barge.
 */
export const BARGE_BACKCHANNEL = new Set([
  // the phone's (phone/stream.ts)
  "yeah", "yes", "yep", "ok", "okay", "right", "sure", "mhm", "mm", "hmm", "uh", "um", "huh", "uhhuh", "mmhm", "ah", "oh", "got", "it", "cool", "nice",
  // the app's (web/src/lib/barge.ts)
  "kay", "k", "alright", "yup", "mmm", "hm", "wow", "great", "awesome", "amazing", "perfect", "sweet", "good", "gotcha", "true", "exactly",
  "totally", "interesting", "love", "thanks", "thank", "you", "makes", "sense", "i", "see", "fair", "enough", "word", "bet", "copy", "that",
  "indeed", "definitely",
]);

const flag = (raw: string | undefined): boolean => {
  const v = (raw ?? "on").trim().toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
};

/** CALL_SERVER_BARGE=off: the app decides its own barge-in again (preview only). */
export function serverBargeOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return flag(env.CALL_SERVER_BARGE);
}

/** CALL_STOP_INTERRUPT=off: a lone "wait, stop" is a turn again. */
export function stopInterruptOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return flag(env.CALL_STOP_INTERRUPT);
}

/** How long after a barge-in a lone stop is still part of it (ms). */
export const STOP_AFTER_BARGE_MS = 4_000;

/** His words, as the barge rule counts them: lower case, no punctuation, backchannel out. */
export function bargeWords(text: string): string[] {
  return echoWords(text)
    .map((w) => w.replace(/'/g, ""))
    .filter((w) => w && !BARGE_BACKCHANNEL.has(w));
}

export interface BargeVerdict {
  barge: boolean;
  /** Share of his words found in what was playing (0..1). */
  share: number;
  words: number;
}

/**
 * Does this text, heard while Michael was audible, cut him? One real word,
 * not echo (the phone's rule). `played` is what was audible around his
 * speech (CallMouth.playedNear over the echo window).
 */
export function judgeBarge(text: string, played: string, minWords = 1): BargeVerdict {
  const words = bargeWords(text).length;
  if (words < minWords) return { barge: false, share: 0, words };
  const share = echoShare(text, played);
  return { barge: share < ECHO_SHARE, share, words };
}

/** The echo window for speech that began at `startedAt` and is still going at `now`. */
export function bargeWindow(startedAt: number, now: number): { at: number; backSec: number; aheadSec: number } {
  return { at: startedAt, backSec: ECHO_BACK_S, aheadSec: Math.max(0, now - startedAt) / 1000 + ECHO_AHEAD_S };
}

/** The words that make an utterance a stop. One of them must be there. */
const STOP_CORE = new Set(["wait", "stop", "hold", "hang", "pause", "shh", "shush", "enough", "quiet", "halt"]);
/** What may sit around them: "okay wait", "hold on a sec", "stop stop, Michael". Nothing that asks or tells. */
const STOP_AROUND = new Set([
  "on", "up", "a", "sec", "second", "minute", "moment", "just", "please", "ok", "okay", "hey", "michael", "no", "sorry",
  "wait", "stop", "it", "that", "there", "talking", "for", "one", "be", "hm", "um", "uh", "oh", "yeah", "right", "now",
]);
const MAX_STOP_WORDS = 6;

/**
 * Is this utterance only a stop ("Wait, stop.", "Hold on a sec.", "Okay,
 * stop.")? Pure. "Wait, what time is it?" and "Stop the build." are not:
 * every word must be a stop word or what sits around one, at most six.
 */
export function isStopOnly(text: string): boolean {
  if (/\?/.test(text)) return false;
  const words = echoWords(text).map((w) => w.replace(/'/g, ""));
  if (!words.length || words.length > MAX_STOP_WORDS) return false;
  return words.some((w) => STOP_CORE.has(w)) && words.every((w) => STOP_CORE.has(w) || STOP_AROUND.has(w));
}
