import { useEffect, useRef, useState } from "react";
import type { StudioCardMeta, StudioOptionMeta } from "../../lib/types";
import { chooseOption, elapsed, pickedOption, rememberPick, sendStudioAnswer, stateLabel, stopJob, thumbSrc } from "../../lib/studio";
import { requestStage } from "../../lib/search";
import { copyText } from "../../lib/messageActions";
import { showToast } from "../../lib/toast";
import ExpandedMedia from "../ExpandedMedia";
import ContextMenu from "../ContextMenu";
// Its stylesheet, ./studio-card.css, is imported once by the shell (main.tsx),
// like search-card.css: Node-run UI tests import this file and cannot load CSS.

/* ============================================================
   StudioCard — "this came up, your call" (11/03).

   One card per studio job, in three states, updated in place:
     working   skeleton tiles, the engine, a running clock, Stop
     decision  2–4 lettered options. TAP an option = that's the answer
               (into the live call if there is one, else a chat message).
               The expand corner opens the viewer; long-press / right-click
               for Choose · View · Attach to message · Copy folder path.
     failed    what went wrong, and "Try again" (a message to the agent)

   Self-contained like SearchCard: its own stylesheet reads only design
   tokens through local --ast-* aliases (current shell names first, the
   redesign's as fallbacks), so it drops into the new shell unchanged.
   ============================================================ */

const LONG_PRESS_MS = 500;
const MOVE_SLOP = 10;

function formatTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

const Glyph = () => (
  <svg className="ast-glyph" viewBox="0 0 16 16" aria-hidden="true">
    <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
    <path d="M2 6.5h12M5 3.5l1.6 3M8.4 3.5 10 6.5" />
  </svg>
);

export interface StudioCardProps {
  card: StudioCardMeta;
  messageId: string;
  bot: string;
  byLabel: string;
}

export default function StudioCard({ card, messageId, bot, byLabel }: StudioCardProps) {
  const [picked, setPicked] = useState<string | null>(() => pickedOption(messageId));
  const [open, setOpen] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; index: number; touch: boolean } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);

  // The working clock ticks only while the job runs.
  useEffect(() => {
    if (card.state !== "working") return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [card.state]);

  function choose(opt: StudioOptionMeta) {
    const where = chooseOption(bot, card.ask, opt);
    if (!where) {
      showToast("Not signed in", 2400);
      return;
    }
    rememberPick(messageId, opt.key);
    setPicked(opt.key);
    showToast(where === "call" ? `Option ${opt.key}: told ${byLabel} on the call` : `Option ${opt.key} sent`);
  }

  function attach(opt: StudioOptionMeta) {
    const taken = requestStage({ bot, mediaId: opt.media.id, name: opt.media.originalName, mime: opt.media.mime, size: opt.media.size, previewUrl: thumbSrc(opt) });
    showToast(taken ? "Added to your message" : "It's in Files");
  }

  async function stop() {
    if (!card.jobId || stopping) return;
    setStopping(true);
    const r = await stopJob(card.jobId);
    if (!r.ok) {
      setStopping(false);
      showToast(r.error ?? "Couldn't stop it", 2600);
    }
  }

  const options = card.options ?? [];
  const pending = card.state === "working" ? Math.max(1, Math.min(4, card.n ?? 4)) : 0;
  const meta = [card.engine, card.guide && card.step ? `${card.guide} · ${card.step}` : card.guide || card.step].filter(Boolean).join(" · ");

  return (
    <section className="ahi-studio-card" data-state={card.state} aria-label={`${byLabel}: ${card.ask || stateLabel(card)}`}>
      <div className="ast-head">
        <Glyph />
        <span className="ast-ask" dir="auto">
          {card.ask || (card.state === "working" ? "Working on it" : "Your call")}
        </span>
        <span className="ast-state">{card.state === "working" ? `${stateLabel(card)} ${elapsed(card.startedAt ?? card.at, now)}` : stateLabel(card)}</span>
      </div>

      {card.state === "working" && (
        <div className="ast-grid" data-count={pending} aria-busy="true">
          {Array.from({ length: pending }, (_, i) => (
            <span key={i} className="ast-tile is-pending" aria-hidden="true">
              <span className="ast-key">{"ABCD"[i]}</span>
            </span>
          ))}
        </div>
      )}

      {card.state === "decision" && (
        <div className="ast-grid" data-count={options.length} role="list">
          {options.map((opt, i) => (
            <OptionTile
              key={opt.key}
              opt={opt}
              picked={picked === opt.key}
              dimmed={picked !== null && picked !== opt.key}
              onChoose={() => choose(opt)}
              onExpand={() => setOpen(i)}
              onMenu={(x, y, touch) => setMenu({ x, y, index: i, touch })}
            />
          ))}
        </div>
      )}

      {card.state === "failed" && (
        <div className="ast-failed">
          <p dir="auto">{card.error || "It didn't come back."}</p>
          <button type="button" className="ast-btn" onClick={() => sendStudioAnswer(bot, { text: `That ${card.engine ?? "studio"} job didn't land${card.ask ? ` (${card.ask})` : ""}. Try it again.` })}>
            Try again
          </button>
        </div>
      )}

      {card.state === "decision" && (
        <p className="ast-hint">{picked ? `You picked ${picked}. Say or type what to change, or tap another.` : `Tap one, or just say which. ${card.more ? `+${card.more} more in the folder.` : ""}`}</p>
      )}
      {card.note && card.state !== "working" && (
        <p className="ast-note" dir="auto">
          {card.note}
        </p>
      )}

      <div className="ast-foot">
        <span>
          {byLabel} · {formatTime(card.at)}
          {meta ? ` · ${meta}` : ""}
        </span>
        {card.state === "working" && card.jobId ? (
          <button type="button" className="ast-link" onClick={() => void stop()} disabled={stopping}>
            {stopping ? "Stopping…" : "Stop"}
          </button>
        ) : card.folder ? (
          <button type="button" className="ast-link" onClick={() => void copyText(card.folder ?? "").then((ok) => showToast(ok ? "Folder path copied" : "Couldn't copy"))}>
            Folder
          </button>
        ) : null}
      </div>

      {open !== null && (
        <ExpandedMedia
          items={options.map((o) => ({ ...o.media, originalName: o.label ? `${o.key} — ${o.label}` : `Option ${o.key}` }))}
          startIndex={open}
          onClose={() => setOpen(null)}
          actions={[
            {
              label: "CHOOSE",
              onSelect: (i) => {
                const o = options[i];
                if (o) choose(o);
                setOpen(null);
              },
            },
            { label: "ATTACH", onSelect: (i) => options[i] && attach(options[i]) },
          ]}
        />
      )}
      {menu && options[menu.index] && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          autoFocus={!menu.touch}
          onClose={() => setMenu(null)}
          items={[
            { label: `Choose ${options[menu.index].key}`, onSelect: () => choose(options[menu.index]) },
            { label: "View large", onSelect: () => setOpen(menu.index) },
            { label: "Attach to message", onSelect: () => attach(options[menu.index]) },
            ...(card.folder ? [{ label: "Copy folder path", onSelect: () => void copyText(card.folder ?? "").then((ok) => showToast(ok ? "Folder path copied" : "Couldn't copy")) }] : []),
          ]}
        />
      )}
    </section>
  );
}

/** One option: TAP chooses, the corner expands, long-press / right-click opens the menu. */
function OptionTile({
  opt,
  picked,
  dimmed,
  onChoose,
  onExpand,
  onMenu,
}: {
  opt: StudioOptionMeta;
  picked: boolean;
  dimmed: boolean;
  onChoose: () => void;
  onExpand: () => void;
  onMenu: (x: number, y: number, touch: boolean) => void;
}) {
  const [state, setState] = useState<"loading" | "loaded" | "broken">("loading");
  const press = useRef<{ x: number; y: number; timer: number } | null>(null);
  const fired = useRef(false);
  const video = opt.media.type === "video";
  const hasPicture = !video || opt.media.thumbnail;

  useEffect(() => () => {
    if (press.current) window.clearTimeout(press.current.timer);
  }, []);

  function cancel() {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }

  return (
    <div className={`ast-option${picked ? " is-picked" : ""}${dimmed ? " is-dimmed" : ""}`} role="listitem">
      <button
        type="button"
        className={`ast-tile is-${state}`}
        aria-label={`Choose option ${opt.key}${opt.label ? `: ${opt.label}` : ""}`}
        aria-pressed={picked}
        onClick={(e) => {
          if (fired.current) {
            fired.current = false;
            e.preventDefault();
            return;
          }
          onChoose();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          cancel();
          if (fired.current) return;
          onMenu(e.clientX, e.clientY, false);
        }}
        onPointerDown={(e) => {
          if (e.pointerType === "mouse") return;
          fired.current = false;
          const { clientX: x, clientY: y } = e;
          press.current = {
            x,
            y,
            timer: window.setTimeout(() => {
              fired.current = true;
              press.current = null;
              onMenu(x, y, true);
            }, LONG_PRESS_MS),
          };
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_SLOP) cancel();
        }}
        onPointerUp={cancel}
        onPointerCancel={cancel}
      >
        {hasPicture ? (
          <img src={thumbSrc(opt)} alt={opt.label || `Option ${opt.key}`} loading="lazy" decoding="async" draggable={false} onLoad={() => setState("loaded")} onError={() => setState("broken")} />
        ) : (
          <span className="ast-tile-fallback">clip</span>
        )}
        {video && <span className="ast-play" aria-hidden="true" />}
        <span className="ast-key">{opt.key}</span>
        {picked && <span className="ast-check" aria-hidden="true" />}
      </button>
      <button type="button" className="ast-expand" aria-label={`View option ${opt.key} large`} onClick={onExpand}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
        </svg>
      </button>
      {opt.label && (
        <span className="ast-label" dir="auto">
          {opt.label}
        </span>
      )}
    </div>
  );
}
