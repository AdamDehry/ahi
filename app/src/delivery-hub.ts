/* ============================================================
   delivery-hub.ts — MAT RELAY CP2 / P0 (delivery correctness)

   A pure, socket-agnostic per-user queue of UNACKED outbound
   deliveries with TTL + dedupe-by-key. websocket.ts owns the
   actual sockets and the send loop; this module only tracks
   *what still needs to reach a given user* so it can be replayed
   when a socket (re)connects or comes back to the foreground.

   Why this exists:
     Before CP2, a `voice-tts` payload was sent once to the exact
     WebSocket captured at voice-start. If the PWA backgrounded and
     that socket closed during the multi-second TTS window, the
     audio was silently dropped and never recovered — the user was
     left with a stuck text-only reply. The hub decouples delivery
     identity from any single socket: enqueue once, deliver to any
     current socket for the user, and replay on reconnect until the
     client ACKs (or the entry expires).

   Durability note: this is an IN-MEMORY, best-effort recovery
   layer for the live-delivery window only. The message store on
   disk remains the durable source of truth — older history is
   always recoverable via the normal history/`/ui/messages` reads.
   ============================================================ */

import { randomUUID } from "crypto";

export type DeliveryKind = "message" | "voice-tts";

export interface Delivery {
  deliveryId: string;
  userId: string;
  kind: DeliveryKind;
  /** Exact JSON object to (re)send. Already carries `deliveryId`. */
  payload: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
  /** Optional dedupe key — re-enqueuing the same key supersedes the prior. */
  key?: string;
}

/**
 * TTLs per kind. `message` deliveries only need to bridge a brief
 * reconnect (history covers anything older), so a short window is
 * enough. `voice-tts` carries base64 audio and needs to survive a
 * background→foreground bounce, so it lives a little longer; the
 * canonical voice-media upsert is the long-term recovery beyond it.
 */
const DEFAULT_TTL_MS: Record<DeliveryKind, number> = {
  message: 90_000,
  "voice-tts": 180_000,
};

/** Safety cap so a user that never ACKs can't grow the queue without bound. */
const MAX_PER_USER = 200;

class DeliveryHub {
  private byUser = new Map<string, Map<string, Delivery>>();

  /**
   * Enqueue a delivery for `userId` and return it (its `payload`
   * already includes the assigned `deliveryId`). If `opts.key` is
   * given, any existing unacked delivery with the same key is
   * dropped first so updates supersede rather than stack.
   */
  enqueue(
    userId: string,
    kind: DeliveryKind,
    payload: Record<string, unknown>,
    opts?: { ttlMs?: number; key?: string },
  ): Delivery {
    const now = Date.now();
    const deliveryId = `dlv-${now.toString(36)}-${randomUUID().slice(0, 8)}`;
    const delivery: Delivery = {
      deliveryId,
      userId,
      kind,
      payload: { ...payload, deliveryId },
      createdAt: now,
      expiresAt: now + (opts?.ttlMs ?? DEFAULT_TTL_MS[kind]),
      key: opts?.key,
    };

    let queue = this.byUser.get(userId);
    if (!queue) {
      queue = new Map();
      this.byUser.set(userId, queue);
    }

    if (opts?.key) {
      for (const [id, existing] of queue) {
        if (existing.key === opts.key) queue.delete(id);
      }
    }

    queue.set(deliveryId, delivery);

    if (queue.size > MAX_PER_USER) {
      const overflow = [...queue.values()].sort((a, b) => a.createdAt - b.createdAt);
      const drop = queue.size - MAX_PER_USER;
      for (let i = 0; i < drop; i++) queue.delete(overflow[i].deliveryId);
    }

    return delivery;
  }

  /** Remove a delivery once the client confirms it applied/played it. */
  ack(userId: string, deliveryId: string): boolean {
    const queue = this.byUser.get(userId);
    if (!queue) return false;
    const removed = queue.delete(deliveryId);
    if (queue.size === 0) this.byUser.delete(userId);
    return removed;
  }

  /**
   * Unacked, non-expired deliveries for a user, oldest-first.
   * Expired entries are swept lazily on read.
   */
  pending(userId: string): Delivery[] {
    const queue = this.byUser.get(userId);
    if (!queue) return [];
    const now = Date.now();
    const out: Delivery[] = [];
    for (const [id, d] of queue) {
      if (d.expiresAt <= now) {
        queue.delete(id);
        continue;
      }
      out.push(d);
    }
    if (queue.size === 0) this.byUser.delete(userId);
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }

  /** Drop all expired entries across every user (periodic sweep). */
  sweep(): void {
    const now = Date.now();
    for (const [userId, queue] of this.byUser) {
      for (const [id, d] of queue) {
        if (d.expiresAt <= now) queue.delete(id);
      }
      if (queue.size === 0) this.byUser.delete(userId);
    }
  }
}

export const deliveryHub = new DeliveryHub();
