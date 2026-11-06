/* ============================================================
   hold-line.ts — "One sec.", the bottom rung of the answer ladder
   (voice step 3, 10/27; the default and the ruling are step 4's).

   The fast gate (front-gate.ts) buys the main brain a second with a line of
   its own. Measured on the phone after voice-speed shipped (turn logs,
   10/27 17:08–17:30Z): the gate's line failed its checker on 11 of 17
   turns, and a rejected line meant NOTHING was said until the answer — 5–13 s
   of silence. So: a short neutral line, rendered once per voice ahead of
   time, played at the hold point when nothing else has started.

   ── the owner's ruling, 10/27 after his test call (replaces the 10/13 rule) ───
   On 10/13 the owner ruled the quick line is fresh every turn — "no canned
   rotation", "never a canned stand-in" — and step 3 shipped this line at 4 s
   (parity with the ElevenLabs call) for that reason. After hearing it on his
   10/27 test call he chose it: "One sec." at 1.4 s is the default, for the
   quick lookup mid-conversation, when nothing above it on the ladder has
   claimed the turn (answer-ladder.ts owns the decision):
     1. the fast layer's instant answer wins (and cancels this line if it
        claims the turn first, within ~3 s);
     2. a contextual line only when the main answer is 10 s+ away;
     3. this line at 1.4 s;
     4. never two holding sounds, never a filler AND "One sec.".
   The 1.4 s is counted from his end of speech (answer-ladder.ts, "The clock").

   Never on a bare greeting, yes/no or thanks (front-gate.ts needsWork): there
   the fast voice's reply may be the whole answer, and "One sec." before
   "Morning." is worse than a beat of quiet.

   CALL_HOLD_MS     the hold point, ms after his speech ended (default 1400,
                    the owner's pick; 4000 = step 3's; 0 = off, the strict 10/13 rule)
   CALL_HOLD_LINES  the lines, "|"-separated (default "One sec.")
   ============================================================ */

/** Picked after a test call (over step 3's 4 s). */
export const HOLD_MS_DEFAULT = 1_400;
export const HOLD_LINES_DEFAULT = ["One sec."];

export function holdMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CALL_HOLD_MS;
  if (raw === undefined || raw.trim() === "") return HOLD_MS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : HOLD_MS_DEFAULT;
}

export function holdLines(env: NodeJS.ProcessEnv = process.env): string[] {
  const lines = (env.CALL_HOLD_LINES ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.length ? lines : [...HOLD_LINES_DEFAULT];
}

export interface HoldLine {
  text: string;
  pcm: Buffer;
}

/**
 * The rendered hold lines for one voice (bot + provider + model), shared by
 * every call that speaks in it: rendered once per process, on first use.
 * A line that failed to render is retried on the next warm().
 */
export class HoldLineBank {
  private readonly ready = new Map<string, Buffer>();
  private readonly pending = new Set<string>();
  private last: string | null = null;

  constructor(
    private readonly render: (text: string) => Promise<Buffer>,
    private readonly lines: readonly string[] = HOLD_LINES_DEFAULT,
    private readonly log: (line: string) => void = () => {},
  ) {}

  warm(): void {
    for (const text of this.lines) {
      if (this.ready.has(text) || this.pending.has(text)) continue;
      this.pending.add(text);
      this.render(text).then(
        (pcm) => {
          this.pending.delete(text);
          if (pcm.length >= 2) this.ready.set(text, pcm);
        },
        (err: Error) => {
          this.pending.delete(text);
          this.log(`[hold] could not render a hold line: ${err.message}`);
        },
      );
    }
  }

  /** The next line to say: never the one said last, when there is a choice. Null when none is rendered yet. */
  next(): HoldLine | null {
    const all = this.lines.filter((t) => this.ready.has(t));
    if (!all.length) return null;
    const pick = all.find((t) => t !== this.last) ?? all[0];
    this.last = pick;
    return { text: pick, pcm: this.ready.get(pick)! };
  }
}
