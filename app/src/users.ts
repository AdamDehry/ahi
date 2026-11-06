import { readFileSync, existsSync } from "fs";
import { canonicalAgentId } from "./agent-rename.js";
import { resolve } from "path";

/**
 * Multi-user token registry.
 *
 * Replaces the single DASHBOARD_TOKEN model. Every incoming dashboard /
 * PWA / WebSocket connection is authenticated by a token lookup against
 * this registry; the resolved UserConfig is then attached to the request
 * so downstream handlers can scope visibility and storage per user.
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
  /** IANA timezone for per-turn local context (e.g. "America/New_York"). */
  timezone: string;
  /** Human-readable location label for per-turn context (e.g. "Austin, TX"). */
  locationLabel: string;
  /** Agents this user is allowed to see / address. */
  agents: string[];
  /**
   * Admin flag — gates the "everything" experience (Costs tab, Settings
   * tab, canonical ~/ai/mission-control, cross-user visibility). Non-admin
   * users get the scoped experience (per-user clipboard, files, mission
   * control). Defaults to false when omitted.
   */
  admin: boolean;
  /** Jewish calendar in the agents' time context (Hebrew date, Shabbat, holidays). Off unless chosen. */
  jewishCalendar: boolean;
}

/**
 * Raw JSON shape on disk — `userId` is derived, not stored, so users.json
 * stays minimal and maintainable.
 */
interface UserConfigRaw {
  token: string;
  name: string;
  telegramChatId: number | null;
  timezone?: string;
  locationLabel?: string;
  agents: string[];
  admin?: boolean;
  jewishCalendar?: boolean;
}

let users: UserConfig[] | null = null;

function usersPath(): string {
  // AHI_USERS_FILE points an isolated instance or a test sandbox at its own
  // registry. Unset in production, where this is exactly the old literal.
  const override = process.env.AHI_USERS_FILE;
  return override ? resolve(override) : resolve(import.meta.dirname, "../config/users.json");
}

/**
 * Load and validate the user registry. Loud-fails at startup if the file
 * is missing or malformed — no silent fallback to an empty list. Downstream
 * auth must have a concrete allow-list.
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
    if (entry.timezone != null && (typeof entry.timezone !== "string" || !entry.timezone.trim())) {
      throw new Error(`[users] Entry ${entry.name}: timezone must be a non-empty IANA timezone string`);
    }
    if (entry.locationLabel != null && (typeof entry.locationLabel !== "string" || !entry.locationLabel.trim())) {
      throw new Error(`[users] Entry ${entry.name}: locationLabel must be a non-empty string`);
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
      timezone: entry.timezone?.trim() ?? "America/New_York",
      locationLabel: entry.locationLabel?.trim() ?? "",
      agents: [...new Set(entry.agents.map(canonicalAgentId))],
      admin: entry.admin === true,
      jewishCalendar: entry.jewishCalendar === true,
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

/**
 * The workspace owner's user id: AHI_OWNER_ID if set, else the first admin in users.json, else "owner".
 * (A user id is the lowercased name, so the owner's id is whatever name setup gave them.)
 */
export function ownerUserId(): string {
  const env = process.env.AHI_OWNER_ID?.trim().toLowerCase();
  if (env) return env;
  try {
    return loadUsers().find((u) => u.admin)?.userId ?? "owner";
  } catch {
    return "owner";
  }
}
