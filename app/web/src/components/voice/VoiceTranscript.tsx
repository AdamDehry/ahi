import { useCallback, useEffect, useRef, useState } from "react";
import KaraokeLine from "./KaraokeLine";
import type { VoiceTurn } from "../../lib/voicelayer";

/** Manual scroll past this many px from the bottom pauses auto-follow. */
const FOLLOW_SLACK_PX = 24;

/** What the work gate did with a remark said into running work (voicelayer.ts `tag`). */
const GATE_TAGS: Record<string, string> = {
  status: "ANSWERED FROM THE BEAT",
  addition: "QUEUED · AFTER THIS",
  queued: "QUEUED · AFTER THIS",
  ask: "ASKED BACK",
  "stop-for": "STOPPED FOR THIS",
  name: "FLOOR OPEN",
  merged: "SAME THOUGHT",
};

/**
 * The call's own thread, plus the live provisional line beneath it.
 *
 * Separable from the layer surface on purpose: the next chapter mounts a
 * screen-share surface BESIDE this pane, and that should be a layout change
 * rather than a rebuild.
 */
/**
 * Work lines (part five): what the agent did and found, shown under its
 * reply and visibly NOT spoken — muted, italic, a hairline rule and a label.
 */
function WorkLines({ lines }: { lines: string[] }) {
  const shown = lines.map((l) => l.trim()).filter(Boolean);
  if (!shown.length) return null;
  return (
    <div className="vwork" aria-label="Work notes, not spoken">
      <span className="vwork-label mono">NOT SPOKEN</span>
      {shown.map((line, i) => (
        <div key={i} className={`vwork-line${/[\u0590-\u05FF]/.test(line) ? " has-hebrew" : ""}`}>
          {line}
        </div>
      ))}
    </div>
  );
}

export default function VoiceTranscript({
  turns,
  provisional,
}: {
  turns: VoiceTurn[];
  provisional: string;
}) {
  const paneRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(following);
  followingRef.current = following;

  useEffect(() => {
    if (!following) return;
    const el = paneRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, provisional, following]);

  // A reply that grows word by word as it is spoken (KaraokeLine) does so
  // without a render; keep its newest words in view while following.
  const keepInView = useCallback(() => {
    if (!followingRef.current) return;
    const el = paneRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Hebrew must never be slanted — oblique Hebrew renders broken, so the
  // provisional line is conveyed by muted COLOUR and drops the italic
  // entirely when the line contains Hebrew (3J).
  const hasHebrew = /[֐-׿]/.test(provisional);

  return (
    <>
      <section
        className="vthread"
        ref={paneRef}
        onScroll={() => {
          const el = paneRef.current;
          if (!el) return;
          const atBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;
          setFollowing(atBottom);
        }}
      >
        {turns.map((turn) =>
          turn.kind === "aside" ? (
            // Heard, not for him (always-on): greyed, labelled, kept nowhere else.
            <div key={turn.id} className="vturn-aside" aria-label="Not for Michael">
              <span className="aside-tag mono">(NOT FOR ME)</span>
              {turn.text}
            </div>
          ) : turn.kind === "user" ? (
            // Bubble sides are SEMANTIC and never flip — outgoing is right in
            // any language. Only the text inside takes its script's direction.
            <div key={turn.id} className={`vturn-user${turn.dropped ? " dropped" : ""}${turn.tag ? " gated" : ""}`}>
              {turn.dropped && <span className="drop-tag mono">DROPPED IN</span>}
              {turn.tag && <span className="drop-tag mono">{GATE_TAGS[turn.tag] ?? turn.tag.toUpperCase()}</span>}
              {turn.image && <img className="drop-img" src={turn.image} alt="Image dropped into the call" />}
              {turn.text}
            </div>
          ) : turn.failed ? (
            <div key={turn.id} className="vturn-agent failed">
              <span className="fail-msg">⚠ {turn.failed}</span>
            </div>
          ) : (
            <div key={turn.id} className="vturn-agent-wrap">
              <KaraokeLine state={turn.karaoke} settled={turn.settled} interrupted={turn.interrupted} onGrow={keepInView} />
              <WorkLines lines={turn.work} />
            </div>
          ),
        )}
      </section>

      <div className={`provisional${hasHebrew ? " has-hebrew" : ""}`}>{provisional}</div>

      {!following && (
        <button
          type="button"
          className="follow-pill mono"
          onClick={() => {
            setFollowing(true);
            const el = paneRef.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          }}
        >
          FOLLOWING PAUSED · TAP TO RESUME
        </button>
      )}
    </>
  );
}
