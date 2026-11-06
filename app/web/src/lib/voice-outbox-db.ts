/* ============================================================
   voice-outbox-db.ts — durable storage for unsent voice notes.

   WHY THIS EXISTS. Until now a voice note lived in one place: a Blob in
   the Recorder's closure. One POST, and on failure an alert() and the
   blob went out of scope. The owner lost a six-minute note that way twice in
   two weeks — the recording was perfect, the network wasn't, and there
   was nothing left to retry.

   So the note goes to disk BEFORE the upload starts and is deleted only
   once the gateway has confirmed it holds the audio. Everything between
   those two points is retry.

   IndexedDB, not localStorage: localStorage is strings only, and
   base64-ing a multi-megabyte Opus blob into a 5MB quota is exactly the
   trap that loses the long notes. IndexedDB stores the Blob itself.

   Every function here can REJECT — quota exhausted, private mode,
   Safari evicting the database. Callers must treat a rejection as
   "storage is unavailable" and fall back to the old in-memory path
   (lib/voice-outbox.ts does; recording never depends on this file).
   ============================================================ */

const DB_NAME = "ahi-voice-outbox";
const DB_VERSION = 1;
const STORE = "notes";

export interface VoiceNoteRecord {
  /**
   * Identity, and ALSO the clientMessageId sent to /ui/voice-send. It is
   * minted once, at record time, and reused by every retry — so the
   * gateway's WS echo (meta.clientMessageId) names this exact record and
   * can confirm receipt even when the HTTP response never arrives.
   */
  id: string;
  bot: string;
  /** Owner at record time; a note is only ever drained for its own user. */
  userId?: string;
  blob: Blob;
  mime: string;
  durationSec: number;
  sizeBytes: number;
  /** Queue order. Strictly increasing within a session (see nextSequence). */
  createdAt: number;
  attempts: number;
  /**
   * Set ONLY when the gateway permanently refused the note (unsupported
   * type, too large, no access). Auto-retry stops; the note stays on disk
   * with a Retry button, because a refused note is still the owner's audio and
   * only he gets to throw it away.
   */
  failed?: boolean;
  lastError?: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function rawOpen(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const idb = globalThis.indexedDB;
    if (!idb) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = idb.open(DB_NAME, DB_VERSION);
    } catch (err) {
      // Firefox in private mode throws from open() rather than erroring.
      reject(err instanceof Error ? err : new Error("IndexedDB open threw"));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        // The queue is drained oldest-first, and an index does that ordering
        // for us — getAll() on the index comes back in key order.
        store.createIndex("createdAt", "createdAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    // A failed open must not be cached: the next attempt (after the user
    // frees space, or leaves private mode) has to be allowed to succeed.
    dbPromise = rawOpen().catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

/**
 * Resolves only on transaction COMPLETE, not on request success. That is the
 * point of the whole file: when this resolves the note is on disk and a
 * reload can find it. request.onsuccess fires while the transaction can
 * still abort.
 */
export async function putVoiceNote(record: VoiceNoteRecord): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, "readwrite");
    } catch (err) {
      reject(err instanceof Error ? err : new Error("voice outbox transaction failed"));
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("voice outbox write aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("voice outbox write failed"));
    try {
      tx.objectStore(STORE).put(record);
    } catch (err) {
      // DataCloneError (a Blob the engine refuses to clone) throws here.
      reject(err instanceof Error ? err : new Error("voice outbox put threw"));
    }
  });
}

function readRequest<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction;
        try {
          tx = db.transaction(STORE, mode);
        } catch (err) {
          reject(err instanceof Error ? err : new Error("voice outbox transaction failed"));
          return;
        }
        let request: IDBRequest<T>;
        try {
          request = run(tx.objectStore(STORE));
        } catch (err) {
          reject(err instanceof Error ? err : new Error("voice outbox request threw"));
          return;
        }
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("voice outbox request failed"));
        tx.onabort = () => reject(tx.error ?? new Error("voice outbox transaction aborted"));
      }),
  );
}

/** Every queued note, OLDEST FIRST — the order they must be uploaded in. */
export async function allVoiceNotes(): Promise<VoiceNoteRecord[]> {
  const rows = await readRequest<VoiceNoteRecord[]>("readonly", (store) =>
    store.index("createdAt").getAll() as IDBRequest<VoiceNoteRecord[]>,
  );
  // The index gives createdAt order; `id` breaks any tie so the sweep order
  // is identical on every device and every reload.
  return rows.slice().sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function getVoiceNote(id: string): Promise<VoiceNoteRecord | undefined> {
  return readRequest<VoiceNoteRecord | undefined>("readonly", (store) =>
    store.get(id) as IDBRequest<VoiceNoteRecord | undefined>,
  );
}

export async function deleteVoiceNote(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, "readwrite");
    } catch (err) {
      reject(err instanceof Error ? err : new Error("voice outbox transaction failed"));
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("voice outbox delete aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("voice outbox delete failed"));
    try {
      tx.objectStore(STORE).delete(id);
    } catch (err) {
      reject(err instanceof Error ? err : new Error("voice outbox delete threw"));
    }
  });
}

/** Test seam only: drop the cached handle so a fresh database can be opened. */
export function resetVoiceOutboxDb(): void {
  dbPromise = null;
}
