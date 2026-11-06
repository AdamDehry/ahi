import type { ConnectionStatus } from "./ws";

/**
 * The header's connection chip (ONLINE / RESTARTING / RECONNECTING / OFFLINE).
 *
 * A planned restart (systemd SIGTERM) is announced by the gateway before it
 * closes the socket — a `restarting` frame, then close code 1012 ("service
 * restart"). From then until the socket is back the chip says RESTARTING with
 * an amber dot; if it isn't back within 90 s, the normal RECONNECTING /
 * OFFLINE logic takes over. Unplanned drops never see RESTARTING.
 */
export const RESTART_GRACE_MS = 90_000;

export type ConnectionDot = ConnectionStatus | "restarting";

export function connectionDisplay(
  connection: ConnectionStatus,
  restartingAt: number | null,
  now: number = Date.now(),
): { label: string; dot: ConnectionDot } {
  if (connection === "open") return { label: "ONLINE", dot: "open" };
  if (restartingAt !== null && now - restartingAt < RESTART_GRACE_MS) return { label: "RESTARTING", dot: "restarting" };
  return connection === "connecting" ? { label: "RECONNECTING", dot: "connecting" } : { label: "OFFLINE", dot: "closed" };
}
