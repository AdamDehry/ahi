/**
 * brief-header.ts — the machine header a foreman brief must carry before the
 * Feed shows a Start button. TWIN of foreman/bin/fm_brief_header.py: same
 * keys, same rules, same error wording; both run the fixtures in
 * foreman/fixtures/brief-headers (test/feed-brief-header.test.ts).
 *
 *   ---
 *   feed: brief · agent · runtime · model · effort · name · why · pre_approved · summary
 *   repo + branch + worktree   (cut a worktree)   OR   workdir   (build in place)
 *   track: trk-… | bld-… | idea-…   (optional: the feed row this brief backs)
 *   ---
 *
 * Flat `key: value` lines, unknown keys refused — a typo must never pass as
 * "optional". Nothing below the closing --- is read: that is the human brief.
 */
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, join } from "path";

export const MARKER = "brief";
const AGENTS = ["zali", "avi"] as const;
const RUNTIMES = ["claude", "codex"] as const;
const EFFORT: Record<(typeof RUNTIMES)[number], readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["none", "low", "medium", "high", "xhigh", "ultra", "max"],
};
const REQUIRED = ["feed", "agent", "runtime", "model", "effort", "name", "why", "pre_approved", "summary"] as const;
const OPTIONAL = ["repo", "branch", "worktree", "workdir", "track"] as const;
const KNOWN = new Set<string>([...REQUIRED, ...OPTIONAL]);
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{2,60}(?:\[1m\])?$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/\-]{0,100}$/;
const TRACK_RE = /^(?:trk|bld|idea)-[a-z0-9._-]{1,80}$/;
const BARE_ALIASES = new Set(["opus", "sonnet", "haiku", "fable", "gpt"]);
const LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/;

export interface BriefHeader {
  feed: string;
  agent: "zali" | "avi";
  runtime: "claude" | "codex";
  model: string;
  effort: string;
  name: string;
  why: string;
  pre_approved: boolean;
  summary: string;
  repo: string | null;
  branch: string | null;
  worktree: string | null;
  workdir: string | null;
  track: string | null;
}

export type HeaderResult = { valid: true; header: BriefHeader; errors: [] } | { valid: false; header: null; errors: string[] };

function splitFrontMatter(text: string): { block: string[] } | { error: string } {
  const lines = text.split("\n");
  if (!lines.length || lines[0].replace(/\s+$/, "") !== "---") return { error: "no front matter: the brief must open with --- on line 1" };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].replace(/\s+$/, "") === "---") return { block: lines.slice(1, i) };
  }
  return { error: "front matter never closes: no second --- line" };
}

function parseBlock(block: string[]): { fields: Record<string, string>; errors: string[] } {
  const fields: Record<string, string> = {};
  const errors: string[] = [];
  block.forEach((raw, i) => {
    const n = i + 2;
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const m = LINE_RE.exec(line);
    if (!m) {
      errors.push(`line ${n}: not a key: value line`);
      return;
    }
    const key = m[1];
    let value = m[2].replace(/\s+#.*$/, "").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key in fields) {
      errors.push(`line ${n}: duplicate key ${key}`);
      return;
    }
    fields[key] = value;
  });
  return { fields, errors };
}

function validateFields(f: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(f)) if (!KNOWN.has(k)) errors.push(`unknown key: ${k}`);
  for (const k of REQUIRED) if (!f[k]) errors.push(`missing: ${k}`);
  if (f.feed && f.feed !== MARKER) errors.push(`feed must be exactly '${MARKER}'`);
  if (f.agent && !(AGENTS as readonly string[]).includes(f.agent)) errors.push(`agent must be one of ${AGENTS.join(", ")}`);
  const rt = f.runtime;
  if (rt && !(RUNTIMES as readonly string[]).includes(rt)) errors.push(`runtime must be one of ${RUNTIMES.join(", ")}`);
  if (f.model) {
    if (!MODEL_RE.test(f.model)) errors.push("model must be a full slug (letters, digits, dots, dashes; optional [1m])");
    else if (BARE_ALIASES.has(f.model)) errors.push(`model is a bare alias (${f.model}) — name the full slug`);
  }
  if (f.effort && (rt === "claude" || rt === "codex") && !EFFORT[rt].includes(f.effort)) errors.push(`effort for ${rt} must be one of ${EFFORT[rt].join(", ")}`);
  if (f.name && !NAME_RE.test(f.name)) errors.push("name must be kebab-case, 1..60 chars");
  if (f.why && !(f.why.length >= 15 && f.why.length <= 300)) errors.push("why must be one line of 15..300 chars");
  if (f.pre_approved && f.pre_approved !== "yes" && f.pre_approved !== "no") errors.push("pre_approved must be yes or no");
  if (f.summary && f.summary.length > 160) errors.push("summary must be <= 160 chars");
  if (f.repo) {
    if (!f.repo.startsWith("/")) errors.push("repo must be an absolute path");
    if (!f.branch) errors.push("branch is required when repo is set");
    else if (!BRANCH_RE.test(f.branch)) errors.push("branch has characters git would refuse");
    if (!f.worktree) errors.push("worktree is required when repo is set");
    else if (!NAME_RE.test(f.worktree)) errors.push("worktree must be kebab-case, 1..60 chars");
    if (f.workdir) errors.push("workdir and repo are exclusive — with repo the worktree is the workdir");
  } else {
    if (!f.workdir) errors.push("workdir is required when repo is not set");
    else if (!f.workdir.startsWith("/")) errors.push("workdir must be an absolute path");
    for (const k of ["branch", "worktree"]) if (f[k]) errors.push(`${k} only makes sense with repo`);
  }
  if (f.track && !TRACK_RE.test(f.track)) errors.push("track must be trk-…, bld-… or idea-…");
  return errors;
}

/** Parse + validate the front matter of a brief's text. Never throws. */
export function parseBriefHeader(text: string): HeaderResult {
  const split = splitFrontMatter(text);
  if ("error" in split) return { valid: false, header: null, errors: [split.error] };
  const { fields, errors } = parseBlock(split.block);
  errors.push(...validateFields(fields));
  if (errors.length) return { valid: false, header: null, errors };
  return {
    valid: true,
    errors: [],
    header: {
      feed: fields.feed,
      agent: fields.agent as BriefHeader["agent"],
      runtime: fields.runtime as BriefHeader["runtime"],
      model: fields.model,
      effort: fields.effort,
      name: fields.name,
      why: fields.why,
      pre_approved: fields.pre_approved === "yes",
      summary: fields.summary,
      repo: fields.repo || null,
      branch: fields.branch || null,
      worktree: fields.worktree || null,
      workdir: fields.workdir || null,
      track: fields.track || null,
    },
  };
}

export interface BriefFile {
  path: string;
  /** File stem — the brief's own row id is `brief-<stem>`. */
  stem: string;
  sha256: string;
  mtime: string;
  /** Human title: the first `# ` heading below the header, else the stem. */
  title: string;
  result: HeaderResult;
}

export function readBrief(path: string): BriefFile | null {
  try {
    const raw = readFileSync(path);
    const text = raw.toString("utf8");
    const { mtimeMs } = statSync(path);
    const heading = /^#\s+(.+?)\s*$/m.exec(text.replace(/^---[\s\S]*?\n---\n?/, ""));
    const stem = basename(path).replace(/\.md$/i, "");
    return {
      path,
      stem,
      sha256: createHash("sha256").update(raw).digest("hex"),
      mtime: new Date(mtimeMs).toISOString(),
      title: heading ? heading[1].slice(0, 160) : stem,
      result: parseBriefHeader(text),
    };
  } catch {
    return null;
  }
}

/** Every *.md in the briefs folder, valid or not (the feed decides what to show). Missing dir → []. */
export function scanBriefs(dir: string | null): BriefFile[] {
  if (!dir || !existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".md")).sort();
  } catch {
    return [];
  }
  return names.map((n) => readBrief(join(dir, n))).filter((b): b is BriefFile => b !== null);
}
