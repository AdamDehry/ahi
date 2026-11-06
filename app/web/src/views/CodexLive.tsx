import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { clockLabel } from "../components/panel/format";
import { EMPTY, STATUS_WORD, elapsedLabel, fetchLive, isLive, merge, onCodexLive, type LiveEvent, type LiveState } from "../lib/codexLive";

/**
 * A Codex build, live and read-only — what the Claude app's
 * remote-control view gives him for a Claude build: what Codex says, every
 * command it runs, every file it touches, and whether it is working, waiting
 * or done, with the clock running.
 *
 * Nothing here can type into the session. It keeps working across a page
 * reload (it starts again from the recent window) and a gateway restart (it
 * keeps its place by event number and the socket's doorbell comes back with
 * the socket); polling covers any frame that never arrives.
 */

const POLL_LIVE_MS = 2500;
const POLL_IDLE_MS = 15_000;
const NEAR_BOTTOM_PX = 64;

const VERB: Record<string, string> = { read: "Read", search: "Search", list: "List", run: "Ran" };

function Event({ e, tz }: { e: LiveEvent; tz: string }) {
  switch (e.kind) {
    case "say":
      return <div className={`cl-say${e.final ? " final" : ""}`}>{e.text}</div>;
    case "user":
      return (
        <div className="cl-user">
          <span className="mono-label">{e.brief ? "Brief" : "Message in"} · {clockLabel(e.at, tz)}</span>
          {e.text && <div className="cl-user-text">{e.text}</div>}
        </div>
      );
    case "cmd":
      return (
        <div className={`cl-cmd${e.exit !== null && e.exit !== 0 ? " bad" : ""}`}>
          <span className="cl-verb">{VERB[e.verb] ?? "Ran"}</span>
          <code>{e.text}</code>
          {e.exit !== null && e.exit !== 0 && <span className="cl-exit">exit {e.exit}</span>}
          {e.ms !== null && <span className="cl-ms">{elapsedLabel(e.ms)}</span>}
        </div>
      );
    case "edit":
      return (
        <div className="cl-edit">
          <span className="cl-verb">{e.files.length === 1 ? "Edited" : `Edited ${e.files.length}`}</span>
          <div className="cl-files">
            {e.files.map((f) => (
              <div key={f.path} className="cl-file">
                <code>{f.path}</code>
                <span className="cl-diff">
                  {f.op === "add" ? "new " : f.op === "delete" ? "deleted " : ""}
                  {f.plus > 0 && <span className="plus">+{f.plus}</span>} {f.minus > 0 && <span className="minus">−{f.minus}</span>}
                </span>
              </div>
            ))}
          </div>
        </div>
      );
    case "web":
      return (
        <div className="cl-cmd">
          <span className="cl-verb">Looked</span>
          <code>{e.text}</code>
        </div>
      );
    case "turn":
      return (
        <div className="cl-turn mono-label">
          {e.phase === "start" ? `Started work · ${clockLabel(e.at, tz)}` : e.phase === "aborted" ? `Interrupted · ${clockLabel(e.at, tz)}` : `Finished its turn · ${clockLabel(e.at, tz)}${e.ms ? ` · ${elapsedLabel(e.ms)}` : ""}`}
        </div>
      );
  }
}

export function CodexLivePanel({ build, tz, initial }: { build: string; tz: string; /** Seed (static renders, previews). */ initial?: LiveState }) {
  const [st, setSt] = useState<LiveState>(initial ?? EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [pinned, setPinned] = useState(true);
  const stRef = useRef(st);
  stRef.current = st;
  const inflight = useRef(false);
  const again = useRef(false);
  const skew = useRef(0);
  const box = useRef<HTMLDivElement | null>(null);

  const pull = useCallback(async () => {
    if (inflight.current) {
      again.current = true;
      return;
    }
    inflight.current = true;
    try {
      do {
        again.current = false;
        const v = await fetchLive(build, stRef.current.view?.cursor ?? 0);
        skew.current = Date.parse(v.serverNow) - Date.now();
        setSt((prev) => {
          const next = merge(prev, v);
          stRef.current = next;
          return next;
        });
        setError(null);
      } while (again.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Can't reach the gateway.");
    } finally {
      inflight.current = false;
    }
  }, [build]);

  // A different build: start clean.
  useEffect(() => {
    setSt(EMPTY);
    stRef.current = EMPTY;
    setError(null);
    setPinned(true);
    void pull();
  }, [build, pull]);

  // Doorbell + poll + coming back to the foreground.
  const live = st.view ? isLive(st.view.status) : true;
  useEffect(() => {
    const off = onCodexLive(build, () => void pull());
    const t = setInterval(() => document.visibilityState === "visible" && void pull(), live ? POLL_LIVE_MS : POLL_IDLE_MS);
    const onVis = () => document.visibilityState === "visible" && void pull();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      off();
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [build, pull, live]);

  // The elapsed clock.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);

  // Auto-scroll: follow the bottom unless he has scrolled up to read.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [st.events.length, st.view?.now?.text, pinned]);
  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX);
  };

  const v = st.view;
  void tick;
  const now = Date.now() + skew.current;
  const started = v?.startedAt ? Date.parse(v.startedAt) : null;
  const ended = v?.endedAt ? Date.parse(v.endedAt) : null;
  const elapsed = started ? (ended ?? now) - started : null;
  const status = v?.status ?? "starting";
  const quietFor = v?.lastActivityAt ? now - Date.parse(v.lastActivityAt) : null;

  return (
    <section className={`cl-panel ${status}`} aria-label="Live Codex session">
      <div className="cl-head">
        <span className={`cl-status ${status}`}>
          <i />
          {STATUS_WORD[status]}
        </span>
        {elapsed !== null && <span className="mono-label">{elapsedLabel(elapsed)}</span>}
        {v?.session?.model && <span className="mono-label">{[v.session.model, v.session.effort].filter(Boolean).join(" · ")}</span>}
        <span className="mono-label cl-ro">Live · read-only</span>
      </div>
      {error && <div className="cl-error">{v ? `Showing what arrived before — ${error}` : error}</div>}
      <div className="cl-log" ref={box} onScroll={onScroll}>
        {st.omitted > 0 && <div className="cl-turn mono-label">{st.omitted} earlier steps not shown</div>}
        {!v && !error && <div className="cl-quiet">Opening the session…</div>}
        {v && !st.events.length && status === "starting" && <div className="cl-quiet">Codex is starting. The transcript appears the moment the brief goes in.</div>}
        {v && status === "no-session" && <div className="cl-quiet">No Codex session was found for this build.</div>}
        {st.events.map((e) => (
          <Event key={e.seq} e={e} tz={tz} />
        ))}
        {v?.now && (
          <div className="cl-cmd running">
            <span className="cl-verb">Running</span>
            <code>{v.now.text}</code>
            <span className="cl-ms">{elapsedLabel(now - Date.parse(v.now.since))}</span>
          </div>
        )}
        {status === "running" && !v?.now && quietFor !== null && quietFor > 4000 && <div className="cl-quiet">Thinking… {elapsedLabel(quietFor)}</div>}
        {status === "waiting" && <div className="cl-quiet">Codex finished its turn and is waiting for the next message.</div>}
      </div>
      {!pinned && st.events.length > 0 && (
        <button className="cl-jump mono-label" onClick={() => setPinned(true)}>
          Latest ↓
        </button>
      )}
    </section>
  );
}
