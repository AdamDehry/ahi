import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions, installSkills, mirrorShelf, latestRelease, planSkillUpdates, readManifest, validateBundle, type Bundle } from "../src/updates.ts";

// Scratch stays beside the test, never in /tmp.
const scratch = mkdtempSync(join(import.meta.dirname, ".tmp-updates-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const file = (path: string, text: string, executable = false) => {
  const buf = Buffer.from(text);
  return { path, sha256: createHash("sha256").update(buf).digest("hex"), content: buf.toString("base64"), executable };
};
const bundle = (version: string, extra: Partial<Bundle> = {}): Bundle => ({
  format: "ahi-skills/1",
  release: "0.3.0",
  skills: [
    { name: "oom-safe-runs", category: "code-quality", version, files: [file("SKILL.md", `---\nname: oom-safe-runs\nversion: ${version}\n---\n`), file("scripts/run.sh", "#!/bin/sh\n", true)] },
  ],
  ...extra,
});

test("compareVersions orders dotted versions numerically", () => {
  assert.equal(compareVersions("v0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.equal(compareVersions("0.2.0", "v0.3.0"), -1);
});

test("validateBundle refuses traversal, absolute paths and bad checksums", () => {
  assert.ok(validateBundle(bundle("1.0.0")));
  const evil = bundle("1.0.0");
  evil.skills[0].files.push(file("../../escape.sh", "x"));
  assert.throws(() => validateBundle(evil), /unsafe file path/);
  const abs = bundle("1.0.0");
  abs.skills[0].files.push(file("/etc/passwd", "x"));
  assert.throws(() => validateBundle(abs), /unsafe file path/);
  const tampered = bundle("1.0.0");
  tampered.skills[0].files[0].content = Buffer.from("changed").toString("base64");
  assert.throws(() => validateBundle(tampered), /checksum mismatch/);
  const noSkillMd = bundle("1.0.0");
  noSkillMd.skills[0].files.shift();
  assert.throws(() => validateBundle(noSkillMd), /no SKILL.md/);
  assert.throws(() => validateBundle({ format: "other" }), /Not an AHI skills bundle/);
});

test("planSkillUpdates lists new and newer skills only", () => {
  assert.deepEqual(planSkillUpdates(null, bundle("1.0.0").skills).map((s) => s.name), ["oom-safe-runs"]);
  const installed = { release: "0.2.0", skills: [{ name: "oom-safe-runs", category: "code-quality", version: "1.0.0" }] };
  assert.equal(planSkillUpdates(installed, bundle("1.0.0").skills).length, 0);
  assert.deepEqual(planSkillUpdates(installed, bundle("1.1.0").skills)[0], { name: "oom-safe-runs", category: "code-quality", version: "1.1.0", from: "1.0.0" });
});

test("installSkills swaps in, backs up the old copy, mirrors managed skills and keeps the owner's own", () => {
  const root = join(scratch, "a", "skills"), flat = join(scratch, "a", "claude-skills");
  mkdirSync(root, { recursive: true });
  const first = installSkills(validateBundle(bundle("1.0.0")), root, flat, new Date("2026-11-05T00:00:00Z"));
  assert.deepEqual(first, { installed: ["oom-safe-runs"], keptOwn: [] });
  assert.match(readFileSync(join(root, "code-quality/oom-safe-runs/SKILL.md"), "utf8"), /version: 1.0.0/);
  assert.ok(existsSync(join(flat, "oom-safe-runs/.ahi-managed")));
  assert.equal(readManifest(root)?.skills[0].version, "1.0.0");

  installSkills(validateBundle(bundle("1.1.0")), root, flat, new Date("2026-11-06T00:00:00Z"));
  assert.match(readFileSync(join(root, "code-quality/oom-safe-runs/SKILL.md"), "utf8"), /version: 1.1.0/);
  assert.match(readFileSync(join(root, "_backup/2026-11-06T00-00-00-000Z/code-quality/oom-safe-runs/SKILL.md"), "utf8"), /version: 1.0.0/);
  assert.match(readFileSync(join(flat, "oom-safe-runs/SKILL.md"), "utf8"), /version: 1.1.0/);

  // The owner's own copy in the flat folder (no AHI marker) is never overwritten.
  const own = join(scratch, "b", "claude-skills", "oom-safe-runs");
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, "SKILL.md"), "mine");
  const r = installSkills(validateBundle(bundle("1.0.0")), join(scratch, "b", "skills"), join(scratch, "b", "claude-skills"));
  assert.deepEqual(r.keptOwn, ["oom-safe-runs"]);
  assert.equal(readFileSync(join(own, "SKILL.md"), "utf8"), "mine");
});

test("latestRelease reads the release and only trusts a github.com bundle URL", async () => {
  const fake = (assetUrl: string) => (async () => new Response(JSON.stringify({
    tag_name: "v0.3.0", name: "AHI v0.3.0", html_url: "https://github.com/o/r/releases/tag/v0.3.0", published_at: "2026-11-06T00:00:00Z", body: "notes",
    assets: [{ name: "ahi-skills.json", browser_download_url: assetUrl }],
  }), { status: 200 })) as unknown as typeof fetch;
  const ok = await latestRelease("o/r", true, fake("https://github.com/o/r/releases/download/v0.3.0/ahi-skills.json"));
  assert.equal(ok.version, "0.3.0");
  assert.ok(ok.bundleUrl);
  const other = await latestRelease("o/r", true, fake("https://example.com/ahi-skills.json"));
  assert.equal(other.bundleUrl, null);
  const missing = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(latestRelease("o/none", true, missing), /No release published yet/);
});

test("mirrorShelf fills missing and AHI-managed entries only, and refreshes a managed one on a new version", () => {
  const root = join(scratch, "m", "skills"), flat = join(scratch, "m", "claude-skills");
  const put = (name: string, version: string) => {
    mkdirSync(join(root, "design", name), { recursive: true });
    writeFileSync(join(root, "design", name, "SKILL.md"), `version ${version}`);
  };
  put("documents", "1.0.0");
  put("vision", "1.0.0");
  writeFileSync(join(root, "MANIFEST.json"), JSON.stringify({ release: "0.2.0", skills: [{ name: "documents", category: "design", version: "1.0.0" }, { name: "vision", category: "design", version: "1.0.0" }] }));
  mkdirSync(join(flat, "vision"), { recursive: true });
  writeFileSync(join(flat, "vision", "SKILL.md"), "the owner's own");
  assert.deepEqual(mirrorShelf(root, flat), { copied: ["documents"], keptOwn: ["vision"] });
  assert.equal(readFileSync(join(flat, "vision", "SKILL.md"), "utf8"), "the owner's own");
  assert.deepEqual(mirrorShelf(root, flat).copied, []); // idempotent
  put("documents", "1.1.0");
  writeFileSync(join(root, "MANIFEST.json"), JSON.stringify({ release: "0.3.0", skills: [{ name: "documents", category: "design", version: "1.1.0" }] }));
  assert.deepEqual(mirrorShelf(root, flat).copied, ["documents"]);
  assert.equal(readFileSync(join(flat, "documents", "SKILL.md"), "utf8"), "version 1.1.0");
});
