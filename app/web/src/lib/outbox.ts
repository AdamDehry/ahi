import { sendMessage } from "./api";
import { actions, getState } from "../store";

/**
 * Outbox flush engine — the only place send I/O happens.
 *
 * Lifecycle per entry (created by actions.enqueueSend):
 *   POST ok        → sendDelivered (bubble stays pending until WS echo)
 *   server reject  → sendRejected  (bubble → failed, tap-to-retry)
 *   network error  → stays queued; retried with backoff and flushed
 *                    again on WS reconnect / browser 'online'
 *
 * In-flight guard prevents double-POSTs when flush triggers overlap
 * (send + reconnect + online can all fire close together).
 */
const inFlight = new Set<string>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 2_000;
const RETRY_MAX = 30_000;

export function flushOutbox(): void {
  const { outbox } = getState();
  for (const entry of outbox) {
    if (inFlight.has(entry.localId)) continue;
    inFlight.add(entry.localId);
    sendMessage(entry.bot, entry.text, entry.localId, entry.attachmentIds, entry.answers)
      .then((result) => {
        if (result.ok) {
          retryDelay = 2_000; // network is healthy again
          actions.sendDelivered(entry.localId);
        } else if (result.kind === "rejected") {
          actions.sendRejected(entry.localId);
        } else {
          scheduleRetry(); // network — keep queued, try again later
        }
      })
      .finally(() => inFlight.delete(entry.localId));
  }
}

function scheduleRetry(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX);
    flushOutbox();
  }, retryDelay);
}

/** Wire the browser-level flush triggers once (App calls this on mount). */
export function initOutboxTriggers(): () => void {
  const onOnline = () => flushOutbox();
  window.addEventListener("online", onOnline);
  return () => window.removeEventListener("online", onOnline);
}
