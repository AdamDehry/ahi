import type { GateClaim, GateVerdict } from "./front-gate.js";

/* ============================================================
   gate-draft.ts — the fast layer drafts its verdict while he is still
   talking (voice step 4, the owner: "by the time he stops, the reply is ready").

   The turn does not exist until the composer commits his thought, and that
   is 0.8–2.8 s after he stopped on the 10/27 test call: the recognizer
   closes the utterance, then the composer holds it (350 ms for a finished
   sentence, up to 2.2 s for a dangling one) in case he goes on. Every one of
   those milliseconds the fast gate used to spend idle, then took 0.8–2.8 s
   of its own after the final. So the gate is asked at each PAUSE instead:
     · his speech ends — on what the recognizer has so far (the partial);
     · an utterance closes — on the whole buffered thought (the composer's
       pending text).
   When the turn commits with the same words, its gate verdict is the draft —
   often already decided, and its claim (the tag) already made, so the
   arbiter (answer-ladder.ts) knows at once. A curveball (he went on, or the
   final reads differently) simply drops the draft: the turn asks afresh,
   nothing was said, nothing is undone. A draft never speaks; only a
   committed turn does.

   Cost: one more fast-model request per pause that is not the end of his
   thought (≈7% of turns had two or more utterances, gateway log 10/27), on
   the call's two warm lanes. No new processes.

   Never drafted: a phone call still waiting for its passphrase (the phrase
   must never reach a model — phone/stream.ts), a muted call, the app on
   standby. CALL_GATE_DRAFT=off turns drafting off.
   ============================================================ */

/**
 * What makes a draft the same as the final: the same words, in the same
 * order, case and sentence punctuation aside. Only . , ! ? ; : … and quotes
 * are dropped (a point, comma or colon inside a number stays) — never an
 * operator, a digit, an apostrophe or a letter of any script ("2 + 2" and
 * "2 - 2" stay different; Codex, step 4).
 */
export function draftKey(text: string): string {
  return (
    text
      // Canonical only (NFC): compatibility folding would make "2²" read "22" (Codex r2).
      .normalize("NFC")
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      // A point, comma or colon between digits is part of a number ("1.2" is not "1:2").
      .replace(/(?<!\d)[.,:]|[.,:](?!\d)/g, " ")
      .replace(/[!?;…"“”]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * CALL_DRAFT_ONE_LANE=off: a draft on his partial words goes to both lanes
 * again (step 5). On (voice step 6): it takes one lane, so the turn's real
 * ask never queues behind a guess on both (front-gate.ts FrontGate.askOne).
 */
export function draftOneLane(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CALL_DRAFT_ONE_LANE ?? "on").trim().toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

/**
 * A draft is a guess when it is made on his partial words at a speech end:
 * the recognizer has not closed the utterance, and the closed one usually
 * reads differently (on a phone call: 5 words, then 7). An utterance's draft is
 * on his whole thought so far — the words the turn most likely commits with.
 */
export function draftIsGuess(why: string): boolean {
  return why === "speech-end";
}

export function gateDraftOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.CALL_GATE_DRAFT ?? "on").trim().toLowerCase();
  return v !== "off" && v !== "false" && v !== "0";
}

/** One draft: the gate asked on words he has said so far. */
export interface GateDraft {
  readonly text: string;
  readonly key: string;
  readonly startedAt: number;
  readonly verdict: Promise<GateVerdict>;
  /** The claim made so far (the gate's tag), or null. */
  readonly claim: GateClaim | null;
  /** Hear the claim: at once if it is already made, else when it is. */
  onClaim(fn: (c: GateClaim) => void): void;
  /** The verdict, if it is in. */
  readonly settled: GateVerdict | null;
  /** Stop waiting on it (the turn that took it ended). */
  cancel(): void;
}

/** Ask the gate for `text`; `onClaim` hears its tag; `why` is the pause that made it. Must never throw. */
export type DraftStart = (text: string, signal: AbortSignal, onClaim: (c: GateClaim) => void, why: string) => Promise<GateVerdict>;

/**
 * One call's drafts: at most one live at a time (the newest words win). A
 * draft that is taken belongs to the turn; one that is not is dropped when
 * the next one starts or the turn commits with other words.
 */
export class GateDrafts {
  private current: (GateDraft & { controller: AbortController }) | null = null;

  constructor(
    private readonly start: DraftStart,
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** Draft for these words, unless the live draft already has them. */
  draft(text: string, why: string): void {
    const key = draftKey(text);
    if (!key) return;
    if (this.current?.key === key) return;
    this.drop();
    const controller = new AbortController();
    let claim: GateClaim | null = null;
    let settled: GateVerdict | null = null;
    const listeners: Array<(c: GateClaim) => void> = [];
    const startedAt = this.now();
    const verdict = this.start(
      text,
      controller.signal,
      (c) => {
        if (claim) return;
        claim = c;
        for (const fn of listeners.splice(0)) fn(c);
      },
      why,
    ).then((v) => {
      settled = v;
      return v;
    });
    this.current = {
      text,
      key,
      startedAt,
      verdict,
      controller,
      get claim() {
        return claim;
      },
      get settled() {
        return settled;
      },
      onClaim(fn) {
        if (claim) fn(claim);
        else listeners.push(fn);
      },
      cancel: () => controller.abort(),
    };
    this.log(`[gate-draft] drafting (${why}, ${key.split(" ").length} words)`);
  }

  /**
   * The turn committed with `text`: the live draft if it has the same words
   * (it now belongs to the turn), else null — and the draft is dropped.
   */
  take(text: string): GateDraft | null {
    const d = this.current;
    this.current = null;
    if (!d) return null;
    if (d.key === draftKey(text)) {
      this.log(`[gate-draft] used (${d.settled ? `decided ${d.settled.kind}` : d.claim ? `claimed ${d.claim}` : "in flight"}, ${this.now() - d.startedAt}ms ahead)`);
      return d;
    }
    d.controller.abort();
    this.log("[gate-draft] dropped (the final reads differently)");
    return null;
  }

  /** Stop waiting on the live draft (he went on, the call ended). */
  drop(): void {
    this.current?.controller.abort();
    this.current = null;
  }
}
