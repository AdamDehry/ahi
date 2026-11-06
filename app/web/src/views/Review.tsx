import { useCallback, useEffect, useRef, useState } from "react";
import { actions, useAppState } from "../store";
import { renderMarkdown } from "../lib/markdown";
import {
  ackAlert,
  approveWithFingerprint,
  decide,
  fetchItem,
  fetchReview,
  webauthnSupported,
  type Decision,
  type ReviewItem,
  type ReviewView,
  type SystemAlert,
} from "../lib/review";
import { IconBack, IconCheck, IconFingerprint } from "../components/icons";

/**
 * Review (Standing Mandates v1) — the owner's closure screen.
 *
 *   Waiting for you · Holding · Done since last time
 *
 * Open tracks moved to Builds (design C10): Review is for decisions, Builds
 * is for close-out, and two lists of open tracks would drift apart.
 *
 * Tap an item → full brief → Approve / No / Hold, on a bar the right thumb
 * reaches. YELLOW is one tap. RED shows the whole brief first, then asks for
 * the phone's fingerprint; the gateway verifies it. With no passkey, a RED
 * item can't be approved here — it stays waiting and says why.
 */

// ── formatting ───────────────────────────────────────────────────────────

function ago(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (mins < 60) return `${Math.max(1, mins)}M`;
  const h = Math.round(mins / 60);
  if (h < 36) return `${h}H`;
  return `${Math.round(h / 24)}D`;
}

function clock(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** "TODAY 11:00 AM" / "FRI 4:40 PM" — in the zone the schedule runs in (ET),
 *  so the label matches the message, wherever the phone is. */
function whenLabel(iso: string, tz: string): string {
  const d = new Date(iso);
  const day = (x: Date) => x.toLocaleDateString("en-US", { timeZone: tz });
  const time = d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  if (day(d) === day(new Date())) {
    const hour = Number(d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", hour12: false }));
    return `${hour < 17 ? "TODAY" : "TONIGHT"} ${time}`;
  }
  const days = (d.getTime() - Date.now()) / 86_400_000;
  if (days <= 6) return `${d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" })} ${time}`;
}

const LANE_WORD: Record<ReviewItem["lane"], string> = { GREEN: "GREEN", YELLOW: "YELLOW", RED: "RED" };

function outcome(item: ReviewItem): { word: string; tone: "positive" | "muted" } {
  if (item.status === "done") return { word: "DONE", tone: "positive" };
  if (item.status === "denied") return { word: "SAID NO", tone: "muted" };
  if (item.decided_how === "fingerprint") return { word: "APPROVED · FINGERPRINT", tone: "positive" };
  if (item.decided_how?.startsWith("chat")) return { word: "APPROVED · IN THREAD", tone: "positive" };
  return { word: "APPROVED", tone: "positive" };
}

// ── list ────────────────────────────────────────────────────────────────

function LaneChip({ item }: { item: ReviewItem }) {
  if (item.lane === "RED") {
    return (
      <span className="rv-lane red">
        <IconFingerprint size={13} />
        RED · FINGERPRINT
      </span>
    );
  }
  return <span className={`rv-lane ${item.lane.toLowerCase()}`}>{LANE_WORD[item.lane]}{item.lane === "YELLOW" ? " · ONE TAP" : ""}</span>;
}

function ItemCard({ item, held }: { item: ReviewItem; held?: boolean }) {
  const lane = item.lane === "RED" ? "red" : item.lane === "YELLOW" ? "yellow" : "green";
  const who = AGENT_NAME[item.created_by] ?? (item.created_by ? item.created_by[0].toUpperCase() + item.created_by.slice(1) : "");
  return (
    <button type="button" className={`rv-item lane-${lane}${held ? " held" : ""}`} onClick={() => actions.openReview(item.id)}>
      <span className={`rv-risk ${lane}`} aria-hidden="true" />
      <span className="rv-item-main">
        <span className="rv-item-meta">
          <span className={`rd-tag ${lane === "yellow" ? "gold" : lane}`}>
            {lane === "red" && <IconFingerprint size={11} />}
            {lane === "red" ? "Fingerprint" : lane === "yellow" ? "One tap" : "Low risk"}
          </span>
          <span>
            {who ? `${who} · ` : ""}
            {ago(item.created).toLowerCase()} ago
          </span>
        </span>
        <span className="rv-item-title">{item.title}</span>
        <span className="rv-item-sub">
          {item.desk}
          {item.cost_risk ? ` · ${item.cost_risk}` : ""}
        </span>
        {held && <span className="rv-item-held">{item.reminded_at ? `Reminded once at ${clock(item.reminded_at)} · no more pings` : "On hold"}</span>}
      </span>
      <svg className="rv-item-chev" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m9 6 6 6-6 6" />
      </svg>
    </button>
  );
}

const AGENT_NAME: Record<string, string> = { michael: "Michael", zali: "Zali", avi: "Avi", miriam: "Miriam", foreman: "Michael" };
type ReviewTab = "Waiting" | "Holding" | "Done" | "System";

function DoneRow({ item }: { item: ReviewItem }) {
  const o = outcome(item);
  return (
    <button className="rv-done-row" onClick={() => actions.openReview(item.id)}>
      <span className={`rv-done-mark ${o.tone}`}>{item.status === "denied" ? "×" : <IconCheck />}</span>
      <span className="rv-done-body">
        <span className="rv-done-title">{item.title}</span>
        <span className={`mono-label ${o.tone === "positive" ? "positive" : ""}`}>
          {o.word} · {clock(item.done_at ?? item.decided_at ?? item.created).toUpperCase()}
        </span>
      </span>
    </button>
  );
}

function BuildRow({ b }: { b: ReviewView["builds"][number] }) {
  const ok = b.state === "done" || b.state === "shipped";
  return (
    <div className="rv-done-row static">
      <span className={`rv-done-mark ${ok ? "positive" : "muted"}`}>{ok ? <IconCheck /> : "!"}</span>
      <span className="rv-done-body">
        <span className="rv-done-title">{b.name}</span>
        <span className={`mono-label ${ok ? "" : "negative"}`}>
          BUILD {ok ? "FINISHED" : b.state.toUpperCase()}
          {b.agent ? ` · ${b.agent.toUpperCase()}` : ""}
          {b.at ? ` · ${clock(b.at).toUpperCase()}` : ""}
        </span>
      </span>
    </div>
  );
}

/**
 * Review → System: what used to arrive as raw Telegram lines.
 * One row per kind of alert — a repeat bumps its count, never adds a row.
 * "Got it" stops the one push a hard alert earns after six unanswered hours;
 * the row stays until the problem clears itself.
 */
function AlertRow({ a, onAck }: { a: SystemAlert; onAck: (cls: string) => void }) {
  const resolved = !!a.resolved_at;
  const tone = resolved ? "positive" : a.severity === "hard" && !a.acked_at ? "negative" : "";
  return (
    <div className={`rv-done-row static rv-alert${resolved ? " resolved" : ""}`}>
      <span className={`rv-done-mark ${resolved ? "positive" : "muted"}`}>{resolved ? <IconCheck /> : "!"}</span>
      <span className="rv-done-body">
        <span className="rv-done-title">{a.title}</span>
        <span className={`mono-label ${tone}`}>
          {resolved
            ? `CLEARED · ${clock(a.resolved_at!).toUpperCase()}`
            : `${a.severity === "hard" ? "HARD" : "SOFT"}${a.count > 1 ? ` · ${a.count}×` : ""} · SINCE ${clock(a.first_seen).toUpperCase()} · LAST ${ago(a.last_seen)} AGO${a.acked_at ? " · SEEN" : ""}`}
        </span>
        {a.detail && !resolved && <span className="rv-alert-detail">{a.detail}</span>}
      </span>
      {!resolved && !a.acked_at && (
        <button className="rv-alert-ack mono-label" onClick={() => onAck(a.class)}>
          GOT IT
        </button>
      )}
    </div>
  );
}

export function ReviewList() {
  const { reviewRev } = useAppState();
  const [view, setView] = useState<ReviewView | null>(null);
  const [tab, setTab] = useState<ReviewTab>("Waiting");
  const marked = useRef(false);

  const load = useCallback(() => {
    // The first look of a visit advances "since last time"; refreshes don't.
    const mark = !marked.current;
    marked.current = true;
    void fetchReview(mark).then((v) => {
      if (!v) return;
      setView(v);
      actions.setReviewWaiting(v.waiting.length);
    });
  }, []);

  useEffect(load, [load, reviewRev]);
  useEffect(() => {
    const onVis = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [load]);

  if (!view) {
    return (
      <div className="tool-page rv-page">
        <div className="rv-col">
          <div className="rv-card skeleton-card" />
          <div className="rv-card skeleton-card" />
        </div>
      </div>
    );
  }

  const nothing = !view.waiting.length && !view.holding.length;
  const alerts = view.alerts ?? [];
  const openAlerts = alerts.filter((a) => !a.resolved_at).length;
  const ack = (cls: string) => void ackAlert(cls).then(load);
  const next = view.next.map((n) => `${n.label.toUpperCase()} ${whenLabel(n.at, view.tz)}`).join(" · ");

  const tabs: Array<{ key: ReviewTab; n: number }> = [
    { key: "Waiting", n: view.waiting.length },
    { key: "Holding", n: view.holding.length },
    { key: "Done", n: view.done.length + view.builds.length },
    { key: "System", n: openAlerts },
  ];
  const doneHead = view.first_visit ? "Done this past week" : `Done since ${clock(view.since)}`;

  return (
    <div className="tool-page rv-page rd-review">
      <div className="rv-col">
        <div className="rd-builds-head">
          <div className="rd-eyebrow">THE DECISION DESK</div>
          <h2>
            Your judgment matters<span className="rd-title-dot">.</span>
          </h2>
          <p>A few considered decisions. Then, back to your day.</p>
        </div>
        <div className="rd-tabs" role="tablist" aria-label="Decisions">
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`rd-tab${tab === t.key ? " active" : ""}`} onClick={() => setTab(t.key)}>
              {t.key}
              {t.n > 0 && t.key !== "Done" && <span className="rv-tab-n">{t.n}</span>}
            </button>
          ))}
        </div>
        <div className="rv-items">
          {tab === "Waiting" &&
            (view.waiting.length ? (
              view.waiting.map((i) => <ItemCard key={i.id} item={i} />)
            ) : (
              <div className="rv-empty">
                <h2 className="rv-empty-title">
                  All <em>clear.</em>
                </h2>
                <p className="rv-empty-body">{nothing ? "Nothing needs you right now." : "Nothing waiting. Some decisions are holding."}</p>
              </div>
            ))}
          {tab === "Holding" && (view.holding.length ? view.holding.map((i) => <ItemCard key={i.id} item={i} held />) : <div className="rv-quiet">Nothing is holding.</div>)}
          {(tab === "Waiting" || tab === "Done") && (
            <>
              <div className="rv-head2">
                <h2>{tab === "Waiting" ? "Recently resolved" : doneHead}</h2>
              </div>
              {view.done.length || view.builds.length ? (
                <div className="rv-done-list">
                  {view.done.map((i) => (
                    <DoneRow key={i.id} item={i} />
                  ))}
                  {view.builds.map((b) => (
                    <BuildRow key={b.id} b={b} />
                  ))}
                </div>
              ) : (
                <div className="rv-quiet">Nothing new since {view.first_visit ? "last week" : clock(view.since)}.</div>
              )}
            </>
          )}
          {tab === "System" &&
            (alerts.length ? (
              <div className="rv-done-list">
                {alerts.map((a) => (
                  <AlertRow key={a.class} a={a} onAck={ack} />
                ))}
              </div>
            ) : (
              <div className="rv-quiet">No system alerts.</div>
            ))}
        </div>
        {next && tab === "Waiting" && <div className="mono-label rv-next">NEXT · {next}</div>}
      </div>
    </div>
  );
}

// ── detail ──────────────────────────────────────────────────────────────

type Phase = { kind: "idle" } | { kind: "busy"; which: Decision } | { kind: "error"; message: string };

export function ReviewDetail({ id, withBackBar }: { id: string; withBackBar?: boolean }) {
  const { reviewRev } = useAppState();
  const [item, setItem] = useState<ReviewItem | null>(null);
  const [passkeys, setPasskeys] = useState<number>(0);
  const [missing, setMissing] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [readToEnd, setReadToEnd] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void fetchItem(id).then((r) => {
      if (!live) return;
      if (!r) return setMissing(true);
      setItem(r.item);
      setPasskeys(r.passkeys);
    });
    return () => {
      live = false;
    };
  }, [id, reviewRev]);

  // "Brief shown in full first": RED approval unlocks once the end of the
  // brief has been on screen.
  useEffect(() => {
    const el = endRef.current;
    if (!el || readToEnd) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setReadToEnd(true);
    }, { threshold: 1 });
    io.observe(el);
    return () => io.disconnect();
  }, [item, readToEnd]);

  if (missing) return <div className="tool-page"><div className="tool-empty mono-label">THAT ITEM IS GONE</div></div>;
  if (!item) return <div className="tool-page rv-page"><div className="rv-col"><div className="l2-content skeleton-card" /></div></div>;

  const open = item.status === "waiting" || item.status === "held";
  const red = item.lane === "RED";
  const busy = phase.kind === "busy";

  async function act(d: Decision) {
    if (!item || busy) return;
    setPhase({ kind: "busy", which: d });
    const r = red && d === "approve" ? await approveWithFingerprint(item.id) : await decide(item.id, d);
    if (r.ok) {
      setItem(r.value.item);
      setPhase({ kind: "idle" });
      actions.reviewChanged();
    } else {
      setPhase({ kind: "error", message: r.error });
    }
  }

  const canFingerprint = passkeys > 0 && webauthnSupported();

  return (
    <div className={`rv-detail lane-${item.lane.toLowerCase()}`}>
      <div className="rv-detail-scroll">
        <div className="rv-col">
          {withBackBar && (
            <div className="l2-head">
              <button className="l2-back" onClick={actions.closeReviewItem}>
                <IconBack />
                <span className="mono-label">REVIEW</span>
              </button>
            </div>
          )}

          {red && open && (
            <div className="rv-red-banner">
              <IconFingerprint size={20} />
              <div>
                <div className="rv-red-banner-title">Needs your fingerprint</div>
                <div className="rv-red-banner-body">
                  Money, a message in your name, credentials, or something that can't be undone. Read it through — approving asks for your fingerprint, and the gateway checks it.
                </div>
              </div>
            </div>
          )}

          <div className="rv-detail-lane">
            <LaneChip item={item} />
            <span className="mono-label">
              {item.desk.toUpperCase()} · FROM {item.created_by.toUpperCase()} · {ago(item.created)} AGO
            </span>
          </div>
          <h1 className="rv-detail-title">{item.title}</h1>

          {item.cost_risk && (
            <div className="rv-cost">
              <span className="mono-label">COST / RISK</span>
              <span className="rv-cost-text">{item.cost_risk}</span>
            </div>
          )}

          <div className="rv-brief msg-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.brief || "_No brief._") }} />
          <div ref={endRef} className="rv-brief-end mono-label">END OF BRIEF</div>
          {item.ref && <div className="rv-ref mono-label">REF · {item.ref}</div>}
        </div>
      </div>

      <div className="rv-actionbar">
        <div className="rv-col">
          {phase.kind === "error" && <div className="rv-error" role="alert">{phase.message}</div>}

          {!open ? (
            <div className={`rv-result ${item.status}`}>
              <span className="rv-result-mark">{item.status === "denied" ? "×" : <IconCheck />}</span>
              <span>
                {item.status === "denied"
                  ? "You said no."
                  : item.status === "done"
                    ? `Done${item.done_note ? ` — ${item.done_note}` : ""}.`
                    : item.decided_how === "fingerprint"
                      ? "Approved with your fingerprint."
                      : "Approved."}
              </span>
              <span className="mono-label">{item.decided_at ? clock(item.decided_at).toUpperCase() : ""}</span>
            </div>
          ) : (
            <>
              {red && !canFingerprint && (
                <div className="rv-nopasskey">
                  <span>
                    {passkeys === 0
                      ? "No passkey yet, so RED can't be approved in the app. It stays waiting."
                      : "This browser can't use passkeys. Open the installed app on your phone."}
                  </span>
                  {passkeys === 0 && (
                    <button className="rv-link" onClick={() => actions.toggleSettings(true)}>
                      Set up a passkey
                    </button>
                  )}
                </div>
              )}
              <div className="rv-buttons">
                <button className="rv-btn ghost" disabled={busy || item.status === "held"} onClick={() => void act("hold")}>
                  {item.status === "held" ? "Holding" : "Hold"}
                </button>
                <button className="rv-btn outline" disabled={busy} onClick={() => void act("deny")}>
                  No
                </button>
                {(!red || canFingerprint) && (
                  <button
                    className={`rv-btn primary${red ? " red" : ""}`}
                    disabled={busy || (red && !readToEnd)}
                    onClick={() => void act("approve")}
                  >
                    {red && <IconFingerprint size={18} />}
                    {busy && phase.which === "approve"
                      ? red ? "Checking…" : "Approving…"
                      : red
                        ? readToEnd ? "Approve" : "Read to the end"
                        : "Approve"}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Desktop / non-pushed entry: list, or the open item with a back bar. */
export default function Review() {
  const { reviewItem } = useAppState();
  return reviewItem ? <ReviewDetail id={reviewItem} withBackBar /> : <ReviewList />;
}
