import { ownerUserId } from "./users.js";
import { config as loadEnv } from "dotenv";
import { resolve } from "path";
import { gatewayStateRoot } from "./multi-user-paths.js";
import { VOICE_STYLES } from "./voice-styles.js";
import { normalizeClaudeModel } from "./claude-models.js";
import { normalizeEffort } from "./claude-effort.js";
import { aliasLegacyAgentEnv } from "./agent-rename.js";

loadEnv({ path: resolve(import.meta.dirname, "../.env") });

export type TTSProvider = "openai" | "google" | "chirp" | "gemini" | "elevenlabs" | "cartesia";

/**
 * STT provider used INSIDE voice mode (the live turn loop), as distinct from
 * one-shot voice-note transcription in voice-in.ts.
 *
 *   cartesia — ink-2 over the auto turn-detection socket. 0.6–1.4s with
 *              model-driven end-of-thought; the default, because latency is
 *              the whole point of voice mode.
 *   openai   — the simulator's batch path with a synthesised live preview.
 *   google   — the incumbent streaming recognizer in stt.ts. Also the
 *              automatic runtime fallback when the configured provider fails
 *              to start, so a bad key degrades voice mode instead of
 *              killing it.
 */
export type VoiceSttProvider = "cartesia" | "openai" | "google";

/**
 * Voice mode is the same Michael as chat: same model, same
 * prompt assembly, same memory, same voice. The July rule that put voice on
 * Sonnet regardless of the text model is retired — a call that answers on a
 * different model is a different inference of the agent, and that is exactly
 * what made voice mode feel like somebody else.
 *
 * So there is no voice model DEFAULT any more: an empty `voiceModeModel`
 * means "whatever chat uses right now", resolved per turn by `voiceModelFor`,
 * so a model change in the dashboard reaches the next call too. An explicit
 * override is still possible (env `{AGENT}_VOICE_MODE_MODEL_OVERRIDE`, or the
 * saved `voiceModeModel` setting) for a deliberate experiment.
 *
 * The OLD env names (`{AGENT}_VOICE_MODE_MODEL`, `VOICE_MODE_MODEL`) are
 * deliberately no longer read: they encode the superseded ruling, and a stale
 * value left in an .env would silently keep calls on the old model.
 */
export function voiceModelFor(bot: Pick<BotConfig, "model" | "voiceModeModel">): string {
  return bot.voiceModeModel || bot.model;
}

/**
 * Effort for voice-mode turns. Chat runs at the CLI's configured effort
 * (xhigh on this box); a spoken reply is one to three sentences and the
 * listener is waiting in silence, so voice takes the lowest effort that keeps
 * the answer right. Measured choice — see the build report.
 */
export const VOICE_MODE_EFFORT_DEFAULT = "low";



/**
 * ElevenLabs per-agent voice config (Step 6 — michael's v3 experiment).
 * Style prompts do NOT apply here: v3 is directed by inline audio tags
 * ([dry], [pause], ...) that the agent authors in its own spoken text.
 * On any ElevenLabs failure the TTS layer falls back to fallbackProvider
 * so a voice reply always goes out.
 */
export interface ElevenConfig {
  voiceName: string;         // Saved-voice name to resolve via GET /v1/voices
  voiceId?: string;          // Direct voice_id override — skips the lookup
  model: string;             // e.g. "eleven_v3"
  fallbackProvider: TTSProvider;
}

/**
 * Cartesia Sonic per-agent voice config (Voice Mode Phase 1).
 *
 * SOURCE OF TRUTH: this lives on BotConfig and is threaded to the TTS layer
 * exactly like ElevenLabs. Env (`MICHAEL_CARTESIA_VOICE_ID`, global
 * `CARTESIA_VOICE_ID`) is the BOOTSTRAP DEFAULT only; whatever the dashboard
 * persisted in bot-settings.json is applied on top by applySavedSettings and
 * wins. The TTS layer never reads Cartesia env directly, so there is no path
 * where the UI shows one voice while another is actually serving.
 *
 * Style prompts do NOT apply here — Sonic takes the text as written.
 * Language is pinned to a single code per voice: Benedict is an English
 * voice, and Hebrew gets its own localized voice_id in a later ticket. Stray
 * Hebrew words inside an English line should be transliterated to Latin
 * upstream so Benedict says them in-voice.
 */
export interface CartesiaConfig {
  voiceName: string;         // Display/pick name shown in the dashboard ("Benedict")
  voiceId: string;           // Cartesia voice UUID (no name lookup — ids only)
  model: string;             // e.g. "sonic-3.5"
  language: string;          // BCP-47-ish short code Cartesia expects ("en")
  sampleRate: number;        // Raw PCM sample rate requested from the API
  speed: string;             // "slowest" | "slow" | "normal" | "fast" | "fastest"
  fallbackProvider: TTSProvider;
}

/**
 * Cartesia voice catalog — display name → voice_id. The dashboard picker and
 * the TTS layer both read this one map, so a name shown in the UI and the id
 * sent to Cartesia can never drift apart.
 *
 * English voices only. Hebrew is a separate localized voice_id (later ticket).
 */
export const CARTESIA_VOICE_IDS: Record<string, string> = {
  Benedict: "3c0f09d6-e0d7-499c-a594-70c5b7b93048",
};

const CARTESIA_DEFAULT_VOICE_NAME = "Benedict";
const CARTESIA_DEFAULT_VOICE_ID = CARTESIA_VOICE_IDS[CARTESIA_DEFAULT_VOICE_NAME];

/**
 * Resolve an agent's Cartesia config from env.
 * Precedence: `{AGENT}_CARTESIA_X` → `CARTESIA_X` → built-in default.
 */
export function loadCartesiaConfig(agentName: string): CartesiaConfig {
  const PREFIX = (agentName || "").toUpperCase();
  const pick = (key: string, fallback: string): string =>
    (PREFIX ? process.env[`${PREFIX}_CARTESIA_${key}`] : undefined) ||
    process.env[`CARTESIA_${key}`] ||
    fallback;

  const sampleRate = parseInt(pick("SAMPLE_RATE", "44100"), 10);

  const voiceName = pick("VOICE_NAME", CARTESIA_DEFAULT_VOICE_NAME);

  return {
    voiceName,
    // An explicit id override wins; otherwise the name resolves through the
    // catalog, falling back to Benedict if the name is unknown.
    voiceId: pick("VOICE_ID", CARTESIA_VOICE_IDS[voiceName] || CARTESIA_DEFAULT_VOICE_ID),
    model: pick("MODEL", "sonic-3.5"),
    language: pick("LANGUAGE", "en"),
    sampleRate: Number.isFinite(sampleRate) ? sampleRate : 44100,
    speed: pick("SPEED", "normal"),
    // If Cartesia is down or out of credits, voice replies fall back rather
    // than vanishing — same fail-soft contract as ElevenLabs.
    fallbackProvider: pick("FALLBACK_PROVIDER", "openai") as TTSProvider,
  };
}

export interface BotConfig {
  name: string;
  token: string;
  model: string;
  voice: string;          // OpenAI voice name (cedar, nova, fable, ...)
  ttsProvider: TTSProvider;
  voiceSttProvider: VoiceSttProvider;  // STT inside voice mode (default ink-2)
  /**
   * Is voice mode available for this agent at all?
   *
   * DEFAULT OFF. The merge lands dark: until the owner's device gate passes
   * (barge-in with open speakers on the S25, plus an ear pass) the composer
   * behaves exactly as it did before voice mode existed, and the server
   * refuses to open a voice session. Flip it per-agent from the dashboard.
   */
  voiceModeEnabled: boolean;
  /**
   * Explicit model OVERRIDE for turns inside voice mode. Empty (the default)
   * means the chat model — see `voiceModelFor`. Voice used to default to
   * Sonnet regardless of the text model; that rule is retired.
   */
  voiceModeModel: string;
  /** Effort for voice-mode turns (`--effort`). See VOICE_MODE_EFFORT_DEFAULT. */
  voiceModeEffort: string;
  googleVoice: string;    // Chirp 3 HD voice (same name pool as Gemini)
  geminiVoice: string;    // Gemini voice (Charon, Orus, Leda, Fenrir, Puck, ...)
  styleInstructions: string;  // Gemini style prompt (empty if none configured)
  eleven: ElevenConfig;
  cartesia: CartesiaConfig;
}

export interface GatewayConfig {
  bots: BotConfig[];
  port: number;
  mode: "polling" | "webhook";
  webhookUrl?: string;
  openaiApiKey?: string;
  googleTtsApiKey?: string;
  geminiApiKey?: string;
  sessionDir: string;
  /**
   * Maps Telegram user IDs to friendly identifiers ("owner", "family", ...).
   * Currently used to tag inbound Miriam messages so she can reliably
   * distinguish between the people she serves without parsing content.
   * Populated from OWNER_TELEGRAM_ID in .env.
   */
  userIdentityMap: Record<number, string>;
}

export function loadConfig(): GatewayConfig {
  aliasLegacyAgentEnv();
  const bots: BotConfig[] = [];

  // Voice name defaults per agent (used for both Chirp 3 HD and Gemini — same name pool)
  const voiceDefaults: Record<string, string> = {
    michael: "Charon",        // deep, authoritative (locked)
    miriam: "Aoede",          // warm, level, Sephardic/Israeli Hebrew (locked)
    zali: "Iapetus",         // level builder register, age and geological patience (locked)
    avi: "Puck",              // Gemini default if switched (not in use — Avi stays on OpenAI fable)
  };

  function makeBotConfig(
    name: string,
    tokenEnvKey: string,
    modelDefault: string,
    openaiVoiceDefault: string
  ): BotConfig | null {
    // Every agent is present in the app. A Telegram token only adds the phone chat for that agent;
    // AGENT_ENABLED=false (e.g. ZALI_ENABLED=false) turns an agent off.
    const token = process.env[tokenEnvKey] ?? "";
    if (process.env[`${name.toUpperCase()}_ENABLED`] === "false") return null;
    const PREFIX = name.toUpperCase();
    return {
      name,
      token,
      model: normalizeClaudeModel(process.env[`${PREFIX}_MODEL`] || modelDefault),
      voice: process.env[`${PREFIX}_VOICE`] || openaiVoiceDefault,
      ttsProvider: (process.env[`${PREFIX}_TTS_PROVIDER`] || "openai") as TTSProvider,
      // ink-2 by default — see VoiceSttProvider. Per-agent override first,
      // then a global switch, so the whole fleet can be moved off Cartesia
      // with one env var if the credit burn proves too hot.
      voiceSttProvider: (process.env[`${PREFIX}_VOICE_STT_PROVIDER`] ||
        process.env.VOICE_STT_PROVIDER ||
        "cartesia") as VoiceSttProvider,
      // Opt-IN only: anything other than an explicit "true" leaves it off, so
      // a missing or malformed value can never accidentally enable voice.
      voiceModeEnabled:
        (process.env[`${PREFIX}_VOICE_MODE_ENABLED`] ?? process.env.VOICE_MODE_ENABLED) === "true",
      voiceModeModel: process.env[`${PREFIX}_VOICE_MODE_MODEL_OVERRIDE`] || "",
      voiceModeEffort:
        normalizeEffort(process.env[`${PREFIX}_VOICE_MODE_EFFORT`] || process.env.VOICE_MODE_EFFORT) ??
        VOICE_MODE_EFFORT_DEFAULT,
      googleVoice: process.env[`${PREFIX}_GOOGLE_VOICE`] || voiceDefaults[name] || "Charon",
      geminiVoice: process.env[`${PREFIX}_GEMINI_VOICE`] || voiceDefaults[name] || "Charon",
      styleInstructions: VOICE_STYLES[name] || "",
      eleven: {
        voiceName: process.env[`${PREFIX}_ELEVEN_VOICE_NAME`] || "Daniel",
        voiceId: process.env[`${PREFIX}_ELEVEN_VOICE_ID`] || undefined,
        // Notes on eleven_v4_turbo: half the credits of eleven_v4.
        model: process.env[`${PREFIX}_ELEVEN_MODEL`] || "eleven_v4_turbo",
        // If ElevenLabs is down/out of quota, voice replies fall back to the
        // agent's pre-eleven provider (michael today: openai/cedar).
        fallbackProvider: (process.env[`${PREFIX}_ELEVEN_FALLBACK_PROVIDER`] || "openai") as TTSProvider,
      },
      // Bootstrap default from env; applySavedSettings may override it with
      // whatever the dashboard persisted.
      cartesia: loadCartesiaConfig(name),
    };
  }

  // Michael — always present
  const michael = makeBotConfig("michael", "MICHAEL_BOT_TOKEN", "claude-sonnet-5", "cedar");
  if (michael) bots.push(michael);

  // Miriam
  const miriam = makeBotConfig("miriam", "MIRIAM_BOT_TOKEN", "claude-haiku-4-5", "nova");
  if (miriam) bots.push(miriam);

  // Zali
  const zali = makeBotConfig("zali", "ZALI_BOT_TOKEN", "claude-opus-5-5","cedar");
  if (zali) bots.push(zali);

  // Avi
  const avi = makeBotConfig("avi", "AVI_BOT_TOKEN", "claude-opus-5-5","fable");
  if (avi) bots.push(avi);

  if (bots.length === 0) {
    throw new Error("Every agent is turned off. Remove MICHAEL_ENABLED=false from your settings.");
  }

  // Build Telegram user-ID → friendly identifier map from env.
  // Silently skips any entry whose env value is missing or not a number.
  const userIdentityMap: Record<number, string> = {};
  const identityEntries: Array<[string, string]> = [
    ["OWNER_TELEGRAM_ID", ownerUserId()],
  ];
  for (const [envKey, friendly] of identityEntries) {
    const raw = process.env[envKey];
    if (!raw) continue;
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed)) {
      userIdentityMap[parsed] = friendly;
    }
  }

  return {
    bots,
    port: parseInt(process.env.GATEWAY_PORT || "18789", 10),
    mode: (process.env.GATEWAY_MODE || "polling") as "polling" | "webhook",
    webhookUrl: process.env.WEBHOOK_URL,
    openaiApiKey: process.env.OPENAI_API_KEY,
    googleTtsApiKey: process.env.GOOGLE_TTS_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY,
    // AHI_GATEWAY_STATE_DIR is checked BEFORE CLAUDE_SESSION_DIR on purpose.
    // An isolated instance reuses production's .env (it needs the same tokens
    // and API keys), and that file pins CLAUDE_SESSION_DIR at the production
    // state root — so if CLAUDE_SESSION_DIR won, sessions.json would still be
    // written into production and the two SessionMaps would clobber each
    // other's Claude session ids. The isolation switch is the more specific
    // intent, so it wins wherever it is explicitly set. Unset: unchanged, and
    // gatewayStateRoot() is then exactly the old resolve(homedir(),"ai/state").
    sessionDir:
      process.env.AHI_GATEWAY_STATE_DIR || process.env.CLAUDE_SESSION_DIR || gatewayStateRoot(),
    userIdentityMap,
  };
}
