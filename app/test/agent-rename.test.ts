// An install made before the builder's rename (tzali → zali) keeps working: its env, folders, keys and briefs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aliasLegacyAgentEnv, canonicalAgentId, migrateLegacyAgentHome } from "../src/agent-rename.ts";
import { parseBriefHeader } from "../src/review/brief-header.ts";

// Scratch stays beside the test, never in /tmp.
const scratch = mkdtempSync(join(import.meta.dirname, ".tmp-agent-rename-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const put = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const read = (path: string) => readFileSync(path, "utf8");
const json = (path: string) => JSON.parse(read(path));

test("the old id maps to the new one; every other id is untouched", () => {
  assert.equal(canonicalAgentId("tzali"), "zali");
  for (const id of ["zali", "michael", "avi", "miriam", "foreman"]) assert.equal(canonicalAgentId(id), id);
});

test("an old .env keeps configuring the agent, and a new key wins over the old one", () => {
  const env: NodeJS.ProcessEnv = { TZALI_BOT_TOKEN: "old-token", TZALI_ENABLED: "false", TZALI_MODEL: "old", ZALI_MODEL: "new", MICHAEL_MODEL: "m" };
  aliasLegacyAgentEnv(env);
  assert.equal(env.ZALI_BOT_TOKEN, "old-token");
  assert.equal(env.ZALI_ENABLED, "false");
  assert.equal(env.ZALI_MODEL, "new");
  assert.equal(env.MICHAEL_MODEL, "m");
});

test("an old home is migrated once: folders, files, JSON keys and the seeded soul text", () => {
  const root = join(scratch, "home");
  const state = join(root, "state");
  put(join(root, "agents/soul/TZALI.md"), "# Tzali — צלי\n\nYou are Tzali. Your own note survives.\n");
  put(join(root, "agents/soul/MICHAEL.md"), "| **Tzali** (צלי) | Builder |\nDelegate to Tzali.\n");
  put(join(root, "agents/memory/tzali/MEMORY.md"), "remembered\n");
  put(join(root, "mission-control/AGENT_REGISTRY.md"), "| Tzali | Engineering |\n");
  put(join(state, "users.json"), JSON.stringify([{ name: "Dana", agents: ["michael", "tzali", "avi"] }]));
  put(join(state, "sessions.json"), JSON.stringify({ "tzali:42": { id: "s1" }, "michael:42": { id: "s2" } }));
  put(join(state, "polling-offset.json"), JSON.stringify({ tzali: 7, avi: 8 }));
  put(join(state, "bot-settings.json"), JSON.stringify({ tzali: { voice: "cedar" }, zali: { voice: "kept" } }));
  put(join(state, "threads/dana/tzali/dana.json"), JSON.stringify([{ bot: "tzali", text: "Tzali said hi" }]));
  put(join(state, "threads/dana/tzali/dana.archive.jsonl"), `${JSON.stringify({ bot: "tzali" })}\n${JSON.stringify({ bot: "avi" })}\n`);
  // A folder the new name already has: merged in, and a clashing file is kept, never overwritten.
  put(join(state, "messages/tzali/a.json"), "{}");
  put(join(state, "messages/tzali/clash.json"), '"old"');
  put(join(state, "messages/zali/clash.json"), '"new"');
  put(join(state, "notes.txt"), "mentions tzali but is not ours to rewrite\n");

  const logs: string[] = [];
  migrateLegacyAgentHome(root, state, (s) => logs.push(s));

  assert.equal(existsSync(join(root, "agents/soul/TZALI.md")), false);
  assert.equal(read(join(root, "agents/soul/ZALI.md")), "# Zali\n\nYou are Zali. Your own note survives.\n");
  assert.equal(read(join(root, "agents/soul/MICHAEL.md")), "| **Zali** | Builder |\nDelegate to Zali.\n");
  assert.equal(read(join(root, "agents/memory/zali/MEMORY.md")), "remembered\n");
  assert.equal(read(join(root, "mission-control/AGENT_REGISTRY.md")), "| Zali | Engineering |\n");
  assert.deepEqual(json(join(state, "users.json"))[0].agents, ["michael", "zali", "avi"]);
  assert.deepEqual(json(join(state, "sessions.json")), { "zali:42": { id: "s1" }, "michael:42": { id: "s2" } });
  assert.deepEqual(json(join(state, "polling-offset.json")), { zali: 7, avi: 8 });
  assert.deepEqual(json(join(state, "bot-settings.json")), { tzali: { voice: "cedar" }, zali: { voice: "kept" } });
  assert.deepEqual(json(join(state, "threads/dana/zali/dana.json")), [{ bot: "zali", text: "Tzali said hi" }]);
  assert.equal(read(join(state, "threads/dana/zali/dana.archive.jsonl")), '{"bot":"zali"}\n{"bot":"avi"}\n');
  assert.equal(read(join(state, "messages/zali/a.json")), "{}");
  assert.equal(read(join(state, "messages/zali/clash.json")), '"new"');
  assert.equal(read(join(state, "messages/tzali/clash.json")), '"old"');
  assert.equal(read(join(state, "notes.txt")), "mentions tzali but is not ours to rewrite\n");
  assert.ok(logs.some((l) => l.includes("kept")), "the kept clash is reported");
  assert.match(read(join(state, ".agent-renamed-zali")), /kept .*messages\/tzali\/clash\.json/, "the marker lists the kept clash");

  // Runs once: a later old-named folder (say, restored from a backup) is left alone.
  put(join(root, "agents/memory/tzali/LATER.md"), "x");
  migrateLegacyAgentHome(root, state, () => {});
  assert.ok(existsSync(join(root, "agents/memory/tzali/LATER.md")));
});

test("a pass with a failed step leaves no marker, and the next start finishes the job", () => {
  const root = join(scratch, "partial");
  const state = join(root, "state");
  put(join(state, "locked/tzali/a.json"), '{"bot":"tzali"}');
  put(join(state, "polling-offset.json"), JSON.stringify({ tzali: 1 }));
  chmodSync(join(state, "locked"), 0o000);
  const logs: string[] = [];
  try {
    migrateLegacyAgentHome(root, state, (s) => logs.push(s));
  } finally {
    chmodSync(join(state, "locked"), 0o700);
  }
  assert.ok(logs.some((l) => l.includes("could not read")), "the unreadable folder is reported");
  assert.equal(existsSync(join(state, ".agent-renamed-zali")), false);
  assert.deepEqual(json(join(state, "polling-offset.json")), { zali: 1 }, "the readable part is done already");

  migrateLegacyAgentHome(root, state, () => {});
  assert.deepEqual(json(join(state, "locked/zali/a.json")), { bot: "zali" });
  assert.ok(existsSync(join(state, ".agent-renamed-zali")));
});

test("a temp copy left by an interrupted run is cleared and the original is migrated", () => {
  const root = join(scratch, "interrupted");
  const state = join(root, "state");
  put(join(state, "tzali.json"), JSON.stringify({ bot: "tzali", n: 1 }));
  put(join(state, "tzali.json.agent-rename-tmp"), '{"bot":"za'); // the crash came mid-write
  const logs: string[] = [];
  migrateLegacyAgentHome(root, state, (s) => logs.push(s));
  assert.deepEqual(readdirSync(state).sort(), [".agent-renamed-zali", "zali.json"]);
  assert.deepEqual(json(join(state, "zali.json")), { bot: "zali", n: 1 });
  assert.ok(!logs.some((l) => l.includes("could not")), logs.join("\n"));
});

test("users.json that still lists the old id loads with the new one, once", async () => {
  const file = join(scratch, "users.json");
  writeFileSync(file, JSON.stringify([{ token: "t".repeat(32), name: "Dana", agents: ["michael", "tzali", "zali"], admin: true }]));
  process.env.AHI_USERS_FILE = file;
  const { loadUsers } = await import("../src/users.ts");
  assert.deepEqual(loadUsers()[0].agents, ["michael", "zali"]);
});

test("a foreman brief written before the rename still validates, addressed to zali, in the foreman and the server", () => {
  const brief = join(scratch, "brief.md");
  writeFileSync(brief, [
    "---", "feed: brief", "agent: tzali", "runtime: claude", "model: claude-opus-5-5", "effort: high",
    "name: old-brief", `workdir: ${scratch}`, "why: a brief written before the builder was renamed", "pre_approved: no", "summary: a brief from before the rename", "---", "", "Do it.", "",
  ].join("\n"));
  const r = spawnSync("python3", ["-B", join(import.meta.dirname, "../../foreman/bin/fm_brief_header.py"), "validate", brief], { encoding: "utf8" });
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.errors, []);
  assert.equal(out.header.agent, "zali");
  const ts = parseBriefHeader(readFileSync(brief, "utf8"));
  assert.deepEqual(ts.errors, [], "the server's validator accepts it too");
  assert.equal(ts.header?.agent, "zali");
});
