/**
 * In-app updates. AHI releases are GitHub releases of the repo this install came from; each one carries
 * `ahi-skills.json`, the release's skills shelf (every skill's files, version and sha256). This module
 * answers "is there a newer AHI?" and installs newer skills in place; the app itself updates through the
 * release's AHI Setup download.
 *
 * Where the repo comes from: `release.json` beside package.json (written by the release workflow), or
 * AHI_UPDATE_REPO ("owner/name"). With neither, updates report `configured: false` and nothing is fetched.
 */
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Context, Hono } from "hono";
import { atomicWriteJson } from "./multi-user-paths.js";

const BUNDLE_ASSET = "ahi-skills.json";
const BUNDLE_FORMAT = "ahi-skills/1";
const MANAGED_MARKER = ".ahi-managed";
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface SkillEntry { name: string; category: string; version: string }
interface Manifest { release: string; skills: SkillEntry[] }
interface BundleFile { path: string; sha256: string; executable?: boolean; content: string }
interface BundleSkill extends SkillEntry { files: BundleFile[] }
export interface Bundle { format: string; release: string; skills: BundleSkill[] }
interface Release { tag: string; version: string; name: string; url: string; publishedAt: string; notes: string; bundleUrl: string | null }

/** Compare dotted numeric versions ("v0.10.1" > "0.9"); non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/i, "").split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** A bundle file path must stay inside its skill folder: relative, forward slashes, no "..", no dot-dirs. */
function safeRelPath(p: string): boolean {
  if (!p || p.length > 300 || p.includes("\\") || p.includes("\0") || p.startsWith("/")) return false;
  return p.split("/").every((seg) => seg && seg !== "." && seg !== ".." && !/^[A-Za-z]:$/.test(seg));
}

/** Validate a downloaded bundle before anything touches disk. Throws with a reason a person can read. */
export function validateBundle(raw: unknown): Bundle {
  const b = raw as Bundle;
  if (!b || b.format !== BUNDLE_FORMAT || typeof b.release !== "string" || !Array.isArray(b.skills)) throw Error("Not an AHI skills bundle");
  const seen = new Set<string>();
  for (const s of b.skills) {
    if (!SLUG.test(s?.name) || !SLUG.test(s?.category) || typeof s.version !== "string") throw Error(`Bad skill entry: ${String(s?.name)}`);
    if (seen.has(s.name)) throw Error(`Skill listed twice: ${s.name}`);
    seen.add(s.name);
    if (!Array.isArray(s.files) || !s.files.some((f) => f.path === "SKILL.md")) throw Error(`${s.name} has no SKILL.md`);
    for (const f of s.files) {
      if (!safeRelPath(f.path)) throw Error(`${s.name}: unsafe file path`);
      if (typeof f.content !== "string" || sha256(Buffer.from(f.content, "base64")) !== f.sha256) throw Error(`${s.name}/${f.path}: checksum mismatch`);
    }
  }
  return b;
}

/** Skills in the bundle that are new or carry a higher version than the installed manifest. */
export function planSkillUpdates(installed: Manifest | null, skills: SkillEntry[]): Array<SkillEntry & { from: string | null }> {
  const have = new Map((installed?.skills ?? []).map((s) => [s.name, s]));
  return skills
    .filter((s) => { const h = have.get(s.name); return !h || compareVersions(s.version, h.version) > 0 || h.category !== s.category; })
    .map(({ name, category, version }) => ({ name, category, version, from: have.get(name)?.version ?? null }));
}

export function readManifest(skillsRoot: string): Manifest | null {
  try { return JSON.parse(readFileSync(join(skillsRoot, "MANIFEST.json"), "utf8")) as Manifest; } catch { return null; }
}

/**
 * Install the planned skills: each lands in a hidden staging folder first and is swapped in by rename; the
 * copy it replaces moves to skills/_backup/<stamp>/. Then the shelf is mirrored to the flat folder Claude Code
 * reads, which keeps any copy the owner made there themselves (no AHI marker).
 */
export function installSkills(bundle: Bundle, skillsRoot: string, claudeSkillsDir: string, now = new Date()): { installed: string[]; keptOwn: string[] } {
  const have = new Map((readManifest(skillsRoot)?.skills ?? []).map((s) => [s.name, s]));
  const plan = new Set(planSkillUpdates({ release: "", skills: [...have.values()] }, bundle.skills).map((p) => p.name));
  const backupRoot = join(skillsRoot, "_backup", now.toISOString().replace(/[:.]/g, "-"));
  const installed: string[] = [];
  for (const skill of bundle.skills.filter((s) => plan.has(s.name))) {
    const finalDir = join(skillsRoot, skill.category, skill.name);
    const staging = join(skillsRoot, skill.category, `.${skill.name}.incoming-${randomBytes(4).toString("hex")}`);
    for (const f of skill.files) {
      const target = resolve(staging, f.path);
      if (!target.startsWith(staging + sep)) throw Error(`${skill.name}: unsafe file path`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(f.content, "base64"), { mode: f.executable ? 0o755 : 0o644 });
    }
    for (const dir of new Set([finalDir, join(skillsRoot, have.get(skill.name)?.category ?? skill.category, skill.name)])) {
      if (!existsSync(dir)) continue;
      const dest = join(backupRoot, dir.slice(skillsRoot.length + 1));
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(dir, dest);
    }
    renameSync(staging, finalDir);
    have.set(skill.name, { name: skill.name, category: skill.category, version: skill.version });
    installed.push(skill.name);
  }
  atomicWriteJson(join(skillsRoot, "MANIFEST.json"), { release: bundle.release, skills: [...have.values()].sort((a, b) => a.name.localeCompare(b.name)) });
  const { keptOwn } = mirrorShelf(skillsRoot, claudeSkillsDir);
  return { installed, keptOwn: keptOwn.filter((n) => plan.has(n)) };
}

/**
 * Make every shelf skill visible to Claude Code: copy it to the flat ~/.claude/skills/<name> when that entry is
 * missing, or AHI-managed (marker present) at another version. An entry without the marker is the owner's own
 * and is never touched — that includes a symlink into the shelf, which is how a hand-run shelf (fm_skills link)
 * owns the folder instead of this app.
 */
export function mirrorShelf(skillsRoot: string, claudeSkillsDir: string): { copied: string[]; keptOwn: string[] } {
  const copied: string[] = [], keptOwn: string[] = [];
  for (const s of readManifest(skillsRoot)?.skills ?? []) {
    const src = join(skillsRoot, s.category, s.name), flat = join(claudeSkillsDir, s.name), marker = join(flat, MANAGED_MARKER);
    if (!SLUG.test(s.name) || !SLUG.test(s.category) || !existsSync(join(src, "SKILL.md"))) continue;
    if (existsSync(flat) && !existsSync(marker)) { keptOwn.push(s.name); continue; }
    if (existsSync(marker) && readFileSync(marker, "utf8").trim() === `${s.name} ${s.version}`) continue;
    rmSync(flat, { recursive: true, force: true });
    mkdirSync(claudeSkillsDir, { recursive: true });
    cpSync(src, flat, { recursive: true });
    writeFileSync(marker, `${s.name} ${s.version}\n`);
    copied.push(s.name);
  }
  return { copied, keptOwn };
}

/** This install's version and the repo its updates come from. */
function localRelease(appDir: string): { version: string; repo: string | null } {
  const read = (f: string) => { try { return JSON.parse(readFileSync(join(appDir, f), "utf8")); } catch { return {}; } };
  const pkg = read("package.json"), rel = read("release.json");
  const repo = process.env.AHI_UPDATE_REPO || rel.repo || null;
  return { version: String(rel.tag || pkg.version || "0.0.0").replace(/^v/i, ""), repo: repo && REPO.test(repo) ? repo : null };
}

let cached: { repo: string; at: number; release: Release } | null = null;

/** The repo's latest published release (cached 6 h; `force` skips the cache). */
export async function latestRelease(repo: string, force = false, fetchImpl: typeof fetch = fetch): Promise<Release> {
  if (!force && cached && cached.repo === repo && Date.now() - cached.at < CHECK_TTL_MS) return cached.release;
  const r = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "ahi-updater" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw Error(r.status === 404 ? "No release published yet" : `GitHub answered ${r.status}`);
  const j = (await r.json()) as { tag_name: string; name?: string; html_url: string; published_at: string; body?: string; assets?: Array<{ name: string; browser_download_url: string }> };
  const asset = j.assets?.find((a) => a.name === BUNDLE_ASSET)?.browser_download_url ?? null;
  const release: Release = {
    tag: j.tag_name, version: j.tag_name.replace(/^v/i, ""), name: j.name || j.tag_name, url: j.html_url,
    publishedAt: j.published_at, notes: (j.body || "").slice(0, 4000),
    bundleUrl: asset && asset.startsWith("https://github.com/") ? asset : null,
  };
  cached = { repo, at: Date.now(), release };
  return release;
}

async function downloadBundle(url: string, fetchImpl: typeof fetch = fetch): Promise<Bundle> {
  const r = await fetchImpl(url, { headers: { "User-Agent": "ahi-updater" }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw Error(`Download failed (${r.status})`);
  if (Number(r.headers.get("content-length") || 0) > MAX_BUNDLE_BYTES) throw Error("Skills bundle is too large");
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BUNDLE_BYTES) throw Error("Skills bundle is too large");
  return validateBundle(JSON.parse(buf.toString("utf8")));
}

/** GET /ui/updates — what's newer; POST /ui/updates/skills — install the newer skills. Owner only. */
export function registerUpdateRoutes(
  app: Hono<any>,
  resolveOwner: (c: Context) => { admin?: boolean } | null,
  opts: { appDir: string; skillsRoot: string; claudeSkillsDir: string },
): void {
  // Off the startup path: a fresh install copies its whole shelf here once.
  setImmediate(() => {
    try {
      const { copied } = mirrorShelf(opts.skillsRoot, opts.claudeSkillsDir);
      if (copied.length) console.log(`[updates] skills shelf mirrored for Claude Code: ${copied.join(", ")}`);
    } catch (err) {
      console.error("[updates] could not mirror the skills shelf:", err);
    }
  });
  const { version, repo } = localRelease(opts.appDir);
  // GET only needs each bundled skill's name, category and version — never hold the file contents.
  let listFor: { tag: string; skills: SkillEntry[] } | null = null;
  const guard = (c: Context) => {
    const u = resolveOwner(c);
    if (!u) return c.json({ error: "Unauthorized" }, 401);
    if (!u.admin) return c.json({ error: "Forbidden" }, 403);
    return null;
  };

  app.get("/ui/updates", async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const installed = readManifest(opts.skillsRoot);
    const current = { version, skillsRelease: installed?.release ?? null };
    if (!repo) return c.json({ configured: false, current });
    try {
      const latest = await latestRelease(repo, c.req.query("refresh") === "1");
      let skills: ReturnType<typeof planSkillUpdates> = [];
      if (latest.bundleUrl && compareVersions(latest.version, installed?.release ?? "0") > 0) {
        if (listFor?.tag !== latest.tag) {
          const b = await downloadBundle(latest.bundleUrl);
          listFor = { tag: latest.tag, skills: b.skills.map(({ name, category, version: v }) => ({ name, category, version: v })) };
        }
        skills = planSkillUpdates(installed, listFor.skills);
      }
      const { bundleUrl: _omit, ...shown } = latest;
      return c.json({ configured: true, current, latest: shown, appUpdate: compareVersions(latest.version, version) > 0, skills });
    } catch (err) {
      return c.json({ configured: true, current, error: (err as Error).message });
    }
  });

  app.post("/ui/updates/skills", async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    if (!repo) return c.json({ error: "Updates are not configured" }, 400);
    try {
      const latest = await latestRelease(repo);
      if (!latest.bundleUrl) return c.json({ error: "This release carries no skills" }, 400);
      return c.json(installSkills(await downloadBundle(latest.bundleUrl), opts.skillsRoot, opts.claudeSkillsDir));
    } catch (err) {
      console.error("[updates] skills install failed:", err);
      return c.json({ error: (err as Error).message }, 500);
    }
  });
}
