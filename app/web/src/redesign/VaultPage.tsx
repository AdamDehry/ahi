/**
 * Vault — the FINAL page one for one, on the real vault.
 *
 * Every control runs the real thing: Connect account = passkey → the provider's own sign-in
 * (Plaid Link) → token stored encrypted → accounts pulled, all inside ConnectModal; Add manually
 * writes a ledger account or item; Add statement uploads and parses; Refresh feeds pulls every
 * connection; Lock locks the Vault on the server until a passkey opens it; the attention cards,
 * debts and records open the record's own editor. Figures come from /app/vault only.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  ackFlag, deleteDoc, disconnect, fetchVault, importSeed, money, OWNER_LABELS, refreshFeeds, webauthnSupported,
  type Owner, type VaultAccount, type VaultItem, type VaultPicture,
} from "../lib/vault";
import { lockVault, unlockVault } from "../lib/vault";
import { AccountModal, ConnectModal, ItemModal, Modal, NewAccountModal, UploadModal } from "../views/Vault";
import "../styles/vault.css";
import "./vault-final.css";
import { Icon } from "./icons";
import { CATEGORY_TABS, attentionOf, recordsOf, shortDate, type Category, type VRecord } from "./vaultRecords";

/* ── tiny shared state so the header's Lock button and the page agree ── */
type LockState = { canLock: boolean; locked: boolean; rev: number };
let lockState: LockState = { canLock: false, locked: false, rev: 0 };
const subs = new Set<() => void>();
const setLock = (p: Partial<LockState>) => {
  lockState = { ...lockState, ...p };
  subs.forEach((f) => f());
};
const useLock = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => lockState);

const SVG: Record<string, string> = {
  bank: "M3 10h18M4 10v10m5-10v10m6-10v10m5-10v10M2 21h20M12 3 2 9h20L12 3Z",
  credit: "M3 8h18M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM6 15h3",
  lock: "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5Z",
  refresh: "M20 9a8 8 0 0 0-14-5L3 7m0-5v5h5M4 15a8 8 0 0 0 14 5l3-3m0 5v-5h-5",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-11v6m0-10h.01",
  out: "M7 17 17 7M7 7h10v10",
  fingerprint: "M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4 M14 13.12c0 2.38 0 6.38-1 8.88 M17.29 21.02c.12-.6.43-2.3.5-3.02 M2 12a10 10 0 0 1 18-6 M2 16h.01 M21.8 16c.2-2 .131-5.354 0-6 M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2 M8.65 22c.21-.66.45-1.32.57-2 M9 6.8a6 6 0 0 1 9 5.2v2",
};
const G = ({ n }: { n: keyof typeof SVG }) => (
  <svg className="rd-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d={SVG[n]} />
  </svg>
);

/** The page header's Lock (FINAL vaultHeading action). */
export function VaultLockButton() {
  const st = useLock();
  const [busy, setBusy] = useState(false);
  if (st.locked) return null;
  return (
    <button
      type="button"
      className="vault-button"
      disabled={!st.canLock || busy}
      title={st.canLock ? "Lock the Vault until your passkey opens it" : "Add a passkey in Settings first, so you can unlock it again"}
      onClick={async () => {
        setBusy(true);
        const r = await lockVault();
        setBusy(false);
        if (r.ok) setLock({ locked: true, rev: st.rev + 1 });
      }}
    >
      <G n="lock" /> Lock
    </button>
  );
}

type Dialog =
  | { kind: "account"; account: VaultAccount }
  | { kind: "item"; item: VaultItem | null }
  | { kind: "new-account" }
  | { kind: "connect" }
  | { kind: "upload" }
  | { kind: "manual" }
  | { kind: "coverage" }
  | { kind: "explainer" }
  | { kind: "owners" };

export default function VaultPage() {
  const lock = useLock();
  const [pic, setPic] = useState<VaultPicture | null>(null);
  const [err, setErr] = useState<{ error: string; code?: string; status?: number } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [section, setSection] = useState<"overview" | "connections" | "documents">("overview");
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");
  const [cat, setCat] = useState<Category | "all">("all");
  const [query, setQuery] = useState("");
  const [ownerF, setOwnerF] = useState<Owner | "all">("all");
  const [sort, setSort] = useState<"name" | "balance" | "attention">("name");
  const [archived, setArchived] = useState(false);
  const [debtSort, setDebtSort] = useState<"apr" | "interest">("apr");
  const [allAttention, setAllAttention] = useState(false);

  const load = useCallback(async () => {
    const r = await fetchVault();
    if (r.ok) {
      setPic(r.value);
      setErr(null);
      setLock({ locked: false, canLock: r.value.passkeys > 0 });
    } else {
      setErr({ error: r.error, code: r.code, status: r.status });
      setLock({ locked: r.code === "app-locked", canLock: false });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, lock.rev]);

  const say = (t: string) => {
    setToast(t);
    window.setTimeout(() => setToast((x) => (x === t ? "" : x)), 6000);
  };
  const close = () => {
    setDialog(null);
    void load();
  };

  const records = useMemo(() => (pic ? recordsOf(pic) : []), [pic]);
  const attention = useMemo(() => (pic ? attentionOf(pic, records) : []), [pic, records]);
  const rank = useMemo(() => new Map(attention.filter((a) => a.recordId).map((a) => [a.recordId!, a.score])), [attention]);
  const allAccounts = useMemo(() => (pic ? pic.owners.flatMap((g) => g.accounts) : []), [pic]);
  const open = (r: VRecord | undefined | null) => {
    if (!r) return;
    if (r.account) setDialog({ kind: "account", account: r.account });
    else if (r.item) setDialog({ kind: "item", item: r.item });
  };
  const openId = (id: string | null) => open(records.find((r) => r.id === id));

  if (err) {
    if (err.code === "app-locked")
      return <LockedView onOpen={() => setLock({ rev: lock.rev + 1 })} />;
    return (
      <section className="native-vault">
        <div className="vault-empty">
          <G n="lock" />
          <h1>{err.code === "vault-locked" ? "The Vault's key is missing." : err.status === 404 ? "This Vault is private." : "Your picture is still here."}</h1>
          <p>
            {err.code === "vault-locked"
              ? "The encryption key is missing on the gateway. Nothing is shown until it is back."
              : err.status === 404
                ? "Only its owner can see these financial records."
                : `The Vault could not load (${err.error}). Saved figures stay intact.`}
          </p>
          {err.status !== 404 && err.code !== "vault-locked" && (
            <button type="button" className="vault-button primary" onClick={() => void load()}>
              Try again
            </button>
          )}
        </div>
      </section>
    );
  }
  if (!pic)
    return (
      <section className="native-vault">
        <div className="vault-overview">
          <div className="vault-net-worth skeleton-card" />
          <div className="vault-overview-side">
            <div className="vault-summary-card skeleton-card" />
          </div>
        </div>
      </section>
    );

  const pressure = Object.entries(pic.cash_flow.pressure_by_owner) as Array<[Owner, { minimums: number; cash: number; shortfall: number }]>;
  const covered = pressure.every(([, p]) => p.shortfall <= 0);
  const shares = pic.owner_look_through.shares.filter((s) => s.pct > 0);
  const liveConnections = pic.connections.filter((c) => c.status !== "disconnected");
  const debts = [...pic.expensive_debts].sort((a, b) => (debtSort === "interest" ? (b.interest_per_year ?? 0) - (a.interest_per_year ?? 0) : b.apr_pct - a.apr_pct)).slice(0, 3);
  const owners = [...new Set(records.map((r) => r.owner))];
  const inTab = (c: Category | "all") => records.filter((r) => r.archived === archived && (c === "all" || r.category === c));
  const shown = inTab(cat)
    .filter((r) => ownerF === "all" || r.owner === ownerF)
    .filter((r) => `${r.name} ${r.kind} ${OWNER_LABELS[r.owner]}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => (sort === "balance" ? Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0) : sort === "attention" ? (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0) : a.name.localeCompare(b.name)));

  const refresh = async () => {
    setBusy("refresh");
    const r = await refreshFeeds();
    setBusy("");
    say(r.ok ? `Refreshed ${r.value.refreshed} connection${r.value.refreshed === 1 ? "" : "s"}${r.value.failed ? `, ${r.value.failed} failed` : ""}${r.value.flags.length ? `; ${r.value.flags.length} new to look at` : ""}.` : r.error);
    void load();
  };

  const dialogs = (
    <>
      {dialog?.kind === "account" && <AccountModal account={dialog.account} all={allAccounts} onClose={close} />}
      {dialog?.kind === "item" && <ItemModal item={dialog.item} onClose={close} />}
      {dialog?.kind === "new-account" && <NewAccountModal onClose={close} />}
      {dialog?.kind === "connect" && <ConnectModal picture={pic} onClose={close} />}
      {dialog?.kind === "upload" && <UploadModal onClose={close} />}
      {dialog?.kind === "manual" && (
        <Modal title="Add to your picture." onClose={() => setDialog(null)}>
          <div className="vault-add-choices">
            <button type="button" onClick={() => setDialog({ kind: "new-account" })}>
              <G n="bank" />
              <strong>Financial account</strong>
              <span>A bank, credit, loan or investment account entered by hand.</span>
            </button>
            <button type="button" onClick={() => setDialog({ kind: "item", item: null })}>
              <Icon name="home" />
              <strong>Asset or debt</strong>
              <span>Property, a vehicle, a business share, or another item.</span>
            </button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "coverage" && (
        <Modal title="Minimums, next 30 days." onClose={() => setDialog(null)}>
          <p className="vault-dialog-p">
            {money(pic.cash_flow.minimums_30d, 2)} in scheduled minimum payments across {pic.cash_flow.minimums_counted} account{pic.cash_flow.minimums_counted === 1 ? "" : "s"}
            {pic.cash_flow.minimums_unknown ? `; ${pic.cash_flow.minimums_unknown} more have no minimum on file` : ""}. Each owner’s minimums are set against that owner’s own tracked cash, never someone else’s.
          </p>
          <div className="vault-coverage">
            {pressure.length ? (
              pressure.map(([o, p]) => (
                <div key={o}>
                  <span>{OWNER_LABELS[o]}</span>
                  <span>
                    {money(p.minimums, 2)} due · {money(p.cash, 2)} cash
                  </span>
                  <strong className={p.shortfall > 0 ? "watch" : "good"}>{p.shortfall > 0 ? `Short ${money(p.shortfall, 2)}` : "Covered"}</strong>
                </div>
              ))
            ) : (
              <p className="vault-muted">No minimums are due in the next 30 days.</p>
            )}
          </div>
          <p className="vault-form-note">Figures as of {shortDate(pic.staleness.oldest_as_of)} to {shortDate(pic.staleness.newest_as_of)}.</p>
        </Modal>
      )}
      {dialog?.kind === "explainer" && (
        <Modal title="How totals work." onClose={() => setDialog(null)}>
          <p className="vault-dialog-p">
            <strong>Your net worth</strong> is only what is yours: your own assets less what you owe. Every figure belongs to one owner and is never netted into anyone else’s.
          </p>
          <p className="vault-dialog-p">
            <strong>Including business ownership</strong> adds your documented share of each business you own, and is always labelled as such: {money(pic.owner.net, 2)} of your own
            {shares.map((s) => ` + ${s.pct}% of ${OWNER_LABELS[s.owner]} (${money(s.net * (s.pct / 100), 2)})`).join("")} = {money(pic.owner_look_through.net, 2)}.
          </p>
          <p className="vault-dialog-p">Figures with no amount are left out and counted as unknown, never guessed. A share with no documented split is never assumed.</p>
        </Modal>
      )}
      {dialog?.kind === "owners" && (
        <Modal title="Owners in your picture." onClose={() => setDialog(null)}>
          <p className="vault-dialog-p">Each record belongs to one owner. Change a record’s owner from the record itself; shares in a business come from its documented split.</p>
          <div className="vault-coverage">
            {pic.owners.map((g) => {
              const sh = pic.owner_look_through.shares.find((s) => s.owner === g.owner);
              return (
                <button
                  key={g.owner}
                  type="button"
                  className="vault-owner-row"
                  onClick={() => {
                    setOwnerF(g.owner);
                    setCat("all");
                    setDialog(null);
                    document.querySelector(".vault-records")?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  <span>{g.label}</span>
                  <span>
                    {g.accounts.length + g.items.length} records{sh ? ` · your share ${sh.pct}%` : ""}
                  </span>
                  <strong>{money(g.totals.net, 2)}</strong>
                </button>
              );
            })}
          </div>
        </Modal>
      )}
    </>
  );

  if (section !== "overview")
    return (
      <section className="native-vault">
        <button type="button" className="vault-button vault-back" onClick={() => setSection("overview")}>
          <Icon name="arrow-left" /> Back to Vault
        </button>
        <header className="vault-heading">
          <div>
            <h1>{section === "connections" ? "Your bank connections." : "The sources behind your picture."}</h1>
            <p>{section === "connections" ? "Linked accounts stay separate from manual records." : "Statements and credit reports, read before anything changes."}</p>
          </div>
          <div className="vault-heading-actions">
            {section === "connections" ? (
              <button type="button" className="vault-button primary" onClick={() => setDialog({ kind: "connect" })}>
                Connect account
              </button>
            ) : (
              <button type="button" className="vault-button primary" onClick={() => setDialog({ kind: "upload" })}>
                Add statement
              </button>
            )}
          </div>
        </header>
        {toast && <p className="vault-toast" role="status">{toast}</p>}
        {section === "connections" ? (
          <div className="vault-connection-grid">
            {pic.connections.map((c) => (
              <article key={c.id}>
                <span className="vault-generic-bank">
                  <G n="bank" />
                </span>
                <h2>{c.institution}</h2>
                <p>
                  {c.status === "active" || c.status === "connected" ? "Linked" : c.status.replace(/_/g, " ")} · {c.accounts} account{c.accounts === 1 ? "" : "s"} · {OWNER_LABELS[c.owner]}
                </p>
                <small>
                  Read only through {c.provider}. Last refreshed {c.last_refresh_at ? shortDate(c.last_refresh_at) : "never"}
                  {c.last_refresh_ok === false ? " (failed)" : ""}.
                </small>
                <div>
                  {c.status !== "disconnected" && (
                    <button
                      type="button"
                      className="vault-button"
                      onClick={async () => {
                        if (!confirm(`Disconnect ${c.institution}? Its token is deleted; the figures stay as a saved snapshot.`)) return;
                        const r = await disconnect(c.id);
                        say(r.ok ? `${c.institution} disconnected; the token is deleted.` : r.error);
                        void load();
                      }}
                    >
                      Disconnect
                    </button>
                  )}
                </div>
              </article>
            ))}
            {!pic.connections.length && <p className="vault-muted">No bank is connected yet. Connect account signs you in at the bank itself, read only.</p>}
          </div>
        ) : (
          <div className="vault-document-grid">
            {pic.documents.map((d) => (
              <article key={d.id}>
                <Icon name="folder" />
                <strong>{d.filename}</strong>
                <small>
                  {d.kind.replace(/-/g, " ")} · {OWNER_LABELS[d.owner]} · {shortDate(d.uploaded_at)}
                </small>
                <p>{d.parsed ? d.parsed.summary : "Stored; nothing was read from it automatically."}</p>
                <button
                  type="button"
                  className="vault-button"
                  onClick={async () => {
                    if (!confirm("Delete this document? Figures already applied stay.")) return;
                    const r = await deleteDoc(d.id);
                    say(r.ok ? "Document deleted." : r.error);
                    void load();
                  }}
                >
                  Delete
                </button>
              </article>
            ))}
            {!pic.documents.length && <p className="vault-muted">No documents added yet.</p>}
          </div>
        )}
        {dialogs}
      </section>
    );

  return (
    <section className="native-vault">
      <div className="vault-overview">
        <article className="vault-net-worth">
          <span className="eyebrow">YOUR NET WORTH</span>
          <strong className={pic.owner.net < 0 ? "neg" : undefined}>{money(pic.owner.net, 2)}</strong>
          <p>Personal assets, less what you owe.</p>
          <div>
            <span>
              <Icon name="shield" /> Private by design
            </span>
            <small>
              Figures as of {shortDate(pic.staleness.newest_as_of)}
              {pic.owner.unknown_figures ? ` · ${pic.owner.unknown_figures} unknown left out` : ""}
            </small>
          </div>
        </article>
        <div className="vault-overview-side">
          <button type="button" className="vault-summary-card" onClick={() => setDialog({ kind: "explainer" })}>
            <span>
              Including business ownership <G n="info" />
            </span>
            <strong>{money(pic.owner_look_through.net, 2)}</strong>
            <small>{shares.length ? shares.map((s) => `${OWNER_LABELS[s.owner]} · ${s.pct}%`).join(" / ") : "No documented business shares"}</small>
          </button>
          <button type="button" className="vault-summary-card" onClick={() => setDialog({ kind: "coverage" })}>
            <span>Minimums · next 30 days</span>
            <strong>{money(pic.cash_flow.minimums_30d, 2)}</strong>
            <small className={covered ? "good" : "watch"}>{covered ? "Covered by tracked cash for each owner" : "Cash coverage varies by owner"}</small>
          </button>
          <button
            type="button"
            className="vault-summary-card"
            onClick={() => {
              setSort("attention");
              setCat("all");
              document.querySelector(".vault-records")?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          >
            <span>Figures to refresh</span>
            <strong>
              {pic.staleness.stale_count}
              <em> / {pic.staleness.total_known}</em>
            </strong>
            <small>Older than 45 days</small>
          </button>
        </div>
      </div>

      <div className="vault-toolbar">
        <div>
          <button type="button" className="vault-button primary" disabled={!!busy} onClick={() => setDialog({ kind: "connect" })}>
            <Icon name="plus" /> Connect account
          </button>
          <button type="button" className="vault-button" disabled={!!busy} aria-haspopup="dialog" onClick={() => setDialog({ kind: "manual" })}>
            Add manually <Icon name="chevron" />
          </button>
          <button type="button" className="vault-button" disabled={!!busy} onClick={() => setDialog({ kind: "upload" })}>
            <Icon name="upload" /> Add statement
          </button>
          {!pic.initialized && (
            <button
              type="button"
              className="vault-button"
              disabled={!!busy}
              onClick={async () => {
                setBusy("seed");
                const r = await importSeed();
                setBusy("");
                say(r.ok ? `Loaded the snapshot: ${r.value.accounts} accounts, ${r.value.items} items.` : r.error);
                void load();
              }}
            >
              Load the October snapshot
            </button>
          )}
        </div>
        <button
          type="button"
          className="vault-button"
          disabled={!!busy || !liveConnections.length}
          title={liveConnections.length ? "Pull fresh balances from every connected bank" : "Connect a bank first"}
          onClick={() => void refresh()}
        >
          <G n="refresh" /> {busy === "refresh" ? "Refreshing…" : "Refresh feeds"}
        </button>
      </div>
      <div className="vault-inline-links">
        <button type="button" className="vault-button" onClick={() => setSection("connections")}>
          {liveConnections.length} bank connection{liveConnections.length === 1 ? "" : "s"} <Icon name="arrow-right" />
        </button>
        <button type="button" className="vault-button" onClick={() => setSection("documents")}>
          {pic.documents.length} document{pic.documents.length === 1 ? "" : "s"} <Icon name="arrow-right" />
        </button>
      </div>
      {toast && <p className="vault-toast" role="status">{toast}</p>}

      {!records.length ? (
        <div className="vault-empty">
          <h2>Your picture starts with one account.</h2>
          <p>Connect a bank, or enter an account, asset or debt by hand.</p>
          <button type="button" className="vault-button primary" onClick={() => setDialog({ kind: "connect" })}>
            Connect account
          </button>
        </div>
      ) : (
        <>
          <div className="vault-section-title">
            <div>
              <h2>A moment of attention</h2>
              <span>
                {attention.length} item{attention.length === 1 ? "" : "s"} · ordered by urgency
              </span>
            </div>
            {attention.length > 4 && (
              <button type="button" className="vault-button" onClick={() => setAllAttention(!allAttention)}>
                {allAttention ? "Show less" : "See all"}
              </button>
            )}
          </div>
          <div className="vault-attention">
            {attention.length ? (
              attention.slice(0, allAttention ? attention.length : 4).map((a) => (
                <div key={a.key} className={`vault-flag ${a.tone}`}>
                  <i />
                  <button type="button" className="vault-flag-open" onClick={() => openId(a.recordId)} disabled={!a.recordId}>
                    <small>{a.label}</small>
                    <strong>{a.title}</strong>
                    <p>{a.body}</p>
                  </button>
                  {a.flag ? (
                    <button
                      type="button"
                      className="vault-flag-ack"
                      title="Mark it handled; the figure stays as it is"
                      onClick={async () => {
                        const r = await ackFlag(a.flag!.id);
                        say(r.ok ? "Marked as handled." : r.error);
                        void load();
                      }}
                    >
                      Got it
                    </button>
                  ) : (
                    <G n="out" />
                  )}
                </div>
              ))
            ) : (
              <div className="vault-clear">Nothing needs your attention right now.</div>
            )}
          </div>

          <div className="vault-section-title">
            <div>
              <h2>The most expensive debts</h2>
              <span>Simple annual estimate at the current balance; fees and future changes excluded.</span>
            </div>
            <select aria-label="Sort expensive debts" value={debtSort} onChange={(e) => setDebtSort(e.target.value as "apr" | "interest")}>
              <option value="apr">Highest APR</option>
              <option value="interest">Estimated interest</option>
            </select>
          </div>
          <div className="vault-debts">
            {debts.length ? (
              debts.map((d) => (
                <button key={d.id} type="button" onClick={() => openId(d.id)}>
                  <span>
                    {d.institution}
                    {d.last4 ? ` ·· ${d.last4}` : ""}
                    <small>{OWNER_LABELS[d.owner]}</small>
                  </span>
                  <strong>
                    {d.apr_pct}% <small>APR</small>
                  </strong>
                  <span>
                    ~{money(d.interest_per_year, 2)}
                    <small>interest / year</small>
                  </span>
                  <Icon name="chevron-right" />
                </button>
              ))
            ) : (
              <p className="vault-muted vault-debts-empty">No interest-bearing debts recorded.</p>
            )}
          </div>

          <div className="vault-section-title">
            <div>
              <h2>Everything, in its place.</h2>
              <span>Filter by category or owner; See all brings the picture together.</span>
            </div>
            <button type="button" className="vault-button" onClick={() => setDialog({ kind: "owners" })}>
              Manage owners
            </button>
          </div>
          <div className="vault-category-tabs" role="tablist" aria-label="Vault categories">
            {CATEGORY_TABS.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={cat === id} onClick={() => setCat(id)}>
                {label}
                <small>{inTab(id).length}</small>
              </button>
            ))}
          </div>
          <div className="vault-list-tools">
            <label>
              <Icon name="search" />
              <input type="search" aria-label="Search Vault records" placeholder="Find an account or asset…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <select aria-label="Filter Vault owner" value={ownerF} onChange={(e) => setOwnerF(e.target.value as Owner | "all")}>
              <option value="all">All owners</option>
              {owners.map((o) => (
                <option key={o} value={o}>
                  {OWNER_LABELS[o]}
                </option>
              ))}
            </select>
            <select aria-label="Sort Vault records" value={sort} onChange={(e) => setSort(e.target.value as "name" | "balance" | "attention")}>
              <option value="name">Name</option>
              <option value="balance">Largest balance</option>
              <option value="attention">Needs attention</option>
            </select>
            <label className="vault-archive-filter">
              <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
              Archived
            </label>
          </div>
          <div className="vault-records">
            {shown.map((r) => (
              <button key={`${r.ref}:${r.id}`} type="button" className="vault-record" onClick={() => open(r)}>
                <span className="vault-record-icon">{r.category === "cash" ? <G n="bank" /> : r.category === "credit" ? <G n="credit" /> : r.category === "property" ? <Icon name="home" /> : <Icon name="layers" />}</span>
                <span className="vault-record-main">
                  <strong>{r.name}</strong>
                  <small>
                    {OWNER_LABELS[r.owner]} · {r.kind}
                    {r.last4 ? ` · •• ${r.last4}` : ""}
                  </small>
                  <em className={r.stale ? "stale" : undefined}>
                    {r.archived ? "Closed" : r.source} · {shortDate(r.asOf)}
                  </em>
                </span>
                <span className="vault-record-value">
                  {r.value === null ? "Unknown" : money(r.value, 2)}
                  {r.apr !== null && <small>{r.apr}% APR</small>}
                </span>
                <Icon name="chevron-right" />
              </button>
            ))}
            {!shown.length && <div className="vault-list-empty">No records match these filters.</div>}
          </div>
        </>
      )}
      <footer className="vault-footer">
        Private to you · figures from your banks, statements and entries ·
        <button type="button" className="vault-button" onClick={() => setDialog({ kind: "explainer" })}>
          How totals work
        </button>
      </footer>
      {dialogs}
    </section>
  );
}

function LockedView({ onOpen }: { onOpen: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="native-vault">
      <div className="vault-empty">
        <G n="lock" />
        <h1>Your Vault is locked.</h1>
        <p>Confirm with your passkey to open your financial picture.</p>
        <button
          type="button"
          className="vault-button primary"
          disabled={busy || !webauthnSupported()}
          onClick={async () => {
            setBusy(true);
            setError("");
            const r = await unlockVault();
            setBusy(false);
            if (r.ok) onOpen();
            else setError(r.error);
          }}
        >
          <G n="fingerprint" /> {busy ? "Waiting for your passkey…" : "Unlock"}
        </button>
        {error && (
          <p className="vault-form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
