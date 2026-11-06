/* ============================================================
   barge.ts — barge-in only on real speech (part seven, 10/13).

   Until now a reply was cut the moment the mic heard ~200 ms of energy above
   0.02 RMS, and again whenever ANY utterance committed — a cough, a TV, a
   one-word "awesome" — and the reply in the speaker was gone. At 18:33Z a
   lone "Awesome." committed in the middle of a 15-second reply, the app
   stopped all queued audio on that commit, and the owner heard the reply die
   "though I didn't say anything".

   Now:
     - mic ENERGY only ducks the reply (lowers it) for a moment: instant
       feedback, nothing lost. If nothing confirms speech, it comes back up;
     - a CUT needs the recognizer to confirm words while Michael is audible:
       two or more words, or one stop word ("wait", "stop"), that are neither
       a backchannel ("okay", "awesome", "mm hmm") nor Michael's own words
       coming back through the mic (echo);
     - a committed utterance no longer cuts anything by itself; the gateway's
       "voice-thinking" (a real turn is starting) does. A silent
       acknowledgement leaves the reply playing.
   ============================================================ */

/** Duck level while unconfirmed energy is on the mic. */
export const DUCK_GAIN = 0.3;
/** How long energy alone may hold the duck before the reply comes back up. */
export const DUCK_HOLD_MS = 1500;

const norm = (w: string): string => w.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9']/g, "");

export function wordsOf(text: string): string[] {
  return text.split(/\s+/).map(norm).filter(Boolean);
}

/** Backchannel words: alone or together, they acknowledge — they never take the floor. */
const BACKCHANNEL = new Set([
  "ok", "okay", "kay", "k", "alright", "right", "yeah", "yep", "yup", "yes", "sure", "mhm", "mm", "mmm", "hmm",
  "hm", "uh", "huh", "um", "ah", "oh", "wow", "cool", "nice", "great", "awesome", "amazing", "perfect", "sweet",
  "good", "got", "it", "gotcha", "true", "exactly", "totally", "interesting", "love", "thanks", "thank", "you",
  "makes", "sense", "i", "see", "fair", "enough", "nice", "word", "bet", "copy", "that", "indeed", "definitely",
]);

/** One of these alone is enough to take the floor. */
const STOP_WORDS = new Set(["stop", "wait", "hold", "hang", "pause", "no", "nope", "sorry", "actually", "michael", "miriam", "hey", "listen", "excuse"]);

/** Every word is a backchannel ("okay cool", "mm hmm", "got it, thanks"). */
export function isBackchannel(text: string): boolean {
  const w = wordsOf(text);
  return w.length > 0 && w.every((x) => BACKCHANNEL.has(x));
}

/**
 * Michael's own words coming back through the mic: most of what was heard
 * appears in what he is saying. THE echo rule for every door since voice
 * step 3 — the gateway's copy is src/voice/echo-rule.ts (same words, same
 * 0.6), held equal by test/voice-echo-rule.test.ts. Change both or neither.
 */
export function isEchoOf(heard: string, agentText: string): boolean {
  const h = wordsOf(heard);
  if (!h.length) return false;
  const said = new Set(wordsOf(agentText));
  if (!said.size) return false;
  const inSaid = h.filter((w) => said.has(w)).length;
  return inSaid / h.length >= 0.6;
}

/** Does this recognizer text confirm that the owner is really talking over the reply? */
export function confirmsBargeIn(heard: string, agentText: string): boolean {
  const w = wordsOf(heard);
  if (!w.length) return false; // noise: energy without words
  if (isEchoOf(heard, agentText)) return false;
  if (w.some((x) => STOP_WORDS.has(x)) && !isEchoOf(heard, agentText)) return true;
  if (isBackchannel(heard)) return false;
  return w.length >= 2;
}
