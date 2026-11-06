/**
 * The bell inbox (slice 9, D08). Rows come from services that already exist:
 * build attention (state.attention), waiting Review items, the schedule's
 * attention rows, and WhatsApp customers waiting. Categories and Unread
 * filter them. "Seen" never approves, closes or resolves anything: schedule
 * rows use the server's read marker; the rest are marked seen on this device
 * (labelled as such). Opening a row goes to its exact source.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { actions, useAppState } from "../store";
import { fetchReview, type ReviewItem } from "../lib/review";
import { SCHEDULE_URL, ago, scheduleUi, useScheduleUi, type AttentionRow, type ScheduleView } from "../lib/schedule";
import { BOT_LABELS } from "../lib/types";
import { usePushPrefs } from "../lib/push";
import { Icon, type IconName } from "./icons";
import { goPage } from "./Shell";
import { readStoredList, writeStoredList } from "../lib/cache";

type Cat = "work" | "gmail" | "calendar";
/** `attn`: the attention-bar key a build row stands for — seeing the row dismisses that bar, and a dismissed bar reads as seen. */
interface Row { key: string; cat: Cat; kicker: string; title: string; line: string; at: string | null; open: () => void; serverRead?: string; attn?: string; dismissed?: boolean }

const SEEN_KEY = "ahi-bell-seen";
const readSeen = (): Set<string> => new Set(readStoredList(SEEN_KEY));
const writeSeen = (s: Set<string>) => writeStoredList(SEEN_KEY, [...s], 500);

/** The bell's rows (admin sources only), fetched once for both the dot and the open inbox (ChromeActions owns it). */
export function useBellSources(open: boolean) {
  const s = useAppState();
  const admin = !!s.user?.admin;
  // Settings → Notifications: In-app off empties the inbox; an app or activity switched off drops its rows.
  const prefs = usePushPrefs(`${s.user?.userId ?? ""}:${admin ? 1 : 0}`);
  const [review, setReview] = useState<ReviewItem[]>([]);
  const [sched, setSched] = useState<AttentionRow[]>([]);
  // Unread inbox mail from every connected Gmail (FINAL's Gmail source, blue).
  const [mail, setMail] = useState<Array<{ account: string; id: string; from: string; subject: string; at: string }>>([]);
  const { rev } = useScheduleUi();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!admin) {
      setReview([]);
      setSched([]);
      return;
    }
    let live = true;
    void fetchReview(false).then((v) => live && setReview(v?.waiting ?? []));
    fetch(SCHEDULE_URL, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<ScheduleView>) : null))
      .then((v) => live && setSched(v?.attention ?? []))
      .catch(() => {});
    fetch("/app/gmail/threads?account=all&folder=inbox&unread=1&limit=8", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => live && setMail((v?.threads ?? []).slice(0, 8)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [admin, s.user?.userId, open, rev, s.reviewRev, s.buildsRev, tick]);
  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    if (!admin) return out; // every source here is owner-only; a session change must not leave rows behind
    if (prefs?.inApp === false) return out;
    const allow = (src: string, ev?: string) => {
      const p = prefs?.sources?.[src];
      return !p || (p.enabled && (!ev || p.events[ev] !== false));
    };
    if (allow("builds", "approval")) for (const a of s.attention ?? []) out.push({ key: `att:${a.key}`, cat: "work", kicker: a.kind === "question" ? "Question" : "Builds", title: a.title, line: a.line, at: null, open: () => actions.openBuilds(a.cardId), attn: a.key, dismissed: s.attentionDismissed.includes(a.key) });
    if (allow("review", "requests")) for (const r of review) out.push({ key: `rv:${r.id}`, cat: "work", kicker: "Review", title: r.title, line: r.cost_risk || "Ready for your look.", at: r.created, open: () => actions.openReview(r.id) });
    if (allow("calendar"))
      for (const a of sched)
        out.push({
        key: `sc:${a.id}`, cat: "calendar", kicker: a.kind === "decision" ? "Decision" : a.kind === "review" ? "Review" : "Question",
        title: a.text, line: BOT_LABELS[a.who] ?? a.who, at: a.at, serverRead: a.unread ? a.id : undefined,
        open: () => (a.kind === "review" ? actions.openReview() : scheduleUi.open(a.block)),
      });
    if (allow("gmail")) for (const m of mail) out.push({ key: `gm:${m.account}:${m.id}`, cat: "gmail", kicker: "Gmail", title: m.subject, line: m.from, at: m.at, open: () => goPage("gmail") });
    return out;
  }, [admin, prefs, s.attention, s.attentionDismissed, review, sched, mail]);
  return { rows, prefs, refresh: () => setTick((n) => n + 1) };
}

const CAT_ICON: Record<Cat, IconName> = { work: "layers", gmail: "gmail", calendar: "calendar" };
const CAT_LABEL: Record<Cat, string> = { work: "Your work", gmail: "Gmail", calendar: "Calendar" };

/** Unseen count for the bell's dot. */
export function bellCount(rows: Row[]): number {
  const seen = readSeen();
  return rows.filter((r) => !seen.has(r.key) && !r.dismissed && (r.cat !== "calendar" || r.serverRead)).length;
}

export default function BellInbox({ rows, refresh, onClose }: { rows: Row[]; refresh: () => void; onClose: () => void }) {
  const [seen, setSeen] = useState(readSeen);
  const [tab, setTab] = useState<"all" | "unread">("all");
  const [cat, setCat] = useState<Cat | "all">("all");
  const box = useRef<HTMLDivElement>(null);
  const isUnread = useCallback((r: Row) => (r.cat === "calendar" ? !!r.serverRead && !seen.has(r.key) : !seen.has(r.key) && !r.dismissed), [seen]);
  const unread = rows.filter(isUnread);
  const shown = rows.filter((r) => (cat === "all" || r.cat === cat) && (tab === "all" || isUnread(r)));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current && !box.current.contains(t) && !(t as HTMLElement).closest?.(".rd-bell-btn")) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);
  const markSeen = async (list: Row[]) => {
    const next = new Set(seen);
    list.forEach((r) => next.add(r.key));
    setSeen(next);
    writeSeen(next);
    actions.dismissAttention(...list.map((r) => r.attn).filter((k): k is string => !!k));
    const ids = list.map((r) => r.serverRead).filter((x): x is string => !!x);
    if (ids.length && (await scheduleUi.markRead(ids))) refresh();
  };
  const groups = (["work", "gmail", "calendar"] as Cat[]).map((c) => ({ c, items: shown.filter((r) => r.cat === c) })).filter((g) => g.items.length);
  return (
    <div className="rd-bell" ref={box} role="dialog" aria-label="Notifications">
      <div className="rd-bell-head">
        <div>
          <div className="rd-eyebrow">YOUR INBOX</div>
          <h2>
            Notifications <span>{unread.length} unread</span>
          </h2>
        </div>
        <button type="button" className="rd-chat-control" aria-label="Close notifications" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="rd-bell-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "all"} className={tab === "all" ? "on" : ""} onClick={() => setTab("all")}>
          All activity
        </button>
        <button type="button" role="tab" aria-selected={tab === "unread"} className={tab === "unread" ? "on" : ""} onClick={() => setTab("unread")}>
          Unread <span>{unread.length}</span>
        </button>
      </div>
      <div className="rd-chips">
        {(["all", "work", "gmail", "calendar"] as const).map((c) => (
          <button key={c} type="button" className={`rd-chip${cat === c ? " on" : ""}`} aria-pressed={cat === c} onClick={() => setCat(c)}>
            {c === "all" ? "Everything" : CAT_LABEL[c]}
          </button>
        ))}
      </div>
      <div className="rd-bell-list">
        {!groups.length && <p className="rd-quiet rd-empty-line">{tab === "unread" ? "Nothing unread." : "Nothing needs you right now."}</p>}
        {groups.map((g) => (
          <section key={g.c} className={`rd-bell-group tone-${g.c}`}>
            <h3>
              <Icon name={CAT_ICON[g.c]} /> {CAT_LABEL[g.c]} <span>{g.items.length}</span>
            </h3>
            {g.items.map((r) => (
              <button
                key={r.key}
                type="button"
                className={`rd-bell-row${isUnread(r) ? " unread" : " seen"}`}
                onClick={() => {
                  void markSeen([r]);
                  r.open();
                  onClose();
                }}
              >
                <span className="rd-bell-kicker">{r.kicker}</span>
                <span className="rd-bell-title">{r.title}</span>
                <span className="rd-bell-line">{r.line}</span>
                {r.at && <span className="rd-bell-at">{ago(r.at)}</span>}
              </button>
            ))}
          </section>
        ))}
      </div>
      <div className="rd-bell-foot">
        <button type="button" onClick={() => (goPage("today"), onClose())}>
          See Today <Icon name="arrow-right" />
        </button>
        <button type="button" onClick={() => void markSeen(unread)} disabled={!unread.length} title="Marks them seen here; nothing is approved or closed">
          <Icon name="check" /> Mark all as seen
        </button>
      </div>
      <p className="rd-bell-note">Seen is remembered on this device (calendar items on the server). Seeing something never approves or closes it.</p>
    </div>
  );
}
