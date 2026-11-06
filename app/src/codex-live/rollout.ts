/**
 * rollout.ts — a Codex rollout JSONL, read as a live transcript.
 *
 * Codex (0.162) writes one rollout per session under
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl, appended as the
 * session runs. The records this view uses:
 *
 *   session_meta                       first line: id, cwd, originator, cli_version
 *   turn_context                       model, effort
 *   event_msg task_started / task_complete / turn_aborted   the turn is open / closed
 *   event_msg item_completed
 *     AgentMessage                     what Codex says (commentary + final)
 *     UserMessage                      the brief, and every steer typed in later
 *     CommandExecution                 a command it ran: parsed_cmd, exit_code, duration
 *     FileChange                       files it added / updated / deleted
 *     Extension (web.search), ImageView
 *   response_item custom_tool_call / function_call (+ _output)   a tool call in flight
 *
 * PURE: lines in, events out. Every string that leaves goes through the
 * caller's redactor, and command OUTPUT never leaves at all — it is where an
 * `env` dump or a cat'd config would carry a credential, and the view only
 * needs to know a command ran and how it ended. Reasoning is encrypted in the
 * rollout and is never shown; it only counts as activity.
 *
 * Unknown record types are skipped, never fatal: a newer Codex adds records
 * and the view keeps working on the ones it knows.
 */

export type LiveEvent =
  | { seq: number; at: string; kind: "say"; text: string; final: boolean }
  | { seq: number; at: string; kind: "user"; text: string; brief: boolean }
  | { seq: number; at: string; kind: "cmd"; verb: "read" | "search" | "list" | "run"; text: string; exit: number | null; ms: number | null }
  | { seq: number; at: string; kind: "edit"; files: Array<{ path: string; op: string; plus: number; minus: number }> }
  | { seq: number; at: string; kind: "web"; text: string }
  | { seq: number; at: string; kind: "turn"; phase: "start" | "end" | "aborted"; ms: number | null };

export type LiveEventBody = LiveEvent extends infer E ? (E extends LiveEvent ? Omit<E, "seq"> : never) : never;

export interface ParseState {
  seq: number;
  session: { id: string; cwd: string; originator: string | null; cli: string | null; model: string | null; effort: string | null } | null;
  turnOpen: boolean;
  turnStartedAt: string | null;
  lastActivityAt: string | null;
  /** Tool calls issued and not yet answered — call_id → what it is running. */
  inFlight: Map<string, { at: string; text: string }>;
  /** AgentMessage ids already emitted (the same message also arrives as a response_item). */
  saidIds: Set<string>;
  turns: number;
}

export function newParseState(): ParseState {
  return { seq: 0, session: null, turnOpen: false, turnStartedAt: null, lastActivityAt: null, inFlight: new Map(), saidIds: new Set(), turns: 0 };
}

export interface ParseOpts {
  redact: (s: string) => string;
  /** The build's workdir: paths under it are shown relative. */
  workdir?: string;
}

const MAX_SAY = 4000;
const MAX_USER = 700;
const MAX_CMD = 240;
const MAX_FILES = 20;

export function clip(s: string, max: number): string {
  const t = s.replace(/\r/g, "");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function rel(path: string, workdir?: string): string {
  let p = path.replace(/^file:\/\//, "");
  if (workdir) {
    const w = workdir.replace(/\/+$/, "");
    if (p === w) return ".";
    if (p.startsWith(w + "/")) p = p.slice(w.length + 1);
  }
  return p;
}

/**
 * The brief carries the whole active-gate block first; on a phone that is
 * a wall. Show what comes after it — the brief itself — and say it is the brief.
 */
export function briefText(text: string): { text: string; brief: boolean } {
  const end = text.indexOf("═══ END ACTIVE GATES");
  if (end >= 0) {
    const after = text.slice(text.indexOf("\n", end) + 1 || end).trim();
    return { text: after, brief: true };
  }
  if (text.startsWith("═══ ACTIVE GATES")) return { text: "", brief: true };
  return { text, brief: false };
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
    .join("");
}

/** `/bin/bash -lc "cd /w && rg foo"` → "rg foo". */
function commandText(item: Record<string, unknown>, workdir?: string): { verb: "read" | "search" | "list" | "run"; text: string } {
  const parsed = Array.isArray(item.parsed_cmd) ? (item.parsed_cmd as Array<Record<string, unknown>>) : [];
  const verbs = new Set(parsed.map((p) => String(p.type ?? "unknown")));
  let verb: "read" | "search" | "list" | "run" = "run";
  if (parsed.length && verbs.size === 1) {
    const only = [...verbs][0];
    if (only === "read") verb = "read";
    else if (only === "search") verb = "search";
    else if (only === "list_files") verb = "list";
  }
  let text = "";
  if (parsed.length) text = parsed.map((p) => String(p.cmd ?? "")).filter(Boolean).join(" && ");
  if (!text) {
    const cmd = item.command;
    if (Array.isArray(cmd)) text = String(cmd[cmd.length - 1] ?? "");
    else if (typeof cmd === "string") text = cmd;
  }
  if (workdir) text = text.split(`cd ${workdir} && `).join("");
  return { verb, text: oneLine(text) };
}

/** What a code-mode tool call is about to run: the `cmd:"…"` strings inside its script. */
function pendingText(payload: Record<string, unknown>): string {
  const input = typeof payload.input === "string" ? payload.input : typeof payload.arguments === "string" ? payload.arguments : "";
  const cmds: string[] = [];
  const re = /\bcmd"?\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  for (let m = re.exec(input); m && cmds.length < 3; m = re.exec(input)) {
    try {
      cmds.push(JSON.parse(`"${m[1]}"`) as string);
    } catch {
      cmds.push(m[1]);
    }
  }
  if (cmds.length) return oneLine(cmds.join(" ; "));
  const name = typeof payload.name === "string" ? payload.name : "tool";
  return name;
}

function countDiff(diff: string): { plus: number; minus: number } {
  let plus = 0;
  let minus = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) plus++;
    else if (line.startsWith("-")) minus++;
  }
  return { plus, minus };
}

function ms(started: unknown, completed: unknown): number | null {
  return typeof started === "number" && typeof completed === "number" && completed >= started ? completed - started : null;
}

function secondsOrMore(v: number | null): number | null {
  return v !== null && v >= 1000 ? v : null;
}

function durationMs(d: unknown): number | null {
  if (!d || typeof d !== "object") return null;
  const { secs, nanos } = d as { secs?: unknown; nanos?: unknown };
  if (typeof secs !== "number") return null;
  return Math.round(secs * 1000 + (typeof nanos === "number" ? nanos / 1e6 : 0));
}

/**
 * One rollout line → zero or more events (state updated in place).
 * A torn or non-JSON line yields nothing.
 */
export function parseLine(line: string, st: ParseState, opts: ParseOpts): LiveEvent[] {
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (!row || typeof row !== "object") return [];
  const at = typeof row.timestamp === "string" ? row.timestamp : new Date().toISOString();
  const p = (row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>;
  const R = opts.redact;
  const out: LiveEventBody[] = [];

  switch (row.type) {
    case "session_meta": {
      st.session = {
        id: String(p.id ?? p.session_id ?? ""),
        cwd: String(p.cwd ?? ""),
        originator: typeof p.originator === "string" ? p.originator : null,
        cli: typeof p.cli_version === "string" ? p.cli_version : null,
        model: st.session?.model ?? null,
        effort: st.session?.effort ?? null,
      };
      break;
    }
    case "turn_context": {
      if (st.session) {
        if (typeof p.model === "string") st.session.model = p.model;
        if (typeof p.effort === "string") st.session.effort = p.effort;
      }
      break;
    }
    case "event_msg": {
      const t = p.type;
      if (t === "task_started") {
        st.turnOpen = true;
        st.turnStartedAt = at;
        st.turns++;
        out.push({ at, kind: "turn", phase: "start", ms: null });
      } else if (t === "task_complete" || t === "turn_aborted") {
        st.turnOpen = false;
        st.inFlight.clear();
        const d = typeof p.duration_ms === "number" ? p.duration_ms : st.turnStartedAt ? Date.parse(at) - Date.parse(st.turnStartedAt) : null;
        out.push({ at, kind: "turn", phase: t === "task_complete" ? "end" : "aborted", ms: d !== null && Number.isFinite(d) ? d : null });
      } else if (t === "item_completed" && p.item && typeof p.item === "object") {
        const item = p.item as Record<string, unknown>;
        switch (item.type) {
          case "AgentMessage": {
            const id = String(item.id ?? "");
            if (id && st.saidIds.has(id)) break;
            if (id) st.saidIds.add(id);
            const text = clip(R(textOf(item.content).trim()), MAX_SAY);
            if (text) out.push({ at, kind: "say", text, final: item.phase === "final_answer" || item.phase === "final" });
            break;
          }
          case "UserMessage": {
            const b = briefText(textOf(item.content).trim());
            const text = clip(R(b.text), MAX_USER);
            if (text || b.brief) out.push({ at, kind: "user", text, brief: b.brief });
            break;
          }
          case "CommandExecution": {
            const c = commandText(item, opts.workdir);
            out.push({
              at,
              kind: "cmd",
              verb: c.verb,
              text: clip(R(c.text), MAX_CMD),
              exit: typeof item.exit_code === "number" ? item.exit_code : null,
              // Sub-second timings are code-mode wrapper noise, not the command's own time.
              ms: secondsOrMore(durationMs(item.duration) ?? ms(p.started_at_ms, p.completed_at_ms)),
            });
            break;
          }
          case "FileChange": {
            const changes = item.changes && typeof item.changes === "object" ? (item.changes as Record<string, Record<string, unknown>>) : {};
            const files = Object.entries(changes)
              .slice(0, MAX_FILES)
              .map(([path, ch]) => {
                const op = String(ch?.type ?? "update");
                const n =
                  typeof ch?.unified_diff === "string"
                    ? countDiff(ch.unified_diff)
                    : typeof ch?.content === "string"
                      ? { plus: op === "delete" ? 0 : ch.content.split("\n").length, minus: op === "delete" ? ch.content.split("\n").length : 0 }
                      : { plus: 0, minus: 0 };
                return { path: clip(R(rel(path, opts.workdir)), 200), op, ...n };
              });
            if (files.length) out.push({ at, kind: "edit", files });
            break;
          }
          case "Extension": {
            const action = (item.action ?? {}) as Record<string, unknown>;
            const what = typeof action.url === "string" ? action.url : typeof item.query === "string" ? item.query : String(item.kind ?? "extension");
            out.push({ at, kind: "web", text: clip(R(oneLine(`${item.kind === "web.search" ? "Web" : String(item.kind ?? "Tool")}: ${what}`)), MAX_CMD) });
            break;
          }
          case "ImageView": {
            out.push({ at, kind: "web", text: clip(R(`Looked at image ${rel(String(item.path ?? ""), opts.workdir)}`), MAX_CMD) });
            break;
          }
          default:
            break;
        }
      }
      break;
    }
    case "response_item": {
      const t = p.type;
      if (t === "custom_tool_call" || t === "function_call") {
        const id = String(p.call_id ?? p.id ?? "");
        if (id) st.inFlight.set(id, { at, text: clip(R(pendingText(p)), MAX_CMD) });
      } else if (t === "custom_tool_call_output" || t === "function_call_output") {
        st.inFlight.delete(String(p.call_id ?? ""));
      } else if (t === "message" && p.role === "assistant") {
        // Older builds without item_completed: the response_item is the only copy.
        const id = String(p.id ?? "");
        if (id && st.saidIds.has(id)) break;
        if (id) st.saidIds.add(id);
        const text = clip(R(textOf(p.content).trim()), MAX_SAY);
        if (text) out.push({ at, kind: "say", text, final: p.phase === "final_answer" });
      }
      break;
    }
    default:
      break;
  }

  if (row.type === "response_item" || row.type === "event_msg") st.lastActivityAt = at;
  return out.map((e) => ({ ...e, seq: ++st.seq }) as LiveEvent);
}
