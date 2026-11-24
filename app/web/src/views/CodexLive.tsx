import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { clockLabel } from "../components/panel/format";
import { useT, type Key } from "../i18n";
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

const VERB: Record<string, Key> = { read: "ops.cl.verb.read", search: "ops.cl.verb.search", list: "ops.cl.verb.list", run: "ops.cl.verb.ran" };

function Event({ e, tz }: { e: LiveEvent; tz: string }) {
  const t = useT();
  switch (e.kind) {
    case "say":
      return <div className={`cl-say${e.final ? " final" : ""}`} dir="auto">{e.text}</div>;
    case "user":
      return (
        <div className="cl-user">
          <span className="mono-label">{e.brief ? t("ops.cl.brief") : t("ops.cl.messageIn")} · {clockLabel(e.at, tz)}</span>
          {e.text && <div className="cl-user-text" dir="auto">{e.text}</div>}
        </div>
      );
    case "cmd":
      return (
        <div className={`cl-cmd${e.exit !== null && e.exit !== 0 ? " bad" : ""}`}>
          <span className="cl-verb">{t(Object.prototype.hasOwnProperty.call(VERB, e.verb) ? VERB[e.verb] : "ops.cl.verb.ran")}</span>
          <code dir="ltr">{e.text}</code>
          {e.exit !== null && e.exit !== 0 && <span className="cl-exit">{t("ops.cl.exit", { code: String(e.exit) })}</span>}
          {e.ms !== null && <span className="cl-ms">{elapsedLabel(e.ms)}</span>}
        </div>
      );
    case "edit":
      return (
        <div className="cl-edit">
          <span className="cl-verb">{e.files.length === 1 ? t("ops.cl.edited") : t("ops.cl.editedN", { n: e.files.length })}</span>
          <div className="cl-files">
            {e.files.map((f) => (
              <div key={f.path} className="cl-file">
                <code dir="ltr">{f.path}</code>
                <span className="cl-diff">
                  {f.op === "add" ? t("ops.cl.new") : f.op === "delete" ? t("ops.cl.deleted") : ""}
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
          <span className="cl-verb">{t("ops.cl.looked")}</span>
          <code dir="ltr">{e.text}</code>
        </div>
      );
    case "turn":
      return (
        <div className="cl-turn mono-label">
          {e.phase === "start" ? t("ops.cl.startedWork", { time: clockLabel(e.at, tz) }) : e.phase === "aborted" ? t("ops.cl.interrupted", { time: clockLabel(e.at, tz) }) : `${t("ops.cl.finishedTurn", { time: clockLabel(e.at, tz) })}${e.ms ? ` · ${elapsedLabel(e.ms)}` : ""}`}
        </div>
      );
  }
}

export function CodexLivePanel({ build, tz, initial }: { build: string; tz: string; /** Seed (static renders, previews). */ initial?: LiveState }) {
  const t = useT();
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
      setError(err instanceof Error ? err.message : t("ops.cantReachGateway"));
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
    const timer = setInterval(() => document.visibilityState === "visible" && void pull(), live ? POLL_LIVE_MS : POLL_IDLE_MS);
    const onVis = () => document.visibilityState === "visible" && void pull();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      off();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [build, pull, live]);

  // The elapsed clock.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
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
    <section className={`cl-panel ${status}`} aria-label={t("ops.cl.session")}>
      <div className="cl-head">
        <span className={`cl-status ${status}`}>
          <i />
          {t(STATUS_WORD[status])}
        </span>
        {elapsed !== null && <span className="mono-label">{elapsedLabel(elapsed)}</span>}
        {v?.session?.model && <span className="mono-label" dir="ltr">{[v.session.model, v.session.effort].filter(Boolean).join(" · ")}</span>}
        <span className="mono-label cl-ro">{t("ops.cl.readOnly")}</span>
      </div>
      {error && <div className="cl-error">{v ? t("ops.cl.showingBefore", { error }) : error}</div>}
      <div className="cl-log" ref={box} onScroll={onScroll}>
        {st.omitted > 0 && <div className="cl-turn mono-label">{t("ops.cl.omitted", { n: st.omitted })}</div>}
        {!v && !error && <div className="cl-quiet">{t("ops.cl.opening")}</div>}
        {v && !st.events.length && status === "starting" && <div className="cl-quiet">{t("ops.cl.starting")}</div>}
        {v && status === "no-session" && <div className="cl-quiet">{t("ops.cl.noSession")}</div>}
        {st.events.map((e) => (
          <Event key={e.seq} e={e} tz={tz} />
        ))}
        {v?.now && (
          <div className="cl-cmd running">
            <span className="cl-verb">{t("ops.cl.running")}</span>
            <code dir="ltr">{v.now.text}</code>
            <span className="cl-ms">{elapsedLabel(now - Date.parse(v.now.since))}</span>
          </div>
        )}
        {status === "running" && !v?.now && quietFor !== null && quietFor > 4000 && <div className="cl-quiet">{t("ops.cl.thinking", { time: elapsedLabel(quietFor) })}</div>}
        {status === "waiting" && <div className="cl-quiet">{t("ops.cl.waiting")}</div>}
      </div>
      {!pinned && st.events.length > 0 && (
        <button className="cl-jump mono-label" onClick={() => setPinned(true)}>
          {t("ops.cl.latest")}
        </button>
      )}
    </section>
  );
}
