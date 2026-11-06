import { useContext, useEffect, useState } from "react";
import { FinCatsSlot } from "../redesign/World";
import { Modal } from "../components/FinalDialog";
import { actions, useAppState } from "../store";
import { fetchCosts, createCost, updateCost, deleteCost, fetchCostCategories, type CostPayload, type CostCategoryInfo } from "../lib/api";
import { COST_CATEGORIES, type CostEntry } from "../lib/types";
import { IconPlus } from "../components/icons";
import { Icon } from "../redesign/icons";

function monthly(e: CostEntry): number {
  if (e.cost_type === "free") return 0;
  return Number(e.monthly_cost_fixed ?? e.monthly_cost_estimate ?? 0) || 0;
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

const EMPTY_FORM = {
  bucket: "ai_automation",
  service: "",
  category: "",
  cost_type: "subscription" as CostEntry["cost_type"],
  cost: "",
  billing_url: "",
  notes: "",
  active: true,
};

type FormState = typeof EMPTY_FORM;

function entryToForm(e: CostEntry): FormState {
  return {
    bucket: e.bucket,
    service: e.service,
    category: e.category ?? "",
    cost_type: e.cost_type,
    cost: String(e.monthly_cost_fixed ?? e.monthly_cost_estimate ?? ""),
    billing_url: e.billing_url ?? "",
    notes: e.notes ?? "",
    active: e.active,
  };
}

/** Same field semantics as the legacy modal (public/app.js:1857-1885):
 *  free → fixed $0; usage → estimate; fixed/subscription → fixed. */
function formToPayload(f: FormState): CostPayload {
  const costNum = f.cost.trim() === "" ? null : Number(f.cost);
  let monthly_cost_fixed: number | null = null;
  let monthly_cost_estimate: number | null = null;
  if (f.cost_type === "free") monthly_cost_fixed = 0;
  else if (f.cost_type === "usage") monthly_cost_estimate = costNum;
  else monthly_cost_fixed = costNum;
  return {
    bucket: f.bucket,
    service: f.service.trim(),
    category: f.category.trim() || "Other",
    cost_type: f.cost_type,
    monthly_cost_fixed,
    monthly_cost_estimate,
    billing_url: f.billing_url.trim() || null,
    notes: f.notes.trim() || null,
    active: f.active,
  };
}

function CostModal({
  entry,
  categories,
  onClose,
  onSaved,
}: {
  entry: CostEntry | null; // null = add
  categories: CostCategoryInfo[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState>(entry ? entryToForm(entry) : EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function save() {
    if (!form.service.trim()) {
      setError("Service name required.");
      return;
    }
    setBusy(true);
    const ok = entry ? await updateCost(entry.id, formToPayload(form)) : await createCost(formToPayload(form));
    setBusy(false);
    if (ok) {
      onSaved();
      onClose();
    } else {
      setError("Couldn’t save. Your changes are still here.");
    }
  }

  async function remove() {
    if (!entry) return;
    if (!confirm(`Delete "${entry.service}"? This cannot be undone.`)) return;
    setBusy(true);
    const ok = await deleteCost(entry.id);
    setBusy(false);
    if (ok) {
      onSaved();
      onClose();
    } else {
      setError("Couldn’t delete. Try again.");
    }
  }

  // FINAL "Add an operating cost" (finance.js costForm): Category + Group, Service name, Cost type,
  // Monthly amount (USD), Billing link, Notes, Active; foot Delete · Cancel · Save cost.
  return (
    <Modal title={entry ? "Edit operating cost" : "Add an operating cost"} eyebrow="AHI · PRIVATE WORKSPACE" variant="fin-dialog" onClose={onClose}>
      <div className="form-grid">
        <label className="modal-field">
          <span className="mono-label">Category</span>
          <select value={form.bucket} onChange={(e) => set("bucket", e.target.value)}>
            {categories.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="modal-field">
          <span className="mono-label">Group</span>
          <input type="text" value={form.category} onChange={(e) => set("category", e.target.value)} />
        </label>
      </div>
      <label className="modal-field">
        <span className="mono-label">Service name</span>
        <input type="text" required value={form.service} onChange={(e) => set("service", e.target.value)} placeholder="e.g. Voice synthesis" />
      </label>
      <label className="modal-field">
        <span className="mono-label">Cost type</span>
        <select value={form.cost_type} onChange={(e) => set("cost_type", e.target.value as FormState["cost_type"])}>
          <option value="subscription">Subscription</option>
          <option value="fixed">Fixed</option>
          <option value="usage">Usage</option>
          <option value="free">Free</option>
        </select>
      </label>
      <label className="modal-field">
        <span className="mono-label">Monthly amount (USD)</span>
        <input
          type="number"
          min={0}
          step="0.01"
          value={form.cost_type === "free" ? "0" : form.cost}
          onChange={(e) => set("cost", e.target.value)}
          readOnly={form.cost_type === "free"}
          placeholder="0"
        />
      </label>
      <label className="modal-field">
        <span className="mono-label">Billing link</span>
        <input type="url" value={form.billing_url} onChange={(e) => set("billing_url", e.target.value)} placeholder="https://…" />
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
        {entry && (
          <button className="btn-text" onClick={remove} disabled={busy}>
            Delete
          </button>
        )}
        <button className="btn-quiet" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn-accent" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save cost"}
        </button>
      </div>
    </Modal>
  );
}

/** Costs (design 1·6 + fix 3c#6): stat tiles, an Add band below them,
 *  category share bars, and rows with compact icon controls:
 *  [service] … [⋮ edit] [↗ manage] [type pill] [$/mo]. Full CRUD against
 *  the same /ui/costs persistence the legacy dashboard used. */
export default function Costs() {
  const cats = useContext(FinCatsSlot);
  const { toolFilter, costEntries, costCategories } = useAppState();
  const [modal, setModal] = useState<{ open: boolean; entry: CostEntry | null }>({ open: false, entry: null });

  const reload = () => fetchCosts().then(actions.setCosts);
  useEffect(() => {
    if (costEntries === null) reload();
    if (costCategories === null) fetchCostCategories().then(actions.setCostCategories);
  }, [costEntries, costCategories]);

  // Dynamic labels (3d§4) — built-ins + user categories from the gateway.
  const categoryList: CostCategoryInfo[] =
    costCategories ?? COST_CATEGORIES.map((c) => ({ ...c, builtin: true }));
  const labels: Record<string, string> = Object.fromEntries(categoryList.map((c) => [c.key, c.label]));

  if (costEntries === null) {
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

  const visible = costEntries.filter((e) => toolFilter === "all" || e.bucket === toolFilter);
  const grandTotal = costEntries.filter((e) => e.active).reduce((s, e) => s + monthly(e), 0) || 1;

  const byCategory = new Map<string, CostEntry[]>();
  for (const e of visible) {
    const list = byCategory.get(e.bucket) ?? [];
    list.push(e);
    byCategory.set(e.bucket, list);
  }

  // FINAL money rows (Finances): letter tile · name + category · type tag · amount · ⋯ edit · ↗ manage.
  const TYPE_WORD: Record<string, string> = { subscription: "Subscription", usage: "Usage", fixed: "Fixed", free: "Free" };
  const row = (e: CostEntry) => (
    <div key={e.id} className={`money-row${e.active ? "" : " inactive"}`}>
      <span className="service-symbol" aria-hidden="true">
        {(e.service.trim()[0] ?? "·").toUpperCase()}
      </span>
      <div className="grow">
        <strong>{e.service}</strong>
        <p>{e.active ? labels[e.bucket] ?? e.bucket : "Inactive"}</p>
      </div>
      <span className="tag cost-type">{TYPE_WORD[e.cost_type] ?? e.cost_type}</span>
      <span className="amount">{e.cost_type === "free" ? "$0" : `${e.monthly_cost_fixed === null ? "~" : ""}${fmtMoney(monthly(e))}`}</span>
      <button className="money-btn" aria-label={`Edit ${e.service}`} title="Edit" onClick={() => setModal({ open: true, entry: e })}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" stroke="none">
          <circle cx="6" cy="12" r="1.4" />
          <circle cx="12" cy="12" r="1.4" />
          <circle cx="18" cy="12" r="1.4" />
        </svg>
      </button>
      {e.billing_url ? (
        <a className="money-link" href={e.billing_url} target="_blank" rel="noopener noreferrer" aria-label={`Manage ${e.service}`} title="Manage (opens billing page)">
          <Icon name="link" />
        </a>
      ) : (
        <span className="money-link disabled" aria-hidden="true">
          <Icon name="link" />
        </span>
      )}
    </div>
  );

  return (
    <div className="tool-page fin-costs">
      <div className="fin-costs-head">
        <h2>
          Operating costs.
        </h2>
        <button className="btn-accent fin-add" onClick={() => setModal({ open: true, entry: null })}>
          <IconPlus /> Add a cost
        </button>
      </div>
      {cats}

      {[...byCategory.entries()].map(([bucket, list]) => {
        const activeList = list.filter((e) => e.active);
        const inactiveList = list.filter((e) => !e.active);
        const bucketTotal = activeList.reduce((s, e) => s + monthly(e), 0);
        const share = Math.min(1, bucketTotal / grandTotal);
        return (
          <section key={bucket} className="cost-section" aria-label={labels[bucket] ?? bucket}>
            <div className="section-head">
              <h3>{labels[bucket] ?? bucket}</h3>
              <span>
                {fmtMoney(bucketTotal)} / month{activeList.length !== list.length ? ` · ${activeList.length} active` : ""}
              </span>
            </div>
            <div className="metric-bar">
              <span style={{ width: `${share * 100}%` }} />
            </div>
            <div className="money-card">
              {activeList.sort((a, b) => monthly(b) - monthly(a)).map(row)}
              {inactiveList.map(row)}
            </div>
          </section>
        );
      })}
      {visible.length === 0 && <div className="tool-empty mono-label">NO ENTRIES</div>}

      {modal.open && (
        <CostModal
          entry={modal.entry}
          categories={categoryList}
          onClose={() => setModal({ open: false, entry: null })}
          onSaved={reload}
        />
      )}
    </div>
  );
}
