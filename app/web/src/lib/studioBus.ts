/* ============================================================
   studioBus.ts — where a studio card's tap goes while a call is live.

   Dependency-free on purpose: the call screen (VoiceLayer) registers here,
   and the call screen must not pull the app store into its import graph
   (its tests render it without one). lib/studio.ts reads it.
   ============================================================ */

export interface CallAnswer {
  text: string;
  /** The option's picture (the user's own media), when it is a still. */
  mediaId?: string;
  /** Shown in the call transcript beside the drop. */
  preview?: string;
}

type Sink = (a: CallAnswer) => void;
const sinks = new Map<string, Sink>();

/** The call screen, while a call with `bot` is live. Returns an unregister. */
export function registerCallAnswerSink(bot: string, fn: Sink): () => void {
  sinks.set(bot, fn);
  return () => {
    if (sinks.get(bot) === fn) sinks.delete(bot);
  };
}

/** The live call's sink for `bot`, if any. */
export function callAnswerSink(bot: string): Sink | null {
  return sinks.get(bot) ?? null;
}
