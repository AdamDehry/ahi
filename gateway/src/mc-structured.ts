/* ============================================================
   mc-structured.ts — H-040 Round 2 Task C1

   Structured (read + lightly-mutate) layer over the raw mission-
   control markdown files. Lives ALONGSIDE the existing
   `mission-control.ts` whole-file API — this module does NOT
   replace it. The legacy whole-file editor on /ui/mc still works.

   Scope of this file (Path B / C1):
     - parseL2(file)          → list of L2 sub-cards per source file
     - parseL3(file, taskId)  → single L3 detail object (incl. notes)
     - writeNotes(file, taskId, notes)
                              → atomic backup-then-write of just the
                                the operator's Notes block inside the entry,
                                NEVER touching the surrounding table
                                or section structure.

   What this module deliberately does NOT do (deferred to C2):
     - Mark complete / status mutation
     - Reassign / change-priority
     - Bulk operations
     - Full HANDOFF table row serializer

   That C2 work needs golden-file tests; we keep our blast radius
   tight for tonight by limiting writes to a regex-bounded HTML
   comment fence.

   Source-file conventions (per Avi spec §6 + observed format):
     HANDOFF.md     — pipe table rows under "## Pending Handoffs",
                       free-text H-### sections for full specs.
     TODAY.md       — "## YYYY-MM-DD" sections.
     ACTIVITY_FEED.md — "## YYYY-MM-DD — title" entries.
     TODO.md        — "- [ ]" / "- [x]" checklists with sections.
     AGENT_REGISTRY.md — pipe table + section per agent.
     ARCHITECTURE.md — "## Section" headings, document-shaped.
   ============================================================ */

import { readFileSync, writeFileSync, existsSync, renameSync, statSync, unlinkSync } from "fs";
import { resolve, join, dirname } from "path";
import { createHash } from "crypto";

const MC_ROOT = process.env.MC_DIR || resolve(process.env.AHI_HOME || resolve(process.env.HOME || "", "ahi"), "mission-control");

// ── L2 / L3 shapes ──────────────────────────────────────────────────────────

export interface L2Card {
  /** Stable ID. For HANDOFF rows that's the literal H-### token; for sections
   * derived from "##" headings it's a slug; for items without a natural ID
   * it's a short hash of the entry's first 80 chars. */
  id: string;
  /** Human title — the "Task" cell summary, the section heading, or the
   * activity entry's first clause. */
  title: string;
  /** Status emoji+text as it appears in source ("🟡 IN PROGRESS",
   * "✅ SHIPPED 2026-04-26", "☐ TODO", etc.) or "" if none. */
  status: string;
  /** Priority label as it appears in source ("P0", "P1", "P2 — QUEUED…")
   * or "" if none. */
  priority: string;
  /** Assigner → Assignee phrase, or "" if not applicable. */
  assignee: string;
  /** Group hint per Avi §3.3: "active" | "pending" | "done" | "archive" |
   * "today" | "yesterday" | "Apr 25" | section name | "". The PWA
   * decides how to render the grouping. */
  group: string;
  /** One-line summary for the row (first bold clause or first sentence). */
  summary: string;
}

export interface L3Detail extends L2Card {
  /** Full markdown body of the entry, ready to render in SpecBlock.
   * Excludes the operator-notes fence content (split out below). */
  spec: string;
  /** the operator's notes content, "" if none. */
  notes: string;
  /** The L1 card type this row came from (so the PWA knows where to
   * navigate back to). */
  l1: L1Type;
}

export type L1Type =
  | "handoff"
  | "today"
  | "activity"
  | "todo"
  | "agents"
  | "architecture";

const L1_TO_FILE: Record<L1Type, string> = {
  handoff: "HANDOFF.md",
  today: "TODAY.md",
  activity: "ACTIVITY_FEED.md",
  todo: "TODO.md",
  agents: "AGENT_REGISTRY.md",
  architecture: "ARCHITECTURE.md",
};

export const L1_CARDS: { id: L1Type; label: string; blurb: string }[] = [
  { id: "handoff", label: "Handoff", blurb: "Active work, deadlines, blockers" },
  { id: "today", label: "Today", blurb: "What shipped today and yesterday" },
  { id: "activity", label: "Activity", blurb: "Cross-agent progress log" },
  { id: "todo", label: "To-Do", blurb: "Backlog and next actions" },
  { id: "agents", label: "Agents", blurb: "Sub-agent roster and assignments" },
  { id: "architecture", label: "Architecture", blurb: "System architecture reference" },
];

// ── File access helpers (admin-only — non-admin users don't get
// structured MC in C1; the legacy whole-file API still serves them) ─────────

function pathFor(l1: L1Type): string {
  return join(MC_ROOT, L1_TO_FILE[l1]);
}

function readSource(l1: L1Type): string {
  const p = pathFor(l1);
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf-8");
}

// ── the operator's Notes fence handling — single source of truth for the regex.
// Notes always live inside HTML comment fences exactly so the legacy
// whole-file editor and any other markdown viewer treat them as invisible. ──

const NOTES_OPEN = "<!-- operator-notes -->";
const NOTES_CLOSE = "<!-- /operator-notes -->";
const NOTES_FENCE_RE = /<!--\s*operator-notes\s*-->([\s\S]*?)<!--\s*\/operator-notes\s*-->/;

function extractNotes(body: string): { spec: string; notes: string } {
  const m = body.match(NOTES_FENCE_RE);
  if (!m) return { spec: body.trimEnd(), notes: "" };
  const notes = m[1].trim();
  // Strip the fence (and any trailing blank line it leaves behind) from spec.
  const spec = (body.slice(0, m.index!) + body.slice(m.index! + m[0].length))
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return { spec, notes };
}

// ── Synthetic ID for entries without a natural one ──────────────────────────

function shortHash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 6);
}

// ── HANDOFF parser ──────────────────────────────────────────────────────────
//
// The HANDOFF table uses pipe-rows under "## Pending Handoffs" / "## Active
// Deadlines" sections. Each row's Task cell is multi-line — long blocks
// with embedded newlines and markdown. The full per-task spec ALSO lives
// further down the file as "## H-### Full Spec — ..." free-text sections.
//
// L2 strategy: surface every H-### we can find, prefer table-row metadata
// (assigner, priority) when present; merge the Full Spec body into L3.

interface HandoffRow {
  id: string;
  assignee: string;
  priority: string;
  task: string; // Raw task-cell text (may contain bold lead clause).
  spec: string; // Raw spec-cell text.
  rowStart: number; // byte offset in source — for write-back targeting.
  rowEnd: number;
  group: string; // "active" | "pending" | "archive" depending on enclosing section.
}

function parseHandoff(src: string): { rows: HandoffRow[]; specs: Map<string, { body: string; start: number; end: number }> } {
  const rows: HandoffRow[] = [];
  const specs = new Map<string, { body: string; start: number; end: number }>();

  // Walk line-by-line; track current "## Section" heading and any pipe table
  // we're currently inside. A row is a line starting with "| H-" (or
  // "| TODO-" / "| ACT-" if/when those formats land).
  const lines = src.split("\n");
  let currentSection = "";

  // Pre-compute byte offsets for each line for write-back math.
  const offsets: number[] = [0];
  for (let i = 0; i < lines.length; i++) {
    offsets.push(offsets[i] + lines[i].length + 1); // +1 for \n
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sectionMatch = line.match(/^##\s+(.+?)\s*$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      // FALL THROUGH — a "## H-NNN Full Spec ..." heading is also a
      // section heading, but we need its capture below to populate the
      // per-task spec map. Don't `continue` here.
    }

    // Pipe row that starts with "| H-..." (allow leading whitespace
    // for pasted rows; trim() before checking).
    const trimmed = line.trim();
    if (trimmed.startsWith("| H-") || trimmed.startsWith("|H-")) {
      const cells = splitPipeRow(trimmed);
      // Expected: [id, fromto, priority, task, spec]
      if (cells.length >= 4) {
        const id = cells[0].trim();
        const assignee = cells[1]?.trim() || "";
        const priority = cells[2]?.trim() || "";
        const task = cells[3]?.trim() || "";
        const spec = (cells[4] || "").trim();
        const lower = currentSection.toLowerCase();
        let group = "pending";
        if (lower.includes("active")) group = "active";
        else if (lower.includes("archive") || lower.includes("done")) group = "archive";
        else if (lower.includes("blocker")) group = "blocked";
        rows.push({
          id,
          assignee,
          priority,
          task,
          spec,
          rowStart: offsets[i],
          rowEnd: offsets[i + 1],
          group,
        });
      }
    }

    // "## H-NNN ..." headings outside the table = the per-task Full Spec
    // sections. Capture body until the next "##" or "---" delimiter.
    const specHeading = line.match(/^##\s+(H-[\w.\-]+)(?:\s|—|$)/);
    if (specHeading) {
      const id = specHeading[1];
      const start = offsets[i];
      // Walk forward to next "## " heading or "---" rule alone on a line.
      let j = i + 1;
      while (j < lines.length) {
        if (/^##\s+/.test(lines[j])) break;
        if (/^---\s*$/.test(lines[j]) && j + 1 < lines.length && /^##\s+/.test(lines[j + 1])) break;
        j++;
      }
      const end = offsets[j];
      const body = src.slice(start, end);
      specs.set(id, { body, start, end });
    }
  }

  return { rows, specs };
}

/** Split a pipe-table row into its cells. Strips the leading/trailing pipes
 * and unescapes "\|" inside cells. Cells preserve internal whitespace. */
function splitPipeRow(line: string): string[] {
  const inner = line.replace(/^\|/, "").replace(/\|\s*$/, "");
  const out: string[] = [];
  let buf = "";
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === "\\" && inner[i + 1] === "|") {
      buf += "|";
      i += 2;
      continue;
    }
    if (ch === "|") {
      out.push(buf);
      buf = "";
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  out.push(buf);
  return out;
}

/** Pull the first **bold lead clause** of a task cell; falls back to the
 * first sentence (up to ~120 chars). Used for L2 row summary. */
function deriveSummary(task: string): string {
  const bold = task.match(/\*\*([^*]+)\*\*/);
  if (bold) return bold[1].trim().replace(/\s+/g, " ").slice(0, 140);
  const firstSentence = task.split(/[.!?](?:\s|$)/)[0] || task;
  return firstSentence.replace(/\s+/g, " ").trim().slice(0, 140);
}

/** Pull a status emoji+text from anywhere in the task body. Looks for the
 * recognized status tokens (the same vocabulary HANDOFF + Avi spec use). */
function deriveStatus(text: string): string {
  // Scan in priority order — most specific first.
  const patterns: RegExp[] = [
    /(✅\s+SHIPPED(?:\s+\d{4}-\d{2}-\d{2})?)/,
    /(✅\s+DEPLOYED(?:\s+\d{4}-\d{2}-\d{2})?)/,
    /(✅\s+DONE(?:\s+\d{4}-\d{2}-\d{2})?)/,
    /(🔴\s+BLOCKED[^\n.]*)/,
    /(🟡\s+IN\s+PROGRESS[^\n.]*)/,
    /(🟢\s+UNBLOCKED[^\n.]*)/,
    /(⏸\s+DOWNGRADED[^\n.]*)/,
    /(⏸\s+DEFERRED[^\n.]*)/,
    /(☐\s+TODO[^\n.]*)/,
    /(P\d\s+—\s+QUEUED[^\n.]*)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1].trim().replace(/\s+/g, " ");
  }
  return "";
}

/** Pull a priority token from a "Priority" cell or anywhere in body.
 * Returns "P0" / "P1" / "P2" / "P3" / "" — Avi's two-axis dot needs this
 * to color the dot regardless of any trailing qualifier text. */
function derivePriority(priorityCell: string, fallbackBody = ""): string {
  const cell = priorityCell + " " + fallbackBody;
  const m = cell.match(/\bP([0-3])\b/);
  return m ? `P${m[1]}` : "";
}

// ── Public L2 / L3 surface ──────────────────────────────────────────────────

export function listL2(l1: L1Type): L2Card[] {
  const src = readSource(l1);
  if (!src) return [];

  switch (l1) {
    case "handoff": {
      const { rows } = parseHandoff(src);
      return rows.map((r): L2Card => ({
        id: r.id,
        title: deriveSummary(r.task),
        status: deriveStatus(r.task),
        priority: derivePriority(r.priority, r.task),
        assignee: r.assignee,
        group: r.group,
        summary: deriveSummary(r.task),
      }));
    }
    case "todo": {
      // Each "- [ ]" / "- [x]" line under a "### Section" becomes a sub-card.
      // Synthetic IDs: TODO-<6char hash of normalized text>.
      const out: L2Card[] = [];
      const lines = src.split("\n");
      let section = "";
      for (const line of lines) {
        const sec = line.match(/^###\s+(.+?)\s*$/);
        if (sec) { section = sec[1]; continue; }
        const item = line.match(/^-\s+\[(\s|x|X)\]\s+(.+?)\s*$/) || line.match(/^-\s+([⬜🔄✅])\s+(.+?)\s*$/);
        if (item) {
          const checked = /[xX]/.test(item[1]) || item[1] === "✅";
          const text = item[2];
          const id = `TODO-${shortHash(text)}`;
          const summary = deriveSummary(text);
          out.push({
            id,
            title: summary,
            status: checked ? "✅ DONE" : (item[1] === "🔄" ? "🟡 IN PROGRESS" : "☐ TODO"),
            priority: "",
            assignee: "",
            group: section || "todo",
            summary,
          });
        }
      }
      return out;
    }
    case "activity": {
      // Each "## YYYY-MM-DD — title" heading becomes a card. Date used as group.
      const out: L2Card[] = [];
      const re = /^##\s+(\d{4}-\d{2}-\d{2})\s+—\s+(.+?)\s*$/;
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(re);
        if (m) {
          const date = m[1];
          const title = m[2].trim();
          const id = `ACT-${date}-${shortHash(title)}`;
          out.push({
            id,
            title,
            status: "",
            priority: "",
            assignee: "",
            group: date,
            summary: title.replace(/\s+/g, " ").slice(0, 140),
          });
        }
      }
      return out;
    }
    case "today": {
      // Each "## YYYY-MM-DD ..." heading becomes a card.
      const out: L2Card[] = [];
      const re = /^##\s+(\d{4}-\d{2}-\d{2})(.*)$/;
      const lines = src.split("\n");
      for (const line of lines) {
        const m = line.match(re);
        if (m) {
          const date = m[1];
          const tail = m[2].trim();
          const id = `TODAY-${date}`;
          out.push({
            id,
            title: tail || date,
            status: "",
            priority: "",
            assignee: "",
            group: date,
            summary: (tail || date).slice(0, 140),
          });
        }
      }
      return out;
    }
    case "agents":
    case "architecture": {
      // Document-shaped: every "## Section" → one card.
      const out: L2Card[] = [];
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^##\s+(.+?)\s*$/);
        if (!m) continue;
        const heading = m[1].trim();
        const id = `${l1.toUpperCase()}-${shortHash(heading)}`;
        // First non-empty body line for summary.
        let summary = "";
        for (let j = i + 1; j < lines.length && j < i + 8; j++) {
          const t = lines[j].trim();
          if (!t || t.startsWith("##") || t.startsWith("---")) continue;
          summary = t.replace(/[*_`#>]/g, "").slice(0, 140);
          break;
        }
        out.push({
          id,
          title: heading,
          status: "",
          priority: "",
          assignee: "",
          group: l1,
          summary,
        });
      }
      return out;
    }
  }
}

export function readL3(l1: L1Type, taskId: string): L3Detail | null {
  const src = readSource(l1);
  if (!src) return null;

  const card = listL2(l1).find((c) => c.id === taskId);
  if (!card) return null;

  // Compose the spec body. For HANDOFF: prefer the "## H-NNN Full Spec"
  // section if it exists; otherwise fall back to the row's task+spec cells.
  let body = "";
  if (l1 === "handoff") {
    const { rows, specs } = parseHandoff(src);
    const fullSpec = specs.get(taskId);
    const row = rows.find((r) => r.id === taskId);
    if (fullSpec) {
      body = fullSpec.body;
    } else if (row) {
      // Re-render the row's free-text cell as a markdown body. The pipe
      // syntax is just storage; the cell content is markdown that renders
      // fine when extracted.
      body = `**${row.priority}** — ${row.assignee}\n\n${row.task}\n\n${row.spec ? `\n\n${row.spec}` : ""}`;
      // Pull in any trailing operator-notes fence that lives right after the
      // row (notes are appended there when no Full Spec section exists).
      const after = src.slice(row.rowEnd);
      const fenceMatch = after.match(/^\s*<!--\s*operator-notes\s*-->[\s\S]*?<!--\s*\/operator-notes\s*-->/);
      if (fenceMatch) body += "\n\n" + fenceMatch[0];
    }
  } else if (l1 === "todo" || l1 === "activity" || l1 === "today" || l1 === "agents" || l1 === "architecture") {
    body = sliceSection(src, l1, taskId);
  }

  const { spec, notes } = extractNotes(body);

  return {
    ...card,
    spec,
    notes,
    l1,
  };
}

/** For section-shaped files: return the slice from the matched heading
 * up to the next "## " heading (or EOF). For TODO: the line itself. */
function sliceSection(src: string, l1: L1Type, taskId: string): string {
  const lines = src.split("\n");

  if (l1 === "todo") {
    // Find the line whose hash matches.
    for (const line of lines) {
      const item = line.match(/^-\s+\[(\s|x|X)\]\s+(.+?)\s*$/) || line.match(/^-\s+([⬜🔄✅])\s+(.+?)\s*$/);
      if (item && `TODO-${shortHash(item[2])}` === taskId) {
        return item[2];
      }
    }
    return "";
  }

  // For activity / today / agents / architecture — find the matching "##"
  // heading by re-deriving its synthetic ID and slice until next "##".
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/);
    if (!m) continue;
    const heading = m[1].trim();
    let id = "";
    let activityBody = ""; // For activity, the spec is often appended to the heading line itself.
    if (l1 === "activity") {
      const ad = heading.match(/^(\d{4}-\d{2}-\d{2})\s+—\s+(.+)$/);
      if (ad) {
        id = `ACT-${ad[1]}-${shortHash(ad[2].trim())}`;
        activityBody = ad[2].trim();
      }
    } else if (l1 === "today") {
      const td = heading.match(/^(\d{4}-\d{2}-\d{2})/);
      if (td) id = `TODAY-${td[1]}`;
    } else {
      id = `${l1.toUpperCase()}-${shortHash(heading)}`;
    }
    if (id !== taskId) continue;
    // Slice forward.
    let j = i + 1;
    while (j < lines.length && !/^##\s+/.test(lines[j])) j++;
    const after = lines.slice(i + 1, j).join("\n").trim();
    if (l1 === "activity") {
      // Activity entries embed the body on the heading line; surface it as
      // the spec body so SpecBlock has something to render.
      return [activityBody, after].filter(Boolean).join("\n\n");
    }
    return after;
  }
  return "";
}

// ── Notes write-back — the ONE mutation point in C1 ─────────────────────────
//
// Atomic, regex-bounded edit of just the operator-notes fence inside a single
// task entry. Never touches the surrounding pipe table or section structure.
//
// Algorithm:
//   1. Read source.
//   2. Find the byte range of the target entry.
//   3. Inside that range, REPLACE existing fence (regex), or APPEND new
//      fence (with surrounding blank lines).
//   4. Write the modified text to a temp sibling file.
//   5. Rename current source → "<file>.bak-<ts>" (atomic on same FS).
//   6. Rename temp → source (atomic).
//
// On any failure, the original `<file>` either still exists at its
// original path OR exists as the timestamped backup — we never leave
// partial/empty state.

export interface WriteNotesResult {
  ok: true;
  backupPath: string;
  bytesWritten: number;
}

export interface WriteNotesError {
  ok: false;
  error: string;
}

export function writeNotes(
  l1: L1Type,
  taskId: string,
  notes: string,
): WriteNotesResult | WriteNotesError {
  const filePath = pathFor(l1);
  if (!existsSync(filePath)) return { ok: false, error: `MC file not found: ${filePath}` };

  const src = readFileSync(filePath, "utf-8");
  const range = findEntryRange(l1, src, taskId);
  if (!range) return { ok: false, error: `Entry not found: ${taskId} in ${l1}` };

  const before = src.slice(0, range.start);
  const entry = src.slice(range.start, range.end);
  const after = src.slice(range.end);

  const trimmedNotes = notes.trim();
  let newEntry: string;

  if (NOTES_FENCE_RE.test(entry)) {
    if (trimmedNotes.length === 0) {
      // Remove the fence entirely (and a single surrounding blank line if
      // its removal leaves a triple newline).
      newEntry = entry.replace(NOTES_FENCE_RE, "").replace(/\n{3,}/g, "\n\n");
    } else {
      newEntry = entry.replace(
        NOTES_FENCE_RE,
        `${NOTES_OPEN}\n${trimmedNotes}\n${NOTES_CLOSE}`,
      );
    }
  } else {
    if (trimmedNotes.length === 0) {
      // No fence and nothing to write — no-op success.
      return { ok: true, backupPath: "", bytesWritten: 0 };
    }
    // Append fence at the end of the entry, with a leading blank line so
    // it visually separates from whatever came before.
    const trimmedEntry = entry.replace(/\s+$/, "");
    const fence = `\n\n${NOTES_OPEN}\n${trimmedNotes}\n${NOTES_CLOSE}\n`;
    newEntry = trimmedEntry + fence;
    // Preserve trailing newline that was on the original entry, if any —
    // we want to leave the file's surrounding whitespace shape intact.
    if (entry.endsWith("\n\n")) newEntry += "\n";
  }

  const next = before + newEntry + after;

  // Atomic write: temp → backup current → rename temp into place.
  const dir = dirname(filePath);
  const ts = Date.now();
  const tempPath = join(dir, `.${L1_TO_FILE[l1]}.tmp.${process.pid}.${ts}`);
  const backupPath = `${filePath}.bak-${ts}`;

  try {
    writeFileSync(tempPath, next, "utf-8");
  } catch (err) {
    return { ok: false, error: `Write temp failed: ${(err as Error).message}` };
  }

  try {
    renameSync(filePath, backupPath);
  } catch (err) {
    // Roll back the temp.
    try {
      unlinkSync(tempPath);
    } catch {/* ignore */}
    return { ok: false, error: `Backup failed: ${(err as Error).message}` };
  }

  try {
    renameSync(tempPath, filePath);
  } catch (err) {
    // Try to restore the original from backup.
    try {
      renameSync(backupPath, filePath);
    } catch {/* ignore */}
    return { ok: false, error: `Atomic swap failed: ${(err as Error).message}` };
  }

  const bytes = statSync(filePath).size;
  return { ok: true, backupPath, bytesWritten: bytes };
}

/** Find the [start,end) byte range of a single entry in a source file.
 * Definition of "entry" depends on L1 type:
 *   - handoff: prefer the "## H-NNN Full Spec" section if present (so notes
 *              live with the long-form spec); fall back to the table row.
 *   - today / activity / agents / architecture: the "## Heading" block up
 *              to the next "## " heading.
 *   - todo: the single line containing the matching item. (Notes for a
 *           single-line item append directly under it as a new paragraph
 *           between fences — keeps the fence regex valid.)
 */
function findEntryRange(l1: L1Type, src: string, taskId: string): { start: number; end: number } | null {
  const lines = src.split("\n");
  const offsets: number[] = [0];
  for (let i = 0; i < lines.length; i++) {
    offsets.push(offsets[i] + lines[i].length + 1);
  }

  if (l1 === "handoff") {
    const { rows, specs } = parseHandoff(src);
    const fullSpec = specs.get(taskId);
    if (fullSpec) return { start: fullSpec.start, end: fullSpec.end };
    const row = rows.find((r) => r.id === taskId);
    if (row) {
      // Extend the entry range to include a trailing operator-notes fence,
      // if one was previously appended right after this row. Otherwise
      // a second writeNotes call wouldn't see the existing fence (it's
      // outside the bare row range) and would stack a second one.
      let end = row.rowEnd;
      const after = src.slice(end);
      const fenceMatch = after.match(/^\s*<!--\s*operator-notes\s*-->[\s\S]*?<!--\s*\/operator-notes\s*-->\s*\n?/);
      if (fenceMatch) end += fenceMatch[0].length;
      return { start: row.rowStart, end };
    }
    return null;
  }

  if (l1 === "todo") {
    for (let i = 0; i < lines.length; i++) {
      const item = lines[i].match(/^-\s+\[(\s|x|X)\]\s+(.+?)\s*$/) || lines[i].match(/^-\s+([⬜🔄✅])\s+(.+?)\s*$/);
      if (item && `TODO-${shortHash(item[2])}` === taskId) {
        return { start: offsets[i], end: offsets[i + 1] };
      }
    }
    return null;
  }

  // Section-shaped files.
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/);
    if (!m) continue;
    const heading = m[1].trim();
    let id = "";
    if (l1 === "activity") {
      const ad = heading.match(/^(\d{4}-\d{2}-\d{2})\s+—\s+(.+)$/);
      if (ad) id = `ACT-${ad[1]}-${shortHash(ad[2].trim())}`;
    } else if (l1 === "today") {
      const td = heading.match(/^(\d{4}-\d{2}-\d{2})/);
      if (td) id = `TODAY-${td[1]}`;
    } else {
      id = `${l1.toUpperCase()}-${shortHash(heading)}`;
    }
    if (id !== taskId) continue;
    let j = i + 1;
    while (j < lines.length && !/^##\s+/.test(lines[j])) j++;
    return { start: offsets[i], end: offsets[j] };
  }
  return null;
}
