/**
 * Bills — each user's OWN private list of bills.
 *
 * a family member sees none of the owner's money: not the household, not the business,
 * nothing from Costs. She gets an empty Bills tab that is hers alone: she adds
 * bills by hand, and Miriam adds or edits them when she asks in chat.
 *
 * ── Scoping ──────────────────────────────────────────────────────────────
 * Storage is one file per user, inside that user's own data root:
 *   <gateway business root>/<userId>/bills.json   (multiUserPaths().businessRoot)
 * Every read and write takes the userId from the AUTHENTICATED request (app)
 * or from the turn's own user (Miriam) — never from the request body. There is
 * no cross-user read path at all, admin included: the owner's bills are his file,
 * hers are hers. Writes are serialized per user and atomic.
 *
 * ── Miriam ───────────────────────────────────────────────────────────────
 * An agent edits bills by writing a line in its reply:
 *   [[bill: {"op":"add","name":"Phone","amount":85,"dueDay":5,"autopay":true}]]
 *   [[bill: {"op":"update","id":"b-…","amount":90}]]
 *   [[bill: {"op":"delete","id":"b-…"}]]
 * The gateway applies it to the bills of the user that turn belongs to,
 * strips the line, and the tab updates live. Only agents in BILLS_AGENTS
 * (default: miriam) may; anyone else's lines are stripped and ignored.
 * ============================================================ */
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { atomicWriteJson, multiUserPaths } from "./multi-user-paths.js";

export type BillRecurrence = "monthly" | "yearly" | "weekly" | "once";

export interface Bill {
  id: string;
  name: string;
  amount: number | null;
  /** Day of the month it is due (monthly bills). */
  dueDay: number | null;
  /** A specific due date, YYYY-MM-DD (one-off, yearly, or the next due date). */
  dueDate: string | null;
  recurring: BillRecurrence;
  autopay: boolean;
  link: string | null;
  notes: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  /** "user" or "agent:<name>" — who last changed it. */
  updatedBy: string;
}

export interface BillSettings {
  currency: string;
  /** Days before a due date to remind; null = no reminders. */
  remindDaysBefore: number | null;
}

export interface BillsFile {
  schema_version: 1;
  bills: Bill[];
  settings: BillSettings;
}

const DEFAULT_SETTINGS: BillSettings = { currency: "USD", remindDaysBefore: null };
const RECURRENCES: BillRecurrence[] = ["monthly", "yearly", "weekly", "once"];
export const MAX_BILLS = 200;

export function billsPath(userId: string): string {
  return join(multiUserPaths(userId).businessRoot, "bills.json");
}

export function readBills(userId: string): BillsFile {
  const p = billsPath(userId);
  if (!existsSync(p)) return { schema_version: 1, bills: [], settings: { ...DEFAULT_SETTINGS } };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<BillsFile>;
    return {
      schema_version: 1,
      bills: Array.isArray(raw.bills) ? raw.bills : [],
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    };
  } catch (err) {
    console.warn(`[bills] unreadable bills file for ${userId}: ${(err as Error).message}`);
    return { schema_version: 1, bills: [], settings: { ...DEFAULT_SETTINGS } };
  }
}

function writeBills(userId: string, file: BillsFile): void {
  const p = billsPath(userId);
  mkdirSync(dirname(p), { recursive: true });
  atomicWriteJson(p, file);
}

/* ── Validation ──────────────────────────────────────────────────────── */

export type BillInput = Partial<Omit<Bill, "id" | "createdAt" | "updatedAt" | "updatedBy">>;
type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function str(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function money(v: unknown): number | null | undefined {
  if (v === null || v === "") return null;
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 && n < 1e7 ? Math.round(n * 100) / 100 : NaN;
}

/** Cleans one patch. `full` = a new bill (name required). */
export function checkBillInput(input: Record<string, unknown>, full: boolean): Checked<BillInput> {
  const out: BillInput = {};
  if ("name" in input || full) {
    const name = str(input.name, 120);
    if (!name) return { ok: false, error: "A bill needs a name" };
    out.name = name;
  }
  if ("amount" in input) {
    const a = money(input.amount);
    if (Number.isNaN(a)) return { ok: false, error: "Amount must be a number" };
    out.amount = a ?? null;
  }
  if ("dueDay" in input) {
    if (input.dueDay === null || input.dueDay === "") out.dueDay = null;
    else {
      const d = Number(input.dueDay);
      if (!Number.isInteger(d) || d < 1 || d > 31) return { ok: false, error: "Due day must be 1 to 31" };
      out.dueDay = d;
    }
  }
  if ("dueDate" in input) {
    const d = str(input.dueDate, 10);
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, error: "Due date must be YYYY-MM-DD" };
    out.dueDate = d;
  }
  if ("recurring" in input) {
    const r = String(input.recurring ?? "").toLowerCase() as BillRecurrence;
    if (!RECURRENCES.includes(r)) return { ok: false, error: `Recurring must be one of ${RECURRENCES.join(", ")}` };
    out.recurring = r;
  }
  if ("autopay" in input) out.autopay = input.autopay === true || input.autopay === "true" || input.autopay === "yes";
  if ("active" in input) out.active = input.active !== false && input.active !== "false";
  if ("link" in input) {
    const l = str(input.link, 500);
    if (l && !/^https?:\/\//i.test(l)) return { ok: false, error: "Link must start with http:// or https://" };
    out.link = l;
  }
  if ("notes" in input) out.notes = str(input.notes, 2000);
  return { ok: true, value: out };
}

export function checkSettings(input: Record<string, unknown>): Checked<Partial<BillSettings>> {
  const out: Partial<BillSettings> = {};
  if ("currency" in input) {
    const c = str(input.currency, 3)?.toUpperCase() ?? "USD";
    if (!/^[A-Z]{3}$/.test(c)) return { ok: false, error: "Currency must be a 3-letter code" };
    out.currency = c;
  }
  if ("remindDaysBefore" in input) {
    if (input.remindDaysBefore === null || input.remindDaysBefore === "") out.remindDaysBefore = null;
    else {
      const n = Number(input.remindDaysBefore);
      if (!Number.isInteger(n) || n < 0 || n > 30) return { ok: false, error: "Reminder must be 0 to 30 days" };
      out.remindDaysBefore = n;
    }
  }
  return { ok: true, value: out };
}

/* ── Mutations (serialized per user) ─────────────────────────────────── */

const chains = new Map<string, Promise<unknown>>();
function serial<T>(userId: string, fn: () => T): Promise<T> {
  const prev = chains.get(userId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(userId, next.catch(() => {}));
  return next;
}

type Listener = (userId: string, file: BillsFile) => void;
let onChange: Listener | null = null;
/** The gateway wires this to a per-user socket event so the tab updates live. */
export function setBillsChangeListener(fn: Listener | null): void {
  onChange = fn;
}

export type BillsResult = { ok: true; file: BillsFile; bill?: Bill } | { ok: false; status: 400 | 404 | 409; error: string };

export function addBill(userId: string, input: Record<string, unknown>, by = "user"): Promise<BillsResult> {
  return serial(userId, () => {
    const c = checkBillInput(input, true);
    if (!c.ok) return { ok: false as const, status: 400 as const, error: c.error };
    const file = readBills(userId);
    if (file.bills.length >= MAX_BILLS) return { ok: false as const, status: 409 as const, error: `At most ${MAX_BILLS} bills` };
    const now = new Date().toISOString();
    const bill: Bill = {
      id: `b-${randomUUID().slice(0, 8)}`,
      name: c.value.name!,
      amount: c.value.amount ?? null,
      dueDay: c.value.dueDay ?? null,
      dueDate: c.value.dueDate ?? null,
      recurring: c.value.recurring ?? "monthly",
      autopay: c.value.autopay ?? false,
      link: c.value.link ?? null,
      notes: c.value.notes ?? null,
      active: c.value.active ?? true,
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
    };
    file.bills.push(bill);
    writeBills(userId, file);
    onChange?.(userId, file);
    return { ok: true as const, file, bill };
  });
}

export function updateBill(userId: string, id: string, input: Record<string, unknown>, by = "user"): Promise<BillsResult> {
  return serial(userId, () => {
    const c = checkBillInput(input, false);
    if (!c.ok) return { ok: false as const, status: 400 as const, error: c.error };
    const file = readBills(userId);
    const bill = file.bills.find((b) => b.id === id);
    if (!bill) return { ok: false as const, status: 404 as const, error: "No such bill" };
    Object.assign(bill, c.value, { updatedAt: new Date().toISOString(), updatedBy: by });
    writeBills(userId, file);
    onChange?.(userId, file);
    return { ok: true as const, file, bill };
  });
}

export function deleteBill(userId: string, id: string): Promise<BillsResult> {
  return serial(userId, () => {
    const file = readBills(userId);
    const i = file.bills.findIndex((b) => b.id === id);
    if (i < 0) return { ok: false as const, status: 404 as const, error: "No such bill" };
    file.bills.splice(i, 1);
    writeBills(userId, file);
    onChange?.(userId, file);
    return { ok: true as const, file };
  });
}

export function saveBillSettings(userId: string, input: Record<string, unknown>): Promise<BillsResult> {
  return serial(userId, () => {
    const c = checkSettings(input);
    if (!c.ok) return { ok: false as const, status: 400 as const, error: c.error };
    const file = readBills(userId);
    file.settings = { ...file.settings, ...c.value };
    writeBills(userId, file);
    onChange?.(userId, file);
    return { ok: true as const, file };
  });
}

/* ── Agent side ──────────────────────────────────────────────────────── */

export const BILL_SENTINEL_RE = /^[ \t]*\[\[bill:\s*(\{.*\})\s*\]\][ \t]*$/gm;

export function billsAgents(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.BILLS_AGENTS ?? "miriam").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Applies every `[[bill: {...}]]` line in an agent reply to the bills of the
 * user this turn belongs to, and returns the reply without those lines.
 */
export async function applyBillSentinels(
  response: string,
  opts: { userId: string | null | undefined; bot: string },
): Promise<{ cleaned: string; applied: number; failed: string[] }> {
  const re = new RegExp(BILL_SENTINEL_RE.source, "gm");
  const ops: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(response)) !== null) ops.push(m[1]);
  if (!ops.length) return { cleaned: response, applied: 0, failed: [] };
  const cleaned = response.replace(new RegExp(`${BILL_SENTINEL_RE.source}\\r?\\n?`, "gm"), "").replace(/\n{3,}/g, "\n\n").trim();
  const userId = opts.userId;
  if (!userId || userId === "unknown" || !billsAgents().includes(opts.bot)) {
    console.warn(`[bills] ${ops.length} bill line(s) from ${opts.bot} ignored (user ${userId ?? "none"} or agent not allowed)`);
    return { cleaned, applied: 0, failed: ops };
  }
  let applied = 0;
  const failed: string[] = [];
  for (const raw of ops) {
    let op: Record<string, unknown>;
    try {
      op = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      failed.push(raw);
      continue;
    }
    const by = `agent:${opts.bot}`;
    const kind = String(op.op ?? "").toLowerCase();
    const { op: _o, id, ...fields } = op;
    const r =
      kind === "add"
        ? await addBill(userId, fields, by)
        : kind === "update" && typeof id === "string"
          ? await updateBill(userId, id, fields, by)
          : kind === "delete" && typeof id === "string"
            ? await deleteBill(userId, id)
            : ({ ok: false, status: 400, error: "unknown op" } as const);
    if (r.ok) applied++;
    else failed.push(`${kind}: ${r.error}`);
  }
  console.log(`[bills] ${opts.bot} → ${userId}: ${applied} applied${failed.length ? `, ${failed.length} failed (${failed.join("; ")})` : ""}`);
  return { cleaned, applied, failed };
}

/** What the agent is told each turn: how to edit, and the user's current list. */
export function billsAgentHint(bot: string, userId: string | null | undefined, userName: string): string {
  if (!userId || userId === "unknown" || !billsAgents().includes(bot)) return "";
  const file = readBills(userId);
  const list = file.bills.slice(0, 60).map((b) => {
    const due = b.dueDate ? `due ${b.dueDate}` : b.dueDay ? `due day ${b.dueDay}` : "no due date";
    const amt = b.amount === null ? "amount unknown" : `${file.settings.currency} ${b.amount}`;
    return `- ${b.id}: ${b.name}, ${amt}, ${due}, ${b.recurring}${b.autopay ? ", autopay" : ""}${b.active ? "" : ", paused"}${b.link ? `, link ${b.link}` : ""}`;
  });
  return [
    `[BILLS — ${userName}'s own private bills tab in the AHI app]`,
    `You can add, change and remove ${userName}'s bills when ${userName} asks. Put one line per change on its own line in your reply,`,
    'exactly: [[bill: {"op":"add","name":"Phone","amount":85,"dueDay":5,"recurring":"monthly","autopay":true}]]',
    'Change: [[bill: {"op":"update","id":"<id>","amount":90}]]  Remove: [[bill: {"op":"delete","id":"<id>"}]]',
    "Fields: name, amount (number), dueDay (1-31) or dueDate (YYYY-MM-DD), recurring (monthly|yearly|weekly|once), autopay (true/false), link (https URL), notes, active.",
    "The line is applied and hidden; the bill appears in the tab right away. Say it in plain words too (\"Added your phone bill, $85 on the 5th, autopay.\").",
    "Only these bills are hers to see. Never mention or add anyone else's bills.",
    list.length ? `Current bills:\n${list.join("\n")}` : "Current bills: none yet.",
  ].join("\n");
}
