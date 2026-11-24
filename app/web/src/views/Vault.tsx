import { useCallback, useEffect, useState } from "react";
import "../styles/vault.css";
import {
  ackFlag,
  addAccount,
  addItem,
  completeConnect,
  deleteAccount,
  deleteDoc,
  deleteItem,
  deleteSecret,
  disconnect,
  editAccount,
  editItem,
  fetchVault,
  importSeed,
  mergeAccount,
  money,
  openPlaidLink,
  ownerLabel,
  OWNERS,
  refreshFeeds,
  revealSecret,
  startConnect,
  storeSecret,
  uploadDoc,
  webauthnSupported,
  type Owner,
  type VaultAccount,
  type VaultItem,
  type VaultPicture,
} from "../lib/vault";
import { Modal } from "../components/FinalDialog";
import { IconPlus } from "../components/icons";
import { t as tr, tn, useT, type Key } from "../i18n";

/** Vault: the owner's whole financial picture, read-only, grouped by owner.
 *  Nothing nets across owners. Connecting an account and revealing a full
 *  number take his fingerprint. The gateway 404s every route for anyone else. */

const ITEM_KINDS: Array<{ key: string; label: Key }> = [
  { key: "real_estate", label: "vault.kind.realEstate" },
  { key: "vehicle", label: "vault.kind.vehicle" },
  { key: "entity_share", label: "vault.kind.entityShare" },
  { key: "crypto_holding", label: "vault.itemKind.cryptoHolding" },
  { key: "receivable", label: "vault.kind.receivable" },
  { key: "contingent", label: "vault.itemKind.contingent" },
  { key: "other", label: "vault.itemKind.other" },
];

export { Modal };

export function OwnerSelect({ value, onChange }: { value: Owner; onChange: (o: Owner) => void }) {
  useT();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as Owner)}>
      {OWNERS.map((o) => (
        <option key={o} value={o}>
          {ownerLabel(o)}
        </option>
      ))}
    </select>
  );
}

const CONFIDENCE: Record<string, Key> = { high: "vault.confidence.high", medium: "vault.confidence.medium", low: "vault.confidence.low" };

/** Called at render, so it speaks the current language. */
function sourceLabel(a: { source: string; entered_by: string; as_of: string | null; confidence: string }): string {
  const src =
    a.source === "feed" ? tr("vault.src.feed") : a.source === "bureau" ? tr("vault.src.creditReport") : a.source === "manual" ? tr("vault.src.manual", { by: a.entered_by }) : a.source === "statement" ? tr("vault.src.statement") : tr("vault.src.seed");
  const conf = CONFIDENCE[a.confidence] ? tr(CONFIDENCE[a.confidence]) : a.confidence;
  return `${a.as_of ?? tr("vault.noDateLower")} · ${src} · ${conf}`;
}

/* ── Account modal: re-tag, figure (manual only), rate, minimum, note; full number behind the fingerprint ── */

export function AccountModal({ account, all, onClose }: { account: VaultAccount; all: VaultAccount[]; onClose: () => void }) {
  const t = useT();
  const a = account;
  const [owner, setOwner] = useState<Owner>(a.owner);
  const [amount, setAmount] = useState(a.amount === null ? "" : String(a.amount));
  const [asOf, setAsOf] = useState(a.as_of ?? "");
  const [apr, setApr] = useState(a.apr_pct === null ? "" : String(a.apr_pct));
  const [min, setMin] = useState(a.min_payment === null ? "" : String(a.min_payment));
  const [note, setNote] = useState(a.note ?? "");
  const [active, setActive] = useState(a.active);
  const [secret, setSecret] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    const body: Record<string, unknown> = { owner, apr_pct: apr === "" ? null : Number(apr), min_payment: min === "" ? null : min, note: note || null, active };
    if (!a.connected) {
      body.amount = amount === "" ? null : amount;
      body.as_of = asOf || null;
    }
    const r = await editAccount(a.id, body);
    setBusy(false);
    if (r.ok) onClose();
    else setError(r.error);
  }
  async function remove() {
    if (!confirm(t("vault.confirmRemoveAccount", { name: a.institution }))) return;
    const r = await deleteAccount(a.id);
    if (r.ok) onClose();
    else setError(r.error);
  }
  async function keep() {
    setBusy(true);
    const r = await storeSecret(a.id, secret);
    setBusy(false);
    if (r.ok) {
      setSecret("");
      onClose();
    } else setError(r.error);
  }
  async function reveal() {
    setBusy(true);
    const r = await revealSecret(a.id);
    setBusy(false);
    if (r.ok) {
      setShown(r.value.value);
      setTimeout(() => setShown(null), 30_000);
    } else setError(r.error);
  }
  async function merge() {
    if (!mergeTarget) return;
    const r = await mergeAccount(a.id, mergeTarget);
    if (r.ok) onClose();
    else setError(r.error);
  }

  return (
    <Modal title={a.institution} onClose={onClose}>
      <div className="vault-row-sub">{sourceLabel(a)}{a.last4 ? t("vault.endingIn", { last4: a.last4 }) : ""}{a.connected ? t("vault.connectedSuffix") : ""}</div>
      <label className="modal-field">
        <span className="mono-label">{t("vault.label.owner")}</span>
        <OwnerSelect value={owner} onChange={setOwner} />
      </label>
      {!a.connected && (
        <div className="modal-row">
          <label className="modal-field">
            <span className="mono-label">{a.kind === "liability" ? t("vault.label.balanceOwed") : t("vault.label.balance")}</span>
            <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="modal-field">
            <span className="mono-label">{t("vault.label.asOf")}</span>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </label>
        </div>
      )}
      {a.kind === "liability" && (
        <div className="modal-row">
          <label className="modal-field">
            <span className="mono-label">{t("vault.label.rate")}</span>
            <input type="text" inputMode="decimal" value={apr} onChange={(e) => setApr(e.target.value)} />
          </label>
          <label className="modal-field">
            <span className="mono-label">{t("vault.label.minimum")}</span>
            <input type="text" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} />
          </label>
        </div>
      )}
      <label className="modal-field">
        <span className="mono-label">{t("vault.label.note")}</span>
        <textarea rows={3} dir="auto" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <label className="modal-check">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        {t("vault.active")}
      </label>
      <div className="modal-field">
        <span className="mono-label">{t("vault.label.fullNumber")}</span>
        {shown ? (
          <div className="vault-secret" dir="ltr">{shown}</div>
        ) : a.has_secret_number ? (
          <div className="vault-band">
            <button className="btn-quiet" onClick={reveal} disabled={busy || !webauthnSupported()}>
              {t("vault.showOnce")}
            </button>
            <button className="btn-quiet" onClick={() => void deleteSecret(a.id).then(onClose)} disabled={busy}>
              {t("vault.forgetIt")}
            </button>
          </div>
        ) : (
          <div className="modal-row">
            <input type="text" inputMode="numeric" autoComplete="off" dir="ltr" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={t("vault.secretPlaceholder")} />
            <button className="btn-quiet" onClick={keep} disabled={busy || secret.length < 4 || !webauthnSupported()}>
              {t("vault.keep")}
            </button>
          </div>
        )}
      </div>
      {!a.connected && a.source === "bureau" && (
        <label className="modal-field">
          <span className="mono-label">{t("vault.label.thisIsReally")}</span>
          <div className="modal-row">
            <select value={mergeTarget} onChange={(e) => setMergeTarget(e.target.value)}>
              <option value="">{t("vault.mergePlaceholder")}</option>
              {all.filter((x) => x.id !== a.id && x.kind === "liability").map((x) => (
                <option key={x.id} value={x.id}>
                  {x.institution}{x.last4 ? ` (${x.last4})` : ""}
                </option>
              ))}
            </select>
            <button className="btn-quiet" onClick={merge} disabled={!mergeTarget}>
              {t("vault.merge")}
            </button>
          </div>
        </label>
      )}
      {error && <div className="modal-error mono-label">{error.toUpperCase()}</div>}
      <div className="modal-foot">
        <button className="btn-quiet" onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </button>
        <div className="modal-foot-spacer" />
        {!a.connected && (
          <button className="btn-danger" onClick={remove} disabled={busy}>
            {t("common.remove")}
          </button>
        )}
        <button className="btn-accent" onClick={save} disabled={busy}>
          {busy ? t("common.saving") : t("common.save")}
        </button>
      </div>
    </Modal>
  );
}

/* ── Item modal (real estate, vehicles, entity %, dad's BTC, contingent) ── */

export function ItemModal({ item, onClose }: { item: VaultItem | null; onClose: () => void }) {
  const t = useT();
  const [owner, setOwner] = useState<Owner>(item?.owner ?? "owner");
  const [name, setName] = useState(item?.name ?? "");
  const [kind, setKind] = useState(item?.kind ?? "real_estate");
  const [side, setSide] = useState(item?.side ?? "asset");
  const [amount, setAmount] = useState(item?.amount === null || item?.amount === undefined ? "" : String(item.amount));
  const [asOf, setAsOf] = useState(item?.as_of ?? new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState(item?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    if (!name.trim()) return setError(t("vault.giveName"));
    setBusy(true);
    const body = { owner, name, kind, side: kind === "contingent" ? "contingent" : side, amount: amount === "" ? null : amount, as_of: asOf || null, note: note || null };
    const r = item ? await editItem(item.id, body) : await addItem(body);
    setBusy(false);
    if (r.ok) onClose();
    else setError(r.error);
  }
  async function remove() {
    if (!item || !confirm(t("vault.confirmRemoveItem", { name: item.name }))) return;
    const r = await deleteItem(item.id);
    if (r.ok) onClose();
    else setError(r.error);
  }
  return (
    <Modal title={item ? t("vault.editItem") : t("vault.addItem")} onClose={onClose}>
      {item && <div className="vault-row-sub">{t("vault.enteredBy", { who: item.entered_by, date: item.entered_at.slice(0, 10) })}</div>}
      <label className="modal-field">
        <span className="mono-label">{t("vault.label.name")}</span>
        <input type="text" dir="auto" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("vault.namePlaceholder")} />
      </label>
      <div className="modal-row">
        <label className="modal-field">
          <span className="mono-label">{t("vault.label.owner")}</span>
          <OwnerSelect value={owner} onChange={setOwner} />
        </label>
        <label className="modal-field">
          <span className="mono-label">{t("vault.label.kind")}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {ITEM_KINDS.map((k) => (
              <option key={k.key} value={k.key}>
                {t(k.label)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {kind !== "contingent" && (
        <label className="modal-field">
          <span className="mono-label">{t("vault.label.side")}</span>
          <select value={side} onChange={(e) => setSide(e.target.value as "asset" | "liability")}>
            <option value="asset">{t("vault.assetWorth")}</option>
            <option value="liability">{t("vault.liabilityOwed")}</option>
          </select>
        </label>
      )}
      <div className="modal-row">
        <label className="modal-field">
          <span className="mono-label">{t("vault.label.amount")}</span>
          <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="modal-field">
          <span className="mono-label">{t("vault.label.asOf")}</span>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
      </div>
      <label className="modal-field">
        <span className="mono-label">{t("vault.label.note")}</span>
        <textarea rows={3} dir="auto" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {error && <div className="modal-error mono-label">{error.toUpperCase()}</div>}
      <div className="modal-foot">
        <button className="btn-quiet" onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </button>
        <div className="modal-foot-spacer" />
        {item && (
          <button className="btn-danger" onClick={remove} disabled={busy}>
            {t("common.remove")}
          </button>
        )}
        <button className="btn-accent" onClick={save} disabled={busy}>
          {busy ? t("common.saving") : t("common.save")}
        </button>
      </div>
    </Modal>
  );
}

/* ── Manual account modal ── */

export function NewAccountModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [owner, setOwner] = useState<Owner>("owner");
  const [kind, setKind] = useState<"asset" | "liability">("liability");
  const [institution, setInstitution] = useState("");
  const [subtype, setSubtype] = useState("");
  const [last4, setLast4] = useState("");
  const [amount, setAmount] = useState("");
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [apr, setApr] = useState("");
  const [min, setMin] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    if (!institution.trim()) return setError(t("vault.nameInstitution"));
    setBusy(true);
    const r = await addAccount({ owner, kind, institution, subtype: subtype || undefined, last4: last4 || null, amount: amount === "" ? null : amount, as_of: asOf, apr_pct: apr === "" ? null : Number(apr), min_payment: min === "" ? null : min, note: note || null });
    setBusy(false);
    if (r.ok) onClose();
    else setError(r.error);
  }
  return (
    <Modal title={t("vault.addAccountByHand")} onClose={onClose}>
      <div className="modal-row">
        <label className="modal-field">
          <span className="mono-label">{t("vault.label.owner")}</span>
          <OwnerSelect value={owner} onChange={setOwner} />
        </label>
        <label className="modal-field">
          <span className="mono-label">{t("vault.label.side")}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as "asset" | "liability")}>
            <option value="liability">{t("vault.debt")}</option>
            <option value="asset">{t("vault.asset")}</option>
          </select>
        </label>
      </div>
      <label className="modal-field">
        <span className="mono-label">{t("vault.label.institution")}</span>
        <input type="text" dir="auto" value={institution} onChange={(e) => setInstitution(e.target.value)} placeholder={t("vault.institutionPlaceholder")} />
      </label>
      <div className="modal-row">
        <label className="modal-field">
          <span className="mono-label">{t("vault.label.type")}</span>
          <input type="text" dir="ltr" value={subtype} onChange={(e) => setSubtype(e.target.value)} placeholder="credit_card, loan, cash…" />
        </label>
        <label className="modal-field">
          <span className="mono-label">{t("vault.label.last4")}</span>
          <input type="text" inputMode="numeric" dir="ltr" maxLength={4} value={last4} onChange={(e) => setLast4(e.target.value)} />
        </label>
      </div>
      <div className="modal-row">
        <label className="modal-field">
          <span className="mono-label">{t("vault.label.balance")}</span>
          <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="modal-field">
          <span className="mono-label">{t("vault.label.asOf")}</span>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
      </div>
      {kind === "liability" && (
        <div className="modal-row">
          <label className="modal-field">
            <span className="mono-label">{t("vault.label.rate")}</span>
            <input type="text" inputMode="decimal" value={apr} onChange={(e) => setApr(e.target.value)} />
          </label>
          <label className="modal-field">
            <span className="mono-label">{t("vault.label.minimum")}</span>
            <input type="text" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} />
          </label>
        </div>
      )}
      <label className="modal-field">
        <span className="mono-label">{t("vault.label.note")}</span>
        <textarea rows={2} dir="auto" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {error && <div className="modal-error mono-label">{error.toUpperCase()}</div>}
      <div className="modal-foot">
        <button className="btn-quiet" onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </button>
        <div className="modal-foot-spacer" />
        <button className="btn-accent" onClick={save} disabled={busy}>
          {busy ? t("common.saving") : t("common.save")}
        </button>
      </div>
    </Modal>
  );
}

/* ── Connect: owner → fingerprint → the provider's own sign-in ── */

export function ConnectModal({ picture, onClose }: { picture: VaultPicture; onClose: () => void }) {
  const t = useT();
  const [owner, setOwner] = useState<Owner>("owner");
  const [stage, setStage] = useState<"pick" | "link" | "paste" | "done">("pick");
  const [session, setSession] = useState("");
  const [instructions, setInstructions] = useState("");
  const [paste, setPaste] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function begin() {
    setBusy(true);
    setError("");
    const r = await startConnect(owner);
    if (!r.ok) {
      setBusy(false);
      return setError(r.error);
    }
    setSession(r.value.session);
    setInstructions(r.value.instructions);
    if (r.value.mode === "paste") {
      setStage("paste");
      setBusy(false);
      return;
    }
    setStage("link");
    let payload: string | null = null;
    if (r.value.link_token) payload = await openPlaidLink(r.value.link_token);
    else if (r.value.url) {
      window.open(r.value.url, "_blank", "noopener");
      setStage("paste");
      setBusy(false);
      return;
    }
    if (!payload) {
      setBusy(false);
      setStage("pick");
      return setError(t("vault.bankClosed"));
    }
    // The session id is passed along, not read from state: this closure still holds the render
    // before setSession, so reading `session` here was "" and every Link connect failed.
    await finish(payload, r.value.session);
  }
  async function finish(payload: string, sessionId: string = session) {
    setBusy(true);
    const r = await completeConnect(sessionId, payload);
    setBusy(false);
    if (!r.ok) {
      setStage("pick");
      return setError(r.error);
    }
    setResult(tn("vault.connectResult", r.value.accounts, { institution: r.value.institution, owner: ownerLabel(owner) }));
    setStage("done");
  }

  return (
    <Modal title={t("vault.connectAnAccount")} onClose={onClose}>
      {stage === "pick" && (
        <>
          <p className="vault-row-sub">{t("vault.connectIntro", { provider: picture.provider.name, scopes: picture.provider.scopes.join(", ") })}</p>
          {!picture.provider.configured && <div className="modal-error mono-label">{t("vault.providerNotSetUp", { provider: picture.provider.name.toUpperCase() })}</div>}
          {picture.passkeys === 0 && <div className="modal-error mono-label">{t("vault.addPasskeyFirst")}</div>}
          <label className="modal-field">
            <span className="mono-label">{t("vault.label.whoseMoney")}</span>
            <OwnerSelect value={owner} onChange={setOwner} />
          </label>
        </>
      )}
      {stage === "link" && <p className="vault-row-sub" dir="auto">{instructions}</p>}
      {stage === "paste" && (
        <>
          <p className="vault-row-sub" dir="auto">{instructions}</p>
          <textarea className="vault-paste" dir="ltr" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={t("vault.pastePlaceholder")} />
        </>
      )}
      {stage === "done" && <p>{result}</p>}
      {error && <div className="modal-error mono-label">{error.toUpperCase()}</div>}
      <div className="modal-foot">
        <button className="btn-quiet" onClick={onClose} disabled={busy && stage !== "link"}>
          {stage === "done" ? t("common.close") : t("common.cancel")}
        </button>
        <div className="modal-foot-spacer" />
        {stage === "pick" && (
          <button className="btn-accent" onClick={begin} disabled={busy || !picture.provider.configured || picture.passkeys === 0 || !webauthnSupported()}>
            {busy ? t("vault.waitingFingerprint") : t("vault.fingerprintConnect")}
          </button>
        )}
        {stage === "paste" && (
          <button className="btn-accent" onClick={() => finish(paste.trim())} disabled={busy || !paste.trim()}>
            {t("vault.connect")}
          </button>
        )}
      </div>
    </Modal>
  );
}

/* ── Upload a statement or credit report ── */

export function UploadModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState("credit-report");
  const [owner, setOwner] = useState<Owner>("owner");
  const [institution, setInstitution] = useState("");
  const [asOf, setAsOf] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  async function go() {
    if (!file) return;
    setBusy(true);
    const r = await uploadDoc(file, { kind, owner, institution: institution || undefined, as_of: asOf || undefined });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setDone(r.value.document.parsed?.summary ?? (r.value.parse_error ? t("vault.storedNotParsed", { error: r.value.parse_error }) : t("vault.storedNoParser")));
  }
  return (
    <Modal title={t("vault.uploadTitle")} onClose={onClose}>
      {done ? (
        <p dir="auto">{done}</p>
      ) : (
        <>
          <p className="vault-row-sub">{t("vault.uploadIntro")}</p>
          <label className="modal-field">
            <span className="mono-label">{t("vault.label.file")}</span>
            <input type="file" accept=".pdf,.txt,.csv,application/pdf,text/plain" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <div className="modal-row">
            <label className="modal-field">
              <span className="mono-label">{t("vault.label.kind")}</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="credit-report">{t("vault.kind.creditReport")}</option>
                <option value="statement">{t("vault.source.statement")}</option>
                <option value="other">{t("vault.itemKind.other")}</option>
              </select>
            </label>
            <label className="modal-field">
              <span className="mono-label">{t("vault.label.owner")}</span>
              <OwnerSelect value={owner} onChange={setOwner} />
            </label>
          </div>
          <div className="modal-row">
            <label className="modal-field">
              <span className="mono-label">{t("vault.label.institution")}</span>
              <input type="text" dir="auto" value={institution} onChange={(e) => setInstitution(e.target.value)} />
            </label>
            <label className="modal-field">
              <span className="mono-label">{t("vault.label.asOf")}</span>
              <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            </label>
          </div>
        </>
      )}
      {error && <div className="modal-error mono-label">{error.toUpperCase()}</div>}
      <div className="modal-foot">
        <button className="btn-quiet" onClick={onClose} disabled={busy}>
          {done ? t("common.close") : t("common.cancel")}
        </button>
        <div className="modal-foot-spacer" />
        {!done && (
          <button className="btn-accent" onClick={go} disabled={busy || !file}>
            {busy ? t("vault.uploading") : t("common.upload")}
          </button>
        )}
      </div>
    </Modal>
  );
}

/* ── The tab ── */

export default function Vault() {
  const t = useT();
  const [pic, setPic] = useState<VaultPicture | null>(null);
  const [err, setErr] = useState<{ error: string; code?: string; status?: number } | null>(null);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [modal, setModal] = useState<{ kind: "account"; account: VaultAccount } | { kind: "item"; item: VaultItem | null } | { kind: "new-account" } | { kind: "connect" } | { kind: "upload" } | null>(null);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    const r = await fetchVault();
    if (r.ok) {
      setPic(r.value);
      setErr(null);
    } else setErr({ error: r.error, code: r.code, status: r.status });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const close = () => {
    setModal(null);
    void load();
  };

  async function act(label: string, fn: () => Promise<{ ok: boolean; error?: string }>, after?: (r: { ok: boolean; value?: unknown }) => string) {
    setBusy(label);
    const r = await fn();
    setBusy("");
    setToast(r.ok ? (after ? after(r as { ok: boolean; value?: unknown }) : t("vault.actDone", { label })) : r.error ?? t("vault.actFailed", { label }));
    setTimeout(() => setToast(""), 6000);
    void load();
  }

  if (err) {
    const locked = err.code === "vault-locked";
    return (
      <div className="tool-page">
        <div className="tool-empty mono-label">{locked ? t("vault.legacyLocked") : err.status === 404 ? t("vault.legacyNotYours") : err.error.toUpperCase()}</div>
      </div>
    );
  }
  if (!pic) {
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

  const allAccounts = pic.owners.flatMap((g) => g.accounts);
  const ownerPressure = pic.cash_flow.pressure_by_owner.owner;

  return (
    <div className="tool-page">
      {/* Redesign (slice 8): FINAL's net-worth hero and three side cards, same figures as before. */}
      <div className="vault-hero">
        <div className="vault-net">
          <div className="rd-eyebrow">{t("vault.netWorthEyebrow")}</div>
          <div className={`vault-net-n${pic.owner.net < 0 ? " vault-stale" : ""}`}>{money(pic.owner.net)}</div>
          <p>{t("vault.legacyNetWorthSub")}</p>
          <div className="vault-net-foot">{t("vault.legacyNetFoot")}</div>
        </div>
        <div className="vault-side">
          <div className="vault-side-card">
            <div className="vault-side-label">{t("vault.includingBusiness")}</div>
            <div className="vault-side-n">{money(pic.owner_look_through.net)}</div>
            <small>{t("vault.yourShareEntities")}</small>
          </div>
          <div className="vault-side-row">
            <div className="vault-side-card">
              <div className="vault-side-label">{t("vault.minimumsNext30")}</div>
              <div className="vault-side-n">{money(pic.cash_flow.minimums_30d)}</div>
              <small>{pic.cash_flow.minimums_unknown ? t("vault.unknownCount", { n: pic.cash_flow.minimums_unknown }) : t("vault.scheduledMinimums")}</small>
            </div>
            <div className="vault-side-card">
              <div className="vault-side-label">{t("vault.figuresToRefresh")}</div>
              <div className={`vault-side-n${pic.staleness.stale_count ? " vault-stale" : ""}`}>
                {pic.staleness.stale_count}
                <span>/{pic.staleness.total_known}</span>
              </div>
              <small>{t("vault.pastFreshness")}</small>
            </div>
          </div>
        </div>
      </div>
      {ownerPressure && (
        <div className="vault-row-sub">
          {t("vault.pressureLine", {
            min: money(ownerPressure.minimums),
            cash: money(ownerPressure.cash),
            result: ownerPressure.shortfall > 0 ? t("vault.shortLower", { amount: money(ownerPressure.shortfall) }) : t("vault.coveredLower"),
            from: pic.staleness.oldest_as_of ?? "—",
            to: pic.staleness.newest_as_of ?? "—",
          })}
        </div>
      )}

      <div className="vault-band">
        {!pic.initialized && (
          <button className="btn-accent" disabled={!!busy} onClick={() => act(t("vault.seedImport"), () => importSeed(), (r) => t("vault.seeded", { accounts: (r.value as { accounts: number; items: number }).accounts, items: (r.value as { items: number }).items }))}>
            {t("vault.loadPhase1")}
          </button>
        )}
        <button className="btn-quiet" disabled={!!busy} onClick={() => setModal({ kind: "upload" })}>
          {t("vault.uploadDocument")}
        </button>
        <button className="btn-quiet" disabled={!!busy} onClick={() => setModal({ kind: "new-account" })}>
          {t("vault.addAccountByHand")}
        </button>
        <button className="btn-quiet" disabled={!!busy} onClick={() => setModal({ kind: "item", item: null })}>
          <IconPlus /> {t("vault.addItem")}
        </button>
        <button className="btn-quiet" disabled={!!busy || !pic.connections.length} onClick={() => act(t("common.refresh"), () => refreshFeeds(), (r) => t("vault.refreshedFlagsLegacy", { n: (r.value as { refreshed: number }).refreshed, flags: (r.value as { flags: unknown[] }).flags.length }))}>
          {t("vault.refreshFeeds")}
        </button>
        <button className="btn-accent" disabled={!!busy} onClick={() => setModal({ kind: "connect" })}>
          {t("vault.connectAnAccount")}
        </button>
      </div>
      {toast && <div className="vault-row-sub" dir="auto">{toast}</div>}

      {pic.flags.length > 0 && (
        <section className="cost-bucket">
          <div className="cost-bucket-head">
            <span className="cost-bucket-name">{t("vault.needsYou")}</span>
          </div>
          {pic.flags.map((f) => (
            <div key={f.id} className="vault-flag">
              <div className="vault-flag-body">
                <div dir="auto">{f.title}</div>
                <div className="vault-row-sub">{f.detail} · {ownerLabel(f.owner)} · {f.raised_at.slice(0, 10)}</div>
              </div>
              <button className="btn-quiet" onClick={() => act(t("vault.ack"), () => ackFlag(f.id))}>
                {t("vault.gotIt")}
              </button>
            </div>
          ))}
        </section>
      )}

      {pic.expensive_debts.length > 0 && (
        <section className="cost-bucket">
          <div className="cost-bucket-head">
            <span className="cost-bucket-name">{t("vault.debtsByRate")}</span>
          </div>
          {pic.expensive_debts.map((d) => (
            <div key={d.id} className="bill-row">
              <div className="bill-main">
                <span className="bill-name">{d.institution}{d.last4 ? ` (${d.last4})` : ""}</span>
                <span className="bill-amount mono">{t("vault.aprOn", { apr: String(d.apr_pct), amount: money(d.amount) })}</span>
              </div>
              <div className="bill-meta">
                <span className="tool-chip">{ownerLabel(d.owner).toUpperCase()}</span>
                <span className="mono-label">{t("vault.perYear", { amount: money(d.interest_per_year) })}</span>
              </div>
            </div>
          ))}
        </section>
      )}

      {pic.owners.map((g) => (
        <section key={g.owner} className="vault-owner">
          <div className="vault-owner-head" onClick={() => setClosed((o) => ({ ...o, [g.owner]: !o[g.owner] }))}>
            <span className="vault-owner-name" dir="auto">{g.label}</span>
            <span className="vault-row-sub">
              {money(g.totals.assets)} − {money(g.totals.liabilities)}
              {g.totals.unknown_figures ? ` · ${t("vault.unknownCount", { n: g.totals.unknown_figures })}` : ""}
            </span>
            <span className={`vault-owner-net${g.totals.net < 0 ? " neg" : ""}`}>{money(g.totals.net)}</span>
          </div>
          {!closed[g.owner] && (
            <div className="cost-bucket">
              {g.accounts.map((a) => (
                <div key={a.id} className={`bill-row${a.active ? "" : " inactive"}`} onClick={() => setModal({ kind: "account", account: a })} role="button">
                  <div className="bill-main">
                    <span className="bill-name">{a.institution}{a.last4 ? ` (${a.last4})` : ""}</span>
                    <span className="bill-amount mono">{a.kind === "liability" && a.amount !== null ? `−${money(a.amount)}` : money(a.amount)}</span>
                  </div>
                  <div className="bill-meta">
                    <span className={`mono-label${a.stale ? " vault-stale" : ""}`}>{sourceLabel(a)}</span>
                    <span className="tool-chip">{a.subtype.replace(/_/g, " ").toUpperCase()}</span>
                    {a.apr_pct !== null && <span className="tool-chip">{a.apr_pct}%</span>}
                    {a.min_payment !== null && <span className="tool-chip">{t("vault.minChip", { amount: money(a.min_payment) })}</span>}
                    {a.connected && <span className="tool-chip">{t("vault.liveChip")}</span>}
                    {a.shared_with.length > 0 && <span className="tool-chip">{t("vault.withChip", { owners: a.shared_with.map((o) => ownerLabel(o)).join(", ").toUpperCase() })}</span>}
                    {!a.active && <span className="tool-chip">{t("vault.closedChip")}</span>}
                  </div>
                </div>
              ))}
              {g.items.map((i) => (
                <div key={i.id} className="bill-row" onClick={() => setModal({ kind: "item", item: i })} role="button">
                  <div className="bill-main">
                    <span className="bill-name" dir="auto">{i.name}</span>
                    <span className="bill-amount mono">{i.side === "liability" && i.amount !== null ? `−${money(i.amount)}` : i.side === "contingent" ? `(${money(i.amount)})` : money(i.amount)}</span>
                  </div>
                  <div className="bill-meta">
                    <span className="mono-label">{sourceLabel(i)}</span>
                    <span className="tool-chip">{i.kind.replace(/_/g, " ").toUpperCase()}</span>
                    {i.split && <span className="tool-chip">{Object.entries(i.split).map(([o, p]) => `${ownerLabel(o as Owner)} ${p}%`).join(" / ").toUpperCase()}</span>}
                    {i.shared_with.length > 0 && <span className="tool-chip">{t("vault.withChip", { owners: i.shared_with.map((o) => ownerLabel(o)).join(", ").toUpperCase() })}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      ))}

      {pic.connections.length > 0 && (
        <section className="cost-bucket vault-owner">
          <div className="cost-bucket-head">
            <span className="cost-bucket-name">{t("vault.connections")}</span>
          </div>
          {pic.connections.map((c) => (
            <div key={c.id} className="bill-row">
              <div className="bill-main">
                <span className="bill-name">{c.institution}</span>
                <span className="mono-label">{c.status.replace(/_/g, " ").toUpperCase()}</span>
              </div>
              <div className="bill-meta">
                <span className="mono-label">
                  {t("vault.connLine", { owner: ownerLabel(c.owner), n: c.accounts, when: c.last_refresh_at?.slice(0, 10) ?? t("vault.never"), failed: c.last_refresh_ok === false ? t("vault.failedSuffix") : "" })}
                </span>
                <span className="bill-spacer" />
                <button className="btn-danger" onClick={() => confirm(t("vault.confirmDisconnectShort", { name: c.institution })) && act(t("vault.disconnect"), () => disconnect(c.id))}>
                  {t("vault.disconnect")}
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {pic.documents.length > 0 && (
        <section className="cost-bucket vault-owner">
          <div className="cost-bucket-head">
            <span className="cost-bucket-name">{t("vault.documentsHeading")}</span>
          </div>
          {pic.documents.map((d) => (
            <div key={d.id} className="bill-row">
              <div className="bill-main">
                <span className="bill-name" dir="auto">{d.filename}</span>
                <span className="mono-label">{d.kind.toUpperCase()}</span>
              </div>
              <div className="bill-meta">
                <span className="mono-label">{d.uploaded_at.slice(0, 10)} · {ownerLabel(d.owner)}{d.parsed ? ` · ${d.parsed.summary}` : ""}</span>
                <span className="bill-spacer" />
                <button className="btn-quiet" onClick={() => confirm(t("vault.confirmDeleteDocShort")) && act(t("common.delete"), () => deleteDoc(d.id))}>
                  {t("common.delete")}
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {pic.owners.length === 0 && <div className="tool-empty mono-label">{t("vault.legacyEmpty")}</div>}

      {modal?.kind === "account" && <AccountModal account={modal.account} all={allAccounts} onClose={close} />}
      {modal?.kind === "item" && <ItemModal item={modal.item} onClose={close} />}
      {modal?.kind === "new-account" && <NewAccountModal onClose={close} />}
      {modal?.kind === "connect" && <ConnectModal picture={pic} onClose={close} />}
      {modal?.kind === "upload" && <UploadModal onClose={close} />}
    </div>
  );
}
