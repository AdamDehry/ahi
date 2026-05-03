/**
 * Cold-start backlog drain policy.
 *
 * Why this exists:
 * On 2026-04-24 ~15:11 EDT, the gateway was offline long enough for
 * Telegram to accumulate a multi-hour backlog of updates. When the
 * gateway came back up, it tried to process ALL of them in parallel
 * (one invokeAgent per pending update per bot) and blew through the operator's
 * entire 5-hour usage window.
 *
 * Policy:
 *   - On startup, per bot, peek at Telegram's pending updates.
 *   - If the oldest pending update is older than STALE_THRESHOLD_MS,
 *     DRAIN the whole queue without processing (just ACK via offset bump)
 *     and send the affected user ONE summary message.
 *   - The user then explicitly says "CONTINUE" (or any fresh message) to
 *     resume. We don't try to replay — replaying stale state is worse
 *     than losing it.
 *
 * Implementation note:
 *   This uses Telegram's `getUpdates` API directly — calling it with
 *   a high offset confirms all earlier updates, which is the standard
 *   Telegram-side "ACK and drop" mechanism.
 */

import type { Bot } from "grammy";
import { loadOffset, saveOffset } from "./polling-offset.js";

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export interface DrainResult {
  drained: boolean;
  count: number;
  oldestAgeMs: number;
  newestUpdateId: number;
  notifiedChatIds: number[];
}

type PendingUpdate = { update_id: number; message?: { chat: { id: number }; date: number } };

/**
 * Peek at Telegram's pending updates for a bot. Does NOT consume them
 * (timeout=0). Returns up to 100 updates from the earliest unconfirmed one.
 *
 * Gotcha fixed 2026-04-24:
 *   The prior version used `offset: -1` which (per Telegram Bot API)
 *   returns ONLY THE LAST update — not "all updates up to 100". That meant
 *   any backlog older than the newest update was invisible to the drain
 *   check. If the newest update happened to be fresh (< 10min) while a
 *   large older backlog sat behind it, drain would return `drained: false`
 *   and the normal polling loop would then flood-process the whole backlog
 *   in parallel. That's exactly what happened in the second swarm incident.
 *
 * Correct approach:
 *   Use the persisted offset+1 (or no offset at all, which Telegram treats
 *   as "from the last confirmed one"). This returns the earliest unseen
 *   updates, limited by `limit`. If the returned count equals the limit,
 *   the real backlog may be larger — we flag that so drain treats it as
 *   a stale-drain-eligible condition even if timestamp scan is incomplete.
 *
 * IMPORTANT: Calling getUpdates here DOES advance Telegram's internal
 * delivery cursor once we later call it with a higher offset (that's how
 * drain works). But calling it without an offset does NOT confirm the
 * returned updates by itself — Telegram only confirms when a *later*
 * offset is sent. So this peek is safe; grammY can still redeliver them
 * to the polling loop if we decide not to drain.
 */
async function peekPending(bot: Bot, botName: string): Promise<{ updates: PendingUpdate[]; truncated: boolean }> {
  try {
    const stored = loadOffset(botName);
    const limit = 100;
    const updates = (await bot.api.getUpdates({
      // Use stored offset + 1 when we have one; otherwise let Telegram
      // return from the start of its retained window.
      offset: stored > 0 ? stored + 1 : 0,
      limit,
      timeout: 0,
    })) as unknown as PendingUpdate[];
    return { updates, truncated: updates.length >= limit };
  } catch (err) {
    console.warn(`[backlog-drain] ${botName}: peek failed: ${(err as Error).message}`);
    return { updates: [], truncated: false };
  }
}

/**
 * Check + drain the pending backlog for a single bot on startup.
 * Returns whether a drain happened and the set of chat IDs notified.
 */
export async function drainStaleBacklog(
  bot: Bot,
  botName: string,
): Promise<DrainResult> {
  console.log(`[backlog-drain] ${botName}: START — peeking for pending backlog`);
  const { updates: pending, truncated } = await peekPending(bot, botName);

  if (pending.length === 0) {
    console.log(`[backlog-drain] ${botName}: no pending — skip`);
    return { drained: false, count: 0, oldestAgeMs: 0, newestUpdateId: 0, notifiedChatIds: [] };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const datedUpdates = pending.filter((u) => u.message?.date);
  const oldestDate = datedUpdates.length > 0
    ? Math.min(...datedUpdates.map((u) => u.message!.date))
    : nowSec;
  const oldestAgeMs = (nowSec - oldestDate) * 1000;

  const newestUpdateId = Math.max(...pending.map((u) => u.update_id));

  console.log(
    `[backlog-drain] ${botName}: peek found ${pending.length} pending${truncated ? " (TRUNCATED at limit — real backlog larger)" : ""}, ` +
    `oldest ${Math.round(oldestAgeMs / 1000)}s, newest update_id=${newestUpdateId}`,
  );

  // Drain triggers on EITHER a stale oldest message OR a truncated peek
  // (which means >=100 pending — by definition a swarm-risk). Truncation
  // is a strong enough signal on its own because we can't trust the age
  // scan when we only see the first window.
  const shouldDrain = oldestAgeMs >= STALE_THRESHOLD_MS || truncated;

  if (!shouldDrain) {
    console.log(
      `[backlog-drain] ${botName}: ${pending.length} pending, oldest ${Math.round(oldestAgeMs / 1000)}s — under threshold, normal polling will handle`,
    );
    return {
      drained: false,
      count: pending.length,
      oldestAgeMs,
      newestUpdateId,
      notifiedChatIds: [],
    };
  }

  // Stale backlog — DRAIN.
  const reason = truncated && oldestAgeMs < STALE_THRESHOLD_MS
    ? `truncated peek (>=100 pending)`
    : `stale (oldest ${Math.round(oldestAgeMs / 60000)}min)`;
  console.warn(
    `[backlog-drain] ${botName}: DRAINING ${pending.length} updates — reason=${reason} — will notify affected users`,
  );

  // Confirm the entire backlog to Telegram by calling getUpdates with
  // offset = newest + 1. Telegram stops re-delivering everything up to
  // (and including) newest.
  try {
    await bot.api.getUpdates({
      offset: newestUpdateId + 1,
      limit: 1,
      timeout: 0,
    });
    saveOffset(botName, newestUpdateId);
  } catch (err) {
    console.error(
      `[backlog-drain] ${botName}: failed to confirm drain offset ${newestUpdateId}:`,
      (err as Error).message,
    );
    return {
      drained: false,
      count: pending.length,
      oldestAgeMs,
      newestUpdateId,
      notifiedChatIds: [],
    };
  }

  // Notify each affected chat ONCE (dedupe by chat id).
  const chatCounts = new Map<number, number>();
  for (const u of pending) {
    if (u.message?.chat?.id) {
      chatCounts.set(u.message.chat.id, (chatCounts.get(u.message.chat.id) ?? 0) + 1);
    }
  }

  const downtimeMin = Math.round(oldestAgeMs / 60000);
  const notifiedChatIds: number[] = [];
  for (const [chatId, count] of chatCounts) {
    try {
      await bot.api.sendMessage(
        chatId,
        `I was down for about ${downtimeMin} min and missed ${count} message${count === 1 ? "" : "s"} from you. I'm skipping the backlog — send me a fresh message and I'll pick up from there.`,
      );
      notifiedChatIds.push(chatId);
    } catch (err) {
      console.warn(
        `[backlog-drain] ${botName}: failed to notify chat ${chatId}:`,
        (err as Error).message,
      );
    }
  }

  console.warn(
    `[backlog-drain] ${botName}: DRAINED. ACK'd offset=${newestUpdateId}, notified ${notifiedChatIds.length}/${chatCounts.size} chats`,
  );

  return {
    drained: true,
    count: pending.length,
    oldestAgeMs,
    newestUpdateId,
    notifiedChatIds,
  };
}
