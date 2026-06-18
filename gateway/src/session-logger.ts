import { readFileSync, existsSync } from "fs";
import { spawn } from "child_process";
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

const AHI_INDEX_PATH = multiUserPaths("primary").sessionsIndex;
const LEGACY_AHI_INDEX_PATH = resolve(process.env.AHI_HOME || resolve(homedir(), "ahi"), "infra/sessions/index.json");

// Claude Code project dir for gateway-invoked sessions.
// Claude Code derives this folder name from the absolute cwd by replacing
// path separators with dashes (e.g. `/Users/jane/ahi/gateway` becomes
// `-Users-jane-ahi-gateway`). We compute it at runtime from $AHI_HOME so
// the gateway works on any user's machine without install-time templating.
function deriveGatewayProjectDir(): string {
  if (process.env.GATEWAY_CLAUDE_PROJECT_DIR) {
    return resolve(homedir(), process.env.GATEWAY_CLAUDE_PROJECT_DIR);
  }
  const ahiHome = process.env.AHI_HOME || resolve(homedir(), "ahi");
  const gatewayCwd = resolve(ahiHome, "gateway");
  // Replace every path separator (including the leading slash) with a dash.
  const slug = gatewayCwd.replace(/[\\/]/g, "-");
  return resolve(homedir(), ".claude/projects", slug);
}

const GATEWAY_PROJECT_DIR = deriveGatewayProjectDir();

function scheduleSessionBrainBuild(sessionId: string, jsonlPath: string): void {
  if (process.env.AHI_BRAIN_AUTO_BUILD === "false") return;
  const ahiHome = process.env.AHI_HOME || resolve(homedir(), "ahi");
  const script = resolve(ahiHome, "infra/sessions/scripts/process-session.mjs");
  if (!existsSync(script)) return;
  const args = [script, "--session-id", sessionId, "--jsonl", jsonlPath, "--quiet"];
  const child = spawn(process.execPath, args, {
    cwd: ahiHome,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, AHI_HOME: ahiHome },
  });
  child.unref();
}


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
    scheduleSessionBrainBuild(entry.session_id, entry.transcript_path);
  } catch (err) {
    console.error(`[session-logger] Failed to log session ${entry.session_id}:`, err);
  }
}
