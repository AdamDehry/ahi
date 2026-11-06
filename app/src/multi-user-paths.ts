import { AI_ROOT } from "./ai-root.js";
import { accessSync, constants, existsSync, mkdirSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

export interface MultiUserDataPaths {
  userId: string;
  businessRoot: string;
  sessionsDir: string;
  sessionsIndex: string;
  messageThreadsDir: string;
  filesRoot: string;
  filesDir: (conversationId?: string) => string;
  mediaRoot: string;
  mediaDir: (timeline?: string) => string;
  agentsJson: string;
  clipboardJson: string;
  legacy: {
    appSessionsIndex: string;
    userAppRoot: string;
    operatorSessionsIndex: string;
    clipboardJson: string;
    clipboardUserJson: string;
    messagesRoot: string;
    messageThreadsDir: string;
    uploadsRoot: string;
    uploadsUserDir: string;
    photosRoot: string;
  };
}

/**
 * On-disk roots, and the two env vars that move them.
 *
 * Why these are functions instead of `resolve(homedir(), ...)` inline:
 * a second gateway can legitimately run beside the production one — an
 * isolated build for a live end-to-end test (see the ISOLATED INSTANCE
 * block in .env.example). Sharing these roots is not merely untidy, it
 * LOSES DATA: every mutable file under them is read-modify-whole-file-
 * rewritten — message threads through the in-memory threadCache in
 * message-store.ts, sessions.json through SessionMap, polling-offset.json,
 * bot-settings.json, gateway_degraded.json. Two writers means the second
 * one's rewrite silently drops everything the first wrote since it last
 * read the file.
 *
 * Read at call time, so a caller that needs a module-level constant simply
 * calls at module scope (config.ts loads .env before any other module body
 * runs, so values set there are visible too).
 *
 * Both vars are unset in production, where each expression collapses to
 * exactly the literal it replaced: ~/ai/state and ~/business.
 */

/** Root of the gateway's own mutable state — `~/ai/state` by default. */
export function gatewayStateRoot(): string {
  const override = process.env.AHI_GATEWAY_STATE_DIR;
  return override ? resolve(override) : resolve(AI_ROOT, "state");
}

/** Root of per-user business data — threads, media, files. `~/business` by default. */
export function gatewayBusinessRoot(): string {
  const override = process.env.AHI_GATEWAY_BUSINESS_DIR;
  return override ? resolve(override) : resolve(homedir(), "business");
}

/**
 * Root of the AHI sessions corpus — `~/ai/infra/sessions` by default.
 *
 * MC-03: this is the single env-override gate that the sessions-move contract
 * must flip. Every corpus consumer (retrieval.ts, shaar-shoresh.ts, the vector
 * and passage layers, clusters, facts, dashboard) derives its paths from here
 * rather than hard-coding homedir().
 *
 * LOUD FAILURE CONTRACT: when AHI_SESSIONS_ROOT is explicitly set but the
 * directory does not exist or is not readable, we throw immediately rather than
 * silently falling back to the legacy path. A silent fallback would make a
 * misconfigured migration look successful while reading the old corpus — exactly
 * the failure mode MC-03 is designed to prevent.
 *
 * Legacy behaviour (AHI_SESSIONS_ROOT unset): resolves to the same path as
 * resolve(AI_ROOT, "infra/sessions") — byte-identical to the old constant.
 */
export function ahiSessionsRoot(): string {
  const override = process.env.AHI_SESSIONS_ROOT;
  if (override) {
    const resolved = resolve(override);
    if (!existsSync(resolved)) {
      throw new Error(
        `[multi-user-paths] AHI_SESSIONS_ROOT is set to "${override}" but the directory does not exist. ` +
        `Refusing to fall back to the legacy path — a misconfigured override must be loud, not silent.`,
      );
    }
    try {
      accessSync(resolved, constants.R_OK);
    } catch {
      throw new Error(
        `[multi-user-paths] AHI_SESSIONS_ROOT is set to "${override}" but the directory is not readable. ` +
        `Refusing to fall back to the legacy path.`,
      );
    }
    return resolved;
  }
  return resolve(AI_ROOT, "infra/sessions");
}

const warnKeys = new Set<string>();

export function warnDeprecatedPath(key: string, legacyPath: string, canonicalPath: string): void {
  if (warnKeys.has(key)) return;
  warnKeys.add(key);
  console.warn(
    `[multi-user-paths] deprecated legacy path in use: ${legacyPath} -> canonical ${canonicalPath}`,
  );
}

export function safeSegment(value: string | undefined | null, fallback: string): string {
  const raw = (value ?? "").trim().toLowerCase();
  const safe = raw.replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return safe || fallback;
}

export function timelineDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function multiUserPaths(userId: string): MultiUserDataPaths {
  const safeUserId = safeSegment(userId, "unknown");
  const businessRoot = resolve(gatewayBusinessRoot(), safeUserId);
  const sessionsDir = join(businessRoot, "sessions");
  const filesRoot = join(businessRoot, "files");
  const mediaRoot = join(businessRoot, "media");
  return {
    userId: safeUserId,
    businessRoot,
    sessionsDir,
    sessionsIndex: join(sessionsDir, "index.json"),
    messageThreadsDir: join(sessionsDir, "messages"),
    filesRoot,
    filesDir: (conversationId = "general") => join(filesRoot, safeSegment(conversationId, "general")),
    mediaRoot,
    mediaDir: (timeline = timelineDay()) => join(mediaRoot, safeSegment(timeline, timelineDay())),
    agentsJson: join(businessRoot, "agents.json"),
    clipboardJson: join(businessRoot, "clipboard.json"),
    legacy: {
      userAppRoot: resolve(gatewayBusinessRoot(), safeUserId, "app"),
      appSessionsIndex: resolve(gatewayBusinessRoot(), safeUserId, "app", "sessions", "index.json"),
      // ~/ai/sessions — a different root, and read-only legacy: not moved.
      operatorSessionsIndex: resolve(AI_ROOT, "sessions", "index.json"),
      clipboardJson: resolve(gatewayStateRoot(), "clipboard.json"),
      clipboardUserJson: resolve(gatewayStateRoot(), "clipboard", `${safeUserId}.json`),
      messagesRoot: resolve(gatewayStateRoot(), "messages"),
      messageThreadsDir: resolve(gatewayStateRoot(), "messages"),
      uploadsRoot: resolve(gatewayStateRoot(), "uploads"),
      uploadsUserDir: resolve(gatewayStateRoot(), "uploads", safeUserId),
      photosRoot: resolve(gatewayStateRoot(), "photos"),
    },
  };
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function atomicWriteFile(path: string, data: string | Buffer, mode?: number): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
  renameSync(tmp, path);
}

export function atomicWriteJson(path: string, value: unknown): void {
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
