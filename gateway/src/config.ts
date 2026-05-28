import { config as loadEnv } from "dotenv";
import { resolve } from "path";
import { homedir } from "os";
import { VOICE_STYLES } from "./voice-styles.js";

loadEnv({ path: resolve(import.meta.dirname, "../.env") });

export type TTSProvider = "openai" | "google" | "chirp" | "gemini";

export interface BotConfig {
  name: string;
  token: string;
  model: string;
  voice: string;          // OpenAI voice name (cedar, nova, fable, ...)
  ttsProvider: TTSProvider;
  googleVoice: string;    // Chirp 3 HD voice (same name pool as Gemini)
  geminiVoice: string;    // Gemini voice (Charon, Orus, Leda, Fenrir, Puck, ...)
  styleInstructions: string;  // Gemini style prompt (empty if none configured)
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
   * Maps Telegram user IDs to friendly identifiers ("user", "partner", ...).
   * Used to tag inbound messages so multi-user bots (e.g. Miriam) can reliably
   * distinguish between the people they serve without parsing content.
   *
   * Populated from `USER_TELEGRAM_ID` in .env, plus optional additional
   * mappings via `EXTRA_TELEGRAM_IDS` (comma-separated `id:label` pairs,
   * e.g. `EXTRA_TELEGRAM_IDS=123456789:partner,987654321:assistant`).
   */
  userIdentityMap: Record<number, string>;
  /** Friendly name of the primary user, from AHI_USER_NAME (default "the user"). */
  userName: string;
}

export function loadConfig(): GatewayConfig {
  const bots: BotConfig[] = [];

  // Voice name defaults per agent (used for both Chirp 3 HD and Gemini — same name pool)
  const voiceDefaults: Record<string, string> = {
    michael: "Charon",        // deep, authoritative (locked)
    eliyahu: "Zubenelgenubi", // South African-tinged warmth on pure-English (locked)
    miriam: "Aoede",          // warm, level, Sephardic/Israeli Hebrew (locked)
    tzali: "Iapetus",         // level builder register, age and geological patience (locked)
    avi: "Puck",              // Gemini default if switched (not in use — Avi stays on OpenAI fable)
  };

  function makeBotConfig(
    name: string,
    tokenEnvKey: string,
    modelDefault: string,
    openaiVoiceDefault: string
  ): BotConfig | null {
    const token = process.env[tokenEnvKey];
    if (!token) return null;
    const PREFIX = name.toUpperCase();
    return {
      name,
      token,
      model: process.env[`${PREFIX}_MODEL`] || modelDefault,
      voice: process.env[`${PREFIX}_VOICE`] || openaiVoiceDefault,
      ttsProvider: (process.env[`${PREFIX}_TTS_PROVIDER`] || "openai") as TTSProvider,
      googleVoice: process.env[`${PREFIX}_GOOGLE_VOICE`] || voiceDefaults[name] || "Charon",
      geminiVoice: process.env[`${PREFIX}_GEMINI_VOICE`] || voiceDefaults[name] || "Charon",
      styleInstructions: VOICE_STYLES[name] || "",
    };
  }

  // Michael — coordinator / strategist
  const michael = makeBotConfig("michael", "MICHAEL_BOT_TOKEN", "sonnet", "cedar");
  if (michael) bots.push(michael);

  // Eliyahu
  const eliyahu = makeBotConfig("eliyahu", "ELIYAHU_BOT_TOKEN", "haiku", "cedar");
  if (eliyahu) bots.push(eliyahu);

  // Miriam
  const miriam = makeBotConfig("miriam", "MIRIAM_BOT_TOKEN", "haiku", "nova");
  if (miriam) bots.push(miriam);

  // Tzali — builder / engineer
  const tzali = makeBotConfig("tzali", "TZALI_BOT_TOKEN", "opus", "cedar");
  if (tzali) bots.push(tzali);

  // Avi — designer / visual conscience
  const avi = makeBotConfig("avi", "AVI_BOT_TOKEN", "opus", "fable");
  if (avi) bots.push(avi);

  if (bots.length === 0) {
    throw new Error("No bot tokens configured. Set at least one *_BOT_TOKEN in .env");
  }

  // Build Telegram user-ID → friendly identifier map from env.
  // Silently skips any entry whose env value is missing or not a number.
  const userIdentityMap: Record<number, string> = {};
  const userLabel = (process.env.AHI_USER_LABEL || "user").toLowerCase();
  const primaryRaw = process.env.USER_TELEGRAM_ID;
  if (primaryRaw) {
    const parsed = parseInt(primaryRaw, 10);
    if (!Number.isNaN(parsed)) userIdentityMap[parsed] = userLabel;
  }
  // Optional extras: "id:label,id:label,..."
  const extras = process.env.EXTRA_TELEGRAM_IDS;
  if (extras) {
    for (const pair of extras.split(",")) {
      const [idStr, label] = pair.split(":").map(s => s?.trim());
      if (!idStr || !label) continue;
      const parsed = parseInt(idStr, 10);
      if (!Number.isNaN(parsed)) userIdentityMap[parsed] = label.toLowerCase();
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
    sessionDir: process.env.CLAUDE_SESSION_DIR || resolve(process.env.AHI_HOME || resolve(homedir(), "ahi"), "state"),
    userIdentityMap,
    userName: process.env.AHI_USER_NAME || "the user",
  };
}
