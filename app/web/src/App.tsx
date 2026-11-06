import { useCallback, useEffect, useRef, useState } from "react";
import { actions, availableBots, handleServerEvent, takeNavResume, useAppState } from "./store";
import { fetchSession, fetchMessages } from "./lib/api";
import { WsClient, type ConnectionStatus } from "./lib/ws";
import { RESTART_GRACE_MS } from "./lib/connection";
import { flushOutbox, initOutboxTriggers } from "./lib/outbox";
import { confirmVoiceReceipt, drainVoiceOutbox, initVoiceOutbox } from "./lib/voice-outbox";
import {
  dispatchVoiceEvent,
  registerVoiceWs,
  pushVoiceFrame,
  hasVoiceListeners,
} from "./lib/voicebus";
import Login from "./components/Login";
import { AgentList } from "./components/Sidebar";
import Thread from "./components/Thread";
import Composer from "./components/Composer";
import VoiceSessionPage from "./components/voice/VoiceSessionPage";
import CallHost from "./components/voice/CallHost";
import type { VoiceSessionMeta } from "./components/voice/SessionRecordCard";
import MediaPanel from "./components/MediaPanel";
import FilesView from "./views/FilesView";
import Settings from "./views/Settings";
import { ReviewDetail } from "./views/Review";
import { BuildDetail } from "./views/Builds";
import { fetchWaitingCount } from "./lib/review";
import { buildUrl, fetchBuildsAttention, fetchGatewayBuild, type BuildDetail as BuildDetailShape } from "./lib/builds";
import AttentionBar from "./components/AttentionBar";
import { IconBack, IconGear, IconReview } from "./components/icons";
import ToastHost from "./components/Toast";
import ScheduleButton from "./components/schedule/ScheduleButton";
import ScheduleHost from "./components/schedule/ScheduleModal";
import { DesktopShell, PhoneShell } from "./redesign/Shell";
import RedesignBody from "./redesign/Body";
import ChatHeader from "./redesign/ChatHeader";
import { phoneChatOpen, startHistorySync } from "./redesign/history";
import { isHashRoute } from "./redesign/nav";

/**
 * "#builds" → the board, "#builds/<id>" → that card; "#whatsapp" → the
 * Couldn't-answer board, "#whatsapp/<key>" → that thread (the HMAC key — a
 * phone number never rides a URL). True when it routed.
 */
export function openHashRoute(hash: string): boolean {
  if (/^#feed\/?$/.test(hash)) {
    actions.setView("feed");
    return true;
  }
  const b = /^#builds(?:\/([^/?#]+))?\/?$/.exec(hash);
  if (b) {
    actions.openBuilds(b[1] ? decodeURIComponent(b[1]) : null);
    return true;
  }
  return false;
}

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return mobile;
}

/**
 * Edge-swipe-back (design 1·7): a drag starting within 20px of the left
 * edge pops ONE level. At the root the gesture is absorbed with a small
 * rubber-band — an in-app back-swipe must NEVER exit the app (which is
 * also why we implement it ourselves instead of relying on browser
 * history gestures).
 */
function useEdgeSwipeBack(onBack: (() => void) | null) {
  const [dragX, setDragX] = useState(0);
  const tracking = useRef(false);
  const startX = useRef(0);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const x = e.touches[0].clientX;
    if (x <= 20) {
      tracking.current = true;
      startX.current = x;
    }
  }, []);

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!tracking.current) return;
      const dx = Math.max(0, e.touches[0].clientX - startX.current);
      // Root level: absorb — rubber-band hint only.
      setDragX(onBack ? dx : Math.min(24, dx / 4));
    },
    [onBack],
  );

  const onTouchEnd = useCallback(() => {
    if (!tracking.current) return;
    tracking.current = false;
    setDragX((dx) => {
      if (onBack && dx > 80) onBack();
      return 0;
    });
  }, [onBack]);

  return { dragX, handlers: { onTouchStart, onTouchMove, onTouchEnd } };
}


function ChatPane({ bot }: { bot: string }) {
  const [openCall, setOpenCall] = useState<VoiceSessionMeta | null>(null);

  useEffect(() => {
    setOpenCall(null);
  }, [bot]);

  return (
    <div className="thread-col" key={bot}>
      {openCall ? (
        <VoiceSessionPage bot={bot} record={openCall} onClose={() => setOpenCall(null)} />
      ) : (
        <>
          <Thread bot={bot} onOpenVoiceSession={setOpenCall} />
          <Composer bot={bot} />
        </>
      )}
    </div>
  );
}

function MobileApp() {
  const state = useAppState();
  const [menuOpen, setMenuOpen] = useState(false);
  const { view, activeBot, mobileThreadOpen } = state;
  const threadOpen = view === "messages" && mobileThreadOpen && !!activeBot;
  // Files mirrors Messages (3f#2): layer-1 categories, layer-2 the files.
  const filesOpen = view === "files" && state.mobileFilesOpen;
  // Owner detail layers render only for a current owner session (review R3-1, defence in depth:
  // history.ts also moves a demoted session off these views).
  const owner = !!state.user?.admin;
  const reviewOpen = owner && view === "review" && !!state.reviewItem;
  const buildOpen = owner && view === "builds" && !!state.buildsItem;
  const pushed = threadOpen || filesOpen || reviewOpen || buildOpen;

  // Back chain: thread/files pop, else MC L3→L2→L1, else absorb at root (3c2#3).
  const rootPop =
    view === "mission-control" && state.mcL3
      ? actions.closeFitnessDay
      : view === "mission-control" && state.mcL2
        ? actions.closeMcCard
        : null;
  const pop = threadOpen
    ? actions.popMobile
    : filesOpen
      ? actions.popMobileFiles
      : reviewOpen
        ? actions.closeReviewItem
        : buildOpen
          ? actions.closeBuildItem
          : rootPop;
  const { dragX, handlers } = useEdgeSwipeBack(pop);

  const fileCategoryTitle =
    state.toolFilter === "all"
      ? "All"
      : state.toolFilter.charAt(0).toUpperCase() + state.toolFilter.slice(1);

  return (
    <PhoneShell menuOpen={menuOpen} setMenuOpen={setMenuOpen}>
    <div className="mobile-shell">
      {/* The attention bar sits above every screen, pushed ones included — except an open
          conversation, which owns the whole screen: banners never cover a chat. */}
      {!phoneChatOpen(state) && <AttentionBar mobile />}
      {/* Root screen — agent list or tool page (one context at a time). */}
      <div className={`mobile-screen root${pushed ? " under" : ""}`} {...(pushed ? {} : handlers)}>
        {/* The redesign's phone chrome (top bar + dock + full menu) replaces the old root topbar. */}
        {view === "messages" ? (
          <div className="mobile-root-body">
            {state.user?.admin && state.reviewWaiting > 0 && (
              <button className="rv-nudge" onClick={() => actions.openReview()}>
                <IconReview />
                <span className="rv-nudge-text">
                  {state.reviewWaiting} waiting for you
                </span>
                <span className="mono-label">REVIEW</span>
              </button>
            )}
            {/* The full-width agent picker (FINAL phone): search, names, previews; choosing one opens it. */}
            <div className="rd-picker-head">
              <span className="rd-eyebrow">MESSAGE</span>
              {activeBot && (
                <button type="button" className="rd-chat-control" aria-label="Close agent picker" onClick={() => actions.openMobileThread(activeBot)}>
                  <IconBack />
                </button>
              )}
            </div>
            <AgentList mobile withSearch />
          </div>
        ) : (
          <RedesignBody phone activeBot={null} chat={() => null} />
        )}
      </div>

      {/* Files layer-2 — a category's files pushed over the categories,
          BACK top-left exactly like agents→thread (3f#2). */}
      {filesOpen && (
        <div
          className="mobile-screen pushed"
          style={dragX ? { transform: `translateX(${dragX}px)`, transition: "none" } : undefined}
          {...handlers}
        >
          <header className="mobile-topbar">
            <button className="topbar-btn" aria-label="Back" onClick={actions.popMobileFiles}>
              <IconBack />
            </button>
            <div className="mobile-title">{fileCategoryTitle}</div>
            {state.user?.admin && <ScheduleButton />}
            <button className="topbar-btn" aria-label="Settings" onClick={() => actions.toggleSettings()}>
              <IconGear />
            </button>
          </header>
          <div className="mobile-root-body">
            <FilesView />
          </div>
        </div>
      )}

      {/* Thread screen, pushed over the root (260ms slide, 24px parallax). */}
      {threadOpen && activeBot && (
        <div
          className="mobile-screen pushed"
          style={dragX ? { transform: `translateX(${dragX}px)`, transition: "none" } : undefined}
          {...handlers}
        >
          <ChatHeader bot={activeBot} phone />
          <ChatPane bot={activeBot} />
          {state.mediaPanelOpen && <MediaPanel bot={activeBot} mobile page />}
        </div>
      )}

      {/* Review item — pushed over the list; the action bar sits at the
          bottom where the thumb already is. */}
      {reviewOpen && state.reviewItem && (
        <div
          className="mobile-screen pushed rv-screen"
          style={dragX ? { transform: `translateX(${dragX}px)`, transition: "none" } : undefined}
          {...handlers}
        >
          <header className="mobile-topbar">
            <button className="topbar-btn" aria-label="Back" onClick={actions.closeReviewItem}>
              <IconBack />
            </button>
            <div className="mobile-title">Review</div>
            <span className="topbar-btn" aria-hidden="true" />
          </header>
          <ReviewDetail id={state.reviewItem} />
        </div>
      )}

      {/* A build card — pushed over the board; its bar sits in the thumb zone. */}
      {buildOpen && state.buildsItem && (
        <div
          className="mobile-screen pushed rv-screen"
          style={dragX ? { transform: `translateX(${dragX}px)`, transition: "none" } : undefined}
          {...handlers}
        >
          <header className="mobile-topbar">
            <button className="topbar-btn pf-back" aria-label="Back" onClick={actions.closeBuildItem}>
              <IconBack />
              <span className="mono-label">Builds</span>
            </button>
            <div className="mobile-title" />
            {state.user?.admin && <ScheduleButton />}
            <button className="topbar-btn" aria-label="Settings" onClick={() => actions.toggleSettings()}>
              <IconGear />
            </button>
          </header>
          <BuildDetail id={state.buildsItem} />
        </div>
      )}

      {state.settingsOpen && <MobileSettings />}
    </div>
    </PhoneShell>
  );
}

/** Mobile Settings — a pushed screen over wherever you were; back or an
 *  edge-swipe closes it and the prior context is exactly as you left it. */
function MobileSettings() {
  const close = () => actions.toggleSettings(false);
  const { dragX, handlers } = useEdgeSwipeBack(close);
  return (
    <div
      className="mobile-screen pushed settings-screen"
      style={dragX ? { transform: `translateX(${dragX}px)`, transition: "none" } : undefined}
      {...handlers}
    >
      <header className="mobile-topbar">
        <button className="topbar-btn" aria-label="Back" onClick={close}>
          <IconBack />
        </button>
        <div className="mobile-title">Settings</div>
        <span className="topbar-btn" aria-hidden="true" />
      </header>
      <Settings />
    </div>
  );
}

export default function App() {
  const state = useAppState();
  const wsRef = useRef<WsClient | null>(null);
  const isMobile = useIsMobile();

  // Session probe — runs once. The cached snapshot may already be painting
  // real content; this either confirms it (cookie valid) or drops to login.
  useEffect(() => {
    fetchSession().then((user) => actions.sessionResolved(user));
  }, []);

  // WS lifecycle — one connection while authenticated. The server replays
  // session + last-100 history on every (re)connect.
  const authed = !!state.user && state.sessionChecked;
  useEffect(() => {
    if (!authed) return;
    let seenOpen = false;
    let lastStatus: ConnectionStatus | null = null;
    const ws = new WsClient({
      onEvent: (ev) => {
        // ACK/replay protocol (AUDIT.md §2.4): confirm queued deliveries so
        // the server stops replaying them on reconnect.
        const deliveryId = (ev as { deliveryId?: string }).deliveryId;
        if (ev.type === "message" && deliveryId) ws.send({ type: "ack", deliveryId });
        // A stored message echoing its clientMessageId back is PROOF the
        // gateway holds it — the second of the voice outbox's two confirmation
        // channels, and the one that covers an upload whose HTTP response
        // never arrived (the gateway broadcasts before it responds).
        if (ev.type === "message") {
          const echoed = (ev as { meta?: { clientMessageId?: string } }).meta?.clientMessageId;
          if (echoed) void confirmVoiceReceipt(echoed);
        }
        // Voice family → the recorder/TTS bus (3d2#6). `stream-` rides along
        // because the voice layer needs the agent's text as it generates: the
        // karaoke line takes its TIMING from the synthesiser but its
        // punctuation and capitalisation from what the agent actually wrote.
        // handleServerEvent still runs, so the chat thread is unaffected.
        if (
          typeof ev.type === "string" &&
          (ev.type.startsWith("voice-") ||
            ev.type.startsWith("stt-") ||
            // `stream-` only while a call is actually listening: these fire for
            // every token of every ordinary chat reply, and with voice mode off
            // this path must stay exactly as cheap as it was before.
            (ev.type.startsWith("stream-") && hasVoiceListeners()))
        ) {
          dispatchVoiceEvent(ev as Parameters<typeof dispatchVoiceEvent>[0]);
        }
        const meta = (ev as { meta?: { turnId?: string; voiceSession?: unknown } }).meta;
        const isLiveVoiceTurnMessage =
          ev.type === "message" && !!meta?.turnId && !meta.voiceSession && hasVoiceListeners();
        if (!isLiveVoiceTurnMessage) handleServerEvent(ev);
      },
      // Voice-mode TTS PCM. Straight to the audio scheduler — no state, no
      // render. A frame that waited on React would already be late.
      onBinary: (data) => {
        if (data instanceof ArrayBuffer) pushVoiceFrame(data);
      },
      onRestart: () => actions.setRestarting(Date.now()),
      // A live call reconnects on a short backoff (always-on, slice 1).
      urgent: () => hasVoiceListeners(),
      onStatus: (status) => {
        const isReconnectOpen = status === "open" && seenOpen && lastStatus !== "open";
        actions.setConnection(status);
        if (isReconnectOpen) actions.reconcileStreamsAfterReconnect();
        if (status === "open") seenOpen = true;
        lastStatus = status;
        // A live call cannot outlive its socket: the gateway tears the voice
        // session down on close, so a reconnect lands on a socket with no
        // call on it and the screen would wait for a reply that can never
        // arrive. Tell the voice layer, which ends the call honestly (R4-3).
        // Gated on there being a call at all, so ordinary reconnects on the
        // chat path stay exactly as cheap as they were.
        if (status !== "open" && hasVoiceListeners()) {
          dispatchVoiceEvent({ type: "voice-connection-lost" });
        }
        // Back: the voice layer resumes its call by id (always-on, slice 1).
        if (isReconnectOpen && hasVoiceListeners()) {
          dispatchVoiceEvent({ type: "voice-connection-open" });
        }
      },
    });
    wsRef.current = ws;
    registerVoiceWs(ws);
    ws.connect();
    return () => {
      registerVoiceWs(null);
      ws.close();
      wsRef.current = null;
    };
  }, [authed]);

  // A planned restart shows RESTARTING for at most 90 s; past that the normal
  // RECONNECTING / OFFLINE logic takes over (lib/connection.ts).
  useEffect(() => {
    if (state.restartingAt === null) return;
    const left = RESTART_GRACE_MS - (Date.now() - state.restartingAt);
    const t = setTimeout(() => actions.setRestarting(null), Math.max(0, left));
    return () => clearTimeout(t);
  }, [state.restartingAt]);

  // Code-block copy (Step 5 #1): ONE delegated listener for the app
  // lifetime — message HTML is injected (dangerouslySetInnerHTML), so
  // per-render React handlers can't cover it. Delegation covers every
  // current and future block, streaming included, with zero per-bubble
  // wiring and no memo-cache interaction.
  useEffect(() => {
    const onClick = async (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest?.(".code-copy");
      if (!btn) return;
      const pre = btn.parentElement?.querySelector("pre");
      if (!pre) return;
      try {
        await navigator.clipboard.writeText(pre.innerText);
        btn.classList.add("copied");
        setTimeout(() => btn.classList.remove("copied"), 1200);
      } catch {
        // clipboard blocked (permissions/insecure context) — no-op
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  // Default active bot once we know the user.
  const bots = availableBots(state.user);
  const activeBot = state.activeBot && bots.includes(state.activeBot) ? state.activeBot : bots[0] ?? null;

  // Deepen the open thread's history once per bot per session — the WS
  // history frame only carries the last 100 across all bots.
  useEffect(() => {
    if (!authed || !activeBot || state.deepened[activeBot]) return;
    actions.markDeepened(activeBot);
    fetchMessages(activeBot, 200).then((msgs) => actions.mergeMessages(msgs));
  }, [authed, activeBot, state.deepened]);

  // Esc closes the Settings overlay from anywhere.
  useEffect(() => {
    if (!state.settingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") actions.toggleSettings(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state.settingsOpen]);

  // Review desk: the waiting count for the menu badge (admins only).
  const isAdmin = !!state.user?.admin;
  useEffect(() => {
    if (!authed || !isAdmin) return;
    void fetchWaitingCount().then((n) => n !== null && actions.setReviewWaiting(n));
  }, [authed, isAdmin, state.reviewRev]);

  // Builds: the warn badge counts open questions and his own steps (C11) —
  // and the same read feeds the attention bar. Refetched on every
  // builds-update frame, so a ship stage or a new ask lands within a second.
  useEffect(() => {
    if (!authed || !isAdmin) return;
    void fetchBuildsAttention().then((a) => {
      if (!a) return;
      actions.setBuildsNeedYou(a.needYou);
      actions.setAttention(a.items);
      // A ship that is moving on the board is worth watching even if he did not tap it here (another device did).
      if (!state.shipWatch) {
        const moving = a.view.sections.moving.find((c) => c.kicker === "shipping") ?? a.view.sections.needs_you.find((c) => c.kicker === "rolled-back" && c.ship?.result && Date.now() - Date.parse(c.ship.result.at) < 10 * 60_000);
        if (moving) actions.watchShip({ cardId: moving.id, title: moving.title });
      }
    });
  }, [authed, isAdmin, state.buildsRev]);

  // The watched ship: poll its card while it moves (the gateway cannot push
  // through its own restart), and read /health when the socket comes back so
  // "back on <sha>" is measured, not assumed.
  const watching = state.shipWatch?.cardId ?? null;
  useEffect(() => {
    if (!authed || !isAdmin || !watching) return;
    let stop = false;
    const read = async () => {
      try {
        const res = await fetch(buildUrl(watching), { cache: "no-store" });
        if (!res.ok || stop) return;
        const d = (await res.json()) as BuildDetailShape;
        actions.setShipLive(d.ship);
      } catch {
        /* dark window — the socket state carries the visual meanwhile */
      }
    };
    void read();
    const t = setInterval(() => void read(), 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [authed, isAdmin, watching, state.connection]);
  useEffect(() => {
    if (!authed || !isAdmin || state.connection !== "open") return;
    void fetchGatewayBuild().then((b) => b && actions.setGatewaySha(b.sha));
  }, [authed, isAdmin, state.connection]);
  // A landed ship stops being watched a while after it is back; a rollback stays until he dismisses it.
  useEffect(() => {
    const r = state.shipLive?.result;
    if (!state.shipWatch || r?.outcome !== "ok") return;
    const t = setTimeout(() => actions.watchShip(null), 15_000);
    return () => clearTimeout(t);
  }, [state.shipWatch, state.shipLive?.result]);

  // Hash routes (B7) — #builds, #builds/<id>, #whatsapp, #whatsapp/<key> — so
  // the day-close links and a push tap land on the right screen.
  useEffect(() => {
    if (!authed) return;
    const route = () => {
      // Same rule as ?review=: keep the hash until a service worker controls the
      // page, so the one reload on a first open after a release still lands.
      const controlled = !("serviceWorker" in navigator) || !!navigator.serviceWorker.controller;
      if (openHashRoute(window.location.hash) && controlled) window.history.replaceState(null, "", window.location.pathname + window.location.search);
    };
    route();
    window.addEventListener("hashchange", route);
    // A link to this app inside a message (the day-close's Builds line) routes
    // in place instead of opening a second window.
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const url = new URL(a.href, window.location.origin);
      const ours = url.origin === window.location.origin;
      if (ours && url.hash && isHashRoute(url.hash)) {
        e.preventDefault();
        openHashRoute(url.hash);
      }
    };
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("hashchange", route);
      document.removeEventListener("click", onClick, true);
    };
  }, [authed]);

  // Deep links from a notification: /?review=<id> opens the item,
  // /?settings=passkeys opens Settings, /#builds/<id> opens a build. Cold
  // start reads the URL; a running app gets the same URL from the service
  // worker (push-sw.js).
  useEffect(() => {
    if (!authed) return;
    // The screen stashed just before the release reload (main.tsx) comes back
    // first; an explicit deep link in the URL still wins over it.
    if (!window.location.search && !window.location.hash) {
      const resume = takeNavResume();
      if (resume) actions.restoreNav(resume);
    }
    const open = (raw: string) => {
      const url = new URL(raw, window.location.origin);
      const item = url.searchParams.get("review");
      if (item !== null) actions.openReview(item || null);
      else if (url.searchParams.get("settings")) actions.toggleSettings(true);
      else if (url.hash) openHashRoute(url.hash);
    };
    if (window.location.search) {
      open(window.location.href);
      // Clean the URL only once a service worker controls the page. On a first
      // open after a release the new worker takes control and main.tsx reloads
      // once — keeping ?review=<id> through that reload is what makes the
      // notification tap still land on the item.
      if (!("serviceWorker" in navigator) || navigator.serviceWorker.controller) {
        window.history.replaceState(null, "", window.location.pathname);
      }
    }
    const onSw = (e: MessageEvent) => {
      if (e.data?.type === "ahi-open" && typeof e.data.url === "string") open(e.data.url);
    };
    navigator.serviceWorker?.addEventListener("message", onSw);
    return () => navigator.serviceWorker?.removeEventListener("message", onSw);
  }, [authed]);

  // Back/Forward (redesign NAV contract): one history entry per destination.
  useEffect(() => {
    if (!authed) return;
    return startHistorySync();
  }, [authed]);

  // Outbox: flush whenever the WS comes (back) up, and on browser 'online'.
  useEffect(() => initOutboxTriggers(), []);
  useEffect(() => {
    if (state.connection === "open") flushOutbox();
  }, [state.connection]);

  // Voice outbox: same triggers, plus its own 'online' / foreground wiring and
  // an immediate drain on app open (initVoiceOutbox). Mounted for an
  // authenticated session only — an unauthenticated drain would spend every
  // queued note's attempt on a guaranteed 401.
  useEffect(() => {
    if (!authed) return;
    return initVoiceOutbox();
  }, [authed]);
  useEffect(() => {
    if (authed && state.connection === "open") void drainVoiceOutbox();
  }, [authed, state.connection]);

  if (!state.sessionChecked && !state.user) {
    // Cold start, no cache: neutral shell (avoids login flash if the cookie is valid).
    return <div className="app-shell app-shell-loading" />;
  }

  if (!state.user) {
    return <Login />;
  }

  // The live call sits FIRST in both layouts, at the same place in the tree,
  // so crossing the phone/desktop width (an iPhone turned to landscape, a
  // window resized) never unmounts it. When each layout mounted its own, that
  // crossing ended the live call and dialed a new one
  // ended and 998fc9 + eff9f9 were both minted and connected, one tap.
  if (isMobile) {
    return (
      <>
        <CallHost />
        <MobileApp />
        <ScheduleHost />
        <ToastHost />
      </>
    );
  }

  return (
    <>
    {/* The live call, above every view (call-minimize-pill): a view change
        cannot unmount it, and minimized it is the pill in the corner. */}
    <CallHost />
    <DesktopShell>
      <AttentionBar />
      <RedesignBody activeBot={activeBot} chat={(bot) => <ChatPane bot={bot} />} />
    </DesktopShell>
    <ScheduleHost />
    <ToastHost />
    </>
  );
}
