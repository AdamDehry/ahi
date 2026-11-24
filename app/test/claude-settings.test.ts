import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { absoluteRulePath, claudeSettings, writeClaudeSettings } from "../src/claude-settings.ts";

// A Bash permission rule's `*` matches anything (Claude Code's wildcard): enough to show which commands a rule admits.
const admits = (rule: string, command: string) => {
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m) return false;
  const re = m[1].split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${re}$`).test(command);
};

test("Windows home under a folder with a space: quoted hook, quoted skill commands, absolute path rules", () => {
  const s = claudeSettings({
    gatewayRoot: "C:\\Program Files\\AHI\\resources\\ahi-server",
    aiRoot: "D:\\Profiles\\b\\Desktop\\My AI\\AHI\\AHI_OS",
    platform: "win32",
  });
  assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].command, 'node "C:/Program Files/AHI/resources/ahi-server/hooks/ahi-retrieval.mjs"');
  const allow = s.permissions.allow;
  for (const command of [
    'python3 "D:/Profiles/b/Desktop/My AI/AHI/AHI_OS/skills/design/documents/gen_pdf.py" in.md out.pdf',
    'python "D:\\Profiles\\b\\Desktop\\My AI\\AHI\\AHI_OS\\skills\\design\\vision\\ocr.py" photo.jpg',
    "python3 'D:/Profiles/b/Desktop/My AI/AHI/AHI_OS/skills/x/y.py'",
  ]) assert.ok(allow.some((r) => admits(r, command)), command);
  // Another folder that merely starts the same way is not admitted.
  assert.ok(!allow.some((r) => admits(r, 'python3 "D:/Profiles/b/Desktop/My AI/AHI/AHI_OS/skills-evil/x.py"')));
  assert.ok(allow.includes("Write(//d/Profiles/b/Desktop/My AI/AHI/AHI_OS/documents/**)"));
  assert.ok(allow.includes("Edit(//d/Profiles/b/Desktop/My AI/AHI/AHI_OS/skills/**)"));
});

test("POSIX paths: double-slash absolute rules, never the single-slash form that is relative to the settings file", () => {
  assert.equal(absoluteRulePath("/home/o/AHI/AHI_OS/documents"), "//home/o/AHI/AHI_OS/documents");
  const allow = claudeSettings({ gatewayRoot: "/opt/ahi", aiRoot: "/home/o/AHI/AHI_OS", platform: "linux" }).permissions.allow;
  assert.ok(allow.every((r) => !/^(Edit|Write)\(\/[^/]/.test(r)));
  assert.ok(allow.some((r) => admits(r, "python3 /home/o/AHI/AHI_OS/skills/design/vision/ocr.py a.png")));
});

test("writes: project folder when writable, the managed folder with --settings when not, and the Setup-named file first", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-settings-"));
  try {
    const server = join(dir, "server"), ai = join(dir, "My AI", "AHI_OS");
    assert.equal(writeClaudeSettings({ gatewayRoot: server, aiRoot: ai, explicit: "" }), null);
    assert.ok(existsSync(join(server, ".claude", "settings.json")));

    const readOnly = join(dir, "readonly-server");
    writeClaudeSettings({ gatewayRoot: readOnly, aiRoot: ai, explicit: "" });
    rmSync(join(readOnly, ".claude"), { recursive: true });
    chmodSync(readOnly, 0o555);
    const fallback = writeClaudeSettings({ gatewayRoot: readOnly, aiRoot: ai, explicit: "" });
    assert.equal(fallback, join(ai, "state", "claude-settings.json"));
    assert.ok(!existsSync(join(readOnly, ".claude")));
    assert.match(readFileSync(fallback!, "utf8"), /ahi-retrieval\.mjs/);

    const named = join(ai, "state", "named.json");
    assert.equal(writeClaudeSettings({ gatewayRoot: readOnly, aiRoot: ai, explicit: named }), named);
    chmodSync(readOnly, 0o755);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
