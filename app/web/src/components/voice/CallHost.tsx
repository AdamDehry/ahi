import { actions, useAppState } from "../../store";
import VoiceLayer from "./VoiceLayer";

/**
 * Where the live call lives (call-minimize-pill).
 *
 * Mounted ONCE by the app shell — desktop and phone — outside every view,
 * screen and overlay. Before this the call screen was a child of the chat
 * composer: leaving the thread, opening Vault, or even opening a past call's
 * transcript unmounted it, and the composer's own cleanup closed the mic. A
 * call the owner could not step away from is the whole complaint.
 *
 * The store says whether there is a call and whether it is minimized; this
 * mounts the screen for as long as there is one. `VoiceLayer` keeps owning
 * the call's state (`useVoiceLayer`) and simply shows one of two faces —
 * the full screen or the pill — so minimizing changes NOTHING underneath:
 * same hook instance, same socket, same mic, same timer.
 *
 * `key` on the bot: a call for a different agent is a different call. The
 * old screen unmounts (its cleanup ends that call) before the new one starts.
 *
 * Same gate as the composer had: an agent without voice mode never mounts
 * the screen, so with the flag off nothing here renders or subscribes.
 */
export default function CallHost() {
  const { call, voiceBots, elevenBots } = useAppState();
  if (!call || !voiceBots.includes(call.bot)) return null;
  return (
    <VoiceLayer
      key={call.bot}
      bot={call.bot}
      viaEleven={elevenBots.includes(call.bot)}
      minimized={call.minimized}
      onMinimize={actions.minimizeCall}
      onRestore={actions.restoreCall}
      onExit={actions.leaveCall}
    />
  );
}
