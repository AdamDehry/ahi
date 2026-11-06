/* ============================================================
   voice-outbox.ts — the voice-note queue, and the only place a voice
   note is uploaded from.

   Lifecycle of one note:

     record  → putVoiceNote()            on disk before any network I/O
             → POST /ui/voice-send       oldest queued note first
             → 200, or the WS echo       CONFIRMED → deleted
             → network/5xx/401           stays queued, retried
             → 4xx                       stays on disk, marked failed,
                                         manual Retry only

   Two things earn a delete, and nothing else does:

     1. HTTP 200 from /ui/voice-send.
     2. A WS `message` carrying meta.clientMessageId === the note's id.

   (2) is not redundant. The gateway broadcasts the stored voice message
   BEFORE it returns, so a connection that dies in between leaves the
   audio safely on the server and the client convinced it failed. Without
   (2) that note would be re-uploaded on the next sweep and the owner would
   have two copies. With it, the echo settles the record.

   What we cannot fix from here: /ui/voice-send does not dedupe on
   clientMessageId (src/dashboard.ts:1561 stores it as meta and nothing
   more), so delivery is at-least-once and a badly timed failure can still
   duplicate a note. That is the deliberate trade — a duplicate note is an
   annoyance, a lost note is what this file exists to prevent. Server-side
   dedupe on meta.clientMessageId would close it; it is out of this
   branch's scope (PWA only).
   ============================================================ */

import { uploadVoiceNote } from "./api";
import { actions, getState, type VoiceOutboxItem } from "../store";
import {
  allVoiceNotes,
  deleteVoiceNote,
  getVoiceNote,
  putVoiceNote,
  type VoiceNoteRecord,
} from "./voice-outbox-db";

/**
 * Shown when the note could not be written to disk. Deliberately blunt: the
 * user is back on the old behaviour for this note and has a right to know
 * BEFORE they record a long one.
 */
export const VOICE_STORAGE_WARNING =
  "This device isn't saving voice notes locally — a note that fails to send will be lost.";

const RETRY_START_MS = 2_000;
const RETRY_MAX_MS = 30_000;

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = RETRY_START_MS;
let draining = false;
let drainAgain = false;
/** The note currently mid-POST — the outbox row that reads "Sending…". */
let sendingId: string | null = null;

/**
 * Two notes recorded inside the same millisecond would share a createdAt and
 * their queue order would come down to string comparison of a random id.
 * A monotonic stamp keeps FIFO honest.
 */
let lastSequence = 0;
function nextSequence(): number {
  const now = Date.now();
  lastSequence = now > lastSequence ? now : lastSequence + 1;
  return lastSequence;
}

function mintId(): string {
  return `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Ours, vs. every other clientMessageId echoing past on the socket. */
function isVoiceOutboxId(id: string): boolean {
  return id.startsWith("voice-");
}

/**
 * A note is drained only for the user who recorded it. The queue lives in a
 * browser profile and the gateway is multi-user (config/users.json); an
 * unowned note — there should be none — is treated as the current user's.
 */
function ownedByCurrentUser(record: VoiceNoteRecord): boolean {
  const userId = getState().user?.userId;
  return record.userId === undefined || userId === undefined || record.userId === userId;
}

function toItem(record: VoiceNoteRecord): VoiceOutboxItem {
  return {
    id: record.id,
    bot: record.bot,
    durationSec: record.durationSec,
    sizeBytes: record.sizeBytes,
    createdAt: record.createdAt,
    attempts: record.attempts,
    state: record.failed ? "failed" : record.id === sendingId ? "sending" : "queued",
    lastError: record.lastError,
  };
}

/** Push the queue's metadata (never the blobs) into the store for the UI.
 *  Pass `known` when the caller has just read the queue, to save a second
 *  round-trip through IndexedDB. */
async function publish(known?: VoiceNoteRecord[]): Promise<void> {
  try {
    const records = known ?? (await allVoiceNotes());
    actions.setVoiceOutbox(records.filter(ownedByCurrentUser).map(toItem));
  } catch {
    // Reading the queue failed. Say so rather than rendering an empty outbox,
    // which would claim there is nothing waiting.
    actions.setVoiceOutboxWarning(VOICE_STORAGE_WARNING);
  }
}

/**
 * Persist a finished recording. Resolves with `persisted: false` when storage
 * refused it — the caller must then fall back to the old send-from-memory
 * path. This never throws and never blocks on the network: a storage problem
 * may not cost the user a recording (brief item 5).
 */
export async function enqueueVoiceNote(
  bot: string,
  blob: Blob,
  durationSec: number,
): Promise<{ id: string; persisted: boolean }> {
  const id = mintId();
  const record: VoiceNoteRecord = {
    id,
    bot,
    userId: getState().user?.userId,
    blob,
    mime: blob.type || "audio/webm",
    durationSec,
    sizeBytes: blob.size,
    createdAt: nextSequence(),
    attempts: 0,
  };
  try {
    await putVoiceNote(record);
  } catch {
    actions.setVoiceOutboxWarning(VOICE_STORAGE_WARNING);
    return { id, persisted: false };
  }
  actions.setVoiceOutboxWarning(null);
  await publish();
  return { id, persisted: true };
}

type Outcome = "confirmed" | "transient" | "permanent";

async function uploadOne(record: VoiceNoteRecord): Promise<Outcome> {
  sendingId = record.id;
  await publish();
  const result = await uploadVoiceNote(record.bot, record.blob, record.durationSec, record.id);
  sendingId = null;
  if (result.ok) {
    await forget(record.id);
    return "confirmed";
  }
  if (result.kind === "rejected") {
    await annotate(record.id, { failed: true, lastError: result.error });
    return "permanent";
  }
  await annotate(record.id, { attempts: record.attempts + 1, lastError: result.error });
  return "transient";
}

async function forget(id: string): Promise<void> {
  try {
    await deleteVoiceNote(id);
  } catch {
    /* the note stays; a later sweep finds the server already has it via the
       WS echo, or re-uploads it. Never fatal. */
  }
  await publish();
}

/**
 * Write back attempt/failure bookkeeping — but ONLY if the note is still
 * there. A WS echo can confirm and delete a note while its own POST is still
 * in flight; a blind put() would resurrect audio the server already holds and
 * send it a second time.
 */
async function annotate(id: string, patch: Partial<VoiceNoteRecord>): Promise<void> {
  try {
    const current = await getVoiceNote(id);
    if (!current) return;
    await putVoiceNote({ ...current, ...patch });
  } catch {
    /* bookkeeping only — the audio is already safe, and losing an attempt
       count costs nothing. */
  }
  await publish();
}

/**
 * Upload queued notes, oldest first. On a transient failure the sweep STOPS
 * rather than skipping ahead: the queue is a queue, and a big old note must
 * not be overtaken by the small new one behind it (brief item 4).
 */
async function sweep(): Promise<void> {
  let records: VoiceNoteRecord[];
  try {
    records = await allVoiceNotes();
  } catch {
    actions.setVoiceOutboxWarning(VOICE_STORAGE_WARNING);
    return;
  }
  // Disk is the authority: re-mirror before uploading anything. This is also
  // what corrects the strip after a user switch, when the queue the previous
  // user could see is no longer theirs to send.
  await publish(records);
  if (!records.length) {
    clearRetry();
    return;
  }
  for (const record of records) {
    if (!ownedByCurrentUser(record)) continue;
    if (record.failed) continue; // permanent — waits for the Retry button
    // navigator.onLine is only ever trusted to say "definitely offline":
    // a captive portal reports online, so a false positive just means we
    // try and fail. The 'online' event wakes the sweep back up.
    if (navigator.onLine === false) return;
    const outcome = await uploadOne(record);
    if (outcome === "confirmed") {
      retryDelay = RETRY_START_MS; // network is healthy again
      continue;
    }
    if (outcome === "permanent") continue;
    scheduleRetry();
    return;
  }
}

/**
 * Drain the queue. Safe to call from anywhere, as often as you like: a call
 * during an active drain sets a flag instead of starting a second uploader,
 * so one note is never POSTed twice concurrently.
 */
export async function drainVoiceOutbox(): Promise<void> {
  if (draining) {
    drainAgain = true;
    return;
  }
  draining = true;
  try {
    do {
      drainAgain = false;
      await sweep();
    } while (drainAgain);
  } finally {
    draining = false;
  }
}

function scheduleRetry(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    void drainVoiceOutbox();
  }, retryDelay);
}

function clearRetry(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryDelay = RETRY_START_MS;
}

/**
 * The gateway echoed a stored message back over the socket. If it names one
 * of our queued notes, the server HAS the audio — whatever the POST thought.
 */
export async function confirmVoiceReceipt(clientMessageId: string): Promise<void> {
  if (!isVoiceOutboxId(clientMessageId)) return;
  try {
    const record = await getVoiceNote(clientMessageId);
    if (!record) return;
  } catch {
    return;
  }
  await forget(clientMessageId);
}

/** The Retry button: clear the refusal and try again now. */
export async function retryVoiceNote(id: string): Promise<void> {
  try {
    const record = await getVoiceNote(id);
    if (!record) return;
    await putVoiceNote({ ...record, failed: false, lastError: undefined, attempts: 0 });
  } catch {
    actions.setVoiceOutboxWarning(VOICE_STORAGE_WARNING);
    return;
  }
  clearRetry();
  await publish();
  await drainVoiceOutbox();
}

/** Explicit discard. The ONLY path that destroys audio the server never got. */
export async function discardVoiceNote(id: string): Promise<void> {
  try {
    await deleteVoiceNote(id);
  } catch {
    actions.setVoiceOutboxWarning(VOICE_STORAGE_WARNING);
  }
  await publish();
}

/**
 * Wire the queue up for the session: show what is waiting, drain it now
 * (this IS "retry on app open"), and drain again whenever the browser says
 * connectivity came back or the app returns to the foreground. An installed
 * PWA resumed from the background performs no navigation, so
 * visibilitychange is the only signal that the app is being used again.
 */
export function initVoiceOutbox(): () => void {
  const wake = () => {
    void drainVoiceOutbox();
  };
  const onVisible = () => {
    if (!document.hidden) wake();
  };
  window.addEventListener("online", wake);
  document.addEventListener("visibilitychange", onVisible);
  void publish().then(() => drainVoiceOutbox());
  return () => {
    window.removeEventListener("online", wake);
    document.removeEventListener("visibilitychange", onVisible);
    clearRetry();
  };
}

/** Test seam only: forget in-memory scheduling state between cases. */
export function resetVoiceOutboxEngine(): void {
  clearRetry();
  draining = false;
  drainAgain = false;
  sendingId = null;
  lastSequence = 0;
}
