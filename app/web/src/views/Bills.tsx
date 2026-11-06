import { useEffect, useState } from "react";
import { Modal } from "../components/FinalDialog";
import { actions, authStamp, useAppState } from "../store";
import { createBill, deleteBill, fetchBills, saveBillSettings, updateBill, type BillPayload } from "../lib/api";
import type { Bill, BillSettings } from "../lib/types";
import { IconPlus } from "../components/icons";
import { Icon } from "../redesign/icons";

/** Bills: the signed-in user's OWN private bills. Nobody else's are
 *  ever loaded here — the gateway scopes every call to the session's user.
 *  Her agent (Miriam) can add and edit them from chat; the tab updates live. */

const RECURRING: Array<{ key: Bill["recurring"]; label: string }> = [
  { key: "monthly", label: "Monthly" },
  { key: "yearly", label: "Yearly" },
  { key: "weekly", label: "Weekly" },
  { key: "once", label: "One time" },
];

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

function money(n: number | null, currency: string): string {
  if (n === null) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

/** Monthly-equivalent amount (yearly ÷ 12, weekly × 52 ÷ 12, one-time excluded); the Bills total and the Finances summary. */
export function perMonth(b: Pick<Bill, "amount" | "recurring" | "active">): number {
  if (!b.active || b.amount === null) return 0;
  if (b.recurring === "yearly") return b.amount / 12;
  if (b.recurring === "weekly") return (b.amount * 52) / 12;
  if (b.recurring === "once") return 0;
  return b.amount;
}

function dueLabel(b: Bill): string {
  if (b.dueDate) return new Date(`${b.dueDate}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (b.dueDay) return `the ${ordinal(b.dueDay)}`;
  return "no due date";
}

/** Days until the next due day, for monthly bills with a due day. */
function daysUntil(b: Bill, now = new Date()): number | null {
  if (b.dueDate) {
    const d = new Date(`${b.dueDate}T00:00:00`);
    return Math.ceil((d.getTime() - new Date(now.toDateString()).getTime()) / 86_400_000);
  }
  if (!b.dueDay || b.recurring !== "monthly") return null;
  const today = now.getDate();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const day = Math.min(b.dueDay, lastDay);
  if (day >= today) return day - today;
  const nextLast = new Date(now.getFullYear(), now.getMonth() + 2, 0).getDate();
  return lastDay - today + Math.min(b.dueDay, nextLast);
}

interface FormState {
  name: string;
  amount: string;
  dueKind: "day" | "date";
  dueDay: string;
  dueDate: string;
  recurring: Bill["recurring"];
  autopay: boolean;
  link: string;
  notes: string;
  active: boolean;
}

const EMPTY: FormState = {
  name: "",
  amount: "",
  dueKind: "day",
  dueDay: "",
  dueDate: "",
  recurring: "monthly",
  autopay: false,
  link: "",
  notes: "",
  active: true,
};

function toForm(b: Bill): FormState {
  return {
    name: b.name,
    amount: b.amount === null ? "" : String(b.amount),
    dueKind: b.dueDate ? "date" : "day",
    dueDay: b.dueDay ? String(b.dueDay) : "",
    dueDate: b.dueDate ?? "",
    recurring: b.recurring,
    autopay: b.autopay,
    link: b.link ?? "",
    notes: b.notes ?? "",
    active: b.active,
  };
}

function toPayload(f: FormState): BillPayload {
  return {
    name: f.name.trim(),
    amount: f.amount.trim() === "" ? null : Number(f.amount.replace(/[$,\s]/g, "")),
    dueDay: f.dueKind === "day" && f.dueDay ? Number(f.dueDay) : null,
    dueDate: f.dueKind === "date" && f.dueDate ? f.dueDate : null,
    recurring: f.recurring,
    autopay: f.autopay,
    link: f.link.trim() || null,
    notes: f.notes.trim() || null,
    active: f.active,
  };
}

function BillModal({ bill, onClose }: { bill: Bill | null; onClose: () => void }) {
  const [form, setForm] = useState<FormState>(bill ? toForm(bill) : EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    if (!form.name.trim()) return setError("Give the bill a name.");
    setBusy(true);
    const r = bill ? await updateBill(bill.id, toPayload(form)) : await createBill(toPayload(form));
    setBusy(false);
    if (r.ok) onClose();
    else setError(r.error || "Couldn’t save. Your changes are still here.");
  }

  async function remove() {
    if (!bill || !confirm(`Delete "${bill.name}"?`)) return;
    setBusy(true);
    const r = await deleteBill(bill.id);
    setBusy(false);
    if (r.ok) onClose();
    else setError(r.error || "Couldn’t delete. Try again.");
  }

  // FINAL "Add a bill" (finance.js billForm): Bill name; Amount (USD) + Repeats; Due by; the day or date;
  // Autopay is on; Billing link; Notes; Active; foot Delete · Cancel · Save bill.
  return (
    <Modal title={bill ? "Edit your bill" : "Add a bill"} eyebrow="AHI · PRIVATE WORKSPACE" variant="fin-dialog" onClose={onClose}>
      <label className="modal-field">
        <span className="mono-label">Bill name</span>
        <input type="text" required value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Coastline Mobile" />
      </label>
      <div className="form-grid">
        <label className="modal-field">
          <span className="mono-label">Amount (USD)</span>
          <input type="text" inputMode="decimal" value={form.amount} onChange={(e) => set("amount", e.target.value)} placeholder="0.00" />
        </label>
        <label className="modal-field">
          <span className="mono-label">Repeats</span>
          <select value={form.recurring} onChange={(e) => set("recurring", e.target.value as Bill["recurring"])}>
            {RECURRING.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="modal-field">
        <span className="mono-label">Due by</span>
        <select value={form.dueKind} onChange={(e) => set("dueKind", e.target.value as "day" | "date")}>
          <option value="day">Day of the month</option>
          <option value="date">A date</option>
        </select>
      </label>
      {form.dueKind === "day" ? (
        <label className="modal-field">
          <span className="mono-label">Day (1–31)</span>
          <input type="number" min={1} max={31} value={form.dueDay} onChange={(e) => set("dueDay", e.target.value)} />
        </label>
      ) : (
        <label className="modal-field">
          <span className="mono-label">Due date</span>
          <input type="date" value={form.dueDate} onChange={(e) => set("dueDate", e.target.value)} />
        </label>
      )}
      <label className="modal-check">
        <input type="checkbox" checked={form.autopay} onChange={(e) => set("autopay", e.target.checked)} />
        Autopay is on
      </label>
      <label className="modal-field">
        <span className="mono-label">Billing link</span>
        <input type="url" value={form.link} onChange={(e) => set("link", e.target.value)} placeholder="https://…" />
      </label>
      <label className="modal-field">
        <span className="mono-label">Notes</span>
        <textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} />
      </label>
      <label className="modal-check">
        <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} />
        Active
      </label>
      {error && <p className="modal-error">{error}</p>}
      <div className="modal-foot">
        {bill && (
          <button className="btn-text" onClick={remove} disabled={busy}>
            Delete
          </button>
        )}
        <button className="btn-quiet" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn-accent" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save bill"}
        </button>
      </div>
    </Modal>
  );
}

function SettingsModal({ settings, onClose }: { settings: BillSettings; onClose: () => void }) {
  const [currency, setCurrency] = useState(settings.currency);
  const [remind, setRemind] = useState(settings.remindDaysBefore === null ? "" : String(settings.remindDaysBefore));
  const [error, setError] = useState("");
  async function save() {
    const r = await saveBillSettings({ currency: currency.trim().toUpperCase(), remindDaysBefore: remind === "" ? null : Number(remind) });
    if (r.ok) onClose();
    else setError(r.error || "Couldn’t save. Your changes are still here.");
  }
  // FINAL "Bill reminders" (finance.js billSettings).
  const codes = ["USD", "EUR", "GBP"].includes(currency.toUpperCase()) ? ["USD", "EUR", "GBP"] : ["USD", "EUR", "GBP", currency.toUpperCase()];
  return (
    <Modal title="Bill reminders" eyebrow="AHI · PRIVATE WORKSPACE" variant="fin-dialog" onClose={onClose}>
      <label className="modal-field">
        <span className="mono-label">Currency</span>
        <select value={currency.toUpperCase()} onChange={(e) => setCurrency(e.target.value)}>
          {codes.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <label className="modal-field">
        <span className="mono-label">Remind me this many days before</span>
        <input type="number" min={0} max={30} value={remind} onChange={(e) => setRemind(e.target.value)} />
      </label>
      <p className="vault-form-note">Leave blank to turn reminders off.</p>
      {error && <p className="modal-error">{error}</p>}
      <div className="modal-foot">
        <button className="btn-quiet" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-accent" onClick={save}>
          Save
        </button>
      </div>
    </Modal>
  );
}

export default function Bills() {
  const { bills, billSettings, user } = useAppState();
  const [modal, setModal] = useState<{ open: boolean; bill: Bill | null }>({ open: false, bill: null });
  const [settingsOpen, setSettingsOpen] = useState(false);

  // B1: the request is stamped with who asked; the store refuses it if the
  // account changed before it came back, and unmount/account switch cancels.
  const userId = user?.userId ?? null;
  useEffect(() => {
    if (bills !== null || !userId) return;
    const owner = authStamp();
    let cancelled = false;
    void fetchBills().then((r) => {
      if (!cancelled && r) actions.setBills(r.bills, r.settings, owner);
    });
    return () => {
      cancelled = true;
    };
  }, [bills, userId]);

  if (bills === null || billSettings === null) {
    return (
      <div className="tool-page">
        <div className="stat-row">
          {[0, 1, 2].map((i) => (
            <div key={i} className="stat-tile skeleton-card" />
          ))}
        </div>
      </div>
    );
  }

  const cur = billSettings.currency;
  const sorted = [...bills].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (daysUntil(a) ?? 999) - (daysUntil(b) ?? 999);
  });

  const RECUR: Record<Bill["recurring"], string> = { monthly: "Monthly", yearly: "Yearly", weekly: "Weekly", once: "One time" };
  const nextDue = (bill: Bill): Date | null => {
    if (bill.dueDate) return new Date(`${bill.dueDate}T12:00:00`);
    const d = daysUntil(bill);
    if (d === null) return null;
    const t = new Date();
    t.setHours(12, 0, 0, 0);
    t.setDate(t.getDate() + d);
    return t;
  };
  const remind = billSettings.remindDaysBefore;
  return (
    <div className="tool-page fin-costs fin-bills">
      <div className="fin-costs-head">
        <h2>
          Bills, taken care of.
        </h2>
        <button className="btn-accent fin-add" onClick={() => setModal({ open: true, bill: null })}>
          <IconPlus /> Add a bill
        </button>
      </div>
      <div className="fin-bills-watch">
        <span className="service-symbol miriam" aria-hidden="true">M</span>
        <span>{remind === null ? "Reminders are off. Turn them on and Miriam keeps an eye on the dates." : `Miriam is keeping an eye on the dates · ${remind === 0 ? "on the day" : `${remind} day${remind === 1 ? "" : "s"} before`}.`}</span>
        <button className="fin-reminders" onClick={() => setSettingsOpen(true)}>
          <Icon name="bell" /> Reminders
        </button>
      </div>

      {bills.length > 0 && (
        <div className="money-card">
          {sorted.map((bill) => {
            const d = daysUntil(bill);
            const due = nextDue(bill);
            const when = d === null ? (bill.dueDay ? `Due ${dueLabel(bill)}` : "") : d === 0 ? "Due today" : d === 1 ? "Due tomorrow" : d > 0 && d <= 14 ? `In ${d} days` : "";
            return (
              <div key={bill.id} className={`money-row${bill.active ? "" : " inactive"}`}>
                <span className="date-tile" aria-label={due ? due.toDateString() : "No due date"}>
                  {due ? (
                    <>
                      <small>{due.toLocaleDateString("en-US", { month: "short" }).toUpperCase()}</small>
                      <b>{due.getDate()}</b>
                    </>
                  ) : (
                    <b>—</b>
                  )}
                </span>
                <div className="grow">
                  <strong>{bill.name}</strong>
                  <p>{[RECUR[bill.recurring], when, bill.active ? null : "Paused"].filter(Boolean).join(" · ")}</p>
                  {bill.autopay && <span className="tag autopay">Autopay</span>}
                </div>
                <span className="amount">{money(bill.amount, cur)}</span>
                <button className="money-btn" aria-label={`Edit ${bill.name}`} title="Edit" onClick={() => setModal({ open: true, bill })}>
                  <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" stroke="none">
                    <circle cx="6" cy="12" r="1.4" />
                    <circle cx="12" cy="12" r="1.4" />
                    <circle cx="18" cy="12" r="1.4" />
                  </svg>
                </button>
                {bill.link ? (
                  <a className="money-link" href={bill.link} target="_blank" rel="noopener noreferrer" aria-label={`Open ${bill.name}`} title="Open billing page">
                    <Icon name="link" />
                  </a>
                ) : (
                  <span className="money-link disabled" aria-hidden="true">
                    <Icon name="link" />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {bills.length === 0 && <p className="fin-empty">No bills yet. Add one, or ask Miriam: “Add my phone bill, $85 on the 5th, autopay.”</p>}

      {modal.open && <BillModal bill={modal.bill} onClose={() => setModal({ open: false, bill: null })} />}
      {settingsOpen && <SettingsModal settings={billSettings} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
