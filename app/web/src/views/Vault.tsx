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
  OWNER_LABELS,
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

/** Vault: the owner's whole financial picture, read-only, grouped by owner.
 *  Nothing nets across owners. Connecting an account and revealing a full
 *  number take his fingerprint. The gateway 404s every route for anyone else. */

const ITEM_KINDS = [
  { key: "real_estate", label: "Real estate" },
  { key: "vehicle", label: "Vehicle" },
  { key: "entity_share", label: "Entity share" },
  { key: "crypto_holding", label: "Crypto holding" },
  { key: "receivable", label: "Receivable" },
  { key: "contingent", label: "Contingent exposure" },
  { key: "other", label: "Other" },
];

export { Modal };

export function OwnerSelect({ value, onChange }: { value: Owner; onChange: (o: Owner) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as Owner)}>
      {OWNERS.map((o) => (
        <option key={o} value={o}>
          {OWNER_LABELS[o]}
        </option>
      ))}
    </select>
  );
}

function sourceLabel(a: { source: string; entered_by: string; as_of: string | null; confidence: string }): string {
  const src = a.source === "feed" ? "feed" : a.source === "bureau" ? "credit report" : a.source === "manual" ? `manual · ${a.entered_by}` : a.source === "statement" ? "statement" : "seed";
  return `${a.as_of ?? "no date"} · ${src} · ${a.confidence}`;
}

/* ── Account modal: re-tag, figure (manual only), rate, minimum, note; full number behind the fingerprint ── */

export function AccountModal({ account, all, onClose }: { account: VaultAccount; all: VaultAccount[]; onClose: () => void }) {
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
    if (!confirm(`Remove "${a.institution}" from the vault?`)) return;
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
      <div className="vault-row-sub">{sourceLabel(a)}{a.last4 ? ` · ending ${a.last4}` : ""}{a.connected ? " · connected" : ""}</div>
      <label className="modal-field">
        <span className="mono-label">OWNER</span>
        <OwnerSelect value={owner} onChange={setOwner} />
      </label>
      {!a.connected && (
        <div className="modal-row">
          <label className="modal-field">
            <span className="mono-label">{a.kind === "liability" ? "BALANCE OWED" : "BALANCE"}</span>
            <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="modal-field">
            <span className="mono-label">AS OF</span>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </label>
        </div>
      )}
      {a.kind === "liability" && (
        <div className="modal-row">
          <label className="modal-field">
            <span className="mono-label">RATE %</span>
            <input type="text" inputMode="decimal" value={apr} onChange={(e) => setApr(e.target.value)} />
          </label>
          <label className="modal-field">
            <span className="mono-label">MINIMUM / MO</span>
            <input type="text" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} />
          </label>
        </div>
      )}
      <label className="modal-field">
        <span className="mono-label">NOTE</span>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <label className="modal-check">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Active
      </label>
      <div className="modal-field">
        <span className="mono-label">FULL ACCOUNT NUMBER (FINGERPRINT)</span>
        {shown ? (
          <div className="vault-secret">{shown}</div>
        ) : a.has_secret_number ? (
          <div className="vault-band">
            <button className="btn-quiet" onClick={reveal} disabled={busy || !webauthnSupported()}>
              Show once
            </button>
            <button className="btn-quiet" onClick={() => void deleteSecret(a.id).then(onClose)} disabled={busy}>
              Forget it
            </button>
          </div>
        ) : (
          <div className="modal-row">
            <input type="text" inputMode="numeric" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="kept encrypted; shown only with your fingerprint" />
            <button className="btn-quiet" onClick={keep} disabled={busy || secret.length < 4 || !webauthnSupported()}>
              Keep
            </button>
          </div>
        )}
      </div>
      {!a.connected && a.source === "bureau" && (
        <label className="modal-field">
          <span className="mono-label">THIS IS REALLY…</span>
          <div className="modal-row">
            <select value={mergeTarget} onChange={(e) => setMergeTarget(e.target.value)}>
              <option value="">(merge into an existing account)</option>
              {all.filter((x) => x.id !== a.id && x.kind === "liability").map((x) => (
                <option key={x.id} value={x.id}>
                  {x.institution}{x.last4 ? ` (${x.last4})` : ""}
                </option>
              ))}
            </select>
            <button className="btn-quiet" onClick={merge} disabled={!mergeTarget}>
              Merge
            </button>
          </div>
        </label>
      )}
      {error && <div className="modal-error mono-label">{error.toUpperCase()}</div>}
      <div className="modal-foot">
        <button className="btn-quiet" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <div className="modal-foot-spacer" />
        {!a.connected && (
          <button className="btn-danger" onClick={remove} disabled={busy}>
            Remove
          </button>
        )}
        <button className="btn-accent" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}

/* ── Item modal (real estate, vehicles, entity %, dad's BTC, contingent) ── */

export function ItemModal({ item, onClose }: { item: VaultItem | null; onClose: () => void }) {
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
    if (!name.trim()) return setError("Give it a name");
    setBusy(true);
    const body = { owner, name, kind, side: kind === "contingent" ? "contingent" : side, amount: amount === "" ? null : amount, as_of: asOf || null, note: note || null };
    const r = item ? await editItem(item.id, body) : await addItem(body);
    setBusy(false);
    if (r.ok) onClose();
    else setError(r.error);
  }
  async function remove() {
    if (!item || !confirm(`Remove "${item.name}"?`)) return;
    const r = await deleteItem(item.id);
    if (r.ok) onClose();
    else setError(r.error);
  }
  return (
    <Modal title={item ? "Edit item" : "Add item"} onClose={onClose}>
      {item && <div className="vault-row-sub">Entered by {item.entered_by} on {item.entered_at.slice(0, 10)}</div>}
      <label className="modal-field">
        <span className="mono-label">NAME</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 3751 N Park Rd value" />
      </label>
      <div className="modal-row">
        <label className="modal-field">
          <span className="mono-label">OWNER</span>
          <OwnerSelect value={owner} onChange={setOwner} />
        </label>
        <label className="modal-field">
          <span className="mono-label">KIND</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {ITEM_KINDS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {kind !== "contingent" && (
        <label className="modal-field">
          <span className="mono-label">SIDE</span>
          <select value={side} onChange={(e) => setSide(e.target.value as "asset" | "liability")}>
            <option value="asset">Asset (worth)</option>
            <option value="liability">Liability (owed)</option>
          </select>
        </label>
      )}
      <div className="modal-row">
        <label className="modal-field">
          <span className="mono-label">AMOUNT</span>
          <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="modal-field">
          <span className="mono-label">AS OF</span>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
      </div>
      <label className="modal-field">
        <span className="mono-label">NOTE</span>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {error && <div className="modal-error mono-label">{error.toUpperCase()}</div>}
      <div className="modal-foot">
        <button className="btn-quiet" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <div className="modal-foot-spacer" />
        {item && (
          <button className="btn-danger" onClick={remove} disabled={busy}>
            Remove
          </button>
        )}
        <button className="btn-accent" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}

/* ── Manual account modal ── */

export function NewAccountModal({ onClose }: { onClose: () => void }) {
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
    if (!institution.trim()) return setError("Name the institution");
    setBusy(true);
    const r = await addAccount({ owner, kind, institution, subtype: subtype || undefined, last4: last4 || null, amount: amount === "" ? null : amount, as_of: asOf, apr_pct: apr === "" ? null : Number(apr), min_payment: min === "" ? null : min, note: note || null });
    setBusy(false);
    if (r.ok) onClose();
    else setError(r.error);
  }
  return (
    <Modal title="Add account by hand" onClose={onClose}>
      <div className="modal-row">
        <label className="modal-field">
          <span className="mono-label">OWNER</span>
          <OwnerSelect value={owner} onChange={setOwner} />
        </label>
        <label className="modal-field">
          <span className="mono-label">SIDE</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as "asset" | "liability")}>
            <option value="liability">Debt</option>
            <option value="asset">Asset</option>
          </select>
        </label>
      </div>
      <label className="modal-field">
        <span className="mono-label">INSTITUTION</span>
        <input type="text" value={institution} onChange={(e) => setInstitution(e.target.value)} placeholder="e.g. Capcom FCU loan" />
      </label>
      <div className="modal-row">
        <label className="modal-field">
          <span className="mono-label">TYPE</span>
          <input type="text" value={subtype} onChange={(e) => setSubtype(e.target.value)} placeholder="credit_card, loan, cash…" />
        </label>
        <label className="modal-field">
          <span className="mono-label">LAST 4</span>
          <input type="text" inputMode="numeric" maxLength={4} value={last4} onChange={(e) => setLast4(e.target.value)} />
        </label>
      </div>
      <div className="modal-row">
        <label className="modal-field">
          <span className="mono-label">BALANCE</span>
          <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="modal-field">
          <span className="mono-label">AS OF</span>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
      </div>
      {kind === "liability" && (
        <div className="modal-row">
          <label className="modal-field">
            <span className="mono-label">RATE %</span>
            <input type="text" inputMode="decimal" value={apr} onChange={(e) => setApr(e.target.value)} />
          </label>
          <label className="modal-field">
            <span className="mono-label">MINIMUM / MO</span>
            <input type="text" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} />
          </label>
        </div>
      )}
      <label className="modal-field">
        <span className="mono-label">NOTE</span>
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {error && <div className="modal-error mono-label">{error.toUpperCase()}</div>}
      <div className="modal-foot">
        <button className="btn-quiet" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <div className="modal-foot-spacer" />
        <button className="btn-accent" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}

/* ── Connect: owner → fingerprint → the provider's own sign-in ── */

export function ConnectModal({ picture, onClose }: { picture: VaultPicture; onClose: () => void }) {
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
      return setError("The bank sign-in was closed before it finished — nothing was connected.");
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
    setResult(`${r.value.institution}: ${r.value.accounts} account${r.value.accounts === 1 ? "" : "s"} under ${OWNER_LABELS[owner]}.`);
    setStage("done");
  }

  return (
    <Modal title="Connect an account" onClose={onClose}>
      {stage === "pick" && (
        <>
          <p className="vault-row-sub">
            Read-only through {picture.provider.name}. It asks for {picture.provider.scopes.join(", ")} and nothing that can move money. Your fingerprint first, then the bank's own sign-in.
          </p>
          {!picture.provider.configured && <div className="modal-error mono-label">{picture.provider.name.toUpperCase()} IS NOT SET UP ON THIS GATEWAY YET</div>}
          {picture.passkeys === 0 && <div className="modal-error mono-label">ADD A PASSKEY IN SETTINGS FIRST</div>}
          <label className="modal-field">
            <span className="mono-label">WHOSE MONEY IS THIS</span>
            <OwnerSelect value={owner} onChange={setOwner} />
          </label>
        </>
      )}
      {stage === "link" && <p className="vault-row-sub">{instructions}</p>}
      {stage === "paste" && (
        <>
          <p className="vault-row-sub">{instructions}</p>
          <textarea className="vault-paste" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste the token the provider gave you" />
        </>
      )}
      {stage === "done" && <p>{result}</p>}
      {error && <div className="modal-error mono-label">{error.toUpperCase()}</div>}
      <div className="modal-foot">
        <button className="btn-quiet" onClick={onClose} disabled={busy && stage !== "link"}>
          {stage === "done" ? "Close" : "Cancel"}
        </button>
        <div className="modal-foot-spacer" />
        {stage === "pick" && (
          <button className="btn-accent" onClick={begin} disabled={busy || !picture.provider.configured || picture.passkeys === 0 || !webauthnSupported()}>
            {busy ? "Waiting for your fingerprint…" : "Fingerprint, then connect"}
          </button>
        )}
        {stage === "paste" && (
          <button className="btn-accent" onClick={() => finish(paste.trim())} disabled={busy || !paste.trim()}>
            Connect
          </button>
        )}
      </div>
    </Modal>
  );
}

/* ── Upload a statement or credit report ── */

export function UploadModal({ onClose }: { onClose: () => void }) {
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
    setDone(r.value.document.parsed?.summary ?? (r.value.parse_error ? `Stored, but not parsed: ${r.value.parse_error}` : "Stored (encrypted). No parser for this kind yet — enter the figures by hand."));
  }
  return (
    <Modal title="Upload a document" onClose={onClose}>
      {done ? (
        <p>{done}</p>
      ) : (
        <>
          <p className="vault-row-sub">Stored encrypted. A credit report (PDF or text) is read for balances, payments and late marks; nothing personal from it is kept.</p>
          <label className="modal-field">
            <span className="mono-label">FILE</span>
            <input type="file" accept=".pdf,.txt,.csv,application/pdf,text/plain" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <div className="modal-row">
            <label className="modal-field">
              <span className="mono-label">KIND</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="credit-report">Credit report</option>
                <option value="statement">Statement</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="modal-field">
              <span className="mono-label">OWNER</span>
              <OwnerSelect value={owner} onChange={setOwner} />
            </label>
          </div>
          <div className="modal-row">
            <label className="modal-field">
              <span className="mono-label">INSTITUTION</span>
              <input type="text" value={institution} onChange={(e) => setInstitution(e.target.value)} />
            </label>
            <label className="modal-field">
              <span className="mono-label">AS OF</span>
              <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            </label>
          </div>
        </>
      )}
      {error && <div className="modal-error mono-label">{error.toUpperCase()}</div>}
      <div className="modal-foot">
        <button className="btn-quiet" onClick={onClose} disabled={busy}>
          {done ? "Close" : "Cancel"}
        </button>
        <div className="modal-foot-spacer" />
        {!done && (
          <button className="btn-accent" onClick={go} disabled={busy || !file}>
            {busy ? "Uploading…" : "Upload"}
          </button>
        )}
      </div>
    </Modal>
  );
}

/* ── The tab ── */

export default function Vault() {
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
    setToast(r.ok ? (after ? after(r as { ok: boolean; value?: unknown }) : `${label} done`) : r.error ?? `${label} failed`);
    setTimeout(() => setToast(""), 6000);
    void load();
  }

  if (err) {
    const locked = err.code === "vault-locked";
    return (
      <div className="tool-page">
        <div className="tool-empty mono-label">{locked ? "VAULT LOCKED — THE ENCRYPTION KEY IS MISSING ON THE GATEWAY. NOTHING IS SHOWN UNTIL IT IS BACK." : err.status === 404 ? "THE VAULT IS NOT YOURS TO SEE" : err.error.toUpperCase()}</div>
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
          <div className="rd-eyebrow">YOUR NET WORTH</div>
          <div className={`vault-net-n${pic.owner.net < 0 ? " vault-stale" : ""}`}>{money(pic.owner.net)}</div>
          <p>Your own assets, less what you owe.</p>
          <div className="vault-net-foot">Private by design · figures you or your banks provided</div>
        </div>
        <div className="vault-side">
          <div className="vault-side-card">
            <div className="vault-side-label">Including business ownership</div>
            <div className="vault-side-n">{money(pic.owner_look_through.net)}</div>
            <small>Your share of entities you own</small>
          </div>
          <div className="vault-side-row">
            <div className="vault-side-card">
              <div className="vault-side-label">Minimums · next 30 days</div>
              <div className="vault-side-n">{money(pic.cash_flow.minimums_30d)}</div>
              <small>{pic.cash_flow.minimums_unknown ? `${pic.cash_flow.minimums_unknown} unknown` : "Scheduled minimum payments"}</small>
            </div>
            <div className="vault-side-card">
              <div className="vault-side-label">Figures to refresh</div>
              <div className={`vault-side-n${pic.staleness.stale_count ? " vault-stale" : ""}`}>
                {pic.staleness.stale_count}
                <span>/{pic.staleness.total_known}</span>
              </div>
              <small>Past their freshness window</small>
            </div>
          </div>
        </div>
      </div>
      {ownerPressure && (
        <div className="vault-row-sub">
          You: {money(ownerPressure.minimums)} of minimums against {money(ownerPressure.cash)} cash → {ownerPressure.shortfall > 0 ? `short ${money(ownerPressure.shortfall)}` : "covered"}. Figures as of {pic.staleness.oldest_as_of ?? "—"} to {pic.staleness.newest_as_of ?? "—"}.
        </div>
      )}

      <div className="vault-band">
        {!pic.initialized && (
          <button className="btn-accent" disabled={!!busy} onClick={() => act("Seed import", () => importSeed(), (r) => `Seeded: ${(r.value as { accounts: number; items: number }).accounts} accounts, ${(r.value as { items: number }).items} items`)}>
            Load the Phase 1 snapshot
          </button>
        )}
        <button className="btn-quiet" disabled={!!busy} onClick={() => setModal({ kind: "upload" })}>
          Upload document
        </button>
        <button className="btn-quiet" disabled={!!busy} onClick={() => setModal({ kind: "new-account" })}>
          Add account by hand
        </button>
        <button className="btn-quiet" disabled={!!busy} onClick={() => setModal({ kind: "item", item: null })}>
          <IconPlus /> Add item
        </button>
        <button className="btn-quiet" disabled={!!busy || !pic.connections.length} onClick={() => act("Refresh", () => refreshFeeds(), (r) => `Refreshed ${(r.value as { refreshed: number }).refreshed}, ${(r.value as { flags: unknown[] }).flags.length} new flags`)}>
          Refresh feeds
        </button>
        <button className="btn-accent" disabled={!!busy} onClick={() => setModal({ kind: "connect" })}>
          Connect an account
        </button>
      </div>
      {toast && <div className="vault-row-sub">{toast}</div>}

      {pic.flags.length > 0 && (
        <section className="cost-bucket">
          <div className="cost-bucket-head">
            <span className="cost-bucket-name">Needs you</span>
          </div>
          {pic.flags.map((f) => (
            <div key={f.id} className="vault-flag">
              <div className="vault-flag-body">
                <div>{f.title}</div>
                <div className="vault-row-sub">{f.detail} · {OWNER_LABELS[f.owner]} · {f.raised_at.slice(0, 10)}</div>
              </div>
              <button className="btn-quiet" onClick={() => act("Ack", () => ackFlag(f.id))}>
                Got it
              </button>
            </div>
          ))}
        </section>
      )}

      {pic.expensive_debts.length > 0 && (
        <section className="cost-bucket">
          <div className="cost-bucket-head">
            <span className="cost-bucket-name">Most expensive debts by rate</span>
          </div>
          {pic.expensive_debts.map((d) => (
            <div key={d.id} className="bill-row">
              <div className="bill-main">
                <span className="bill-name">{d.institution}{d.last4 ? ` (${d.last4})` : ""}</span>
                <span className="bill-amount mono">{d.apr_pct}% on {money(d.amount)}</span>
              </div>
              <div className="bill-meta">
                <span className="tool-chip">{OWNER_LABELS[d.owner].toUpperCase()}</span>
                <span className="mono-label">≈ {money(d.interest_per_year)} / YR</span>
              </div>
            </div>
          ))}
        </section>
      )}

      {pic.owners.map((g) => (
        <section key={g.owner} className="vault-owner">
          <div className="vault-owner-head" onClick={() => setClosed((o) => ({ ...o, [g.owner]: !o[g.owner] }))}>
            <span className="vault-owner-name">{g.label}</span>
            <span className="vault-row-sub">
              {money(g.totals.assets)} − {money(g.totals.liabilities)}
              {g.totals.unknown_figures ? ` · ${g.totals.unknown_figures} unknown` : ""}
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
                    {a.min_payment !== null && <span className="tool-chip">MIN {money(a.min_payment)}</span>}
                    {a.connected && <span className="tool-chip">LIVE</span>}
                    {a.shared_with.length > 0 && <span className="tool-chip">WITH {a.shared_with.map((o) => OWNER_LABELS[o]).join(", ").toUpperCase()}</span>}
                    {!a.active && <span className="tool-chip">CLOSED</span>}
                  </div>
                </div>
              ))}
              {g.items.map((i) => (
                <div key={i.id} className="bill-row" onClick={() => setModal({ kind: "item", item: i })} role="button">
                  <div className="bill-main">
                    <span className="bill-name">{i.name}</span>
                    <span className="bill-amount mono">{i.side === "liability" && i.amount !== null ? `−${money(i.amount)}` : i.side === "contingent" ? `(${money(i.amount)})` : money(i.amount)}</span>
                  </div>
                  <div className="bill-meta">
                    <span className="mono-label">{sourceLabel(i)}</span>
                    <span className="tool-chip">{i.kind.replace(/_/g, " ").toUpperCase()}</span>
                    {i.split && <span className="tool-chip">{Object.entries(i.split).map(([o, p]) => `${OWNER_LABELS[o as Owner]} ${p}%`).join(" / ").toUpperCase()}</span>}
                    {i.shared_with.length > 0 && <span className="tool-chip">WITH {i.shared_with.map((o) => OWNER_LABELS[o]).join(", ").toUpperCase()}</span>}
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
            <span className="cost-bucket-name">Connections</span>
          </div>
          {pic.connections.map((c) => (
            <div key={c.id} className="bill-row">
              <div className="bill-main">
                <span className="bill-name">{c.institution}</span>
                <span className="mono-label">{c.status.replace(/_/g, " ").toUpperCase()}</span>
              </div>
              <div className="bill-meta">
                <span className="mono-label">{OWNER_LABELS[c.owner]} · {c.accounts} accounts · last {c.last_refresh_at?.slice(0, 10) ?? "never"}{c.last_refresh_ok === false ? " · failed" : ""}</span>
                <span className="bill-spacer" />
                <button className="btn-danger" onClick={() => confirm(`Disconnect ${c.institution}? The token is deleted.`) && act("Disconnect", () => disconnect(c.id))}>
                  Disconnect
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {pic.documents.length > 0 && (
        <section className="cost-bucket vault-owner">
          <div className="cost-bucket-head">
            <span className="cost-bucket-name">Documents</span>
          </div>
          {pic.documents.map((d) => (
            <div key={d.id} className="bill-row">
              <div className="bill-main">
                <span className="bill-name">{d.filename}</span>
                <span className="mono-label">{d.kind.toUpperCase()}</span>
              </div>
              <div className="bill-meta">
                <span className="mono-label">{d.uploaded_at.slice(0, 10)} · {OWNER_LABELS[d.owner]}{d.parsed ? ` · ${d.parsed.summary}` : ""}</span>
                <span className="bill-spacer" />
                <button className="btn-quiet" onClick={() => confirm("Delete this document?") && act("Delete", () => deleteDoc(d.id))}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {pic.owners.length === 0 && <div className="tool-empty mono-label">EMPTY — LOAD THE PHASE 1 SNAPSHOT, OR ADD AN ACCOUNT</div>}

      {modal?.kind === "account" && <AccountModal account={modal.account} all={allAccounts} onClose={close} />}
      {modal?.kind === "item" && <ItemModal item={modal.item} onClose={close} />}
      {modal?.kind === "new-account" && <NewAccountModal onClose={close} />}
      {modal?.kind === "connect" && <ConnectModal picture={pic} onClose={close} />}
      {modal?.kind === "upload" && <UploadModal onClose={close} />}
    </div>
  );
}
