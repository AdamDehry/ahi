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
  ackFlag, deleteDoc, disconnect, fetchVault, importSeed, money, ownerLabel, refreshFeeds, webauthnSupported,
  type Owner, type VaultAccount, type VaultItem, type VaultPicture,
} from "../lib/vault";
import { lockVault, unlockVault } from "../lib/vault";
import { AccountModal, ConnectModal, ItemModal, Modal, NewAccountModal, UploadModal } from "../views/Vault";
import "../styles/vault.css";
import "./vault-final.css";
import { Icon } from "./icons";
import { tn, useLang, useT } from "../i18n";
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
  const t = useT();
  const st = useLock();
  const [busy, setBusy] = useState(false);
  if (st.locked) return null;
  return (
    <button
      type="button"
      className="vault-button"
      disabled={!st.canLock || busy}
      title={st.canLock ? t("vault.lockTitle") : t("vault.lockNeedsPasskey")}
      onClick={async () => {
        setBusy(true);
        const r = await lockVault();
        setBusy(false);
        if (r.ok) setLock({ locked: true, rev: st.rev + 1 });
      }}
    >
      <G n="lock" /> {t("vault.lock")}
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
  const t = useT();
  const lang = useLang();
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

  const say = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((x) => (x === msg ? "" : x)), 6000);
  };
  const close = () => {
    setDialog(null);
    void load();
  };

  // Labels are produced in the current language, so the language is part of the memo.
  const records = useMemo(() => (pic ? recordsOf(pic) : []), [pic, lang]); // eslint-disable-line react-hooks/exhaustive-deps
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
          <h1>{err.code === "vault-locked" ? t("vault.errKeyTitle") : err.status === 404 ? t("vault.errPrivateTitle") : t("vault.errStillHereTitle")}</h1>
          <p>
            {err.code === "vault-locked"
              ? t("vault.errKeyBody")
              : err.status === 404
                ? t("vault.errPrivateBody")
                : t("vault.errCouldNotLoad", { error: err.error })}
          </p>
          {err.status !== 404 && err.code !== "vault-locked" && (
            <button type="button" className="vault-button primary" onClick={() => void load()}>
              {t("common.tryAgain")}
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
    .filter((r) => `${r.name} ${r.kind} ${ownerLabel(r.owner)}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => (sort === "balance" ? Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0) : sort === "attention" ? (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0) : a.name.localeCompare(b.name)));

  const refresh = async () => {
    setBusy("refresh");
    const r = await refreshFeeds();
    setBusy("");
    say(
      r.ok
        ? tn("vault.refreshed", r.value.refreshed, {
            failed: r.value.failed ? t("vault.refreshedFailed", { n: r.value.failed }) : "",
            flags: r.value.flags.length ? t("vault.refreshedFlags", { n: r.value.flags.length }) : "",
          })
        : r.error,
    );
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
        <Modal title={t("vault.addToPicture")} onClose={() => setDialog(null)}>
          <div className="vault-add-choices">
            <button type="button" onClick={() => setDialog({ kind: "new-account" })}>
              <G n="bank" />
              <strong>{t("vault.financialAccount")}</strong>
              <span>{t("vault.financialAccountBody")}</span>
            </button>
            <button type="button" onClick={() => setDialog({ kind: "item", item: null })}>
              <Icon name="home" />
              <strong>{t("vault.assetOrDebt")}</strong>
              <span>{t("vault.assetOrDebtBody")}</span>
            </button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "coverage" && (
        <Modal title={t("vault.coverageTitle")} onClose={() => setDialog(null)}>
          <p className="vault-dialog-p">
            {tn("vault.coverageBody", pic.cash_flow.minimums_counted, {
              amount: money(pic.cash_flow.minimums_30d, 2),
              unknown: pic.cash_flow.minimums_unknown ? t("vault.coverageUnknown", { n: pic.cash_flow.minimums_unknown }) : "",
            })}
          </p>
          <div className="vault-coverage">
            {pressure.length ? (
              pressure.map(([o, p]) => (
                <div key={o}>
                  <span>{ownerLabel(o)}</span>
                  <span>{t("vault.dueCash", { due: money(p.minimums, 2), cash: money(p.cash, 2) })}</span>
                  <strong className={p.shortfall > 0 ? "watch" : "good"}>{p.shortfall > 0 ? t("vault.short", { amount: money(p.shortfall, 2) }) : t("vault.covered")}</strong>
                </div>
              ))
            ) : (
              <p className="vault-muted">{t("vault.noMinimums")}</p>
            )}
          </div>
          <p className="vault-form-note">{t("vault.figuresRange", { from: shortDate(pic.staleness.oldest_as_of), to: shortDate(pic.staleness.newest_as_of) })}</p>
        </Modal>
      )}
      {dialog?.kind === "explainer" && (
        <Modal title={t("vault.explainerTitle")} onClose={() => setDialog(null)}>
          <p className="vault-dialog-p">
            <strong>{t("vault.explNetWorth")}</strong> {t("vault.explNetWorthBody")}
          </p>
          <p className="vault-dialog-p">
            <strong>{t("vault.includingBusiness")}</strong>{" "}
            {t("vault.explBusinessBody", {
              own: money(pic.owner.net, 2),
              shares: shares.map((s) => t("vault.explShare", { pct: String(s.pct), owner: ownerLabel(s.owner), amount: money(s.net * (s.pct / 100), 2) })).join(""),
              total: money(pic.owner_look_through.net, 2),
            })}
          </p>
          <p className="vault-dialog-p">{t("vault.explUnknown")}</p>
        </Modal>
      )}
      {dialog?.kind === "owners" && (
        <Modal title={t("vault.ownersTitle")} onClose={() => setDialog(null)}>
          <p className="vault-dialog-p">{t("vault.ownersBody")}</p>
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
                  <span dir="auto">{g.label}</span>
                  <span>{t("vault.recordsCount", { n: g.accounts.length + g.items.length, share: sh ? t("vault.yourShare", { pct: String(sh.pct) }) : "" })}</span>
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
          <Icon name="arrow-left" /> {t("vault.backToVault")}
        </button>
        <header className="vault-heading">
          <div>
            <h1>{section === "connections" ? t("vault.connectionsTitle") : t("vault.documentsTitle")}</h1>
            <p>{section === "connections" ? t("vault.connectionsSub") : t("vault.documentsSub")}</p>
          </div>
          <div className="vault-heading-actions">
            {section === "connections" ? (
              <button type="button" className="vault-button primary" onClick={() => setDialog({ kind: "connect" })}>
                {t("vault.connectAccount")}
              </button>
            ) : (
              <button type="button" className="vault-button primary" onClick={() => setDialog({ kind: "upload" })}>
                {t("vault.addStatement")}
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
                <h2 dir="auto">{c.institution}</h2>
                <p>
                  {c.status === "active" || c.status === "connected" ? t("vault.source.linked") : c.status.replace(/_/g, " ")} · {tn("vault.accounts", c.accounts)} · {ownerLabel(c.owner)}
                </p>
                <small>
                  {t("vault.readOnlyThrough", {
                    provider: c.provider,
                    when: c.last_refresh_at ? shortDate(c.last_refresh_at) : t("vault.never"),
                    failed: c.last_refresh_ok === false ? t("vault.failedParen") : "",
                  })}
                </small>
                <div>
                  {c.status !== "disconnected" && (
                    <button
                      type="button"
                      className="vault-button"
                      onClick={async () => {
                        if (!confirm(t("vault.confirmDisconnect", { name: c.institution }))) return;
                        const r = await disconnect(c.id);
                        say(r.ok ? t("vault.disconnected", { name: c.institution }) : r.error);
                        void load();
                      }}
                    >
                      {t("vault.disconnect")}
                    </button>
                  )}
                </div>
              </article>
            ))}
            {!pic.connections.length && <p className="vault-muted">{t("vault.noBankYet")}</p>}
          </div>
        ) : (
          <div className="vault-document-grid">
            {pic.documents.map((d) => (
              <article key={d.id}>
                <Icon name="folder" />
                <strong dir="auto">{d.filename}</strong>
                <small>
                  {d.kind.replace(/-/g, " ")} · {ownerLabel(d.owner)} · {shortDate(d.uploaded_at)}
                </small>
                <p dir={d.parsed ? "auto" : undefined}>{d.parsed ? d.parsed.summary : t("vault.docNothingRead")}</p>
                <button
                  type="button"
                  className="vault-button"
                  onClick={async () => {
                    if (!confirm(t("vault.confirmDeleteDoc"))) return;
                    const r = await deleteDoc(d.id);
                    say(r.ok ? t("vault.docDeleted") : r.error);
                    void load();
                  }}
                >
                  {t("common.delete")}
                </button>
              </article>
            ))}
            {!pic.documents.length && <p className="vault-muted">{t("vault.noDocs")}</p>}
          </div>
        )}
        {dialogs}
      </section>
    );

  return (
    <section className="native-vault">
      <div className="vault-overview">
        <article className="vault-net-worth">
          <span className="eyebrow">{t("vault.netWorthEyebrow")}</span>
          <strong className={pic.owner.net < 0 ? "neg" : undefined}>{money(pic.owner.net, 2)}</strong>
          <p>{t("vault.netWorthSub")}</p>
          <div>
            <span>
              <Icon name="shield" /> {t("vault.privateByDesign")}
            </span>
            <small>
              {t("vault.figuresAsOf", {
                date: shortDate(pic.staleness.newest_as_of),
                unknown: pic.owner.unknown_figures ? t("vault.unknownLeftOut", { n: pic.owner.unknown_figures }) : "",
              })}
            </small>
          </div>
        </article>
        <div className="vault-overview-side">
          <button type="button" className="vault-summary-card" onClick={() => setDialog({ kind: "explainer" })}>
            <span>
              {t("vault.includingBusiness")} <G n="info" />
            </span>
            <strong>{money(pic.owner_look_through.net, 2)}</strong>
            <small>{shares.length ? shares.map((s) => `${ownerLabel(s.owner)} · ${s.pct}%`).join(" / ") : t("vault.noBusinessShares")}</small>
          </button>
          <button type="button" className="vault-summary-card" onClick={() => setDialog({ kind: "coverage" })}>
            <span>{t("vault.minimumsNext30")}</span>
            <strong>{money(pic.cash_flow.minimums_30d, 2)}</strong>
            <small className={covered ? "good" : "watch"}>{covered ? t("vault.coveredByCash") : t("vault.coverageVaries")}</small>
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
            <span>{t("vault.figuresToRefresh")}</span>
            <strong>
              {pic.staleness.stale_count}
              <em> / {pic.staleness.total_known}</em>
            </strong>
            <small>{t("vault.olderThan45")}</small>
          </button>
        </div>
      </div>

      <div className="vault-toolbar">
        <div>
          <button type="button" className="vault-button primary" disabled={!!busy} onClick={() => setDialog({ kind: "connect" })}>
            <Icon name="plus" /> {t("vault.connectAccount")}
          </button>
          <button type="button" className="vault-button" disabled={!!busy} aria-haspopup="dialog" onClick={() => setDialog({ kind: "manual" })}>
            {t("vault.addManually")} <Icon name="chevron" />
          </button>
          <button type="button" className="vault-button" disabled={!!busy} onClick={() => setDialog({ kind: "upload" })}>
            <Icon name="upload" /> {t("vault.addStatement")}
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
                say(r.ok ? t("vault.seedLoaded", { accounts: r.value.accounts, items: r.value.items }) : r.error);
                void load();
              }}
            >
              {t("vault.loadOctober")}
            </button>
          )}
        </div>
        <button
          type="button"
          className="vault-button"
          disabled={!!busy || !liveConnections.length}
          title={liveConnections.length ? t("vault.refreshTitle") : t("vault.connectBankFirst")}
          onClick={() => void refresh()}
        >
          <G n="refresh" /> {busy === "refresh" ? t("vault.refreshing") : t("vault.refreshFeeds")}
        </button>
      </div>
      <div className="vault-inline-links">
        <button type="button" className="vault-button" onClick={() => setSection("connections")}>
          {tn("vault.bankConnections", liveConnections.length)} <Icon name="arrow-right" />
        </button>
        <button type="button" className="vault-button" onClick={() => setSection("documents")}>
          {tn("vault.documents", pic.documents.length)} <Icon name="arrow-right" />
        </button>
      </div>
      {toast && <p className="vault-toast" role="status">{toast}</p>}

      {!records.length ? (
        <div className="vault-empty">
          <h2>{t("vault.emptyTitle")}</h2>
          <p>{t("vault.emptyBody")}</p>
          <button type="button" className="vault-button primary" onClick={() => setDialog({ kind: "connect" })}>
            {t("vault.connectAccount")}
          </button>
        </div>
      ) : (
        <>
          <div className="vault-section-title">
            <div>
              <h2>{t("vault.attentionTitle")}</h2>
              <span>{tn("vault.attentionCount", attention.length)}</span>
            </div>
            {attention.length > 4 && (
              <button type="button" className="vault-button" onClick={() => setAllAttention(!allAttention)}>
                {allAttention ? t("vault.showLess") : t("vault.tab.all")}
              </button>
            )}
          </div>
          <div className="vault-attention">
            {attention.length ? (
              attention.slice(0, allAttention ? attention.length : 4).map((a) => (
                <div key={a.key} className={`vault-flag ${a.tone}`}>
                  <i />
                  <button type="button" className="vault-flag-open" onClick={() => openId(a.recordId)} disabled={!a.recordId}>
                    <small dir="auto">{a.label}</small>
                    <strong dir="auto">{a.title}</strong>
                    <p dir="auto">{a.body}</p>
                  </button>
                  {a.flag ? (
                    <button
                      type="button"
                      className="vault-flag-ack"
                      title={t("vault.markHandledTitle")}
                      onClick={async () => {
                        const r = await ackFlag(a.flag!.id);
                        say(r.ok ? t("vault.markedHandled") : r.error);
                        void load();
                      }}
                    >
                      {t("vault.gotIt")}
                    </button>
                  ) : (
                    <G n="out" />
                  )}
                </div>
              ))
            ) : (
              <div className="vault-clear">{t("vault.nothingNeeds")}</div>
            )}
          </div>

          <div className="vault-section-title">
            <div>
              <h2>{t("vault.debtsTitle")}</h2>
              <span>{t("vault.debtsSub")}</span>
            </div>
            <select aria-label={t("vault.sortDebts")} value={debtSort} onChange={(e) => setDebtSort(e.target.value as "apr" | "interest")}>
              <option value="apr">{t("vault.highestApr")}</option>
              <option value="interest">{t("vault.estimatedInterest")}</option>
            </select>
          </div>
          <div className="vault-debts">
            {debts.length ? (
              debts.map((d) => (
                <button key={d.id} type="button" onClick={() => openId(d.id)}>
                  <span>
                    {d.institution}
                    {d.last4 ? ` ·· ${d.last4}` : ""}
                    <small>{ownerLabel(d.owner)}</small>
                  </span>
                  <strong>
                    {d.apr_pct}% <small>{t("vault.apr")}</small>
                  </strong>
                  <span>
                    ~{money(d.interest_per_year, 2)}
                    <small>{t("vault.interestPerYear")}</small>
                  </span>
                  <Icon name="chevron-right" />
                </button>
              ))
            ) : (
              <p className="vault-muted vault-debts-empty">{t("vault.noDebts")}</p>
            )}
          </div>

          <div className="vault-section-title">
            <div>
              <h2>{t("vault.everythingTitle")}</h2>
              <span>{t("vault.everythingSub")}</span>
            </div>
            <button type="button" className="vault-button" onClick={() => setDialog({ kind: "owners" })}>
              {t("vault.manageOwners")}
            </button>
          </div>
          <div className="vault-category-tabs" role="tablist" aria-label={t("vault.categoriesAria")}>
            {CATEGORY_TABS.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={cat === id} onClick={() => setCat(id)}>
                {t(label)}
                <small>{inTab(id).length}</small>
              </button>
            ))}
          </div>
          <div className="vault-list-tools">
            <label>
              <Icon name="search" />
              <input type="search" dir="auto" aria-label={t("vault.searchAria")} placeholder={t("vault.searchPlaceholder")} value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <select aria-label={t("vault.filterOwnerAria")} value={ownerF} onChange={(e) => setOwnerF(e.target.value as Owner | "all")}>
              <option value="all">{t("vault.allOwners")}</option>
              {owners.map((o) => (
                <option key={o} value={o}>
                  {ownerLabel(o)}
                </option>
              ))}
            </select>
            <select aria-label={t("vault.sortAria")} value={sort} onChange={(e) => setSort(e.target.value as "name" | "balance" | "attention")}>
              <option value="name">{t("vault.sortName")}</option>
              <option value="balance">{t("vault.sortBalance")}</option>
              <option value="attention">{t("vault.sortAttention")}</option>
            </select>
            <label className="vault-archive-filter">
              <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
              {t("vault.archived")}
            </label>
          </div>
          <div className="vault-records">
            {shown.map((r) => (
              <button key={`${r.ref}:${r.id}`} type="button" className="vault-record" onClick={() => open(r)}>
                <span className="vault-record-icon">{r.category === "cash" ? <G n="bank" /> : r.category === "credit" ? <G n="credit" /> : r.category === "property" ? <Icon name="home" /> : <Icon name="layers" />}</span>
                <span className="vault-record-main">
                  <strong dir="auto">{r.name}</strong>
                  <small>
                    {ownerLabel(r.owner)} · {r.kind}
                    {r.last4 ? ` · •• ${r.last4}` : ""}
                  </small>
                  <em className={r.stale ? "stale" : undefined}>
                    {r.archived ? t("vault.closed") : r.source} · {shortDate(r.asOf)}
                  </em>
                </span>
                <span className="vault-record-value">
                  {r.value === null ? t("common.unknown") : money(r.value, 2)}
                  {r.apr !== null && <small>{t("vault.aprValue", { n: String(r.apr) })}</small>}
                </span>
                <Icon name="chevron-right" />
              </button>
            ))}
            {!shown.length && <div className="vault-list-empty">{t("vault.noMatch")}</div>}
          </div>
        </>
      )}
      <footer className="vault-footer">
        {t("vault.footer")}
        <button type="button" className="vault-button" onClick={() => setDialog({ kind: "explainer" })}>
          {t("vault.howTotalsWork")}
        </button>
      </footer>
      {dialogs}
    </section>
  );
}

function LockedView({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="native-vault">
      <div className="vault-empty">
        <G n="lock" />
        <h1>{t("vault.lockedTitle")}</h1>
        <p>{t("vault.lockedBody")}</p>
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
          <G n="fingerprint" /> {busy ? t("vault.waitingPasskey") : t("vault.unlock")}
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
