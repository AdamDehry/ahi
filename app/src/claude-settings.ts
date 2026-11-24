import { mkdirSync, writeFileSync } from "fs";
import path from "path";

// The Claude settings every agent turn runs with: the memory-search hook and the skill/document permissions.
// Where they go:
//   - AHI_CLAUDE_SETTINGS (AHI Setup sets it to <AHI_OS>/state/claude-settings.json): an installed app's own
//     folder is read-only on Windows (Program Files) and Linux (AppImage), and a signed Mac bundle must never be
//     written into. The file is handed to claude with --settings.
//   - otherwise <server>/.claude/settings.json, the project settings claude reads from its cwd (a dev checkout);
//     if that folder is read-only, <AHI_OS>/state/claude-settings.json with --settings instead.
// Never the provider home's own settings.json: that file is the owner's, and stays as they left it.

type Platform = NodeJS.Platform;
const pathFor = (platform: Platform) => (platform === "win32" ? path.win32 : path.posix);

/** A Claude Code path rule's absolute form: "//" then the POSIX path (D:\Profiles\x → //d/Profiles/x). A single leading
 * slash would mean "relative to the settings file", which never matches. */
export function absoluteRulePath(p: string): string {
  return "/" + p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_m, d: string) => "/" + d.toLowerCase());
}

/** Every way a model may spell "a file inside dir" in a shell command: bare, "double-" or 'single-'quoted (a path
 * with a space, like "My AI", must be quoted), and on Windows with either slash. */
function commandPrefixes(dir: string, platform: Platform): string[] {
  const spellings = platform === "win32" ? [dir, dir.replace(/\\/g, "/")] : [dir];
  return [...new Set(spellings)].flatMap((d) => {
    const inside = d + (d.includes("\\") ? "\\" : "/");
    return [inside, `"${inside}`, `'${inside}`];
  });
}

export function claudeSettings({ gatewayRoot, aiRoot, platform = process.platform }: { gatewayRoot: string; aiRoot: string; platform?: Platform }) {
  const p = pathFor(platform);
  const skills = p.join(aiRoot, "skills");
  const documents = p.join(aiRoot, "documents");
  return {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              // Node, not a shell script: one hook for Mac, Windows and Linux. A quoted absolute path with forward
              // slashes after a bare `node` parses the same in bash, cmd and PowerShell, spaces included.
              command: `node "${p.join(gatewayRoot, "hooks", "ahi-retrieval.mjs").replace(/\\/g, "/")}"`,
              timeout: 10,
            },
          ],
        },
      ],
    },
    permissions: {
      allow: [
        ...["python3", "python"].flatMap((py) => commandPrefixes(skills, platform).map((prefix) => `Bash(${py} ${prefix}*)`)),
        ...[documents, skills].flatMap((dir) => ["Edit", "Write"].map((tool) => `${tool}(${absoluteRulePath(dir)}/**)`)),
      ],
    },
  };
}

/**
 * Write the settings; returns the file to pass with --settings, or null when they went to the project folder that
 * claude reads by itself. Throws only if no writable place is left (the caller warns and carries on without them).
 */
export function writeClaudeSettings({ gatewayRoot, aiRoot, explicit = process.env.AHI_CLAUDE_SETTINGS }: { gatewayRoot: string; aiRoot: string; explicit?: string }): string | null {
  const body = JSON.stringify(claudeSettings({ gatewayRoot, aiRoot }), null, 2) + "\n";
  const write = (file: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
    return file;
  };
  if (explicit) return write(path.resolve(explicit));
  try {
    write(path.resolve(gatewayRoot, ".claude", "settings.json"));
    return null;
  } catch (err) {
    const fallback = write(path.resolve(aiRoot, "state", "claude-settings.json"));
    console.warn(`[gateway] ${path.resolve(gatewayRoot)} is read-only (${(err as NodeJS.ErrnoException).code}); Claude settings written to ${fallback} and passed with --settings`);
    return fallback;
  }
}
