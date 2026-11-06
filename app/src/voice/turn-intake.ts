import type { AckDecision } from "./ack-gate.js";

/* ============================================================
   turn-intake.ts — what happens to a committed utterance before the turn
   gate, in the order it was SAID (B2 + S1, 10/14).

   Three outcomes: echo (dropped, the agent's own voice), a silent ack (no
   reply), or a real turn (dispatched to the turn gate, which supersedes
   whatever is running). Most utterances decide instantly; an ack-shaped one
   ("Okay.") waits on the fast model.

   The defect this closes: "Okay." waited on its verdict while "Actually send
   a second file." went straight through; the late TURN verdict then
   dispatched "Okay." LAST, and the turn gate aborted the real request in
   favour of it. A verdict could also fire after the call had hung up.

   Now every utterance is numbered on arrival, and a verdict is dropped when:
     - a NEWER utterance has already been dispatched as a real turn — an
       ack-shaped utterance never supersedes newer work (it only reached the
       model because every word of it was an acknowledgement); or
     - the call ended — pending classifications are aborted on close.
   ============================================================ */

export interface TurnIntakeDeps<A> {
  /** A real turn: into the turn gate. `ackGateMs` = time spent deciding. */
  dispatch(args: A, ackGateMs: number): void;
  /** A silent acknowledgement. */
  silent(args: A, d: AckDecision): void;
  /** The agent's own voice, dropped. */
  echo(args: A): void;
  /** Is this utterance echo? (synchronous, instant) */
  isEcho(args: A): boolean;
  /** Always a real turn, no classification (a drop rides it). */
  immediate(args: A): boolean;
  /** The ack verdict, or null when the gate is off for this call. */
  decide(args: A, signal: AbortSignal): Promise<AckDecision> | null;
  /** The call is over (hang-up); nothing may start. */
  ended(): boolean;
  log?(line: string): void;
}

export class TurnIntake<A> {
  private arrived = 0;
  private lastDispatched = 0;
  private closed = false;
  private readonly pending = new Set<AbortController>();

  constructor(private readonly deps: TurnIntakeDeps<A>) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  submit(args: A): void {
    if (this.closed || this.deps.ended()) {
      this.deps.log?.("utterance after the call ended — dropped");
      return;
    }
    const n = ++this.arrived;
    if (this.deps.immediate(args)) {
      this.dispatchNow(n, args, 0);
      return;
    }
    if (this.deps.isEcho(args)) {
      this.deps.echo(args);
      return;
    }
    const controller = new AbortController();
    const verdict = this.deps.decide(args, controller.signal);
    if (!verdict) {
      this.dispatchNow(n, args, 0);
      return;
    }
    this.pending.add(controller);
    const settle = (d: AckDecision | null): void => {
      this.pending.delete(controller);
      if (this.closed || controller.signal.aborted || this.deps.ended()) {
        this.deps.log?.(`verdict #${n} arrived after the call ended — dropped`);
        return;
      }
      if (d?.silent) {
        this.deps.silent(args, d);
        return;
      }
      if (n < this.lastDispatched) {
        // A newer real turn is already running; this ack-shaped utterance
        // must not supersede it.
        this.deps.log?.(`verdict #${n} (${d?.reason ?? "failed"}) is older than turn #${this.lastDispatched} — dropped`);
        return;
      }
      this.dispatchNow(n, args, d?.ms ?? 0);
    };
    verdict.then(settle, () => settle(null));
  }

  /** Hang-up / session close: abort pending classifications; nothing more is dispatched. */
  close(): void {
    this.closed = true;
    for (const c of this.pending) c.abort();
    this.pending.clear();
  }

  private dispatchNow(n: number, args: A, ms: number): void {
    this.lastDispatched = Math.max(this.lastDispatched, n);
    this.deps.dispatch(args, ms);
  }
}
