/* ============================================================
   already-said.ts — an answer he already heard is not said again
   (the owner, live call 10/27 15:14).

   The case: he asks, the answer is written, and he hears it only as he
   finishes adding to his question (ElevenLabs pays an owed answer on his next
   words). The add-on then started a fresh turn: a holding line ("that's a
   fair thing to untangle, pulling it together") and a second answer covering
   the same ground. The 10/22 fix ("two paragraphs", 475a4d1) handled this as a
   revision; 4c2a473 (10/23) made a grown line a FRESH line once its answer
   had finished, and the repeat came back.

   The rule now, in code:
     · the answer he just heard goes to the main turn as already said
       (`alreadySaidNote`);
     · that turn may answer with exactly NOTHING_NEW — the call then says
       nothing more for it (`NothingNewFilter` holds the reply back while it
       could still be that marker, so the marker is never spoken);
     · no holding line is said after it (the caller skips the fast voice).
   ============================================================ */

/** The main turn's whole reply when what he heard already answers him. Never spoken. */
export const NOTHING_NEW = "(nothing new)";

/** Tell the main turn what he just heard, and that silence is an answer. */
export function alreadySaidNote(said: string): string {
  const text = said.replace(/\s+/g, " ").trim().slice(0, 1_500);
  return (
    `(He heard you say this as he finished the line below — treat it as already said: "${text}". ` +
    `If it already answers his line, reply with exactly ${NOTHING_NEW} and nothing else: the call stays quiet. ` +
    "Otherwise say only what is new. Never repeat or rephrase it, and no warm-up line.)\n\n"
  );
}

const norm = (s: string): string => s.trim().toLowerCase();

/** Is this whole reply the marker (allowing stray spaces, a full stop, or emphasis around it)? */
export function isNothingNew(text: string): boolean {
  return norm(text).replace(/^[*_"'\s]+|[*_"'.\s]+$/g, "") === NOTHING_NEW;
}

/** The reply as recorded — what was spoken: empty when it was only the marker, and a leading marker dropped. */
export function stripNothingNew(text: string): string {
  if (isNothingNew(text)) return "";
  const lead = text.match(/^[*_"'\s]*/)?.[0].length ?? 0;
  if (!text.slice(lead).toLowerCase().startsWith(NOTHING_NEW)) return text;
  return text.slice(lead + NOTHING_NEW.length).replace(/^[*_"'.\s]+/, "");
}

/**
 * Sits in front of a spoken feed. While everything received could still be
 * the marker, it is held; the moment it cannot be, what was held goes on and
 * so does everything after it. At the end, a reply that was only the marker
 * is dropped whole: `finish()` says so.
 */
export class NothingNewFilter {
  private held = "";
  private passing = false;

  constructor(private readonly push: (text: string) => void) {}

  /** Could `text` still grow into the marker? */
  private static couldBe(text: string): boolean {
    const t = norm(text).replace(/^[*_"'\s]+/, "");
    if (!t) return true;
    if (NOTHING_NEW.startsWith(t)) return true;
    // The marker, complete, with only closing emphasis or a full stop after it.
    return t.startsWith(NOTHING_NEW) && /^[*_"'.\s]*$/.test(t.slice(NOTHING_NEW.length));
  }

  write(chunk: string): void {
    if (!chunk) return;
    if (this.passing) {
      this.push(chunk);
      return;
    }
    this.held += chunk;
    if (NothingNewFilter.couldBe(this.held)) return;
    this.passing = true;
    const out = stripNothingNew(this.held);
    this.held = "";
    if (out) this.push(out);
  }


  /** The reply is complete. True when it was only the marker (nothing was passed on). */
  finish(): boolean {
    if (this.passing) return false;
    const out = this.held;
    this.held = "";
    if (isNothingNew(out)) return true;
    // An unfinished prefix ("(noth") or blank: pass on whatever there was.
    if (out) {
      this.passing = true;
      this.push(out);
    }
    return false;
  }
}
