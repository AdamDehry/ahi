/**
 * Phone leg — production wiring. The only file in src/phone/ that knows the
 * gateway's bots, users and call core; everything else takes them as
 * injected deps (and is tested that way).
 *
 * Dark unless PHONE_ENABLED=true. Env (all optional except the flag):
 *   PHONE_PUBLIC_URL        where Twilio reaches us (default AHI_APP_URL)
 *   PHONE_BOT / PHONE_USER  who answers / whose line it is (michael / owner)
 *   PHONE_RING_SEC          outbound ring time before giving up (20 — under voicemail)
 *   PHONE_MAX_OUTBOUND_PER_DAY (10)
 *   PHONE_PASSPHRASE_FILE   (state dir phone/passphrase.json)
 *   PHONE_STREAM_SIGNATURE  require (default) | log-only — the stream handshake's Twilio signature
 *   PHONE_REATTACH          on (default) | off — a broken media stream re-attaches to the same call
 *                           (Twilio <Redirect>) instead of hanging up; off = the old TwiML
 *   PHONE_MAX_CALL_MIN      a hard cap on call length in minutes (default 0 = none, voice step 2)
 *   PHONE_IDLE_MIN          silence before Michael asks "still with me?" (default 15)
 *   TWILIO_ENV_FILE         optional settings file for the Twilio values (unset = environment only)
 *
 * installPhone() never throws: if it cannot start it logs loudly and the
 * gateway boots without it (the routes then 404).
 */
import { APP_URL } from "../app-url.js";
import { ownerUserId } from "../users.js";
import { join } from "node:path";
import type { Hono } from "hono";
import { openCall } from "../websocket.js";
import { lookupByUserId } from "../users.js";
import { gatewayStateRoot } from "../multi-user-paths.js";
import type { BotInstance } from "../telegram.js";
import { callTtsProviderFor, fillerSampleRate, renderFillerPcm, type CallTtsProvider } from "../voice/call-tts.js";
import { readPassphrase } from "./passphrase.js";
import { registerPhoneRoutes, type PhoneInstall } from "./index.js";
import { loadTwilioCreds } from "./twilio.js";

export function phonePassphraseFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.PHONE_PASSPHRASE_FILE || join(gatewayStateRoot(), "phone", "passphrase.json");
}

export function installPhone(app: Hono<any>, instances: BotInstance[]): PhoneInstall | null {
  try {
    if (!/^(1|true|on|yes)$/i.test(process.env.PHONE_ENABLED ?? "")) {
      console.log("[phone] line off (PHONE_ENABLED is not set)");
      return null;
    }
    const creds = loadTwilioCreds();
    if (!creds) {
      console.warn("[phone] PHONE_ENABLED, but the Twilio settings did not load — the line stays off");
      return null;
    }
    const bot = process.env.PHONE_BOT || "michael";
    const instance = instances.find((i) => i.config.name === bot);
    if (!instance) {
      console.warn(`[phone] no bot named ${bot} — the line stays off`);
      return null;
    }
    const userId = process.env.PHONE_USER || ownerUserId();
    const publicUrl = process.env.PHONE_PUBLIC_URL || APP_URL;
    const passphraseFile = phonePassphraseFile();
    const ring = Number(process.env.PHONE_RING_SEC);
    const maxDay = Number(process.env.PHONE_MAX_OUTBOUND_PER_DAY);
    const maxCallMin = Number(process.env.PHONE_MAX_CALL_MIN);
    const idleMin = Number(process.env.PHONE_IDLE_MIN);
    const reattach = !/^(0|false|off|no)$/i.test(process.env.PHONE_REATTACH ?? "");

    const renderIn = async (provider: CallTtsProvider, text: string) => ({
      pcm: await renderFillerPcm(instance.config, provider, text),
      sampleRate: fillerSampleRate(instance.config, provider),
    });

    const phone = registerPhoneRoutes(app, {
      creds,
      publicUrl,
      bot,
      user: () => lookupByUserId(userId),
      openCall,
      // A line of the phone's own (greeting, passphrase prompts), in the call's voice.
      say: async (text) => {
        const provider = callTtsProviderFor(instance.config);
        try {
          return await renderIn(provider, text);
        } catch (err) {
          if (provider === "cartesia") throw err;
          console.warn(`[phone] ${provider} could not say a line (${(err as Error).message}) — Cartesia instead`);
          return renderIn("cartesia", text);
        }
      },
      passphraseFile,
      serviceToken: () => process.env.REVIEW_DESK_TOKEN,
      ...(Number.isFinite(ring) && ring >= 5 ? { ringSec: ring } : {}),
      ...(Number.isFinite(maxDay) && maxDay >= 0 ? { maxOutboundPerDay: maxDay } : {}),
      streamSignature: process.env.PHONE_STREAM_SIGNATURE === "log-only" ? "log-only" : "require",
      reattach,
      streamOptions: {
        ...(Number.isFinite(maxCallMin) && maxCallMin > 0 ? { maxCallMs: maxCallMin * 60_000 } : {}),
        ...(Number.isFinite(idleMin) && idleMin >= 1 ? { idleMs: idleMin * 60_000 } : {}),
        ...(reattach ? {} : { reattachWindowMs: 0 }),
      },
    });
    console.log(
      `[phone] line up — ${bot} answers for ${userId} · webhook ${publicUrl}/api/phone/voice · ` +
        `passphrase ${readPassphrase(passphraseFile) ? "set" : "NOT SET (inbound calls refused until it is)"} · ` +
        `broken stream ${reattach ? "re-attaches" : "hangs up (PHONE_REATTACH=off)"} · ` +
        `Michael-calls-the owner ${process.env.REVIEW_DESK_TOKEN ? "on" : "OFF (no REVIEW_DESK_TOKEN)"}`,
    );
    return phone;
  } catch (err) {
    console.error("[phone] FAILED to start — gateway continues without it:", err);
    return null;
  }
}
