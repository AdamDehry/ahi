import { codexLiveNudge } from "./lib/codexLive";
import { useSyncExternalStore } from "react";
import type { AttentionItem, ShipState } from "./lib/ship";
import type { Bill, BillSettings, Clip, CostEntry, FileEntry, LocalMessage, McFile, McL2Entry, MessageEvent, ServerEvent, UserPublic } from "./lib/types";
import { BOT_ORDER, isPrivate } from "./lib/types";
import type { ConnectionStatus } from "./lib/ws";
import { loadSnapshot, saveSnapshot, type AnswerLink } from "./lib/cache";
import { answersFor, MAX_ANSWERS, type SentAnswer } from "./lib/answers";

export interface StreamState {
  streamId: string;
  bot: string;
  text: string;
  tools: string[];
  done: boolean;
  error: string | null;
  /** Boundary of the current assistant message inside `text`. */
  messageStart: number;
  /** Client/server identity of the user message this stream answers. */
  originMessageId: string | null;
}

function localMessageId(message: LocalMessage): string {
  return message.meta?.clientMessageId
    ?? message.localId
    ?? message.meta?.messageId
    ?? `${message.timestamp}|${message.text}`;
}

export function appendStreamChunkText(stream: StreamState, chunk: string): StreamState {
  if (!chunk) return stream;
  return { ...stream, text: stream.text + chunk };
}

export interface OutboxEntry {
  localId: string;
  bot: string;
  text: string;
  /**
   * Staged media ids travelling WITH this message (design lock v4: words +
   * cargo are one message). They ride in the outbox so a flaky network
   * retries the whole message — caption and cargo together — instead of
   * landing the words now and the files never.
   */
  attachmentIds?: string[];
  /** Build questions this message answers (see answerInThread) — the gateway clears their cards. */
  answers?: SentAnswer[];
}

/**
 * A recorded voice note waiting to reach the gateway. The audio itself lives
 * in IndexedDB (lib/voice-outbox-db.ts) — this is the metadata the outbox
 * strip renders, and it is REBUILT from disk on every change rather than
 * being a second copy of the truth.
 */
export type VoiceOutboxState = "queued" | "sending" | "failed";

export interface VoiceOutboxItem {
  /** Also the clientMessageId — stable across retries. */
  id: string;
  bot: string;
  durationSec: number;
  sizeBytes: number;
  createdAt: number;
  attempts: number;
  state: VoiceOutboxState;
  lastError?: string;
}

/**
 * Every screen the app can show. The original eleven views keep their names
 * (deep links, NavSnapshot, push taps all speak them); the redesign adds its
 * new pages, and groups old views under them (redesign/nav.ts PAGE_OF):
 * feed/builds/review/live → Your work · files/clipboard/mission-control/
 * documents → Documents · costs/bills → Finances.
 */
export type View =
  | "messages" | "feed" | "review" | "builds" | "whatsapp" | "mission-control" | "clipboard" | "files" | "costs" | "bills" | "vault"
  | "home" | "today" | "live" | "documents" | "gmail" | "team" | "connections";

export type { McFile } from "./lib/types";

export interface AppState {
  user: UserPublic | null;
  /** null until the /ui/session probe resolves — the login screen must
   *  not flash while we still might be authenticated. */
  sessionChecked: boolean;
  connection: ConnectionStatus;
  /** True once the WS has opened at least once — gates the reconnect
   *  banner so the initial connect never flashes it. */
  hadConnection: boolean;
  /** When the gateway announced a planned restart (ms) — null once the socket is back (lib/connection.ts). */
  restartingAt: number | null;
  /** Per-bot threads, ascending by timestamp. Includes pending local sends. */
  threads: Record<string, LocalMessage[]>;
  /** Bots whose deep history (/ui/messages) has been fetched this session. */
  deepened: Record<string, boolean>;
  /** Media / Files / Links panel over the chat. Memory only. */
  mediaPanelOpen: boolean;
  /** "Show in chat": the message the thread should scroll to and flash.
   *  `nonce` makes a second tap on the same item scroll again. */
  reveal: { bot: string; messageId: string; nonce: number } | null;
  /** Live streams by streamId. */
  streams: Record<string, StreamState>;
  activeBot: string | null;
  /** Unsent composer text per bot — survives agent switches AND reloads. */
  drafts: Record<string, string>;
  /** Build questions quoted into a bot's draft by Answer in thread (at most MAX_ANSWERS).
   *  Words under a quote answer that question (lib/answers.ts); any send spends them all. */
  answerLinks: Record<string, AnswerLink[]>;
  /** Sends awaiting a successful POST. Flushed by lib/outbox.ts; network
   *  failures stay queued (bubble stays pending), server rejections move
   *  the bubble to failed (tap-to-retry). Session-only — not persisted,
   *  so a reload can never double-send. */
  outbox: OutboxEntry[];
  /** Recorded voice notes not yet confirmed by the gateway, oldest first.
   *  Unlike `outbox` this one IS durable — the audio is in IndexedDB and
   *  survives a reload, a crash and a week offline. Mirror only: written by
   *  lib/voice-outbox.ts from what is actually on disk. */
  voiceOutbox: VoiceOutboxItem[];
  /** Set when the voice queue could not be written or read. Recording still
   *  works (it falls back to send-from-memory) — this is the warning that
   *  says the safety net is off. */
  voiceOutboxWarning: string | null;
  /** Agents with voice mode enabled server-side (from the session event). */
  voiceBots: string[];
  /** Of those, the ones whose calls go over ElevenLabs (VOICE_CALL_ROLLBACK=elevenlabs since voice step 3). */
  elevenBots: string[];
  /** bot → epoch-ms of the last send still awaiting any reply signal.
   *  Drives the typing indicator; cleared by stream-start / out-message. */
  awaiting: Record<string, number>;
  /** True while the state came from the localStorage snapshot only. */
  hydratedFromCache: boolean;
  /** Current tool view (design: one anchored menu switches views). */
  view: View;
  /** Desktop sidebar collapsed (Claude-Code pattern). Persisted. */
  sidebarCollapsed: boolean;
  /** Mobile nav stack: true = thread pushed over the root list. */
  mobileThreadOpen: boolean;
  /** Mobile Files drill-in (3f#2): true = a category's files pushed over
   *  the layer-1 categories list. Files only — Clipboard stays flat. */
  mobileFilesOpen: boolean;
  /** Mission-control cards, keyed by file name; null = not yet loaded. */
  mcFiles: Record<string, McFile> | null;
  /** Fitness card entries (mc-structured, deployed); null = not loaded. */
  fitnessEntries: McL2Entry[] | null;
  /** Mission Control drill-down: L2 = open card key ("fitness" or file
   *  name), L3 = open fitness day id. Back pops one level (3c2#3). */
  mcL2: string | null;
  mcL3: string | null;
  /** Sidebar filter for tool pages (clipboard type, files/costs category). */
  toolFilter: string;
  /** Settings is an OVERLAY, not a view — the prior view (and its scroll,
   *  and the sidebar state) stays mounted underneath and is restored
   *  exactly on close. */
  settingsOpen: boolean;
  /**
   * The live voice call (call-minimize-pill). It lives HERE, not in
   * the chat composer, so the call survives every view change: the call
   * screen is mounted by the app shell (components/voice/CallHost) for as
   * long as this is set, and nothing a view does can unmount it. `minimized`
   * swaps the full screen for the floating pill; the call itself does not
   * change. One call at a time — starting another replaces it.
   */
  call: { bot: string; minimized: boolean } | null;
  /** Shared tool-page data (sidebar + peek + views all read these). */
  clips: Clip[] | null;
  filesList: FileEntry[] | null;
  costEntries: CostEntry[] | null;
  /** The signed-in user's OWN bills (null = not loaded). Cleared on logout. */
  bills: Bill[] | null;
  billSettings: BillSettings | null;
  /** Step 3d: server-backed category lists. */
  fileCategories: string[] | null;
  costCategories: Array<{ key: string; label: string; builtin: boolean }> | null;
  /** Review desk: the open item (mobile pushes it as a screen), the waiting
   *  count (menu badge), and a revision bumped by the WS review-update
   *  event so an open Review screen refetches. */
  reviewItem: string | null;
  reviewWaiting: number;
  reviewRev: number;
  /** Builds panel: the open card (mobile pushes it), the warn badge (open
   *  questions + his own steps only — C11), and a refetch revision. */
  buildsItem: string | null;
  buildsNeedYou: number;
  buildsRev: number;
  /** The attention bar: what waits on him across every screen, and
   *  the keys he dismissed this session (memory only — back on reload, and
   *  a new occurrence has a new key). */
  attention: AttentionItem[];
  attentionDismissed: string[];
  /** The ship he is watching land: set by his Ship tap (or by opening a card
   *  that is shipping); cleared when it is back and seen, or by him. */
  shipWatch: { cardId: string; title: string } | null;
  /** The watched ship's state as last read from its card (App polls while it moves). */
  shipLive: ShipState | null;
  /** /health's build sha: the one before the ship, and the newest seen since the socket came back. */
  gatewayShaBefore: string | null;
  gatewayShaNow: string | null;
  /** WhatsApp dashboard: the open thread by HMAC key (never digits) and the
   *  gap it was opened on (scrolled to), the tab, the warn badge (people
   *  waiting on a call back) and a refetch revision. Memory only. */
  waItem: { key: string; gap: string | null } | null;
  waTab: "gaps" | "inbox";
  waWaiting: number;
  waRev: number;
}

let state: AppState = {
  user: null,
  sessionChecked: false,
  connection: "closed",
  hadConnection: false,
  restartingAt: null,
  threads: {},
  deepened: {},
  mediaPanelOpen: false,
  reveal: null,
  streams: {},
  activeBot: null,
  drafts: {},
  answerLinks: {},
  outbox: [],
  voiceOutbox: [],
  voiceOutboxWarning: null,
  voiceBots: [],
  elevenBots: [],
  awaiting: {},
  hydratedFromCache: false,
  view: "messages",
  sidebarCollapsed: localStorage.getItem("ahi-sidebar-collapsed") === "1",
  mobileThreadOpen: false,
  mobileFilesOpen: false,
  mcFiles: null,
  fitnessEntries: null,
  mcL2: null,
  mcL3: null,
  toolFilter: "all",
  settingsOpen: false,
  call: null,
  clips: null,
  filesList: null,
  costEntries: null,
  bills: null,
  billSettings: null,
  fileCategories: null,
  costCategories: null,
  reviewItem: null,
  reviewWaiting: 0,
  reviewRev: 0,
  buildsItem: null,
  buildsNeedYou: 0,
  buildsRev: 0,
  attention: [],
  attentionDismissed: [],
  shipWatch: null,
  shipLive: null,
  gatewayShaBefore: null,
  gatewayShaNow: null,
  waItem: null,
  waTab: "gaps",
  waWaiting: 0,
  waRev: 0,
};

// ── Instant shell: hydrate last-known user + threads synchronously at
// module load, before any network. This is what replaces the vanilla
// app's blank-then-pop (public/app.js:752-770).
const snap = loadSnapshot();
if (snap) {
  state = {
    ...state,
    user: snap.user,
    threads: snap.threads,
    activeBot: snap.activeBot ?? null,
    drafts: snap.drafts ?? {},
    answerLinks: snap.answerLinks ?? {},
    hydratedFromCache: true,
  };
}

const listeners = new Set<() => void>();

function emit(next: AppState): void {
  state = next;
  for (const l of listeners) l();
  saveSnapshot(state); // debounced inside
}

export function getState(): AppState {
  return state;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, getState);
}

// ── Derived helpers ─────────────────────────────────────────────────

export function availableBots(user: UserPublic | null): string[] {
  const allowed = user ? new Set(user.agents) : null;
  return BOT_ORDER.filter((b) => !allowed || allowed.has(b));
}

export function lastMessage(threads: Record<string, LocalMessage[]>, bot: string): LocalMessage | null {
  const t = threads[bot];
  return t && t.length ? t[t.length - 1] : null;
}

// ── Message merge ───────────────────────────────────────────────────

function messageKey(m: MessageEvent): string {
  // meta.messageId is the canonical server id (deployed contract,
  // AUDIT.md §2.4); legacy records fall back to a content key.
  return m.meta?.messageId ? `id:${m.meta.messageId}` : `${m.bot}|${m.direction}|${m.timestamp}|${m.text}`;
}

/** Merge incoming messages into a thread. Three cases per message:
 *  1. Known messageId → UPSERT in place (e.g. a voice reply upgrading its
 *     fast text placeholder with playable media — deployed contract).
 *  2. Our own "in" echo → replaces the pending optimistic copy.
 *  3. New → insert in ascending timestamp order. */
function mergeThread(existing: LocalMessage[], incoming: MessageEvent[]): LocalMessage[] {
  if (!incoming.length) return existing;
  const seen = new Set(existing.filter((m) => !m.pending).map(messageKey));
  let next = existing;
  for (const raw of incoming) {
    if (isPrivate(raw)) continue;
    const key = messageKey(raw);
    if (seen.has(key)) {
      // Same messageId again = an update to a message we hold (never a
      // duplicate append). Content-keyed duplicates are true repeats — skip.
      const id = raw.meta?.messageId;
      if (id) {
        const idx = next.findIndex((m) => m.meta?.messageId === id);
        if (idx >= 0) next = [...next.slice(0, idx), {
          ...raw,
          localId: next[idx].localId,
          cancelled: next[idx].cancelled,
          steered: next[idx].steered,
        }, ...next.slice(idx + 1)];
      }
      continue;
    }
    seen.add(key);
    // Reconcile: our own "in" message echoing back — replace the local copy.
    // Precise key first (meta.clientMessageId, echoed by the deployed
    // /app/send), then a text-match fallback for older gateway builds.
    if (raw.direction === "in") {
      const echoedId = raw.meta?.clientMessageId;
      let localIdx = echoedId ? next.findIndex((m) => m.localId === echoedId) : -1;
      if (localIdx < 0) {
        localIdx = next.findIndex((m) => m.pending && m.text === raw.text && m.bot === raw.bot);
      }
      if (localIdx >= 0) {
        next = [...next.slice(0, localIdx), {
          ...raw,
          localId: next[localIdx].localId,
          cancelled: next[localIdx].cancelled,
          steered: next[localIdx].steered,
        }, ...next.slice(localIdx + 1)];
        continue;
      }
    }
    next = insertSorted(next, { ...raw });
  }
  return next;
}

function insertSorted(list: LocalMessage[], msg: LocalMessage): LocalMessage[] {
  // Overwhelmingly the common case: append at the end.
  if (!list.length || list[list.length - 1].timestamp.localeCompare(msg.timestamp) <= 0) {
    return [...list, msg];
  }
  let i = list.length - 1;
  while (i > 0 && list[i - 1].timestamp.localeCompare(msg.timestamp) > 0) i--;
  return [...list.slice(0, i), msg, ...list.slice(i)];
}

function sameVoiceOutbox(a: VoiceOutboxItem[], b: VoiceOutboxItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, i) => {
    const other = b[i];
    return (
      item.id === other.id &&
      item.state === other.state &&
      item.attempts === other.attempts &&
      item.lastError === other.lastError
    );
  });
}

// ── Who owns async results (B1) ─────────────────────────────
//
// A Bills request from one account must never land in another's screen.
// Logging out cleared the bills, but a response still in flight from the
// first account was installed by the plain setter after the second signed in.
// Every sign-in, sign-out or change of user bumps the generation; a stamp
// taken when the request started is checked IN THE STORE when it completes.

let authGeneration = 0;

export interface AuthStamp {
  userId: string | null;
  gen: number;
}

/** Who is signed in right now, and in which sign-in. Taken when an owned request starts. */
export function authStamp(): AuthStamp {
  return { userId: state.user?.userId ?? null, gen: authGeneration };
}

function stampIsCurrent(stamp: AuthStamp): boolean {
  return stamp.gen === authGeneration && stamp.userId !== null && stamp.userId === (state.user?.userId ?? null);
}

/** A different user (or none): new generation, and the old user's private data goes. */
function userChange(user: UserPublic | null): Partial<AppState> {
  if ((user?.userId ?? null) === (state.user?.userId ?? null)) return {};
  authGeneration++;
  return { bills: null, billSettings: null };
}

// ── Actions ─────────────────────────────────────────────────────────

export const actions = {
  sessionResolved(user: UserPublic | null): void {
    emit({ ...state, ...userChange(user), user, sessionChecked: true, hydratedFromCache: user ? state.hydratedFromCache : false });
  },

  loggedIn(user: UserPublic): void {
    authGeneration++; // even the same account signing in again starts a new generation
    emit({ ...state, ...userChange(user), user, sessionChecked: true });
  },

  loggedOut(): void {
    authGeneration++;
    emit({
      // Deliberately NOT cleared: voiceOutbox / voiceOutboxWarning. Logging
      // out must never destroy a recording that never reached the gateway —
      // it is still on disk, and the next session drains it (the queue is
      // filtered by the recording user, so it can only be sent by its owner).
      ...state,
      user: null,
      sessionChecked: true,
      connection: "closed",
      hadConnection: false,
      threads: {},
      deepened: {},
      mediaPanelOpen: false,
      reveal: null,
      streams: {},
      activeBot: null,
      drafts: {},
      answerLinks: {},
      outbox: [],
  voiceBots: [],
  elevenBots: [],
      awaiting: {},
      hydratedFromCache: false,
      view: "messages",
      mobileThreadOpen: false,
      mobileFilesOpen: false,
      mcFiles: null,
      fitnessEntries: null,
      mcL2: null,
      mcL3: null,
      settingsOpen: false,
      // Signing out ends the call: the host unmounts the screen, which
      // releases the mic and tells the gateway (voicelayer.ts cleanup).
      call: null,
      clips: null,
      filesList: null,
      costEntries: null,
      bills: null,
      billSettings: null,
      fileCategories: null,
      costCategories: null,
      reviewItem: null,
      reviewWaiting: 0,
      reviewRev: 0,
      buildsItem: null,
      buildsNeedYou: 0,
      buildsRev: 0,
      attention: [],
      attentionDismissed: [],
      shipWatch: null,
      shipLive: null,
      waItem: null,
      waTab: "gaps",
      waWaiting: 0,
      waRev: 0,
    });
  },

  setConnection(connection: ConnectionStatus): void {
    if (state.connection === connection) return;
    emit({
      ...state,
      connection,
      hadConnection: state.hadConnection || connection === "open",
      // Back up: the restart is over.
      restartingAt: connection === "open" ? null : state.restartingAt,
    });
  },

  /** The gateway said it is restarting (frame or close 1012); null clears it (back, or the 90 s grace ran out). */
  setRestarting(at: number | null): void {
    if (state.restartingAt === at) return;
    if (at !== null && state.restartingAt !== null) return; // keep the first mark — the grace runs from it
    emit({ ...state, restartingAt: at });
  },

  setDraft(bot: string, text: string): void {
    if ((state.drafts[bot] ?? "") === text) return;
    emit({ ...state, drafts: { ...state.drafts, [bot]: text } });
  },

  setView(view: View): void {
    // A destination always lands on its page: picking one while Settings is
    // open closes Settings (the redesign renders Settings as a page).
    if (state.view === view) {
      if (state.settingsOpen) emit({ ...state, settingsOpen: false });
      return;
    }
    emit({ ...state, view, settingsOpen: false, mobileThreadOpen: false, mobileFilesOpen: false, toolFilter: "all", mcL2: null, mcL3: null, reviewItem: null, buildsItem: null, waItem: null });
  },

  /** Open WhatsApp — on the board (C12), or straight onto a thread, scrolled to one gap. */
  openWhatsApp(key: string | null = null, gap: string | null = null): void {
    emit({ ...state, view: "whatsapp", waItem: key ? { key, gap } : null, reviewItem: null, buildsItem: null, mobileThreadOpen: false, mobileFilesOpen: false, settingsOpen: false });
  },

  closeWhatsAppItem(): void {
    if (!state.waItem) return;
    emit({ ...state, waItem: null });
  },

  setWhatsAppTab(tab: "gaps" | "inbox"): void {
    if (state.waTab === tab) return;
    emit({ ...state, waTab: tab });
  },

  setWhatsAppWaiting(n: number): void {
    if (state.waWaiting === n) return;
    emit({ ...state, waWaiting: n });
  },

  whatsappChanged(): void {
    emit({ ...state, waRev: state.waRev + 1 });
  },

  /** Open Builds (optionally straight onto one card — #builds/<id>, push taps). */
  openBuilds(id: string | null = null): void {
    emit({ ...state, view: "builds", buildsItem: id, reviewItem: null, mobileThreadOpen: false, mobileFilesOpen: false, settingsOpen: false });
  },

  /** Put the app back on one screen after the release reload (NavSnapshot). */
  restoreNav(snap: NavSnapshot): void {
    emit({
      ...state,
      view: snap.view,
      buildsItem: snap.view === "builds" ? snap.buildsItem : null,
      reviewItem: snap.view === "review" ? snap.reviewItem : null,
      waItem: snap.view === "whatsapp" ? snap.waItem : null,
      activeBot: snap.activeBot ?? state.activeBot,
      mobileThreadOpen: snap.view === "messages" && snap.mobileThreadOpen,
      mobileFilesOpen: false,
      settingsOpen: false,
    });
  },

  closeBuildItem(): void {
    if (!state.buildsItem) return;
    emit({ ...state, buildsItem: null });
  },

  setBuildsNeedYou(n: number): void {
    if (state.buildsNeedYou === n) return;
    emit({ ...state, buildsNeedYou: n });
  },

  buildsChanged(): void {
    emit({ ...state, buildsRev: state.buildsRev + 1 });
  },

  setAttention(items: AttentionItem[]): void {
    const same = items.length === state.attention.length && items.every((it, i) => it.key === state.attention[i].key && it.line === state.attention[i].line);
    if (same) return;
    emit({ ...state, attention: items });
  },

  /** "Not now" — for this session. A new occurrence (new key) comes back on its own. */
  dismissAttention(key: string): void {
    if (state.attentionDismissed.includes(key)) return;
    emit({ ...state, attentionDismissed: [...state.attentionDismissed, key] });
  },

  watchShip(w: { cardId: string; title: string } | null): void {
    if (w?.cardId === state.shipWatch?.cardId && w?.title === state.shipWatch?.title) return;
    emit({ ...state, shipWatch: w, shipLive: w ? state.shipLive : null });
  },

  setShipLive(ship: ShipState | null): void {
    if (JSON.stringify(ship) === JSON.stringify(state.shipLive)) return;
    emit({ ...state, shipLive: ship });
  },

  /** /health answered: remember the sha. The first one seen is "before"; a later different one is "now". */
  setGatewaySha(sha: string | null): void {
    if (!sha || sha === state.gatewayShaNow) return;
    emit({ ...state, gatewayShaBefore: state.gatewayShaNow ?? state.gatewayShaBefore ?? sha, gatewayShaNow: sha });
  },

  /**
   * "Answer in thread" (C9): the panel never answers. It opens the agent's
   * thread with the question quoted in the composer; the answer is a normal
   * message there, so there is one record.
   *
   * `asked`: the run and the needs_operator record. The quote is
   * remembered against them; when he SENDS words under that quote, the send
   * names that exact question so the gateway clears it (build_answered).
   * Backing out, or Later, clears nothing. Past MAX_ANSWERS a quote is simply
   * not linked — that card keeps asking.
   */
  answerInThread(bot: string, quote: string, asked: { build: string | null | undefined; record: string | null | undefined } | null = null): void {
    const quoted = quote.split("\n").map((l) => `> ${l}`).join("\n");
    const existing = state.drafts[bot]?.trim();
    const links = state.answerLinks[bot] ?? [];
    const others = asked?.build ? links.filter((l) => l.build !== asked.build) : links;
    const link: AnswerLink | null = asked?.build && asked.record && others.length < MAX_ANSWERS ? { build: asked.build, record: asked.record, quote: quoted } : null;
    emit({
      ...state,
      view: "messages",
      activeBot: bot,
      mobileThreadOpen: true,
      buildsItem: null,
      settingsOpen: false,
      drafts: { ...state.drafts, [bot]: existing ? `${existing}\n\n${quoted}\n\n` : `${quoted}\n\n` },
      answerLinks: link ? { ...state.answerLinks, [bot]: [...others, link] } : state.answerLinks,
    });
  },

  /** Open Review (optionally straight onto one item — push deep links). */
  openReview(id: string | null = null): void {
    emit({ ...state, view: "review", reviewItem: id, mobileThreadOpen: false, mobileFilesOpen: false, settingsOpen: false });
  },

  closeReviewItem(): void {
    if (!state.reviewItem) return;
    emit({ ...state, reviewItem: null });
  },

  setReviewWaiting(n: number): void {
    if (state.reviewWaiting === n) return;
    emit({ ...state, reviewWaiting: n });
  },

  reviewChanged(waiting?: number): void {
    // A review item can sit on a build card (B4), so Builds refetches too.
    emit({ ...state, reviewRev: state.reviewRev + 1, buildsRev: state.buildsRev + 1, reviewWaiting: typeof waiting === "number" ? waiting : state.reviewWaiting });
  },

  openMcCard(key: string): void {
    emit({ ...state, view: "mission-control", mcL2: key, mcL3: null, settingsOpen: false });
  },

  closeMcCard(): void {
    emit({ ...state, mcL2: null, mcL3: null });
  },

  openFitnessDay(id: string): void {
    emit({ ...state, mcL3: id });
  },

  closeFitnessDay(): void {
    emit({ ...state, mcL3: null });
  },

  setToolFilter(toolFilter: string): void {
    if (state.toolFilter === toolFilter) return;
    emit({ ...state, toolFilter });
  },

  toggleSidebar(): void {
    const sidebarCollapsed = !state.sidebarCollapsed;
    try {
      localStorage.setItem("ahi-sidebar-collapsed", sidebarCollapsed ? "1" : "0");
    } catch {}
    emit({ ...state, sidebarCollapsed });
  },

  /** Mobile push/pop — one context per screen. */
  openMobileThread(bot: string): void {
    emit({ ...state, activeBot: bot, mobileThreadOpen: true });
  },

  popMobile(): void {
    // Back over an open media sheet closes the sheet, not the thread.
    if (state.mediaPanelOpen) {
      emit({ ...state, mediaPanelOpen: false });
      return;
    }
    if (!state.mobileThreadOpen) return;
    emit({ ...state, mobileThreadOpen: false });
  },

  /** Mobile Files drill-in (3f#2) — category picked on layer-1 (toolFilter
   *  is already set by the row's onSelect); its files push as layer-2,
   *  mirroring agents→thread. */
  pushMobileFiles(): void {
    if (state.mobileFilesOpen) return;
    emit({ ...state, mobileFilesOpen: true });
  },

  popMobileFiles(): void {
    if (!state.mobileFilesOpen) return;
    emit({ ...state, mobileFilesOpen: false });
  },

  setMcFiles(files: McFile[]): void {
    const mcFiles: Record<string, McFile> = {};
    for (const f of files) mcFiles[f.name] = f;
    emit({ ...state, mcFiles });
  },

  mcUpdate(name: string, entry: McFile): void {
    // Live push for a card — merge and stamp for the brass pulse.
    const prev = state.mcFiles ?? {};
    emit({ ...state, mcFiles: { ...prev, [name]: { ...entry, touchedAt: Date.now() } } });
  },

  setFitnessEntries(fitnessEntries: McL2Entry[]): void {
    emit({ ...state, fitnessEntries });
  },

  toggleSettings(open?: boolean): void {
    const settingsOpen = open ?? !state.settingsOpen;
    if (settingsOpen === state.settingsOpen) return;
    emit({ ...state, settingsOpen });
  },

  /* ── The live call (call-minimize-pill) ───────────────────────────── */

  /**
   * Open the call screen for this agent. Tapping the voice button on the
   * agent whose call is already running brings a minimized call back
   * instead of starting a second one.
   */
  startCall(bot: string): void {
    const cur = state.call;
    if (cur && cur.bot === bot) {
      if (cur.minimized) emit({ ...state, call: { bot, minimized: false } });
      return;
    }
    emit({ ...state, call: { bot, minimized: false } });
  },

  /** Hide the call screen behind the pill. The call keeps running. */
  minimizeCall(): void {
    const cur = state.call;
    if (!cur || cur.minimized) return;
    emit({ ...state, call: { ...cur, minimized: true } });
  },

  /** Bring the full call screen back over whatever view is open. */
  restoreCall(): void {
    const cur = state.call;
    if (!cur || !cur.minimized) return;
    emit({ ...state, call: { ...cur, minimized: false } });
  },

  /** The call screen is done (the call ended and its glow collapsed, or he backed out of a failed start). */
  leaveCall(): void {
    if (!state.call) return;
    emit({ ...state, call: null });
  },

  setClips(clips: Clip[]): void {
    emit({ ...state, clips });
  },

  setFiles(filesList: FileEntry[]): void {
    emit({ ...state, filesList });
  },

  /**
   * Install the signed-in user's bills — only if `owner` (stamped when the
   * request started) is still the signed-in user, in the same sign-in.
   * Returns whether it was installed.
   */
  setBills(bills: Bill[], billSettings: BillSettings, owner: AuthStamp): boolean {
    if (!stampIsCurrent(owner)) return false;
    emit({ ...state, bills, billSettings });
    return true;
  },
  setCosts(costEntries: CostEntry[]): void {
    emit({ ...state, costEntries });
  },

  setFileCategories(fileCategories: string[]): void {
    emit({ ...state, fileCategories });
  },

  setCostCategories(costCategories: Array<{ key: string; label: string; builtin: boolean }>): void {
    emit({ ...state, costCategories });
  },

  setActiveBot(bot: string | null): void {
    emit({ ...state, activeBot: bot });
  },

  mergeMessages(messages: MessageEvent[]): void {
    if (!messages.length) return;
    const byBot = new Map<string, MessageEvent[]>();
    for (const m of messages) {
      if (isPrivate(m)) continue;
      const list = byBot.get(m.bot) ?? [];
      list.push(m);
      byBot.set(m.bot, list);
    }
    if (!byBot.size) return;
    const threads = { ...state.threads };
    for (const [bot, list] of byBot) {
      threads[bot] = mergeThread(threads[bot] ?? [], list);
    }
    emit({ ...state, threads, hydratedFromCache: false });
  },

  /** The reconnect history frame is authoritative for the recent window.
   *  Replace that window per bot so server-side deletions do not survive
   *  forever in the instant-shell cache. Older cached history and unsent
   *  optimistic messages remain intact. */
  reconcileHistory(messages: MessageEvent[]): void {
    if (!messages.length) return;
    const byBot = new Map<string, MessageEvent[]>();
    for (const message of messages) {
      if (isPrivate(message)) continue;
      const list = byBot.get(message.bot) ?? [];
      list.push(message);
      byBot.set(message.bot, list);
    }

    const threads = { ...state.threads };
    for (const [bot, incoming] of byBot) {
      incoming.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const windowStart = incoming[0].timestamp;
      const retained = (threads[bot] ?? []).filter(
        (message) => message.pending || message.timestamp.localeCompare(windowStart) < 0,
      );
      threads[bot] = mergeThread(retained, incoming);
    }
    emit({ ...state, threads, hydratedFromCache: false });
  },

  toggleMediaPanel(open?: boolean): void {
    const next = open ?? !state.mediaPanelOpen;
    if (next === state.mediaPanelOpen) return;
    emit({ ...state, mediaPanelOpen: next });
  },

  /** Scroll the thread of `bot` to one message (the panel's "Show in chat").
   *  Switches to that agent's thread; the caller has already made sure the
   *  message is loaded (lib/mediaPanel.ts ensureLoaded). */
  revealMessage(bot: string, messageId: string, closePanel: boolean): void {
    emit({
      ...state,
      view: "messages",
      settingsOpen: false,
      activeBot: bot,
      mobileThreadOpen: true,
      mediaPanelOpen: closePanel ? false : state.mediaPanelOpen,
      reveal: { bot, messageId, nonce: (state.reveal?.nonce ?? 0) + 1 },
    });
  },

  revealDone(nonce: number): void {
    if (state.reveal?.nonce !== nonce) return;
    emit({ ...state, reveal: null });
  },

  markDeepened(bot: string): void {
    emit({ ...state, deepened: { ...state.deepened, [bot]: true } });
  },

  /** Optimistic send: bubble + outbox entry exist before any network I/O.
   *  Clears the bot's draft in the same emit (single render). */
  enqueueSend(bot: string, text: string, user: UserPublic, attachmentIds: string[] = []): string {
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // The questions this send answers: words under a linked quote. The draft empties
    // on send, so every link for this bot is spent.
    const answers = answersFor(state.answerLinks[bot] ?? [], text);
    const answerLinks = { ...state.answerLinks };
    delete answerLinks[bot];
    const msg: LocalMessage = {
      type: "message",
      bot,
      direction: "in",
      contentType: attachmentIds.length ? "photo" : "text",
      text,
      timestamp: new Date().toISOString(),
      chatId: 0,
      userId: user.userId,
      senderName: user.name,
      source: "app",
      localId,
      pending: true,
      ...(answers.length ? { answers } : {}),
    };
    emit({
      ...state,
      threads: { ...state.threads, [bot]: [...(state.threads[bot] ?? []), msg] },
      outbox: [
        ...state.outbox,
        { localId, bot, text, ...(attachmentIds.length ? { attachmentIds } : {}), ...(answers.length ? { answers } : {}) },
      ],
      awaiting: { ...state.awaiting, [bot]: Date.now() },
      drafts: { ...state.drafts, [bot]: "" },
      answerLinks,
    });
    return localId;
  },

  /** Which agents the server will accept voice mode for. */
  setVoiceBots(bots: string[], elevenBots: string[] = []): void {
    emit({ ...state, voiceBots: bots, elevenBots });
  },

  /** Mirror the durable voice queue. Called on every queue change, which
   *  during a drain is often — so identical lists do not re-render. */
  setVoiceOutbox(voiceOutbox: VoiceOutboxItem[]): void {
    if (sameVoiceOutbox(state.voiceOutbox, voiceOutbox)) return;
    emit({ ...state, voiceOutbox });
  },

  setVoiceOutboxWarning(voiceOutboxWarning: string | null): void {
    if (state.voiceOutboxWarning === voiceOutboxWarning) return;
    emit({ ...state, voiceOutboxWarning });
  },

  /** POST accepted — drop the outbox entry. The bubble stays pending
   *  until the WS echo (meta.clientMessageId) reconciles it. */
  sendDelivered(localId: string): void {
    emit({ ...state, outbox: state.outbox.filter((e) => e.localId !== localId) });
  },

  /** Server rejected the send — bubble becomes failed (tap-to-retry). */
  sendRejected(localId: string): void {
    const entry = state.outbox.find((e) => e.localId === localId);
    const outbox = state.outbox.filter((e) => e.localId !== localId);
    let threads = state.threads;
    let awaiting = state.awaiting;
    if (entry) {
      const thread = threads[entry.bot] ?? [];
      const idx = thread.findIndex((m) => m.localId === localId);
      if (idx >= 0) {
        const next = [...thread];
        next[idx] = { ...next[idx], pending: false, failed: true };
        threads = { ...threads, [entry.bot]: next };
      }
      awaiting = { ...awaiting };
      delete awaiting[entry.bot];
    }
    emit({ ...state, outbox, threads, awaiting });
  },

  /** Tap-to-retry on a failed bubble: back to pending, re-queued. */
  retrySend(bot: string, localId: string): void {
    const thread = state.threads[bot];
    if (!thread) return;
    const idx = thread.findIndex((m) => m.localId === localId);
    if (idx < 0) return;
    const msg = thread[idx];
    const next = [...thread];
    next[idx] = { ...msg, pending: true, failed: false };
    emit({
      ...state,
      threads: { ...state.threads, [bot]: next },
      outbox: [...state.outbox.filter((e) => e.localId !== localId), { localId, bot, text: msg.text, ...(msg.answers?.length ? { answers: msg.answers } : {}) }],
      awaiting: { ...state.awaiting, [bot]: Date.now() },
    });
  },

  clearAwaiting(bot: string): void {
    if (!(bot in state.awaiting)) return;
    const awaiting = { ...state.awaiting };
    delete awaiting[bot];
    emit({ ...state, awaiting });
  },

  // ── Stream lifecycle ──
  streamStart(streamId: string, bot: string): void {
    const origin = [...(state.threads[bot] ?? [])].reverse().find((m) => m.direction === "in");
    emit({
      ...state,
      streams: { ...state.streams, [streamId]: {
        streamId,
        bot,
        text: "",
        tools: [],
        done: false,
        error: null,
        messageStart: 0,
        originMessageId: origin ? localMessageId(origin) : null,
      } },
    });
  },

  streamChunk(streamId: string, chunk: string): void {
    const s = state.streams[streamId];
    if (!s) return;
    emit({ ...state, streams: { ...state.streams, [streamId]: appendStreamChunkText(s, chunk) } });
  },

  streamTool(streamId: string, toolName: string): void {
    const s = state.streams[streamId];
    if (!s || s.tools.includes(toolName)) return;
    emit({
      ...state,
      streams: {
        ...state.streams,
        [streamId]: { ...s, messageStart: s.text.length, tools: [...s.tools, toolName] },
      },
    });
  },

  streamEnd(streamId: string, finalText?: string, error?: string): void {
    const s = state.streams[streamId];
    if (!s) return;
    emit({
      ...state,
      streams: {
        ...state.streams,
        [streamId]: { ...s, text: finalText ?? s.text, done: true, error: error ?? null },
      },
    });
  },

  cancelStream(streamId: string, bot: string, status: "cancelled" | "steered"): void {
    const stream = state.streams[streamId];
    const targetBot = stream?.bot ?? bot;
    const streams = { ...state.streams };
    delete streams[streamId];

    let threads = state.threads;
    if (stream?.originMessageId) {
      const thread = state.threads[targetBot] ?? [];
      const next = thread.map((m) =>
        m.direction === "in" && localMessageId(m) === stream.originMessageId
          ? {
              ...m,
              pending: false,
              cancelled: status === "cancelled",
              steered: status === "steered",
              meta: { ...m.meta, turnStatus: status },
            }
          : m,
      );
      threads = { ...threads, [targetBot]: next };
    }

    const awaiting = { ...state.awaiting };
    delete awaiting[targetBot];
    emit({ ...state, streams, threads, awaiting });
  },

  /** Contract rule (AUDIT.md §2.3 #3): the canonical `out` message that
   *  follows a finished stream replaces the stream card. Called when an
   *  out-message for that bot arrives. */
  consumeStreamsFor(bot: string): void {
    const ids = Object.values(state.streams)
      .filter((s) => s.bot === bot)
      .map((s) => s.streamId);
    if (!ids.length) return;
    const streams = { ...state.streams };
    for (const id of ids) delete streams[id];
    emit({ ...state, streams });
  },

  /** Reconnect replay only includes canonical messages, never stream
   *  lifecycle frames. Any unfinished stream or awaiting marker that survived
   *  a disconnect is stale UI and will be superseded by replay/live messages. */
  reconcileStreamsAfterReconnect(): void {
    const orphanIds = Object.values(state.streams)
      .filter((s) => !s.done)
      .map((s) => s.streamId);
    if (!orphanIds.length && !Object.keys(state.awaiting).length) return;

    const streams = orphanIds.length ? { ...state.streams } : state.streams;
    for (const id of orphanIds) delete streams[id];

    emit({ ...state, streams, awaiting: {} });
  },
};

// ── Server event router ─────────────────────────────────────────────

export function handleServerEvent(ev: ServerEvent): void {
  // A call's token stream is tagged `voiceCall` by the gateway: it belongs to
  // the voice screen, which has already had it (App dispatches to the voice bus
  // first). The thread must ignore it, because nothing would ever clean up
  // after it — a voice reply is not written to the thread as a message, so the
  // out-message that normally consumes a finished stream card never arrives,
  // and the bubble would simply sit there once the call ended (R4-2).
  //
  // The call's container card is a plain message and is NOT tagged, so it still
  // lands. That card is a call's only representation in the thread.
  if ((ev as { voiceCall?: string }).voiceCall) return;

  switch (ev.type) {
    case "review-update":
      actions.reviewChanged((ev as { waiting?: number }).waiting);
      break;
    case "builds-update":
      actions.buildsChanged();
      break;
    case "restarting":
      actions.setRestarting(Date.now());
      break;
    case "session": {
      const se = ev as { user: UserPublic; voiceBots?: string[]; elevenBots?: string[] };
      actions.sessionResolved(se.user);
      actions.setVoiceBots(se.voiceBots ?? [], se.elevenBots ?? []);
      break;
    }
    case "history":
      actions.reconcileHistory((ev as { messages: MessageEvent[] }).messages ?? []);
      break;
    case "message": {
      const msg = ev as MessageEvent;
      // A search card (or a studio card landing) is not the agent's reply: it
      // must not end a live stream or the typing state (the owner can search, or a
      // job can land, while the agent answers).
      if (msg.direction === "out" && !msg.meta?.search && !msg.meta?.studio) {
        actions.consumeStreamsFor(msg.bot);
        actions.clearAwaiting(msg.bot);
      }
      actions.mergeMessages([msg]);
      break;
    }
    case "stream-start": {
      const bot = (ev as { botName: string }).botName;
      actions.streamStart((ev as { streamId: string }).streamId, bot);
      actions.clearAwaiting(bot); // live stream replaces the typing indicator
      break;
    }
    case "stream-chunk":
      actions.streamChunk((ev as { streamId: string }).streamId, (ev as { chunk: string }).chunk ?? "");
      break;
    case "stream-tool-use":
      actions.streamTool((ev as { streamId: string }).streamId, (ev as { toolName: string }).toolName ?? "tool");
      break;
    case "stream-end":
      actions.streamEnd((ev as { streamId: string }).streamId, (ev as { finalText?: string }).finalText);
      break;
    case "stream-error": {
      const e = ev as { streamId: string; botName: string; error?: string };
      if (e.error === "stopped" || e.error === "steered") {
        actions.cancelStream(e.streamId, e.botName, e.error === "stopped" ? "cancelled" : "steered");
      } else {
        actions.streamEnd(e.streamId, undefined, e.error || "stream error");
      }
      break;
    }
    case "bills-update": {
      // The gateway sends this only to the bills' owner (scoped by userId).
      const e = ev as { userId?: string; bills?: Bill[]; settings?: BillSettings };
      if (e.bills && e.settings && (!e.userId || e.userId === state.user?.userId)) actions.setBills(e.bills, e.settings, authStamp());
      break;
    }
    case "codex-live":
      // Doorbell only: the open live panel fetches the delta itself.
      codexLiveNudge((ev as { build?: unknown }).build);
      break;
    case "mc-update": {
      const e = ev as { file?: string; entry?: McFile };
      if (e.file && e.entry) actions.mcUpdate(e.file, e.entry);
      break;
    }
    default:
      // voice-* — Step 3 (recorder port).
      break;
  }
}

// ── Nav resume across the release reload ───────────────────────────────
// main.tsx reloads the page exactly once when a new release's service worker
// takes control. Nothing of the screen lives in the URL, so a tap inside that
// window — the attention bar's Answer on a fresh open after a release (the owner,
//) — used to land on a reset app: Messages, the bar back, nothing
// opened. The screen is stashed just before that reload and taken back once
// on the next boot; a stale stash (older than the TTL) is ignored.
export interface NavSnapshot {
  v: 1;
  at: number;
  view: View;
  buildsItem: string | null;
  reviewItem: string | null;
  waItem: { key: string; gap: string | null } | null;
  activeBot: string | null;
  mobileThreadOpen: boolean;
}
export const NAV_RESUME_KEY = "ahi-nav-resume";
export const NAV_RESUME_TTL_MS = 60_000;

export function navSnapshot(now = Date.now()): NavSnapshot {
  return { v: 1, at: now, view: state.view, buildsItem: state.buildsItem, reviewItem: state.reviewItem, waItem: state.waItem, activeBot: state.activeBot, mobileThreadOpen: state.mobileThreadOpen };
}

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Called right before the release reload: remember where he is. */
export function stashNav(now = Date.now()): void {
  try {
    sessionStore()?.setItem(NAV_RESUME_KEY, JSON.stringify(navSnapshot(now)));
  } catch {
    /* private mode / quota — the reload still happens, it just lands on Messages */
  }
}

/** The stash, once: read, removed, and null when absent, malformed or older than the TTL. */
export function takeNavResume(now = Date.now()): NavSnapshot | null {
  const store = sessionStore();
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(NAV_RESUME_KEY);
    store.removeItem(NAV_RESUME_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const snap = JSON.parse(raw) as Partial<NavSnapshot>;
    if (snap?.v !== 1 || typeof snap.at !== "number" || typeof snap.view !== "string") return null;
    if (now - snap.at > NAV_RESUME_TTL_MS || now < snap.at) return null;
    return { v: 1, at: snap.at, view: snap.view, buildsItem: snap.buildsItem ?? null, reviewItem: snap.reviewItem ?? null, waItem: snap.waItem ?? null, activeBot: snap.activeBot ?? null, mobileThreadOpen: !!snap.mobileThreadOpen };
  } catch {
    return null;
  }
}
