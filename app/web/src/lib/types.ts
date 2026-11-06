import type { SentAnswer } from "./answers";
// The gateway contract — mirrors src/websocket.ts + src/dashboard.ts exactly.
// See web/AUDIT.md §2 for the full write-up with file:line references.

export interface UserPublic {
  name: string;
  userId: string;
  agents: string[];
  admin: boolean;
}

export type ContentType = "text" | "voice" | "photo" | "document";

/** Media attachment — DEPLOYED gateway shape (AUDIT.md §2.4). `path` is a
 *  server filesystem path; the client always fetches by id via
 *  /ui/media/:id (inline, Range-capable) and /ui/media/:id/thumb. */
export interface MediaRef {
  id: string;
  /** "voice" = a recorded voice note; "audio" / "video" = FILES (an mp3
   *  Michael sends, a clip the owner drops in) — file cards, never the note
   *  player or its transcript. */
  type: "image" | "voice" | "document" | "audio" | "video";
  fileId?: string;
  path: string;
  originalName: string;
  mime: string;
  size: number;
  durationSec?: number;
  transcript?: string;
  thumbnail?: boolean;
}

/** One web result on a search card (bounded, http(s) links only). */
export interface SearchWebResult {
  title: string;
  link: string;
  snippet: string;
  domain: string;
  favicon?: string;
  date?: string;
}

/** One picture on a search card. URLs are never loaded directly (CSP): the
 *  card reads them through the gateway's picture proxy by index. */
export interface SearchImageResult {
  title: string;
  imageUrl: string;
  thumbnailUrl: string;
  width?: number;
  height?: number;
  domain: string;
  link: string;
}

export interface SearchCardMeta {
  kind: "web" | "images";
  query: string;
  /** Who ran it: the user's id or the agent's name. */
  by: string;
  at: string;
  web?: SearchWebResult[];
  images?: SearchImageResult[];
  usage?: { used: number; limit?: number };
  provider?: "serper" | "serpapi";
  cached?: boolean;
}

/** One lettered option on a studio decision card: the user's own media. */
export interface StudioOptionMeta {
  key: "A" | "B" | "C" | "D";
  label?: string;
  media: MediaRef;
}

/** Live studio card (src/studio/ on the gateway): a job in progress, or a decision. */
export interface StudioCardMeta {
  state: "working" | "decision" | "failed";
  ask: string;
  options: StudioOptionMeta[];
  more?: number;
  folder?: string;
  jobId?: string;
  engine?: string;
  n?: number;
  guide?: string;
  step?: string;
  note?: string;
  error?: string;
  by: string;
  at: string;
  startedAt?: string;
}

export interface MessageEvent {
  type: "message";
  bot: string;
  direction: "in" | "out";
  contentType: ContentType;
  text: string;
  timestamp: string; // ISO — sort key (string compare, matches server)
  chatId: number;
  userId: string;
  senderName: string;
  source?: "telegram" | "ui-send" | "private-edge" | "app";
  meta?: {
    voiceDuration?: number;
    photoPath?: string;
    fileName?: string;
    /** Stable server id — canonical dedupe/UPSERT key: an event with a
     *  messageId you already hold replaces your copy in place. */
    messageId?: string;
    /** Voice-turn correlation id (= PWA voiceStreamId). */
    turnId?: string;
    /** Echo of the client-generated id passed to POST /app/send —
     *  the precise reconciliation key for optimistic sends (deployed
     *  contract; AUDIT.md §2.4). */
    clientMessageId?: string;
    /** Present when an agent posted this message with files (send-file). */
    agentFiles?: { by: string };
    /** Inline search card (src/search/ on the gateway) — its presence makes
     *  the thread render the card; `text` stays the plain-text twin. */
    search?: SearchCardMeta;
    /** Live studio card — its presence makes the thread render it; `text`
     *  stays the plain-text twin. Updated in place (same messageId) when a
     *  job lands. */
    studio?: StudioCardMeta;
    /** User-visible outcome when a generated reply was deliberately interrupted. */
    turnStatus?: "cancelled" | "steered";
    /**
     * Call log (frame 3F) — present ONLY on the card a voice call appends to
     * the thread when it ends. Its presence is what makes the client render a
     * card instead of a plain message line.
     */
    voiceSession?: {
      startedAt: number;
      durationSec: number;
      turns: number;
      transcript: { role: "user" | "agent"; text: string }[];
      /** A phone call's card (the phone leg); absent on an app call. */
      channel?: "phone";
      direction?: "inbound" | "outbound";
      /** How the call ended, in plain words, when it did not end cleanly. */
      ending?: string;
    };
  };
  media?: MediaRef;
  /**
   * Every attachment travelling with this message, in send order (design
   * lock v4: words + cargo are ONE message, and the sent grid lays them out
   * by count). `media` stays populated with the FIRST item so older clients
   * and the existing single-media paths keep working unchanged.
   */
  mediaList?: MediaRef[];
  /** Present when the delivery hub queued this event for ACK/replay —
   *  the client must answer {type:"ack", deliveryId}. */
  deliveryId?: string;
}

/** Client-only extension: optimistic sends carry a localId until the
 *  server echo (the broadcast of our own /app/send) reconciles them. */
export interface LocalMessage extends MessageEvent {
  localId?: string;
  pending?: boolean;
  failed?: boolean;
  cancelled?: boolean;
  steered?: boolean;
  /** Build questions this send answers — kept so tap-to-retry still clears the card. */
  answers?: SentAnswer[];
}

export interface SessionEvent {
  type: "session";
  user: UserPublic;
  /**
   * Agents this user can enter voice mode with — i.e. the ones the server
   * will actually accept a `voice-start` for. The composer renders the voice
   * button only for these. Absent on an older server: treated as none, so
   * the button stays hidden rather than appearing and failing.
   */
  voiceBots?: string[];
}

export interface HistoryEvent {
  type: "history";
  messages: MessageEvent[];
}

export interface StreamStartEvent {
  type: "stream-start";
  streamId: string;
  botName: string;
}

export interface StreamChunkEvent {
  type: "stream-chunk";
  streamId: string;
  botName: string;
  chunk: string;
}

export interface StreamToolUseEvent {
  type: "stream-tool-use";
  streamId: string;
  botName: string;
  toolName: string;
}

export interface StreamEndEvent {
  type: "stream-end";
  streamId: string;
  botName: string;
  finalText?: string;
  cost?: number;
  durationMs?: number;
}

export interface StreamErrorEvent {
  type: "stream-error";
  streamId: string;
  botName: string;
  error: string;
}

export type ServerEvent =
  | SessionEvent
  | HistoryEvent
  | MessageEvent
  | StreamStartEvent
  | StreamChunkEvent
  | StreamToolUseEvent
  | StreamEndEvent
  | StreamErrorEvent
  | { type: string; [key: string]: unknown }; // mc-update, voice-* — ignored for now

// ── Tool-page contracts (shared by api.ts, store.ts, views) ─────────

/** Mission-control file card — /ui/mc shape + live mc-update patches. */
export interface McFile {
  name: string;
  label: string;
  blurb?: string;
  content?: string;
  exists?: boolean;
  mtime?: number;
  /** epoch-ms of the last live mc-update — drives the brass pulse. */
  touchedAt?: number;
}

/** mc-structured L2 entry (deployed /app/mc/cards?level=2&type=…). */
export interface McL2Entry {
  id: string;
  title: string;
  status?: string;
  group?: string;
  summary?: string;
  meta?: { dayNumber?: string; isoDate?: string; [k: string]: unknown };
}

/** mc-structured L3 detail (deployed /app/mc/card?l1=…&id=…). `spec`
 *  carries the full markdown body (e.g. a fitness day's routine). */
export interface McL3Detail extends McL2Entry {
  spec?: string;
  notes?: string;
  l1?: string;
}

export interface Clip {
  id: string;
  text: string;
  created: number | string;
}

export interface FileEntry {
  name: string; // may carry a category prefix, e.g. "general/photo.png"
  size: number;
  modified: number | string;
}

export interface CostEntry {
  id: string;
  bucket: string;
  service: string;
  category: string;
  cost_type: "subscription" | "fixed" | "usage" | "free";
  monthly_cost_fixed: number | null;
  monthly_cost_estimate: number | null;
  billing_url: string | null;
  notes: string | null;
  active: boolean;
  used_for?: string;
}

/** Gateway-accepted cost categories — VALID_BUCKETS is fixed server-side
 *  (deployed operating-costs.ts:32); an unknown value on create is
 *  silently coerced to "personal", so the client must never send one. */
export const COST_CATEGORIES: Array<{ key: string; label: string }> = [
  { key: "ai_automation", label: "AI Automation" },
  { key: "business", label: "Business" },
  { key: "personal", label: "Personal" },
];

/** Bot metadata — same registry as public/app.js:7-18. */
export const BOT_ORDER = ["michael", "miriam", "tzali", "avi"] as const;

export const BOT_LABELS: Record<string, string> = {
  michael: "Michael",
  miriam: "Miriam",
  tzali: "Tzali",
  avi: "Avi",
};

export const BOT_SUBTITLES: Record<string, string> = {
  michael: "Strategist",
  miriam: "Personal assistant",
  tzali: "Builder",
  avi: "Visual conscience",
};

/** Messages a private edge channel marks as never shown in the feed (none ship in this release). */
export function isPrivate(msg: { bot: string; source?: string }): boolean {
  return msg.source === "private-edge";
}

/** One of the signed-in user's OWN bills (gateway bills.ts). Never anyone else's. */
export interface Bill {
  id: string;
  name: string;
  amount: number | null;
  dueDay: number | null;
  dueDate: string | null;
  recurring: "monthly" | "yearly" | "weekly" | "once";
  autopay: boolean;
  link: string | null;
  notes: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface BillSettings {
  currency: string;
  remindDaysBefore: number | null;
}
