import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import type { BotConfig, TTSProvider } from "./config.js";
import { CARTESIA_VOICE_IDS } from "./config.js";
import { gatewayStateRoot } from "./multi-user-paths.js";
import { normalizeClaudeModel } from "./claude-models.js";

interface SettingsOverride {
  model?: string;
  voice?: string;
  ttsProvider?: TTSProvider;
  googleVoice?: string;
  geminiVoice?: string;
  elevenVoiceName?: string;
  cartesiaVoiceName?: string;
  /** Voice mode on/off for this agent. Absent = leave the env default. */
  voiceModeEnabled?: boolean;
  /** Explicit voice-mode model override. Absent = the chat model (one Michael). */
  voiceModeModel?: string;
}

type SettingsStore = Record<string, SettingsOverride>;
type OverrideField = keyof SettingsOverride;

// This file is the dashboard's source of truth and is rewritten whole on
// every setting change, so a second gateway sharing it would silently push
// its own test settings into production's next boot. Moves with the state root.
const SETTINGS_FILE = resolve(gatewayStateRoot(), "bot-settings.json");

function load(): SettingsStore {
  if (existsSync(SETTINGS_FILE)) {
    try {
      return JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    } catch {}
  }
  return {};
}

function save(store: SettingsStore): void {
  mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(store, null, 2));
}

/** Apply saved overrides to bot configs at startup */
export function applySavedSettings(bots: BotConfig[]): void {
  const store = load();
  for (const bot of bots) {
    const overrides = store[bot.name];
    if (overrides) {
      // Explicit boolean, NOT a truthy check — `false` is the value that
      // matters here and a truthy test would silently discard it.
      if (typeof overrides.voiceModeEnabled === "boolean") {
        bot.voiceModeEnabled = overrides.voiceModeEnabled;
      }
      if (overrides.model) bot.model = normalizeClaudeModel(overrides.model);
      if (overrides.voiceModeModel) bot.voiceModeModel = overrides.voiceModeModel;
      if (overrides.voice) bot.voice = overrides.voice;
      if (overrides.ttsProvider) bot.ttsProvider = overrides.ttsProvider;
      if (overrides.googleVoice) bot.googleVoice = overrides.googleVoice;
      if (overrides.geminiVoice) bot.geminiVoice = overrides.geminiVoice;
      if (overrides.elevenVoiceName) {
        // A saved name different from the env-configured one invalidates
        // the env-pinned voice_id — the name lookup resolves it instead.
        if (overrides.elevenVoiceName !== bot.eleven.voiceName) {
          bot.eleven.voiceId = undefined;
        }
        bot.eleven.voiceName = overrides.elevenVoiceName;
      }
      if (overrides.cartesiaVoiceName) {
        // Name is the picked value; the id always follows from the catalog so
        // the dashboard's label and the id sent to Cartesia cannot drift.
        const id = CARTESIA_VOICE_IDS[overrides.cartesiaVoiceName];
        if (id) {
          bot.cartesia.voiceName = overrides.cartesiaVoiceName;
          bot.cartesia.voiceId = id;
        } else {
          console.warn(
            `[settings] unknown Cartesia voice "${overrides.cartesiaVoiceName}" for ${bot.name} — keeping "${bot.cartesia.voiceName}"`,
          );
        }
      }

      // No silent disagreement: if a saved provider overrode the env flag,
      // say so at boot. The saved value is the control — env is bootstrap.
      const envProvider = process.env[`${bot.name.toUpperCase()}_TTS_PROVIDER`];
      if (overrides.ttsProvider && envProvider && envProvider !== overrides.ttsProvider) {
        console.warn(
          `[settings] ${bot.name}: dashboard setting "${overrides.ttsProvider}" overrides ` +
            `${bot.name.toUpperCase()}_TTS_PROVIDER="${envProvider}" (env is bootstrap default only)`,
        );
      }
    }
  }
}

/** Persist a setting change */
export function saveBotSetting(botName: string, field: OverrideField, value: string): void {
  const store = load();
  if (!store[botName]) store[botName] = {};
  (store[botName] as Record<string, string>)[field] = value;
  save(store);
}
