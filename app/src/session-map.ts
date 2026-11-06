import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";

/* ── App-only principals (B6) ───────────────────────────────────
   A session is keyed `bot:chatId`. A user with a Telegram id uses it (all
   live users do — their keys are unchanged). A user WITHOUT one used chat id
   0, so every app-only principal resumed the same `bot:0` model session and
   could see another's earlier turns. Each now gets a stable id of their own,
   derived from their userId, in a band no Telegram id can occupy: Telegram
   ids have at most 52 significant bits, so anything at or past -(2^52) is
   ours. The voice-call band (voice/session-scope.ts) sits far below it. */
const APP_PRINCIPAL_BASE = 2 ** 52;

/** The stable chat id an app-only principal's conversations run under. */
export function appPrincipalChatId(userId: string): number {
  const key = `app-principal:${userId}`;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return -(APP_PRINCIPAL_BASE + 1 + hash);
}

/** Is this chat id an app principal's (never a Telegram chat)? */
export function isAppPrincipalChatId(chatId: number): boolean {
  return Number.isInteger(chatId) && chatId <= -(APP_PRINCIPAL_BASE + 1);
}

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
    // Create the state dir if it isn't there yet. On the production root it
    // always is, so this is a no-op — but a FRESH state root (an isolated
    // instance, a new machine) has no directory, and the first save threw
    // ENOENT and took the whole first turn down with it. Caught by the
    // synthetic voice e2e: turn one died, turn two worked only because an
    // unrelated logger had since created the directory.
    mkdirSync(dirname(this.filePath), { recursive: true });
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

  /** Get the most recently active session for a bot (any Telegram chatId — never an app principal's) */
  getLatest(botName: string): SessionEntry | undefined {
    let latest: SessionEntry | undefined;
    for (const entry of Object.values(this.store)) {
      if (entry.botName === botName && !isAppPrincipalChatId(entry.chatId)) {
        if (!latest || entry.lastActive > latest.lastActive) {
          latest = entry;
        }
      }
    }
    return latest;
  }
}
