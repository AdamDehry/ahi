/* ============================================================
   turn-gate.ts — ported from the voice-mode simulator (round-2 item 3).

   THE BUG IT EXISTS TO KILL. Transcription latency opens a window where a
   mic-onset barge-in no-ops (the UI is still `listening` because the previous
   utterance's turn has not started yet). The next utterance's turn-end then
   fires a SECOND turn while the first is still generating, and both die:

     • turn A's chunks fail the orchestrator's `seq !== turnSeq` guard and are
       dropped — the reply the agent really produced never reaches the UI;
     • turn B rejects instantly because the resident bridge holds exactly one
       turn, and renders as a transient note.

   Two utterances, zero replies, no visible cause. That is the owner's 02:57:02.

   THE CONTRACT. `run` is NEVER re-entered. A submit arriving while a turn is
   in flight supersedes it SYNCHRONOUSLY (so the running turn starts unwinding
   on this tick, before any await) and then queues behind it on a promise
   chain. Ordering is submit order; concurrency is exactly one.

   `supersede` is deliberately not awaited: it only has to *signal* (abort the
   controller, cancel TTS). The chain does the waiting.
   ============================================================ */

export interface TurnGate<Args extends unknown[]> {
  /** True while a turn is actually running — not a proxy for the UI state. */
  readonly busy: boolean;
  /**
   * Nothing running AND nothing queued behind it.
   *
   * `busy` alone is NOT safe to retire a gate on: between one turn settling
   * and the next queued turn starting, `busy` is false while work is still
   * pending. A caller that dropped the gate in that window would hand the
   * next utterance a FRESH gate, which supersedes nothing — two turns then
   * run concurrently and kill each other, which is the exact bug this whole
   * module exists to prevent.
   */
  readonly idle: boolean;
  /** Queue a turn. Returns a promise for when THIS turn has settled. */
  submit(...args: Args): Promise<void>;
  /**
   * Queue a turn BEHIND the running one without superseding it (always-on,
   * §4 1c: an addition said into running work is delivered when the work
   * finishes). Same chain, same concurrency of one; the only difference from
   * `submit` is that nothing in flight is cut.
   */
  queue(...args: Args): Promise<void>;
  /** Settles when everything queued so far has finished (call teardown). */
  drain(): Promise<void>;
}

export interface TurnGateOptions<Args extends unknown[]> {
  /** One turn. Never called concurrently. */
  run: (...args: Args) => Promise<unknown>;
  /** Cut the in-flight turn short (abort + cancel TTS). Must not throw. */
  supersede: () => void;
  /** A turn threw past its own handler. */
  onError?: (err: Error) => void;
}

export function makeTurnGate<Args extends unknown[]>({
  run,
  supersede,
  onError,
}: TurnGateOptions<Args>): TurnGate<Args> {
  let chain: Promise<void> = Promise.resolve();
  let inFlight: Promise<unknown> | null = null;
  /** Submitted but not yet settled — running OR still waiting its turn. */
  let pending = 0;

  const queue = (...args: Args): Promise<void> => {
    pending += 1;
    chain = chain.then(async () => {
      const p = run(...args);
      inFlight = p;
      try {
        await p;
      } catch (err) {
        onError?.(err as Error);
      } finally {
        if (inFlight === p) inFlight = null;
        pending -= 1;
      }
    });
    return chain;
  };

  return {
    get busy(): boolean {
      return inFlight !== null;
    },

    get idle(): boolean {
      return pending === 0;
    },

    submit(...args: Args): Promise<void> {
      // Synchronous by design: the running turn must begin unwinding on this
      // tick, before the chain below gets a chance to await anything.
      if (inFlight) {
        try {
          supersede();
        } catch (err) {
          onError?.(err as Error);
        }
      }
      return queue(...args);
    },

    queue,

    drain(): Promise<void> {
      return chain;
    },
  };
}
