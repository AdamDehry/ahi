/* ============================================================
   echo-rule.ts — one echo rule for every door (voice step 3, plan item 5).

   Until now three rules decided "is that Michael's own voice coming back
   through the mic?", each its own way:
     app     (web/src/lib/barge.ts) the words playing AROUND the playback
             position, ≥60% of what was heard among them → not a barge-in;
     server  (ack-gate.ts looksLikeEcho) speech began while audio played, ≥3
             words, ≥80% in order against the WHOLE last reply, never a
             question or a directive → the utterance is dropped;
     phone   (phone/stream.ts) every word heard somewhere in the last 600
             characters said → not a barge-in.
   The same sentence could be echo on one door and the owner on another.

   Now one rule, the app's — the narrowest, because it compares only what was
   audible when he spoke (the playback-position window):

     his speech, from when it began to when it ended, against the words
     PLAYED from ECHO_BACK_S before it to ECHO_AHEAD_S after it; echo when
     at least ECHO_SHARE of his words are among them.

   No window, no echo: a sentence that repeats Michael's words a minute later
   is the owner. The app keeps its copy of the same function (it is a separate
   bundle); test/voice-echo-rule.test.ts runs both over one table.

   CALL_ECHO_RULE=old puts the server and the phone back on their old rules
   (the lever until step 4); every verdict where the two rules disagree is
   logged as numbers (`[echo] … rule=one … old=…`), which is the evidence for
   deleting the old ones.
   ============================================================ */

/** Played audio considered before his speech began (s). Same as the app. */
export const ECHO_BACK_S = 2.5;
/** …and after it ended (the wire and the speaker's buffer). Same as the app. */
export const ECHO_AHEAD_S = 0.5;
/** His speech longer than this counts as this long (the app's bound). */
export const ECHO_MAX_UTTERANCE_S = 8;
/** Share of his words found among the played ones that makes it echo. Same as the app's 0.6. */
export const ECHO_SHARE = 0.6;

const norm = (w: string): string => w.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9']/g, "");

/** Words as the rule compares them (the app's `wordsOf`). */
export function echoWords(text: string): string[] {
  return text.split(/\s+/).map(norm).filter(Boolean);
}

/** The share of `heard`'s words that are among `played`'s (0 when either is empty). */
export function echoShare(heard: string, played: string): number {
  const h = echoWords(heard);
  if (!h.length) return 0;
  const said = new Set(echoWords(played));
  if (!said.size) return 0;
  return h.filter((w) => said.has(w)).length / h.length;
}

/** THE rule: most of what he said is what was playing (the app's `isEchoOf`). */
export function isEchoOf(heard: string, played: string): boolean {
  return echoShare(heard, played) >= ECHO_SHARE;
}

/** CALL_ECHO_RULE=old: the server and the phone back on their own rules. */
export function oldEchoRules(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CALL_ECHO_RULE ?? "").trim().toLowerCase() === "old";
}

/** The window for speech from `startMs` lasting `utteranceSec`: [start - back, start + ahead]. */
export function echoWindow(utteranceSec: number): { backSec: number; aheadSec: number } {
  return { backSec: ECHO_BACK_S, aheadSec: Math.min(Math.max(0, utteranceSec), ECHO_MAX_UTTERANCE_S) + ECHO_AHEAD_S };
}

/** The line written when the rules disagree or the one rule says echo: numbers and tokens only, never the words. */
export function formatEchoVerdict(callId: string, where: string, one: boolean, old: boolean | null, share: number, words: number): string {
  return `[echo] ${callId} ${where} rule=one ${one ? "echo" : "not"}${old === null ? "" : ` old=${old ? "echo" : "not"}`} share=${share.toFixed(2)} words=${words}`;
}
