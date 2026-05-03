import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

/**
 * User registry — single-user shell defaults to one "primary" user, but the
 * multi-slot shape is preserved so a future multi-user setup can drop in
 * extra entries without restructuring callers.
 *
 * File format: JSON array of UserConfig objects, stored at
 * `<gateway>/config/users.json`. That file is gitignored (secrets).
 * A sanitized template lives at `config/users.example.json`.
 */
export interface UserConfig {
  /** Opaque bearer token — the only credential required for auth. */
  token: string;
  /** Human-readable display name. */
  name: string;
  /** Canonical internal id — lowercased `name`. Storage keys use this. */
  userId: string;
  /** Telegram chat id, if any. Used for inbound attribution. */
  telegramChatId: number | null;
  /** Agents this user is allowed to see / address. */
  agents: string[];
  /**
   * Admin flag — gates the "everything" experience (Costs tab, Settings
   * tab, cross-user visibility). Non-admin users get a scoped experience.
   * Defaults to false when omitted.
   */
  admin: boolean;
}

interface UserConfigRaw {
  token: string;
  name: string;
  telegramChatId: number | null;
  agents: string[];
  admin?: boolean;
}

let users: UserConfig[] | null = null;

function usersPath(): string {
  return resolve(import.meta.dirname, "../config/users.json");
}

/**
 * Load and validate the user registry. Loud-fails at startup if the file
 * is missing or malformed — no silent fallback to an empty list.
 */
export function loadUsers(): UserConfig[] {
  if (users) return users;
  const path = usersPath();
  if (!existsSync(path)) {
    throw new Error(
      `[users] Missing config/users.json at ${path}. ` +
        `Copy config/users.example.json and fill in tokens + telegram ids.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(
      `[users] Failed to parse config/users.json: ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(raw)) {
    throw new Error(`[users] config/users.json must be a JSON array`);
  }
  const parsed: UserConfig[] = [];
  const seenTokens = new Set<string>();
  const seenNames = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as Partial<UserConfigRaw>;
    if (!entry || typeof entry !== "object") {
      throw new Error(`[users] Entry ${i} is not an object`);
    }
    if (typeof entry.token !== "string" || entry.token.length < 16) {
      throw new Error(`[users] Entry ${i} (${entry.name ?? "?"}): token missing or too short`);
    }
    if (typeof entry.name !== "string" || !entry.name.trim()) {
      throw new Error(`[users] Entry ${i}: name missing`);
    }
    if (!Array.isArray(entry.agents) || entry.agents.some((a) => typeof a !== "string")) {
      throw new Error(`[users] Entry ${entry.name}: agents must be an array of strings`);
    }
    if (entry.telegramChatId != null && typeof entry.telegramChatId !== "number") {
      throw new Error(`[users] Entry ${entry.name}: telegramChatId must be number or null`);
    }
    if (seenTokens.has(entry.token)) {
      throw new Error(`[users] Duplicate token in users.json (entry ${entry.name})`);
    }
    const userId = entry.name.trim().toLowerCase();
    if (seenNames.has(userId)) {
      throw new Error(`[users] Duplicate user name "${entry.name}"`);
    }
    seenTokens.add(entry.token);
    seenNames.add(userId);
    parsed.push({
      token: entry.token,
      name: entry.name.trim(),
      userId,
      telegramChatId: entry.telegramChatId ?? null,
      agents: entry.agents,
      admin: entry.admin === true,
    });
  }
  users = parsed;
  const summary = parsed
    .map((u) => `${u.name}(${u.agents.join(",")})`)
    .join(" | ");
  console.log(`[users] loaded ${parsed.length} users: ${summary}`);
  return users;
}

export function lookupByToken(token: string | undefined | null): UserConfig | null {
  if (!token) return null;
  const list = loadUsers();
  return list.find((u) => u.token === token) ?? null;
}

export function lookupByChatId(chatId: number | undefined | null): UserConfig | null {
  if (chatId == null) return null;
  const list = loadUsers();
  return list.find((u) => u.telegramChatId === chatId) ?? null;
}

export function lookupByUserId(userId: string | undefined | null): UserConfig | null {
  if (!userId) return null;
  const list = loadUsers();
  return list.find((u) => u.userId === userId) ?? null;
}

/** Resolve a chatId to a display name. Returns "unknown" if no match. */
export function resolveSenderName(chatId: number | undefined | null): string {
  return lookupByChatId(chatId)?.name ?? "unknown";
}

/** Resolve a chatId to a userId. Returns null if no match. */
export function resolveUserId(chatId: number | undefined | null): string | null {
  return lookupByChatId(chatId)?.userId ?? null;
}

/** Check whether a user is allowed to access a given agent. */
export function userCanAccessAgent(user: UserConfig, agent: string): boolean {
  return user.agents.includes(agent);
}

/**
 * Public view of a user — safe to send over the wire (no token).
 * Used by the dashboard/PWA to render only the agents this user may see.
 */
export interface UserPublic {
  name: string;
  userId: string;
  agents: string[];
  admin: boolean;
}

export function toPublic(user: UserConfig): UserPublic {
  return { name: user.name, userId: user.userId, agents: user.agents, admin: user.admin };
}
