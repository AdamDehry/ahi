import { useEffect, useRef } from "react";
import { voiceCutPosition, voiceStreamPosition } from "../../lib/voicebus";
import {
  activeIndex,
  pendingTail,
  spokenCount,
  textFollowsVoice,
  type KaraokeState,
} from "../../lib/karaoke";

const HIGHLIGHT_LEAD_S = 0.08;

/**
 * A voice with no word timings (Gemini) gets its text shown once its audio has
 * played this long: there is nothing to reveal it by, and a reply with no text
 * on screen at all would be worse than one shown a little early.
 */
const TIMINGLESS_SHOW_AFTER_S = 1.0;

/**
 * Where the reply's audio is, for what to show: the live clock, or — between a
 * barge-in cutting the voice and the server's ack settling the turn — the
 * position it was cut at, so the words he heard stay up instead of blanking.
 */
function displayPosition(): number | null {
  return voiceStreamPosition() ?? voiceCutPosition();
}

/** Is the streamed-but-untimed tail held back at playback position `t`? */
export function tailHeld(state: KaraokeState, t: number | null): boolean {
  return state.words.length > 0 || t === null || t < TIMINGLESS_SHOW_AFTER_S;
}

/**
 * One agent reply, highlighted word by word as it is spoken.
 *
 * The words render as React children (they only change when a new batch of
 * timestamps arrives — a few times a turn), but the HIGHLIGHT is driven by a
 * rAF loop writing classes straight to the DOM. Re-rendering sixty times a
 * second to move one class would be the wrong tool, and re-rendering the block
 * mid-read is what made the whole reply flash white in the sim.
 *
 * EXACTLY TWO brightness levels: unread and spoken. `.now` is a colour accent
 * on an already-bright word, never a third opacity — a third shade reads as a
 * dark wave travelling down the reply.
 *
 * Following the voice, an unspoken word is not dim but absent (`.unsaid`), and
 * so is text that has no timings yet. The same clock decides both in the
 * render and in the loop, so a re-render never flashes the unspoken rest.
 */
export default function KaraokeLine({
  state,
  settled,
  interrupted,
  onGrow,
}: {
  state: KaraokeState;
  settled: boolean;
  interrupted: boolean;
  /** More of the reply became visible — the transcript keeps it in view. */
  onGrow?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const follows = textFollowsVoice();
  const growRef = useRef(onGrow);
  growRef.current = onGrow;

  useEffect(() => {
    if (settled) return;
    let raf = 0;
    let shown = -1;
    const paint = (): void => {
      raf = requestAnimationFrame(paint);
      const host = ref.current;
      if (!host) return;
      const t = displayPosition();
      // No clock: leave the line as it was painted (the render covers the start).
      if (t === null) return;

      const spoken = spokenCount(state, t, HIGHLIGHT_LEAD_S);
      const now = activeIndex(state, t, HIGHLIGHT_LEAD_S);
      const nodes = host.querySelectorAll<HTMLElement>("[data-kw]");
      for (let i = 0; i < nodes.length; i++) {
        nodes[i].classList.toggle("spoken", i < spoken);
        nodes[i].classList.toggle("now", i === now);
        if (follows) nodes[i].classList.toggle("unsaid", i >= spoken);
      }
      const tail = host.querySelector<HTMLElement>("[data-tail]");
      const held = follows && tailHeld(state, t);
      if (tail) tail.classList.toggle("held", held);
      const visible = (follows ? spoken : nodes.length) + (tail && !held ? 1 : 0);
      if (visible > shown) {
        if (shown >= 0) growRef.current?.();
        shown = visible;
      }
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [state, settled, follows]);

  const tail = pendingTail(state);
  const settledText = settled ? state.committedText : "";
  // The render agrees with the loop, so new spans never show unspoken words for a frame.
  const t = settled ? null : displayPosition();
  const spokenNow = t === null ? 0 : spokenCount(state, t, HIGHLIGHT_LEAD_S);
  const heldNow = follows && tailHeld(state, t);

  return (
    <div
      ref={ref}
      className={`vturn-agent${settled ? " settled" : ""}${interrupted ? " interrupted" : ""}${follows ? " follows" : ""}`}
    >
      {settled ? (
        settledText
      ) : (
        <>
          {state.words.map((w, i) => (
            // Each word is its own span so the browser can lay the line out
            // bidirectionally while the walk stays in spoken order. Index here is
            // utterance position, NOT visual position — see lib/karaoke.ts.
            <span key={i} data-kw className={`kw${i < spokenNow ? " spoken" : follows ? " unsaid" : ""}`}>
              {w.text}{" "}
            </span>
          ))}
          {/* Streamed text with no timings yet is simply UNREAD — same dim as any
              other unspoken word, never its own shade. Following the voice it
              is held back entirely until it is spoken. */}
          {tail && !interrupted && (
            <span data-tail className={`kw${heldNow ? " held" : ""}`}>
              {tail}
            </span>
          )}
        </>
      )}
      {interrupted && <span className="int-tag mono">INTERRUPTED</span>}
    </div>
  );
}
