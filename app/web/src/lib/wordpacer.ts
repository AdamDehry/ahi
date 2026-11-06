/* ============================================================
   wordpacer.ts — his live words appear one at a time, never a block.

   A recognizer's partials grow in steps: a few words at once, about once a
   second (Scribe), worse on a batch preview. Painted as they come, the line
   jumps a phrase at a time (10/23: "one breath-chunk at a time").
   The pacer paints each step's NEW words one by one across a short span, so
   the line moves like speech; it never falls behind by more than that span.

   Words already on screen that the recognizer revises change in place, at
   once (no re-typing). A shorter or different line, a final, a clear: `jump`,
   immediate, and any pending reveal is dropped.
   ============================================================ */

export interface PacerTiming {
  /** The new words of one step are revealed within about this long. */
  spanMs: number;
  minStepMs: number;
  maxStepMs: number;
}

const DEFAULT_TIMING: PacerTiming = { spanMs: 600, minStepMs: 40, maxStepMs: 150 };

const words = (s: string): string[] => s.split(/\s+/).filter(Boolean);

export class WordPacer {
  private shown = "";
  private target: string[] = [];
  private count = 0; // words of `target` on screen
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stepMs = 0;

  constructor(
    private readonly paint: (text: string) => void,
    private readonly timing: PacerTiming = DEFAULT_TIMING,
  ) {}

  /** What is on screen now. */
  get text(): string {
    return this.shown;
  }

  /** Show exactly this, now. */
  jump(text: string): void {
    this.cancel();
    this.target = words(text);
    this.count = this.target.length;
    this.set(text);
  }

  /** Move toward this line: words already shown update in place, new ones arrive one by one. */
  to(text: string): void {
    const next = words(text);
    const on = this.timer ? this.count : words(this.shown).length;
    if (next.length <= on) {
      this.jump(text);
      return;
    }
    this.cancel();
    this.target = next;
    this.count = on;
    // Revisions to what is already up land in place, at once.
    this.set(next.slice(0, on).join(" "));
    const pending = next.length - on;
    this.stepMs = Math.max(this.timing.minStepMs, Math.min(this.timing.maxStepMs, this.timing.spanMs / pending));
    this.tick();
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private tick(): void {
    this.count++;
    this.set(this.target.slice(0, this.count).join(" "));
    this.timer = this.count < this.target.length ? setTimeout(() => this.tick(), this.stepMs) : null;
  }

  private set(text: string): void {
    if (text === this.shown) return;
    this.shown = text;
    this.paint(text);
  }
}
