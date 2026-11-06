import { useMemo, useRef, useState, useCallback, useEffect } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { BOT_LABELS } from "../lib/types";
import { actions, useAppState } from "../store";
import MessageBubble from "./MessageBubble";
import type { VoiceSessionMeta } from "./voice/SessionRecordCard";
import StreamingBubble from "./StreamingBubble";
import { IconChevronDown } from "./icons";

type Item =
  | { kind: "msg"; key: string; msg: import("../lib/types").LocalMessage }
  | { kind: "stream"; key: string; stream: import("../store").StreamState }
  | { kind: "day"; key: string; label: string };

function dayLabel(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const md = date.toLocaleDateString([], { month: "long", day: "numeric" }).toUpperCase();
  if (date.toDateString() === now.toDateString()) return `TODAY · ${md}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `YESTERDAY · ${md}`;
  if (now.getTime() - date.getTime() < 7 * 86_400_000) {
    return `${date.toLocaleDateString([], { weekday: "long" }).toUpperCase()} · ${md}`;
  }
  return md;
}

/**
 * The conversation surface (feed only — the Composer lives in App so it
 * stays mounted across agent switches). Virtualized; follows the bottom
 * only when the user is already there, otherwise a "new messages" pill.
 * Day dividers between runs (design: centered mono "TODAY · JULY 8").
 */
/** Windows scroll, part 3 (BUG-windows-scroll-stuck):
 *  the part-2 settle loop reached gap=0 headless but produced VISIBLE jank
 *  on the real Surface — each scrollToIndex re-assert is a paintable jump.
 *  The rework attacks the cause instead of the symptom:
 *  - Measurement stability: image attachments now have reserved height
 *    (app.css .media-image), so lazy-loading media no longer shifts item
 *    heights and reopens the gap virtuoso keeps re-measuring.
 *  - The correction primitive is a PIN, not a loop: for a bounded window
 *    after an explicit bottom intent (FAB tap, first mount), a rAF loop
 *    glues scrollTop to the bottom BEFORE each paint. Corrections are
 *    invisible by construction — the list simply stays put while heights
 *    settle. Any user gesture (wheel/touch/pointer) releases the pin
 *    instantly.
 *  Tolerances:
 *  - AT_BOTTOM_PX (96): virtuoso's atBottomThreshold — shared so FAB
 *    visibility and bottom state can't disagree.
 *  - MICRO_SNAP_PX (4): fractional residue zeroed on arrival at bottom;
 *    a no-op where the gap is already 0 (Mac/Android). */
const AT_BOTTOM_PX = 48;
const MICRO_SNAP_PX = 4;
const PIN_MS_JUMP = 700;
const PIN_MS_MOUNT = 600;
/** Part 4 (wheel bounce): virtuoso consults followOutput on EVERY items
 *  change — during streaming that's every token — and inside the
 *  atBottomThreshold zone it re-pinned "auto" against an active wheel:
 *  the bounce the owner felt. Any user input opens this window; while it's
 *  open, auto-follow and the micro-snap stand down. Auto-follow may only
 *  ever act when the user is NOT actively scrolling. Wheel events refresh
 *  the window continuously during a gesture, so 400ms only has to cover
 *  momentum gaps, not whole gestures. (AT_BOTTOM_PX also dropped 96→48:
 *  with the gate the fight is gone, but a narrower zone stops atBottom
 *  tripping a message-and-a-half early.) */
const USER_SCROLL_MS = 400;

export default function Thread({
  bot,
  onOpenVoiceSession,
}: {
  bot: string;
  onOpenVoiceSession?: (record: VoiceSessionMeta) => void;
}) {
  const { threads, streams, awaiting, reveal } = useAppState();
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);

  // ----- pin-to-bottom primitive (imperceptible correction) -----
  // While pinned, a rAF loop assigns scrollTop = bottom before every paint,
  // so height re-measurements (fractional scaling, late media) can never
  // show as motion. A user gesture releases the pin immediately — their
  // intent always wins.
  const pinUntil = useRef(0);
  const pinRaf = useRef(0);

  const userScrollingUntil = useRef(0);
  const isUserScrolling = useCallback(() => performance.now() <= userScrollingUntil.current, []);

  // One handler for every input gesture: releases the pin (part 3) AND
  // opens the user-scrolling window (part 4).
  const onUserGesture = useCallback(() => {
    pinUntil.current = 0;
    userScrollingUntil.current = performance.now() + USER_SCROLL_MS;
  }, []);

  const pinToBottom = useCallback((ms: number) => {
    pinUntil.current = Math.max(pinUntil.current, performance.now() + ms);
    cancelAnimationFrame(pinRaf.current);
    const step = () => {
      if (performance.now() > pinUntil.current) return;
      // Keep ticking even while the scroller doesn't exist yet — on mount
      // Virtuoso appears only after history hydrates, and the pin must be
      // waiting for it, not already dead.
      const s = scrollerRef.current;
      if (s) {
        const target = s.scrollHeight - s.clientHeight;
        if (s.scrollTop < target) s.scrollTop = target;
      }
      pinRaf.current = requestAnimationFrame(step);
    };
    pinRaf.current = requestAnimationFrame(step);
  }, []);

  // Stop the pin's rAF on unmount — it self-terminates anyway, but there is
  // no reason to let it spin against a dead component (Michael, PR #15).
  useEffect(() => () => cancelAnimationFrame(pinRaf.current), []);

  const captureScroller = useCallback((el: HTMLElement | Window | null) => {
    const prev = scrollerRef.current;
    if (prev) {
      prev.removeEventListener("wheel", onUserGesture);
      prev.removeEventListener("touchstart", onUserGesture);
      prev.removeEventListener("pointerdown", onUserGesture);
    }
    const attached = el instanceof HTMLElement ? el : null;
    scrollerRef.current = attached;
    if (attached) {
      attached.addEventListener("wheel", onUserGesture, { passive: true });
      attached.addEventListener("touchstart", onUserGesture, { passive: true });
      attached.addEventListener("pointerdown", onUserGesture, { passive: true });
      attached.addEventListener("keydown", onUserGesture, { passive: true });
      // The list just came into existence — land it pinned at the bottom
      // while initial measurement settles (part 3, "opens scrolled up").
      pinToBottom(PIN_MS_MOUNT);
    }
  }, [onUserGesture, pinToBottom]);

  /** Force true bottom if we're within `tolerance` px of it. The clamp to
   *  scrollHeight is the browser's — assigning past-max is safe. */
  const snapToBottom = useCallback((tolerance: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (gap > 0 && gap <= tolerance) el.scrollTop = el.scrollHeight;
  }, []);

  const messages = threads[bot] ?? [];
  const liveStreams = useMemo(
    () => Object.values(streams).filter((s) => s.bot === bot),
    [streams, bot],
  );

  const items: Item[] = useMemo(() => {
    const list: Item[] = [];
    let lastDay = "";
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const day = new Date(m.timestamp).toDateString();
      if (day !== lastDay) {
        lastDay = day;
        list.push({ kind: "day", key: `day-${day}`, label: dayLabel(m.timestamp) });
      }
      list.push({
        kind: "msg",
        key: m.localId ?? m.meta?.messageId ?? `${m.timestamp}|${m.direction}|${i}`,
        msg: m,
      });
    }
    for (const s of liveStreams) list.push({ kind: "stream", key: s.streamId, stream: s });
    return list;
  }, [messages, liveStreams]);

  // Typing indicator: we sent something and no reply signal (stream-start
  // or out-message) has arrived yet for this bot.
  const showTyping = !!awaiting[bot] && liveStreams.length === 0;

  // New content while scrolled up → count it for the FAB badge.
  // NB the delta must be computed EAGERLY: the original pill passed a
  // functional updater that read prevCount.current lazily — by the time
  // React ran it, the line below had already synced the ref, so the
  // increment was always +0 and the pill never showed (latent since 3a).
  // GATED on having reached the bottom once: during initial mount/history
  // hydration atBottom is transiently false, and counting those items is
  // how the app opened with a bogus 99+ badge on Windows (part 3, bug 2).
  const prevCount = useRef(items.length);
  const everAtBottom = useRef(false);
  useEffect(() => {
    const delta = items.length - prevCount.current;
    if (delta > 0 && !atBottom && everAtBottom.current) setUnseen((u) => u + delta);
    prevCount.current = items.length;
  }, [items.length, atBottom]);

  useEffect(() => {
    if (atBottom) {
      everAtBottom.current = true;
      setUnseen(0);
      // Kill the fractional residue the moment virtuoso declares bottom —
      // without this, followOutput keeps "arriving" a hair short forever.
      // Never during an active gesture: atBottom flickers at the zone
      // boundary while wheeling, and even a 4px nudge against the user's
      // hand reads as fighting them (part 4).
      if (!isUserScrolling()) snapToBottom(MICRO_SNAP_PX);
    }
  }, [atBottom, snapToBottom, isUserScrolling]);

  // First render must LAND pinned at the true bottom: initialTopMostItemIndex
  // alone lands top-aligned and re-measurement (history hydration, media)
  // drifts it upward on Windows — the "opens scrolled up" bug (part 3).
  // The pin absorbs those shifts invisibly until layout settles.
  useEffect(() => {
    pinToBottom(PIN_MS_MOUNT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot]);

  // "Show in chat" (media panel): scroll this thread to one message
  // and flash it. The bottom pin is released first — it would otherwise
  // glue the list back to the newest message. Asked twice because virtuoso
  // places an unmeasured row by estimate; the second pass lands it exactly.
  const revealTimers = useRef<number[]>([]);
  useEffect(() => () => revealTimers.current.forEach((t) => window.clearTimeout(t)), []);
  useEffect(() => {
    if (!reveal || reveal.bot !== bot) return;
    const index = items.findIndex((it) => it.kind === "msg" && it.msg.meta?.messageId === reveal.messageId);
    if (index < 0) return;
    const key = items[index].key;
    const nonce = reveal.nonce;
    pinUntil.current = 0;
    cancelAnimationFrame(pinRaf.current);
    userScrollingUntil.current = performance.now() + 1500; // no auto-follow mid-reveal
    const go = () => virtuosoRef.current?.scrollToIndex({ index, align: "center", behavior: "auto" });
    revealTimers.current.forEach((t) => window.clearTimeout(t));
    revealTimers.current = [
      window.setTimeout(go, 30),
      window.setTimeout(() => {
        go();
        actions.revealDone(nonce);
      }, 320),
      window.setTimeout(() => setFlashKey((k) => (k === key ? null : k)), 2400),
    ];
    setFlashKey(key);
    // items is read for the lookup only; re-running on every new message would re-scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, bot]);

  const jumpToBottom = useCallback(() => {
    // ONE instant jump + a pin. No smooth (it stalls mid-flight while
    // virtuoso re-measures — part 2's finding) and no re-assert loop (each
    // pass was a visible jump on the Surface — part 3's finding). The pin
    // holds the landing at the true bottom pre-paint while heights settle,
    // which is imperceptible by construction; any user gesture releases it.
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
    pinToBottom(PIN_MS_JUMP);
  }, [pinToBottom]);

  // The Home-to-Zali bug: on a slow load the chat's history landed
  // after the mount pin had expired, the list settled its heights with
  // nothing holding the bottom, and the chat opened ~2,000px up with the
  // newest message off screen. Now, whenever the list's height changes, the
  // bottom is held — unless the person has scrolled up, whose place is theirs.
  // "Scrolled up" = left the bottom during their own gesture (wheel, touch,
  // pointer, key) or the app's Show in chat, which opens the same window;
  // the list's own layout corrections never count. Reset on reaching the
  // bottom again or opening another chat.
  const scrolledUp = useRef(false);
  useEffect(() => { scrolledUp.current = false; }, [bot]);
  const onBottomChange = useCallback((bottom: boolean) => {
    setAtBottom(bottom);
    if (bottom) scrolledUp.current = false;
    else if (isUserScrolling()) scrolledUp.current = true;
  }, [isUserScrolling]);
  const holdBottom = useCallback(() => {
    // The pin (re-asserted each frame, released by any gesture) rather than
    // one assignment: the height reported here can still be settling.
    if (!scrolledUp.current && !isUserScrolling()) pinToBottom(PIN_MS_JUMP);
  }, [isUserScrolling, pinToBottom]);

  // And for someone who HAS scrolled up, older messages arriving above don't
  // move what they're reading: react-virtuoso's prepend contract —
  // firstItemIndex drops by exactly the number of items inserted above the
  // previous oldest message. Derived during render (it must change in the same
  // render as the data); a repeated render finds nothing new, so it never
  // double-counts.
  const firstIdx = items.findIndex((it) => it.kind === "msg");
  const firstMsgKey = items[firstIdx]?.key;
  const top = useRef({ bot, key: firstMsgKey, idx: firstIdx, first: 1_000_000 });
  if (top.current.bot !== bot || top.current.key !== firstMsgKey) {
    const was = top.current.bot === bot ? items.findIndex((it) => it.key === top.current.key) : -1;
    const first = was > top.current.idx ? top.current.first - (was - top.current.idx) : top.current.first;
    top.current = { bot, key: firstMsgKey, idx: firstIdx, first };
  }

  const Footer = useCallback(
    () =>
      showTyping ? (
        <div className="agent-run typing">
          <span className="typing-dots" aria-label={`${BOT_LABELS[bot] ?? bot} is thinking`}>
            <i /><i /><i />
          </span>
        </div>
      ) : (
        <div className="feed-tail" />
      ),
    [showTyping, bot],
  );

  return (
    <div className="thread-feed">
      {items.length === 0 && !showTyping ? (
        <div className="feed-empty">
          <span className="mono-label">NO MESSAGES YET</span>
          Say something below — it appears instantly.
        </div>
      ) : (
        <Virtuoso
          ref={virtuosoRef}
          scrollerRef={captureScroller}
          data={items}
          firstItemIndex={top.current.first}
          computeItemKey={(_, item) => item.key}
          initialTopMostItemIndex={{ index: Math.max(0, items.length - 1), align: "end" }}
          followOutput={(isAtBottom) => (isAtBottom && !isUserScrolling() ? "auto" : false)}
          atBottomStateChange={onBottomChange}
          totalListHeightChanged={holdBottom}
          atBottomThreshold={AT_BOTTOM_PX}
          increaseViewportBy={{ top: 600, bottom: 200 }}
          components={{ Footer }}
          itemContent={(_, item) =>
            item.kind === "msg" ? (
              item.key === flashKey ? (
                <div className="reveal-flash" data-reveal={item.msg.meta?.messageId}>
                  <MessageBubble msg={item.msg} onOpenVoiceSession={onOpenVoiceSession} />
                </div>
              ) : (
                <MessageBubble msg={item.msg} onOpenVoiceSession={onOpenVoiceSession} />
              )
            ) : item.kind === "stream" ? (
              <StreamingBubble stream={item.stream} />
            ) : (
              <div className="day-divider mono-label">{item.label}</div>
            )
          }
        />
      )}
      {/* Scroll-to-latest FAB (step 5 #3): ALWAYS rendered so the exit
          animation plays — visibility is a class toggle on !atBottom, the
          legacy dashboard's trick (public/app.js:887). The unseen count
          folds in as a badge on the same control. */}
      <button
        className={`scroll-bottom-fab${!atBottom ? " visible" : ""}`}
        onClick={jumpToBottom}
        aria-label="Scroll to latest"
        aria-hidden={atBottom}
        tabIndex={atBottom ? -1 : 0}
      >
        <IconChevronDown />
        {unseen > 0 && <span className="scroll-bottom-badge">{unseen > 99 ? "99+" : unseen}</span>}
      </button>
    </div>
  );
}
