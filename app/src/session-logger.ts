import { AI_ROOT } from "./ai-root.js";
import { ownerUserId } from "./users.js";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { atomicWriteJson, multiUserPaths, warnDeprecatedPath } from "./multi-user-paths.js";

export interface SessionLogEntry {
  session_id: string;
  agent: string;
  channel: "telegram" | "claude-code" | "api";
  telegram_chat_id: number | null;
  telegram_user: string | null;
  started_at: string;
  episode_name: string | null;
  category: string | null;
  transcript_path: string;
  transcript_path_md?: string;
}

const AHI_INDEX_PATH = multiUserPaths(ownerUserId()).sessionsIndex;
const LEGACY_AHI_INDEX_PATH = resolve(AI_ROOT, "sessions/index.json");

// Claude Code project dir for gateway-invoked sessions
// (Claude Code names a project's folder after its working directory, every non-alphanumeric as "-".)
const GATEWAY_PROJECT_DIR = resolve(homedir(), ".claude/projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"));

export function transcriptPath(sessionId: string): string {
  return resolve(GATEWAY_PROJECT_DIR, `${sessionId}.jsonl`);
}

export function logSession(entry: SessionLogEntry, indexPath = AHI_INDEX_PATH): void {
  try {
    let sessions: SessionLogEntry[] = [];
    const legacyPath = indexPath === AHI_INDEX_PATH ? LEGACY_AHI_INDEX_PATH : null;
    const readPath = existsSync(indexPath) ? indexPath : legacyPath && existsSync(legacyPath) ? legacyPath : indexPath;
    if (readPath !== indexPath) warnDeprecatedPath(`sessions:${entry.agent}:${readPath}`, readPath, indexPath);
    if (existsSync(readPath)) {
      const raw = readFileSync(readPath, "utf-8").trim();
      if (raw && raw !== "[]") {
        sessions = JSON.parse(raw) as SessionLogEntry[];
      }
    }

    // Skip duplicate session IDs (e.g. resumed session logged again)
    if (sessions.some((s) => s.session_id === entry.session_id)) {
      return;
    }

    sessions.push(entry);
    atomicWriteJson(indexPath, sessions);
    console.log(`[session-logger] Logged: ${entry.session_id} (${entry.agent}, ${entry.telegram_user ?? "unknown"})`);
  } catch (err) {
    console.error(`[session-logger] Failed to log session ${entry.session_id}:`, err);
  }
}
