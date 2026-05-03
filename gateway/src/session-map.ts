import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

interface SessionEntry {
  chatId: number;
  claudeSessionId?: string;
  botName: string;
  lastActive: string;
}

type SessionStore = Record<string, SessionEntry>;

export class SessionMap {
  private store: SessionStore = {};
  private filePath: string;

  constructor(sessionDir: string) {
    this.filePath = resolve(sessionDir, "sessions.json");
    this.load();
  }

  private load(): void {
    if (existsSync(this.filePath)) {
      this.store = JSON.parse(readFileSync(this.filePath, "utf-8"));
    }
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.store, null, 2));
  }

  private key(chatId: number, botName: string): string {
    return `${botName}:${chatId}`;
  }

  get(chatId: number, botName: string): SessionEntry | undefined {
    return this.store[this.key(chatId, botName)];
  }

  set(chatId: number, botName: string, claudeSessionId?: string): void {
    this.store[this.key(chatId, botName)] = {
      chatId,
      claudeSessionId,
      botName,
      lastActive: new Date().toISOString(),
    };
    this.save();
  }

  delete(chatId: number, botName: string): void {
    delete this.store[this.key(chatId, botName)];
    this.save();
  }

  touch(chatId: number, botName: string): void {
    const entry = this.get(chatId, botName);
    if (entry) {
      entry.lastActive = new Date().toISOString();
      this.save();
    }
  }

  /** Get the most recently active session for a bot (any chatId) */
  getLatest(botName: string): SessionEntry | undefined {
    let latest: SessionEntry | undefined;
    for (const entry of Object.values(this.store)) {
      if (entry.botName === botName) {
        if (!latest || entry.lastActive > latest.lastActive) {
          latest = entry;
        }
      }
    }
    return latest;
  }
}
