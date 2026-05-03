import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { homedir } from "os";
import type { BotConfig, TTSProvider } from "./config.js";

interface SettingsOverride {
  model?: string;
  voice?: string;
  ttsProvider?: TTSProvider;
  googleVoice?: string;
  geminiVoice?: string;
}

type SettingsStore = Record<string, SettingsOverride>;
type OverrideField = keyof SettingsOverride;

function settingsFile(): string {
  const root = process.env.AHI_HOME || resolve(homedir(), "ahi");
  return resolve(root, "state", "bot-settings.json");
}

function load(): SettingsStore {
  const file = settingsFile();
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, "utf-8"));
    } catch {}
  }
  return {};
}

function save(store: SettingsStore): void {
  const file = settingsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(store, null, 2));
}

/** Apply saved overrides to bot configs at startup */
export function applySavedSettings(bots: BotConfig[]): void {
  const store = load();
  for (const bot of bots) {
    const overrides = store[bot.name];
    if (overrides) {
      if (overrides.model) bot.model = overrides.model;
      if (overrides.voice) bot.voice = overrides.voice;
      if (overrides.ttsProvider) bot.ttsProvider = overrides.ttsProvider;
      if (overrides.googleVoice) bot.googleVoice = overrides.googleVoice;
      if (overrides.geminiVoice) bot.geminiVoice = overrides.geminiVoice;
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
