import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { gatewayStateRoot } from "./multi-user-paths.js";

/**
 * Persists grammY's long-polling offset per bot across gateway restarts.
 *
 * Why this exists:
 * grammY's `bot.start()` tracks the update offset in memory only
 * (`lastTriedUpdateId`). On any crash or restart, the in-memory counter
 * resets and grammY calls `getUpdates` without an offset. Telegram then
 * re-delivers every still-pending update — including ones we had already
 * processed. Observed symptom: "yes" from the owner was re-delivered 20x in
 * 14 minutes across crash-loops after an empty-ctx.reply triggered repeated
 * restarts.
 *
 * Fix:
 *  1. After each update, persist `update.update_id` to disk (per bot).
 *  2. On startup, load the stored offset and confirm it with Telegram by
 *     calling `getUpdates({ offset: stored+1, limit: 1, timeout: 0 })`
 *     before `bot.start()`. Telegram uses the offset to mark all earlier
 *     updates as acknowledged and stops re-delivering them.
 *
 * Storage format (`<state root>/polling-offset.json`, i.e.
 * `~/ai/state/polling-offset.json` unless AHI_GATEWAY_STATE_DIR moves it):
 *   { "michael": 12345, "zali": 12346, ... }
 */

// Read-modify-write of one shared file: two gateways sharing it would stomp
// each other's offsets and hand Telegram a stale acknowledgement, which is
// precisely the re-delivery storm this module exists to prevent. Moves with
// the state root.
const OFFSET_FILE = resolve(gatewayStateRoot(), "polling-offset.json");

type OffsetStore = Record<string, number>;

function readStore(): OffsetStore {
  if (!existsSync(OFFSET_FILE)) return {};
  try {
    const raw = readFileSync(OFFSET_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as OffsetStore;
    return {};
  } catch (err) {
    console.warn(`[polling-offset] Failed to read ${OFFSET_FILE}:`, err);
    return {};
  }
}

function writeStore(store: OffsetStore): void {
  try {
    mkdirSync(dirname(OFFSET_FILE), { recursive: true });
    writeFileSync(OFFSET_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.warn(`[polling-offset] Failed to write ${OFFSET_FILE}:`, err);
  }
}

/**
 * Return the last-saved offset for a bot, or 0 if none.
 */
export function loadOffset(botName: string): number {
  const store = readStore();
  return store[botName] ?? 0;
}

/**
 * Persist the offset for a bot. Called after each successfully-dispatched
 * update. Disk is written synchronously; volume is low (a handful of
 * updates/minute max) so fsync overhead is negligible.
 */
export function saveOffset(botName: string, updateId: number): void {
  const store = readStore();
  const existing = store[botName] ?? 0;
  // Updates within a batch arrive in ascending order, but defend against
  // any out-of-order replay — never move the offset backwards.
  if (updateId <= existing) return;
  store[botName] = updateId;
  writeStore(store);
}
