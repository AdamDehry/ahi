/**
 * `[[studio_job: {...}]]` / `[[studio_decision: {...}]]` — Avi starting a
 * generation, or putting a choice in front of the owner, from ANY reply: a chat
 * turn or a live call. Same contract as `[[search_images:]]`
 * (search/sentinel.ts) and `[[send_file:]]`: takeSentinelFiles — the one call
 * every reply path makes — strips the lines from what the user sees and runs
 * them in the background. On a call the line is never spoken (a bracketed
 * line is an on-screen work line).
 *
 * Each line is one JSON object on one line. A line that can't run is not
 * silent: the reason is told to Avi on his next turn (studio notes), so he
 * never says "started" about a job that didn't.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Studio } from "./service.js";
import type { StudioJob } from "./jobs.js";

export const STUDIO_SENTINEL_RE = /^[ \t]*\[\[studio_(job|decision):\s*(\{.*\})\s*\]\][ \t]*$/gm;
/** Lines a reply may carry; the rest are dropped (and Avi is told). */
export const MAX_PER_REPLY = 3;
/** Let the reply's own text land first, so the card sits under it (as search does). */
const RUN_DELAY_MS = 400;

let live: Studio | null = null;

/** Set once by installStudio; null in tests and when the studio is off. */
export function setStudio(studio: Studio | null): void {
  live = studio;
}

export function studio(): Studio | null {
  return live;
}

export interface StudioLine {
  kind: "job" | "decision";
  raw: unknown;
  /** Set when the JSON did not parse. */
  error?: string;
}

export function parseStudioLines(response: string): { cleaned: string; lines: StudioLine[] } {
  const lines: StudioLine[] = [];
  const re = new RegExp(STUDIO_SENTINEL_RE.source, "gm");
  let m: RegExpExecArray | null;
  while ((m = re.exec(response)) !== null) {
    const kind = m[1] === "job" ? "job" : "decision";
    try {
      lines.push({ kind, raw: JSON.parse(m[2]) });
    } catch (err) {
      lines.push({ kind, raw: null, error: `not valid JSON (${(err as Error).message.slice(0, 80)})` });
    }
  }
  if (!lines.length) return { cleaned: response, lines };
  const cleaned = response.replace(new RegExp(`${STUDIO_SENTINEL_RE.source}\\r?\\n?`, "gm"), "").replace(/\n{3,}/g, "\n\n").trim();
  return { cleaned, lines };
}

/** Run the lines. Never throws. Returns what started / was posted. */
export async function runStudioLines(
  opts: { userId: string; bot: string; lines: StudioLine[] },
  s: Studio | null = live,
  delayMs = 0,
): Promise<{ jobs: number; decisions: number }> {
  const done = { jobs: 0, decisions: 0 };
  if (!s || !opts.lines.length || !opts.userId || opts.userId === "unknown") return done;
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  if (opts.lines.length > MAX_PER_REPLY) s.note(opts.userId, opts.bot, `your last reply had ${opts.lines.length} studio lines; only the first ${MAX_PER_REPLY} ran`);
  for (const line of opts.lines.slice(0, MAX_PER_REPLY)) {
    if (line.error) {
      s.note(opts.userId, opts.bot, `a studio_${line.kind} line was not run: ${line.error}`);
      continue;
    }
    try {
      const r = line.kind === "job" ? s.startJob(opts.userId, opts.bot, line.raw) : await s.postDecision(opts.userId, opts.bot, line.raw);
      if (!r.ok) s.note(opts.userId, opts.bot, `a studio_${line.kind} line was not run: ${r.error}`);
      else if (line.kind === "job") done.jobs++;
      else done.decisions++;
    } catch (err) {
      s.note(opts.userId, opts.bot, `a studio_${line.kind} line failed: ${(err as Error).message}`);
    }
  }
  return done;
}

/** Strip the lines; run them in the background. */
export function takeStudioLines(response: string, opts: { userId: string; bot: string }): string {
  if (!response.includes("[[studio_")) return response;
  const { cleaned, lines } = parseStudioLines(response);
  if (lines.length) void runStudioLines({ ...opts, lines }, live, RUN_DELAY_MS);
  return cleaned;
}

// ── The hint ────────────────────────────────────────────────────────────

export interface GuideInfo {
  name: string;
  path: string;
  version?: string;
  updated?: string;
  summary?: string;
}

/** The guides in force: one file per use case, frontmatter name/version/updated/summary. */
export function listGuides(dir: string): GuideInfo[] {
  if (!existsSync(dir)) return [];
  const out: GuideInfo[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("_") && f !== "README.md").sort()) {
    const path = join(dir, f);
    const head = readFileSync(path, "utf8").slice(0, 1500);
    const fm = /^---\n([\s\S]*?)\n---/.exec(head)?.[1] ?? "";
    const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, "");
    out.push({ name: field("use_case") ?? f.replace(/\.md$/, ""), path, version: field("version"), updated: field("updated"), summary: field("summary") });
  }
  return out;
}

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

function jobLine(j: StudioJob, label: string, now: number): string {
  const what = `${label} ×${j.n}${j.ask ? ` "${j.ask}"` : ""}${j.step ? ` [${j.guide ? `${j.guide} ` : ""}${j.step}]` : ""}`;
  if (j.status === "running") return `- RUNNING ${ago(j.startedAt, now)}: ${what}`;
  const when = j.endedAt ? `${ago(j.endedAt, now)} ago` : "";
  if (j.status === "done") return `- LANDED ${when}: ${what} → ${j.files.length} file(s) in ${j.outDir}${j.note ? ` · ${j.note}` : ""}`;
  return `- ${j.status.toUpperCase()} ${when}: ${what} — ${j.error ?? "no result"}`;
}

/**
 * What a studio agent is told each turn (only when the studio is on and the
 * agent is in STUDIO_AGENTS, default "avi"). Consumes the studio notes.
 */
export function studioAgentHint(
  bot: string,
  userId: string | null | undefined,
  userName: string,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): string {
  const s = live;
  if (!s) return "";
  if ((env.STUDIO_AGENTS ?? "avi").split(",").map((x) => x.trim()).indexOf(bot) < 0) return "";
  if (!userId || userId === "unknown") return "";
  const engines = Object.values(s.jobs.engines()).filter((e) => e.kind !== "fixture" || env.STUDIO_FIXTURE_DIR);
  const engineLines = engines.map((e) => {
    const off = e.unavailable();
    const what =
      e.name === "nano-banana" ? "fast stills and edits; refs welcome"
      : e.name === "nano-banana-pro" ? "slower, finer stills and edits"
      : e.name === "gpt-image" ? "photoreal sheets, precise edits (erase a face, change a sail), text in images"
      : e.name === "avi" ? "a background you with every tool: Higgsfield MCP (Soul Cinema, Seedance video, Cinema Studio), the video pipeline, Foreman builds. The prompt is the whole instruction; it saves results into its job folder"
      : "preview pictures (fixture)";
    return `  ${e.name}${off ? " (OFF: " + off + ")" : ""} — ${what}`;
  });
  const guides = listGuides(s.guidesDir);
  const st = s.state(userId, bot);
  const label = (j: StudioJob) => s.jobs.engines()[j.engine]?.label ?? j.engine;
  const jobs = [...st.running, ...st.recent].slice(0, 6).map((j) => jobLine(j, label(j), now));
  const decision = st.decisions.flatMap((d, i) => [
    `${i === 0 ? "Latest decision card" : "Earlier decision card"} (${ago(d.card.at, now)} ago): "${d.card.ask}"`,
    ...d.card.options.map((o) => `  ${o.key}) ${o.label ?? (o.media.type === "video" ? "clip" : "picture")} — ${o.media.path}`),
    d.answered ? `  His first words after it: "${d.answered}"` : "  Not answered yet.",
  ]);
  if (st.decisions.length) decision.push(`A tap on an option arrives as "<the card's question> → B: <label>" (on a call with the picture); "B" or "the second one" on its own means the latest card.`);
  const notes = s.takeNotes(userId, bot);
  return [
    `[LIVE STUDIO — making films, ads and marketing WITH ${userName}, one step at a time]`,
    `Work like a director on a live call: do one step, put the options in front of ${userName}, let him choose, then the next step. Never run a whole film in the background and come back with a finished thing.`,
    guides.length
      ? `Guides — ONE per use case, always current. Before the first step of a project, read the guide for its use case; re-read the step you are on before each job. Follow it; the other skills are tools it points to. When ${userName} gives you a new tutorial, fold it into that guide (bump its version, add a changelog line).`
      : `No guides found in ${s.guidesDir}.`,
    ...guides.map((g) => `  ${g.name}: ${g.path}${g.version ? ` (v${g.version}${g.updated ? `, ${g.updated}` : ""})` : ""}${g.summary ? ` — ${g.summary}` : ""}`),
    "Start a generation — it runs in the background and you keep talking. One line on its own, one JSON object:",
    `  [[studio_job: {"engine":"nano-banana","n":4,"prompt":"<the full prompt>","ask":"Which cabin?","labels":["…"],"refs":["/abs/ref.png"],"aspect":"16:9","guide":"film","step":"2 assets"}]]`,
    "Engines:",
    ...engineLines,
    `A card shows at once ("making 4") and turns into the decision when the job lands; on a call you say one short line when it does. Say what you started in a sentence; don't describe pictures before they arrive. Up to ${MAX_PER_REPLY} studio lines per reply; at most 3 jobs running.`,
    "Put a choice up now, from files you already have (2–4 options, or a folder):",
    `  [[studio_decision: {"ask":"Which ship?","options":[{"file":"/abs/a.png","label":"black sails"},{"file":"/abs/b.png","label":"red"}]}]]   or   {"ask":"…","folder":"/abs/dir"}`,
    `He answers by voice, typing, a tap on an option, or by pasting a picture. Then regenerate (use the chosen file as a ref) or move to the next step.`,
    `Refs and option files may only come from: his studio folder, the guides, the creative folders (~/AHI/personal/creative, Avi's skills) and his own uploads (the option files listed below are his uploads). Anything else is refused.`,
    jobs.length ? "Jobs now:" : "No studio jobs yet.",
    ...jobs,
    ...decision,
    ...(notes.length ? ["Since your last turn:", ...notes.map((n) => `  ! ${n}`)] : []),
  ].join("\n");
}
