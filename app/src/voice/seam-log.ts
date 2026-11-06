/* ============================================================
   seam-log.ts — one content-free line per seam of a call's answer.

   the owner hears Michael pause mid-sentence on calls. A pause can come from four
   different places — the text arriving late, the synthesis arriving late, the
   app's scheduler, or the app's volume — and the log could not tell them
   apart (call-pauses diagnosis, 10/14). Every spoken piece now leaves one
   `[call-seam]` line when it finishes playing out of the server: WHY it was
   cut where it was, how long it was (characters, never the text), and when
   each stage happened, in ms since the turn opened. The app adds its own
   `[voice-client] seam` lines for what it actually scheduled.

   Reading a line:
     [call-seam] voice-123 t2 p3 why=punct chars=87 at=4.12s gap=0ms inner=0ms | ready+2310 post+2311 pcm+2520..+3010 eof+3015 out+2520..+3015 audio=2.41s eleven_v4_turbo
       why     what made the piece ready (see PieceReason)
       at      where in the answer's audio this piece starts — the same number
               the app reports, so the two sides line up
       gap     silence the listener would hear BEFORE this piece, by the
               server's model of playback (release time vs audio already out)
       inner   silence inside the piece because its audio came slower than speech
       ready   the text was cut and handed to synthesis
       post    its request went out (later than ready when two are in flight)
       pcm     first and last audio received from the provider
       eof     the provider closed the response
       out     first and last audio released to the call (held behind the piece before)
   A seam at or over SEAM_WARN_MS starts with `!! GAP <ms>` so it stands out.
   ============================================================ */

/**
 * What made a piece of the answer ready to speak.
 *   punct   a sentence ended (terminal punctuation and the next character)
 *   clause  a long sentence was cut at a comma, semicolon, colon or dash
 *   cap     a very long run had no safe clause and was cut at a space
 *   tool    the agent moved on to a tool call; the message is complete
 *   reemit  the agent stream re-sent the message; the message is complete
 *   finish  the turn's text ended
 *   work    the piece ended where a work line (shown, not spoken) began
 *   fallback  the turn said nothing aloud, so it says the one fallback line
 *   checkin   a working turn's own "still on it" line (voice/turn-liveness.ts)
 */
export type PieceReason = "punct" | "clause" | "cap" | "tool" | "reemit" | "finish" | "work" | "fallback" | "checkin";

/** A seam at least this long is flagged in the log. */
export const SEAM_WARN_MS = 150;

/**
 * The server's model of the listener's playout: audio plays back to back from
 * the moment it is released, at real time. Returns, for each release, the
 * silence before it — how long the listener ran out of audio waiting for it.
 * It ignores network and the app's own scheduling; the app reports those.
 */
export class PlayoutModel {
  /** Wall ms at which everything released so far finishes playing; 0 before any audio. */
  private endsAt = 0;

  release(nowMs: number, durationSec: number): number {
    const gap = this.endsAt === 0 ? 0 : Math.max(0, nowMs - this.endsAt);
    this.endsAt = Math.max(this.endsAt, nowMs) + durationSec * 1000;
    return gap;
  }
}

/** Everything one `[call-seam]` line says about one piece. Times are absolute ms; 0 = never. */
export interface PieceSeam {
  turn: number;
  /** 1-based position in the turn. */
  piece: number;
  reason: PieceReason | "socket" | "unknown";
  chars: number;
  model: string;
  readyAt: number;
  postAt: number;
  firstPcmAt: number;
  lastPcmAt: number;
  eofAt: number;
  releaseStartAt: number;
  releaseEndAt: number;
  audioSec: number;
  /** Seconds of answer audio released before this piece. */
  atSec: number;
  gapMs: number;
  innerMs: number;
  failed?: boolean;
}

const rel = (at: number, t0: number): string => (at > 0 ? `+${Math.max(0, Math.round(at - t0))}` : "-");

/** The one line. Content-free: numbers, reasons and the model only. */
export function formatSeamLine(label: string, turnOpenedAt: number, p: PieceSeam): string {
  const gap = Math.round(p.gapMs);
  const inner = Math.round(p.innerMs);
  const worst = Math.max(gap, inner);
  const flag = worst >= SEAM_WARN_MS ? `!! GAP ${worst}ms ` : "";
  const range = (a: number, b: number) => (a > 0 ? `${rel(a, turnOpenedAt)}..${rel(b, turnOpenedAt)}` : "-");
  return (
    `[call-seam] ${flag}${label ? `${label} ` : ""}t${p.turn} p${p.piece} why=${p.reason} chars=${p.chars} ` +
    `at=${p.atSec.toFixed(2)}s gap=${gap}ms inner=${inner}ms | ` +
    `ready${rel(p.readyAt, turnOpenedAt)} post${rel(p.postAt, turnOpenedAt)} ` +
    `pcm${range(p.firstPcmAt, p.lastPcmAt)} eof${rel(p.eofAt, turnOpenedAt)} ` +
    `out${range(p.releaseStartAt, p.releaseEndAt)} audio=${p.audioSec.toFixed(2)}s ${p.model}` +
    (p.failed ? " FAILED" : "")
  );
}
