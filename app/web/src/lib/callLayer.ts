import { useCallback, useState } from "react";
import { useVoiceLayer, type VoiceLayerApi } from "./voicelayer";
import { useElevenLayer } from "./elevencall";

/**
 * Which pipeline carries this call. Native unless the gateway's session named
 * the agent in `elevenBots` (VOICE_CALL_ROLLBACK=elevenlabs since voice step 3; CallHost reads
 * it and passes `viaEleven`) — and native
 * again, for the rest of this call, the moment the ElevenLabs side cannot
 * start it. Both hooks are always mounted (hooks cannot be conditional); only
 * the active one does anything, so a native call is exactly today's.
 */
export function useCallLayer(bot: string, viaEleven = false): VoiceLayerApi & { transport: "elevenlabs" | "native" } {
  const [fellBack, setFellBack] = useState(false);
  const eleven = !fellBack && viaEleven;
  const onFallback = useCallback((reason: string) => {
    console.warn(`[eleven] falling back to the native call (${reason})`);
    setFellBack(true);
  }, []);
  const el = useElevenLayer(bot, eleven, onFallback);
  const native = useVoiceLayer(bot, !eleven);
  return eleven ? { ...el, transport: "elevenlabs" } : { ...native, transport: "native" };
}
