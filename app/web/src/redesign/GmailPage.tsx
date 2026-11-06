/**
 * Gmail — FINAL's mail workspace one for one (lines 11–12), on real Gmail.
 *
 * Accounts rail (All inboxes, every connected Gmail, "+"), folders with counts, the list (Unread,
 * newest first, star, account label), the reader (the whole conversation as plain text, attachments
 * listed, Reply / Reply all / Forward into a draft), and one search over All accounts / This account /
 * This folder. "+" opens FINAL's "Connect another account" dialog (ahi ••• Gmail); Continue with
 * Google goes to Google's own sign-in in the browser and comes back here connected.
 *
 * Honest limits: reading and drafts are real; nothing is SENT from the app (Save draft puts it in that
 * account's Gmail Drafts) — sending is the the business mail build's. Archive / trash / spam / labels are
 * not offered (the access asked for is read + drafts only). No Google client on the server → the
 * dialog says so instead of pretending.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "./icons";
import { useEscape } from "../components/FinalDialog";
import "./gmail-final.css";

interface Account {
  id: string;
  email: string;
  name: string;
  color: string;
}
interface Row {
  account: string;
  id: string;
  from: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  at: string;
  unread: boolean;
  starred: boolean;
  count: number;
  attachments: boolean;
  label: string | null;
}
interface Letter {
  id: string;
  from: string;
  fromEmail: string;
  to: string;
  cc: string;
  at: string;
  body: string;
  attachments: Array<{ name: string; size: number }>;
}
type Folder = "inbox" | "starred" | "sent" | "drafts" | "archive" | "all" | "spam" | "trash";
const FOLDERS: Array<[Folder, string, IconName]> = [
  ["inbox", "Inbox", "inbox"],
  ["starred", "Starred", "star"],
  ["sent", "Sent", "forward"],
  ["drafts", "Drafts", "edit"],
  ["archive", "Archive", "archive"],
  ["all", "All mail", "mail"],
  ["spam", "Spam", "spam"],
  ["trash", "Trash", "trash"],
];
type Scope = "all" | "account" | "folder";

const getJson = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url, { cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
  return j as T;
};
const initials = (s: string) => s.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
const avatar = (a: Account) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="40" fill="${a.color}"/><text x="40" y="47" text-anchor="middle" font-family="Arial,sans-serif" font-size="25" fill="#fff">${initials(a.name)}</text></svg>`;
  return <img src={`data:image/svg+xml,${encodeURIComponent(svg)}`} alt="" draggable={false} />;
};
const sameDay = (iso: string) => new Date(iso).toDateString() === new Date().toDateString();
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const date = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function MailButton({ label, icon, onClick, className }: { label: string; icon: IconName; onClick: () => void; className?: string }) {
  return (
    <button type="button" className={`mail-icon-button${className ? ` ${className}` : ""}`} aria-label={label} title={label} onClick={onClick}>
      <Icon name={icon} />
    </button>
  );
}

/** FINAL's "Connect another account": ahi ••• Gmail, then Google's own sign-in in the browser. */
export function ConnectGmailDialog({ configured, onClose }: { configured: boolean; onClose: () => void }) {
  useEscape(onClose);
  return (
    <div className="connection-dialog-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="connection-dialog" role="dialog" aria-modal="true" aria-labelledby="gmail-connect-title">
        <div className="connection-dialog-brand">
          <span className="rd-dialog-wordmark">
            ahi<span>.</span>
          </span>
          <span className="connection-transfer-dots" aria-hidden="true">
            •••
          </span>
          <img src="/brand/gmail.svg" alt="Gmail" />
        </div>
        <h2 id="gmail-connect-title">Connect another account</h2>
        <p>Continue with Google to choose an account and review what AHI can access.</p>
        <div className="connection-dialog-note">
          Your account choice and Google’s consent happen in the browser, on Google’s own page. AHI asks to read your mail and save drafts — it never sends from here.
        </div>
        {!configured && <p className="rd-dialog-error">Google sign-in isn’t set up on this server yet — it needs the owner’s Google sign-in client.</p>}
        <footer>
          <button type="button" className="rd-btn" onClick={onClose}>
            Cancel
          </button>
          {configured ? (
            <a className="rd-btn rd-btn-accent" href="/app/gmail/oauth/start">
              Continue with Google
            </a>
          ) : (
            <button type="button" className="rd-btn rd-btn-accent" disabled>
              Continue with Google
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function Composer({
  accounts,
  initial,
  onClose,
}: {
  accounts: Account[];
  initial: { account: string; to: string; cc: string; subject: string; body: string; threadId?: string; title: string };
  onClose: (saved: boolean) => void;
}) {
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/app/gmail/drafts", { method: "POST", headers: { "Content-Type": "application/json", "X-AHI-Review": "1" }, body: JSON.stringify(d) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
      onClose(true);
    } catch (e) {
      setErr(`Not saved — ${(e as Error).message}`);
      setBusy(false);
    }
  };
  return (
    <section className="mail-compose-overlay" aria-label="Compose email">
      <div className="mail-compose-card" role="dialog" aria-modal="true" aria-label="Write an email">
        <header>
          <div>
            <img src="/brand/gmail.svg" alt="" aria-hidden="true" style={{ width: 18, height: 18 }} />
            <strong>{d.title}</strong>
            <span>Saves to Gmail Drafts</span>
          </div>
          <div>
            <MailButton label="Discard draft" icon="trash" onClick={() => onClose(false)} />
          </div>
        </header>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="mail-compose-line">
            <span>From</span>
            <select value={d.account} onChange={(e) => setD({ ...d, account: e.target.value })} aria-label="Account">
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.email}
                </option>
              ))}
            </select>
          </label>
          <label className="mail-compose-line">
            <span>To</span>
            <input value={d.to} onChange={(e) => setD({ ...d, to: e.target.value })} placeholder="name@example.com" aria-label="Recipients" />
          </label>
          <div className="mail-copy-addresses">
            <label>
              <span>Cc</span>
              <input value={d.cc} onChange={(e) => setD({ ...d, cc: e.target.value })} aria-label="Cc recipients" />
            </label>
          </div>
          <label className="mail-compose-line mail-subject-input">
            <span>Subject</span>
            <input value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} placeholder="What’s it about?" aria-label="Email subject" />
          </label>
          <textarea value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} placeholder="A little room for your words…" aria-label="Email message" />
          {err && (
            <p className="rd-dialog-error" role="alert">
              {err}
            </p>
          )}
          <footer>
            <div>
              <button className="mail-send" type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save draft"} <Icon name="arrow-up" />
              </button>
            </div>
            <small>Nothing is sent from the app — the draft waits in that account’s Gmail.</small>
          </footer>
        </form>
      </div>
    </section>
  );
}

export default function GmailPage() {
  const [status, setStatus] = useState<{ configured: boolean; standIn: boolean; accounts: Account[] } | null>(null);
  const [account, setAccount] = useState<string>("all");
  const [folder, setFolder] = useState<Folder>("inbox");
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [unread, setUnread] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [counts, setCounts] = useState<Partial<Record<Folder, number>>>({});
  const [selected, setSelected] = useState<Row | null>(null);
  const [thread, setThread] = useState<{ subject: string; letters: Letter[] } | null>(null);
  const [find, setFind] = useState("");
  const [connect, setConnect] = useState(false);
  const [compose, setCompose] = useState<null | Parameters<typeof Composer>[0]["initial"]>(null);
  const [note, setNote] = useState<string | null>(null);
  const [readerOpen, setReaderOpen] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [rev, setRev] = useState(0);

  // Back from Google: ?gmail_connected= / ?gmail_error= on the URL (the router keeps the query, not a hash query).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const ok = q.get("gmail_connected"), bad = q.get("gmail_error");
    if (ok || bad) {
      setNote(ok ? "Connected. Your mail is here." : bad);
      if (ok) setAccount(ok);
      q.delete("gmail_connected");
      q.delete("gmail_error");
      const rest = q.toString();
      history.replaceState(history.state, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
    }
  }, []);
  useEffect(() => {
    void getJson<{ configured: boolean; standIn: boolean; accounts: Account[] }>("/app/gmail/status").then(setStatus).catch((e) => setErr((e as Error).message));
  }, [rev]);

  const accounts = status?.accounts ?? [];
  const acct = accounts.find((a) => a.id === account) ?? null;
  // The search scope: All accounts = all mail everywhere; This account = all of this account's mail; This folder = here.
  const listArgs = useMemo(() => {
    const searching = !!applied.trim();
    const which = searching && scope === "all" ? "all" : account;
    const where: Folder = searching && scope !== "folder" ? "all" : folder;
    return { which, where };
  }, [applied, scope, account, folder]);

  const load = useCallback(async () => {
    if (!accounts.length || folder === "drafts") return setRows([]);
    setRows(null);
    setErr(null);
    try {
      const p = new URLSearchParams({ account: listArgs.which, folder: listArgs.where, q: applied, unread: unread ? "1" : "0" });
      const v = await getJson<{ threads: Row[] }>(`/app/gmail/threads?${p}`);
      setRows(v.threads);
    } catch (e) {
      setErr((e as Error).message);
      setRows([]);
    }
  }, [accounts.length, folder, listArgs, applied, unread]);
  useEffect(() => void load(), [load, rev]);
  // Keyed on the account id string, not the accounts array (a fresh [] each render while status loads would loop).
  const countsFor = account === "all" ? accounts[0]?.id : account;
  useEffect(() => {
    if (!countsFor) return setCounts({});
    void getJson<{ counts: Partial<Record<Folder, number>> }>(`/app/gmail/counts?account=${encodeURIComponent(countsFor)}`).then((v) => setCounts(v.counts)).catch(() => setCounts({}));
  }, [countsFor, rev]);
  useEffect(() => {
    if (!selected) return setThread(null);
    setThread(null);
    void getJson<{ subject: string; letters: Letter[] }>(`/app/gmail/thread?account=${encodeURIComponent(selected.account)}&id=${encodeURIComponent(selected.id)}`)
      .then(setThread)
      .catch((e) => setErr((e as Error).message));
  }, [selected]);

  const accountOf = (id: string) => accounts.find((a) => a.id === id);
  const shown = rows ?? [];
  const reply = (mode: "reply" | "reply-all" | "forward") => {
    if (!selected || !thread) return;
    const last = thread.letters[thread.letters.length - 1];
    const quote = `\n\nOn ${date(last.at)}, ${last.from} wrote:\n> ${last.body.split("\n").join("\n> ")}`;
    setCompose({
      account: selected.account,
      to: mode === "forward" ? "" : last.fromEmail,
      cc: mode === "reply-all" ? [last.to, last.cc].filter(Boolean).join(", ") : "",
      subject: `${mode === "forward" ? "Fwd" : "Re"}: ${thread.subject.replace(/^(re|fwd):\s*/i, "")}`,
      body: quote,
      threadId: mode === "forward" ? undefined : selected.id,
      title: mode === "forward" ? "Forward" : "Reply",
    });
  };
  const newMail = () => accounts.length && setCompose({ account: acct?.id ?? accounts[0].id, to: "", cc: "", subject: "", body: "", title: "New message" });
  const needle = find.trim().toLowerCase();
  const mark = (text: string) => {
    if (!needle) return text;
    const parts = text.split(new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
    return parts.map((p, i) => (p.toLowerCase() === needle ? <mark key={i}>{p}</mark> : p));
  };
  const heading = applied.trim() ? "Search results" : FOLDERS.find((f) => f[0] === folder)![1];

  return (
    <div className="rd-page" data-page="gmail">
      <section className={`mail-app${foldersOpen ? " folders-open" : ""}${readerOpen ? " reader-open" : ""}`} aria-label="Gmail multi-inbox workspace">
        <header className="mail-topbar">
          <div className="mail-brand">
            <img src="/brand/gmail.svg" alt="" aria-hidden="true" />
            <span>Gmail</span>
          </div>
          <label className="mail-search">
            <Icon name="search" />
            <input
              type="search"
              placeholder="Search your mail"
              aria-label="Search mail"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (!e.target.value) setApplied("");
              }}
              onKeyDown={(e) => e.key === "Enter" && setApplied(query)}
            />
            <select aria-label="Mail search scope" value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
              <option value="all">All accounts</option>
              <option value="account">This account</option>
              <option value="folder">This folder</option>
            </select>
          </label>
          <MailButton label="Manage connected accounts" icon="people" onClick={() => setConnect(true)} />
        </header>
        {note && (
          <p className="mail-banner" role="status">
            {note}{" "}
            <button type="button" onClick={() => setNote(null)} aria-label="Dismiss">
              ✕
            </button>
          </p>
        )}
        <div className="mail-body">
          <aside className="mail-account-rail" aria-label="Gmail accounts">
            <button type="button" className={`mail-account${account === "all" ? " active" : ""}`} aria-label="All inboxes" title="All inboxes" onClick={() => (setAccount("all"), setSelected(null), setReaderOpen(false))}>
              <Icon name="inbox" />
            </button>
            <span className="mail-rail-gap" />
            {accounts.map((a) => (
              <button key={a.id} type="button" className={`mail-account${account === a.id ? " active" : ""}`} aria-label={`${a.name} · ${a.email}`} title={`${a.name} · ${a.email}`} onClick={() => (setAccount(a.id), setSelected(null), setReaderOpen(false))}>
                {avatar(a)}
                <i style={{ background: a.color }} />
              </button>
            ))}
            <button type="button" className="mail-account mail-add-account" aria-label="Connect another account" title="Connect another account" onClick={() => setConnect(true)}>
              <Icon name="plus" />
            </button>
            <span className="mail-account-rail-foot">
              <Icon name="shield" />
            </span>
          </aside>
          <aside className="mail-folders" aria-label="Mail folders">
            <div className="mail-folder-identity">
              <strong>{acct?.name ?? "All inboxes"}</strong>
              <small>{acct?.email ?? `${accounts.length} account${accounts.length === 1 ? "" : "s"}, one place`}</small>
            </div>
            <button type="button" className="mail-compose-button" onClick={newMail} disabled={!accounts.length}>
              <Icon name="edit" />
              Compose
            </button>
            <nav>
              {FOLDERS.map(([key, label, glyph]) => (
                <button key={key} type="button" className={folder === key ? "active" : ""} aria-current={folder === key ? "page" : undefined} onClick={() => (setFolder(key), setApplied(""), setQuery(""), setUnread(false), setSelected(null), setReaderOpen(false), setFoldersOpen(false))}>
                  <Icon name={glyph} />
                  <span>{label}</span>
                  {!!counts[key] && <small>{counts[key]}</small>}
                </button>
              ))}
            </nav>
            <div className="mail-folder-note">
              <span className="mail-sync-dot" />
              {status?.standIn ? "Preview stand-in" : "Live Gmail"}
              <small>{status?.standIn ? "Sample Google accounts · not your mail" : "Read and drafts · nothing is sent from here"}</small>
            </div>
          </aside>
          <section className="mail-list-pane" aria-label="Email list">
            <header className="mail-list-heading">
              <div>
                <MailButton label="Show mail folders" icon="menu" onClick={() => setFoldersOpen((o) => !o)} />
                <h1>{heading}</h1>
                <span>{rows ? shown.length : ""}</span>
              </div>
              <div>
                <MailButton label="Compose email" icon="edit" onClick={newMail} />
                <MailButton label="Refresh mail" icon="refresh" onClick={() => setRev((n) => n + 1)} />
              </div>
            </header>
            <div className="mail-list-controls">
              <button type="button" className={`mail-filter${unread ? " active" : ""}`} aria-pressed={unread} onClick={() => setUnread((u) => !u)}>
                Unread
              </button>
              <span className="mail-list-sort">Newest first</span>
            </div>
            <div className="mail-message-list">
              {shown.map((t) => {
                const a = accountOf(t.account);
                return (
                  <article key={`${t.account}:${t.id}`} className={`mail-row${t.unread ? " unread" : ""}${selected?.id === t.id && selected.account === t.account ? " selected" : ""}`}>
                    <div className="mail-row-tools">
                      <span className={`mail-star${t.starred ? " starred" : ""}`} aria-label={t.starred ? "Starred" : "Not starred"}>
                        <Icon name="star" />
                      </span>
                    </div>
                    <button type="button" className="mail-row-open" aria-label={`Open ${t.subject}`} onClick={() => (setSelected(t), setReaderOpen(true), setFind(""))}>
                      <div>
                        <strong>{t.from}</strong>
                        <time>{sameDay(t.at) ? time(t.at) : date(t.at)}</time>
                      </div>
                      <h2>
                        {t.subject}
                        {t.count > 1 && <small> {t.count}</small>}
                      </h2>
                      <p>{t.snippet}</p>
                      <footer>
                        {a && (
                          <span className="mail-account-label">
                            <i style={{ background: a.color }} />
                            {a.name}
                          </span>
                        )}
                        {t.attachments && <Icon name="paperclip" />}
                        {t.label && <span className="mail-label">{t.label}</span>}
                      </footer>
                    </button>
                  </article>
                );
              })}
              {rows && !shown.length && (
                <div className="mail-empty">
                  <Icon name={!accounts.length ? "plus" : applied ? "search" : "inbox"} />
                  <h2>{!accounts.length ? "Connect a Gmail account." : folder === "drafts" ? "Drafts stay in Gmail." : applied ? "No matching mail" : "A little breathing room."}</h2>
                  <p>{!accounts.length ? "Every inbox you add sits here, each kept separate." : folder === "drafts" ? "Drafts you save here are in that account’s Gmail Drafts." : applied ? "Try another phrase or search scope." : "Nothing here right now."}</p>
                  {!accounts.length && (
                    <button type="button" className="rd-btn rd-btn-accent" onClick={() => setConnect(true)}>
                      Connect Gmail <Icon name="arrow-right" />
                    </button>
                  )}
                </div>
              )}
              {!rows && <div className="mail-empty"><p>Opening your mail…</p></div>}
              {err && <p className="rd-dialog-error" role="alert">{err}</p>}
            </div>
          </section>
          <section className="mail-reader" aria-label="Email reader">
            {selected ? (
              <>
                <header className="mail-reader-toolbar">
                  <div>
                    <MailButton label="Back to email list" icon="arrow-left" onClick={() => setReaderOpen(false)} />
                  </div>
                  <label className="mail-find">
                    <Icon name="search" />
                    <input aria-label="Find in this conversation" placeholder="Find in this email" value={find} onChange={(e) => setFind(e.target.value)} />
                  </label>
                </header>
                <div className="mail-reader-scroll">
                  <div className="mail-reader-content">
                    <div className="mail-subject">
                      <span className="mail-eyebrow">
                        {accountOf(selected.account)?.name} <span> / </span> {FOLDERS.find((f) => f[0] === folder)![1]}
                      </span>
                      <h1>{thread?.subject ?? selected.subject}</h1>
                      <div>{selected.label && <span className="mail-label">{selected.label}</span>}</div>
                    </div>
                    {!thread && <p className="rd-quiet">Opening…</p>}
                    {thread?.letters.map((m) => (
                      <article key={m.id} className="mail-letter">
                        <header>
                          <span className="mail-sender-avatar">{initials(m.from)}</span>
                          <div>
                            <strong>{m.from}</strong>
                            <small>{m.fromEmail}</small>
                            <span>
                              to {m.to}
                              {m.cc ? ` · cc ${m.cc}` : ""}
                            </span>
                          </div>
                          <time>
                            {date(m.at)}
                            <br />
                            {time(m.at)}
                          </time>
                        </header>
                        <div className="mail-letter-body" style={{ whiteSpace: "pre-wrap" }}>
                          {mark(m.body)}
                        </div>
                        {m.attachments.length > 0 && (
                          <div className="mail-attachments">
                            {m.attachments.map((f, i) => (
                              <span key={i} className="mail-attachment" title="Open it in Gmail">
                                <Icon name="folder" />
                                <span>
                                  <strong>{f.name}</strong>
                                  <small>{kb(f.size)}</small>
                                </span>
                              </span>
                            ))}
                          </div>
                        )}
                      </article>
                    ))}
                    {thread && (
                      <div className="mail-reply-actions">
                        <button type="button" onClick={() => reply("reply")}>
                          <Icon name="reply" />
                          Reply
                        </button>
                        <button type="button" onClick={() => reply("reply-all")}>
                          <Icon name="reply" />
                          Reply all
                        </button>
                        <button type="button" onClick={() => reply("forward")}>
                          <Icon name="forward" />
                          Forward
                        </button>
                      </div>
                    )}
                    <p className="mail-reading-note">
                      <Icon name="shield" />
                      Mail stays with {accountOf(selected.account)?.email}.
                    </p>
                  </div>
                </div>
              </>
            ) : (
              <div className="mail-empty mail-reader-empty">
                <Icon name="mail" />
                <h2>A place to give it your attention.</h2>
                <p>Choose an email to read it here.</p>
                <button type="button" onClick={newMail} disabled={!accounts.length}>
                  Write an email <Icon name="arrow-right" />
                </button>
              </div>
            )}
          </section>
        </div>
        <button type="button" className="mail-mobile-compose" aria-label="Compose email" onClick={newMail}>
          <Icon name="edit" />
        </button>
      </section>
      {connect && <ConnectGmailDialog configured={!!status?.configured} onClose={() => setConnect(false)} />}
      {compose && (
        <Composer
          accounts={accounts}
          initial={compose}
          onClose={(saved) => {
            setCompose(null);
            if (saved) setNote("Draft saved to Gmail Drafts.");
          }}
        />
      )}
    </div>
  );
}
