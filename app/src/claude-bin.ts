import { execFile } from "child_process";
import { realpathSync, statSync } from "fs";
import { delimiter, isAbsolute, join } from "path";

/**
 * Oldest claude CLI that can drive every model in CLAUDE_MODEL_OPTIONS.
 * Measured: the API rejects Opus 5.5 below 2.1.280 and Fable 5.1
 * below 2.1.251 (400 "Claude Code X does not support this model"). A bare
 * `claude` on PATH can be an older global npm install,
 * so the Settings picker would save a model every spawn then fails on. Pin
 * AHI_CLAUDE_BIN to the native install instead.
 */
export const MIN_CLAUDE_CLI_VERSION = "2.1.280";

/** The binary every gateway `claude -p` spawn uses. */
export function resolveClaudeBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.AHI_CLAUDE_BIN || "claude";
}

const JS_ENTRY = /\.[cm]?js$/i;

/**
 * How to start the claude CLI. A native binary runs directly; an npm install whose entry point is a
 * JavaScript file (what AHI Setup installs on some systems) runs through this server's own Node, which
 * works on Windows too, where a .js file or an npm .cmd shim cannot be spawned without a shell.
 */
export function claudeCommand(env: NodeJS.ProcessEnv = process.env): { command: string; prefix: string[] } {
  const bin = resolveClaudeBin(env);
  return JS_ENTRY.test(bin) ? { command: process.execPath, prefix: [bin] } : { command: bin, prefix: [] };
}

/** Absolute path a command resolves to (PATH lookup for bare names), or null. */
export function whichOnPath(cmd: string, pathVar: string = process.env.PATH ?? ""): string | null {
  const candidates = cmd.includes("/") || isAbsolute(cmd) ? [cmd] : pathVar.split(delimiter).filter(Boolean).map((dir) => join(dir, cmd));
  for (const candidate of candidates) {
    try {
      const st = statSync(candidate);
      // Windows has no exec bit; a JavaScript entry point runs through Node, so it only has to exist.
      if (st.isFile() && (process.platform === "win32" || JS_ENTRY.test(candidate) || (st.mode & 0o111) !== 0)) return candidate;
    } catch {}
  }
  return null;
}

export function parseClaudeVersion(output: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Numeric semver-core comparison: <0 if a<b, 0 if equal, >0 if a>b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function runVersion(bin: string): Promise<string> {
  const [command, args] = JS_ENTRY.test(bin) ? [process.execPath, [bin, "--version"]] : [bin, ["--version"]];
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { timeout: 10_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolvePromise(stdout.trim());
    });
  });
}

/**
 * Log which claude binary the gateway will spawn, and its version, so a stale
 * CLI is visible at boot instead of surfacing as failed turns. Never throws.
 */
export async function logClaudeBinAtStartup(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const bin = resolveClaudeBin(env);
  const source = env.AHI_CLAUDE_BIN ? "AHI_CLAUDE_BIN" : "PATH (AHI_CLAUDE_BIN unset)";
  const found = whichOnPath(bin, env.PATH ?? "");
  let target = found;
  if (found) {
    try { target = realpathSync(found); } catch {}
  }
  if (!found) {
    console.warn(`[claude-bin] WARN: ${bin} (via ${source}) not found — every claude spawn will fail`);
    return;
  }
  let versionText: string;
  try {
    // Run the file we just resolved, so the version logged is the one shown.
    versionText = await runVersion(found);
  } catch (err) {
    console.warn(`[claude-bin] WARN: ${bin} -> ${target} (via ${source}): --version failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  console.log(`[claude-bin] ${bin} -> ${target} (via ${source}): ${versionText}`);
  const version = parseClaudeVersion(versionText);
  if (!version) {
    console.warn(`[claude-bin] WARN: could not parse a version from "${versionText}"`);
  } else if (compareVersions(version, MIN_CLAUDE_CLI_VERSION) < 0) {
    console.warn(
      `[claude-bin] WARN: claude CLI ${version} < ${MIN_CLAUDE_CLI_VERSION} — Opus 5.5 (and Fable 5.1 ` +
        `below 2.1.251) will fail with API 400. Set AHI_CLAUDE_BIN to a current CLI.`,
    );
  }
}
