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
import { locale, t as tr, tn, useT, type Key } from "../i18n";

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
const FOLDERS: Array<[Folder, Key, IconName]> = [
  ["inbox", "gmail.folder.inbox", "inbox"],
  ["starred", "gmail.folder.starred", "star"],
  ["sent", "gmail.folder.sent", "forward"],
  ["drafts", "gmail.folder.drafts", "edit"],
  ["archive", "gmail.folder.archive", "archive"],
  ["all", "gmail.folder.all", "mail"],
  ["spam", "gmail.folder.spam", "spam"],
  ["trash", "gmail.folder.trash", "trash"],
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
const time = (iso: string) => new Date(iso).toLocaleTimeString(locale(), { hour: "numeric", minute: "2-digit" });
const date = (iso: string) => new Date(iso).toLocaleDateString(locale(), { month: "short", day: "numeric" });
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
  const t = useT();
  useEscape(onClose);
  return (
    <div className="connection-dialog-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="connection-dialog" role="dialog" aria-modal="true" aria-labelledby="gmail-connect-title">
        <div className="connection-dialog-brand">
          <span className="rd-dialog-wordmark">
            <bdi dir="ltr">ahi<span>.</span></bdi>
          </span>
          <span className="connection-transfer-dots" aria-hidden="true">
            •••
          </span>
          <img src="/brand/gmail.svg" alt="Gmail" />
        </div>
        <h2 id="gmail-connect-title">{t("gmail.connectAnother")}</h2>
        <p>{t("gmail.connectIntro")}</p>
        <div className="connection-dialog-note">{t("gmail.connectNote")}</div>
        {!configured && <p className="rd-dialog-error">{t("gmail.notConfigured")}</p>}
        <footer>
          <button type="button" className="rd-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          {configured ? (
            <a className="rd-btn rd-btn-accent" href="/app/gmail/oauth/start">
              {t("gmail.continueWithGoogle")}
            </a>
          ) : (
            <button type="button" className="rd-btn rd-btn-accent" disabled>
              {t("gmail.continueWithGoogle")}
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
  initial: { account: string; to: string; cc: string; subject: string; body: string; threadId?: string; title: Key };
  onClose: (saved: boolean) => void;
}) {
  const t = useT();
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      // `title` holds a catalog key; the server gets the words, as before.
      const r = await fetch("/app/gmail/drafts", { method: "POST", headers: { "Content-Type": "application/json", "X-AHI-Review": "1" }, body: JSON.stringify({ ...d, title: tr(d.title) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
      onClose(true);
    } catch (e) {
      setErr(t("gmail.notSaved", { error: (e as Error).message }));
      setBusy(false);
    }
  };
  return (
    <section className="mail-compose-overlay" aria-label={t("gmail.composeEmail")}>
      <div className="mail-compose-card" role="dialog" aria-modal="true" aria-label={t("gmail.writeEmail")}>
        <header>
          <div>
            <img src="/brand/gmail.svg" alt="" aria-hidden="true" style={{ width: 18, height: 18 }} />
            <strong>{t(d.title)}</strong>
            <span>{t("gmail.savesToDrafts")}</span>
          </div>
          <div>
            <MailButton label={t("gmail.discardDraft")} icon="trash" onClick={() => onClose(false)} />
          </div>
        </header>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="mail-compose-line">
            <span>{t("gmail.from")}</span>
            <select value={d.account} onChange={(e) => setD({ ...d, account: e.target.value })} aria-label={t("gmail.account")}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.email}
                </option>
              ))}
            </select>
          </label>
          <label className="mail-compose-line">
            <span>{t("gmail.to")}</span>
            <input dir="ltr" value={d.to} onChange={(e) => setD({ ...d, to: e.target.value })} placeholder="name@example.com" aria-label={t("gmail.recipients")} />
          </label>
          <div className="mail-copy-addresses">
            <label>
              <span>{t("gmail.cc")}</span>
              <input dir="ltr" value={d.cc} onChange={(e) => setD({ ...d, cc: e.target.value })} aria-label={t("gmail.ccRecipients")} />
            </label>
          </div>
          <label className="mail-compose-line mail-subject-input">
            <span>{t("gmail.subject")}</span>
            <input dir="auto" value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} placeholder={t("gmail.subjectPlaceholder")} aria-label={t("gmail.subjectAria")} />
          </label>
          <textarea dir="auto" value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} placeholder={t("gmail.bodyPlaceholder")} aria-label={t("gmail.bodyAria")} />
          {err && (
            <p className="rd-dialog-error" role="alert">
              {err}
            </p>
          )}
          <footer>
            <div>
              <button className="mail-send" type="submit" disabled={busy}>
                {busy ? t("common.saving") : t("gmail.saveDraft")} <Icon name="arrow-up" />
              </button>
            </div>
            <small>{t("gmail.nothingSent")}</small>
          </footer>
        </form>
      </div>
    </section>
  );
}

export default function GmailPage() {
  const t = useT();
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
      setNote(ok ? tr("gmail.connected") : bad);
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
    const quote = `\n\n${t("gmail.quoteHeader", { date: date(last.at), from: last.from })}\n> ${last.body.split("\n").join("\n> ")}`;
    setCompose({
      account: selected.account,
      to: mode === "forward" ? "" : last.fromEmail,
      cc: mode === "reply-all" ? [last.to, last.cc].filter(Boolean).join(", ") : "",
      subject: `${mode === "forward" ? "Fwd" : "Re"}: ${thread.subject.replace(/^(re|fwd):\s*/i, "")}`,
      body: quote,
      threadId: mode === "forward" ? undefined : selected.id,
      title: mode === "forward" ? "gmail.forward" : "gmail.reply",
    });
  };
  const newMail = () => accounts.length && setCompose({ account: acct?.id ?? accounts[0].id, to: "", cc: "", subject: "", body: "", title: "gmail.newMessage" });
  const needle = find.trim().toLowerCase();
  const mark = (text: string) => {
    if (!needle) return text;
    const parts = text.split(new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
    return parts.map((p, i) => (p.toLowerCase() === needle ? <mark key={i}>{p}</mark> : p));
  };
  const heading = applied.trim() ? t("gmail.searchResults") : t(FOLDERS.find((f) => f[0] === folder)![1]);

  return (
    <div className="rd-page" data-page="gmail">
      <section className={`mail-app${foldersOpen ? " folders-open" : ""}${readerOpen ? " reader-open" : ""}`} aria-label={t("gmail.workspaceAria")}>
        <header className="mail-topbar">
          <div className="mail-brand">
            <img src="/brand/gmail.svg" alt="" aria-hidden="true" />
            <span>Gmail</span>
          </div>
          <label className="mail-search">
            <Icon name="search" />
            <input
              type="search"
              dir="auto"
              placeholder={t("gmail.searchPlaceholder")}
              aria-label={t("gmail.searchAria")}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (!e.target.value) setApplied("");
              }}
              onKeyDown={(e) => e.key === "Enter" && setApplied(query)}
            />
            <select aria-label={t("gmail.scopeAria")} value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
              <option value="all">{t("gmail.scope.all")}</option>
              <option value="account">{t("gmail.scope.account")}</option>
              <option value="folder">{t("gmail.scope.folder")}</option>
            </select>
          </label>
          <MailButton label={t("gmail.manageAccounts")} icon="people" onClick={() => setConnect(true)} />
        </header>
        {note && (
          <p className="mail-banner" role="status">
            <span dir="auto">{note}</span>{" "}
            <button type="button" onClick={() => setNote(null)} aria-label={t("gmail.dismiss")}>
              ✕
            </button>
          </p>
        )}
        <div className="mail-body">
          <aside className="mail-account-rail" aria-label={t("gmail.accountsAria")}>
            <button type="button" className={`mail-account${account === "all" ? " active" : ""}`} aria-label={t("gmail.allInboxes")} title={t("gmail.allInboxes")} onClick={() => (setAccount("all"), setSelected(null), setReaderOpen(false))}>
              <Icon name="inbox" />
            </button>
            <span className="mail-rail-gap" />
            {accounts.map((a) => (
              <button key={a.id} type="button" className={`mail-account${account === a.id ? " active" : ""}`} aria-label={`${a.name} · ${a.email}`} title={`${a.name} · ${a.email}`} onClick={() => (setAccount(a.id), setSelected(null), setReaderOpen(false))}>
                {avatar(a)}
                <i style={{ background: a.color }} />
              </button>
            ))}
            <button type="button" className="mail-account mail-add-account" aria-label={t("gmail.connectAnother")} title={t("gmail.connectAnother")} onClick={() => setConnect(true)}>
              <Icon name="plus" />
            </button>
            <span className="mail-account-rail-foot">
              <Icon name="shield" />
            </span>
          </aside>
          <aside className="mail-folders" aria-label={t("gmail.foldersAria")}>
            <div className="mail-folder-identity">
              <strong dir="auto">{acct?.name ?? t("gmail.allInboxes")}</strong>
              <small dir={acct ? "ltr" : undefined}>{acct?.email ?? tn("gmail.accountsOnePlace", accounts.length)}</small>
            </div>
            <button type="button" className="mail-compose-button" onClick={newMail} disabled={!accounts.length}>
              <Icon name="edit" />
              {t("gmail.compose")}
            </button>
            <nav>
              {FOLDERS.map(([key, label, glyph]) => (
                <button key={key} type="button" className={folder === key ? "active" : ""} aria-current={folder === key ? "page" : undefined} onClick={() => (setFolder(key), setApplied(""), setQuery(""), setUnread(false), setSelected(null), setReaderOpen(false), setFoldersOpen(false))}>
                  <Icon name={glyph} />
                  <span>{t(label)}</span>
                  {!!counts[key] && <small>{counts[key]}</small>}
                </button>
              ))}
            </nav>
            <div className="mail-folder-note">
              <span className="mail-sync-dot" />
              {status?.standIn ? t("gmail.standIn") : t("gmail.liveGmail")}
              <small>{status?.standIn ? t("gmail.standInNote") : t("gmail.liveNote")}</small>
            </div>
          </aside>
          <section className="mail-list-pane" aria-label={t("gmail.listAria")}>
            <header className="mail-list-heading">
              <div>
                <MailButton label={t("gmail.showFolders")} icon="menu" onClick={() => setFoldersOpen((o) => !o)} />
                <h1>{heading}</h1>
                <span>{rows ? shown.length : ""}</span>
              </div>
              <div>
                <MailButton label={t("gmail.composeEmail")} icon="edit" onClick={newMail} />
                <MailButton label={t("gmail.refreshMail")} icon="refresh" onClick={() => setRev((n) => n + 1)} />
              </div>
            </header>
            <div className="mail-list-controls">
              <button type="button" className={`mail-filter${unread ? " active" : ""}`} aria-pressed={unread} onClick={() => setUnread((u) => !u)}>
                {t("gmail.unread")}
              </button>
              <span className="mail-list-sort">{t("gmail.newestFirst")}</span>
            </div>
            <div className="mail-message-list">
              {shown.map((row) => {
                const a = accountOf(row.account);
                return (
                  <article key={`${row.account}:${row.id}`} className={`mail-row${row.unread ? " unread" : ""}${selected?.id === row.id && selected.account === row.account ? " selected" : ""}`}>
                    <div className="mail-row-tools">
                      <span className={`mail-star${row.starred ? " starred" : ""}`} aria-label={row.starred ? t("gmail.starred") : t("gmail.notStarred")}>
                        <Icon name="star" />
                      </span>
                    </div>
                    <button type="button" className="mail-row-open" aria-label={t("gmail.openNamed", { subject: row.subject })} onClick={() => (setSelected(row), setReaderOpen(true), setFind(""))}>
                      <div>
                        <strong dir="auto">{row.from}</strong>
                        <time>{sameDay(row.at) ? time(row.at) : date(row.at)}</time>
                      </div>
                      <h2 dir="auto">
                        {row.subject}
                        {row.count > 1 && <small> {row.count}</small>}
                      </h2>
                      <p dir="auto">{row.snippet}</p>
                      <footer>
                        {a && (
                          <span className="mail-account-label">
                            <i style={{ background: a.color }} />
                            {a.name}
                          </span>
                        )}
                        {row.attachments && <Icon name="paperclip" />}
                        {row.label && <span className="mail-label">{row.label}</span>}
                      </footer>
                    </button>
                  </article>
                );
              })}
              {rows && !shown.length && (
                <div className="mail-empty">
                  <Icon name={!accounts.length ? "plus" : applied ? "search" : "inbox"} />
                  <h2>{!accounts.length ? t("gmail.emptyConnectTitle") : folder === "drafts" ? t("gmail.emptyDraftsTitle") : applied ? t("gmail.emptySearchTitle") : t("gmail.emptyTitle")}</h2>
                  <p>{!accounts.length ? t("gmail.emptyConnectBody") : folder === "drafts" ? t("gmail.emptyDraftsBody") : applied ? t("gmail.emptySearchBody") : t("gmail.emptyBody")}</p>
                  {!accounts.length && (
                    <button type="button" className="rd-btn rd-btn-accent" onClick={() => setConnect(true)}>
                      {t("gmail.connectGmail")} <Icon name="arrow-right" />
                    </button>
                  )}
                </div>
              )}
              {!rows && <div className="mail-empty"><p>{t("gmail.openingMail")}</p></div>}
              {err && <p className="rd-dialog-error" role="alert">{err}</p>}
            </div>
          </section>
          <section className="mail-reader" aria-label={t("gmail.readerAria")}>
            {selected ? (
              <>
                <header className="mail-reader-toolbar">
                  <div>
                    <MailButton label={t("gmail.backToList")} icon="arrow-left" onClick={() => setReaderOpen(false)} />
                  </div>
                  <label className="mail-find">
                    <Icon name="search" />
                    <input dir="auto" aria-label={t("gmail.findAria")} placeholder={t("gmail.findPlaceholder")} value={find} onChange={(e) => setFind(e.target.value)} />
                  </label>
                </header>
                <div className="mail-reader-scroll">
                  <div className="mail-reader-content">
                    <div className="mail-subject">
                      <span className="mail-eyebrow">
                        {accountOf(selected.account)?.name} <span> / </span> {t(FOLDERS.find((f) => f[0] === folder)![1])}
                      </span>
                      <h1 dir="auto">{thread?.subject ?? selected.subject}</h1>
                      <div>{selected.label && <span className="mail-label">{selected.label}</span>}</div>
                    </div>
                    {!thread && <p className="rd-quiet">{t("gmail.opening")}</p>}
                    {thread?.letters.map((m) => (
                      <article key={m.id} className="mail-letter">
                        <header>
                          <span className="mail-sender-avatar">{initials(m.from)}</span>
                          <div>
                            <strong dir="auto">{m.from}</strong>
                            <small dir="ltr">{m.fromEmail}</small>
                            <span>
                              {t("gmail.toLine", { to: m.to })}
                              {m.cc ? t("gmail.ccLine", { cc: m.cc }) : ""}
                            </span>
                          </div>
                          <time>
                            {date(m.at)}
                            <br />
                            {time(m.at)}
                          </time>
                        </header>
                        <div className="mail-letter-body" dir="auto" style={{ whiteSpace: "pre-wrap" }}>
                          {mark(m.body)}
                        </div>
                        {m.attachments.length > 0 && (
                          <div className="mail-attachments">
                            {m.attachments.map((f, i) => (
                              <span key={i} className="mail-attachment" title={t("gmail.openInGmail")}>
                                <Icon name="folder" />
                                <span>
                                  <strong dir="auto">{f.name}</strong>
                                  <small dir="ltr">{kb(f.size)}</small>
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
                          {t("gmail.reply")}
                        </button>
                        <button type="button" onClick={() => reply("reply-all")}>
                          <Icon name="reply" />
                          {t("gmail.replyAll")}
                        </button>
                        <button type="button" onClick={() => reply("forward")}>
                          <Icon name="forward" />
                          {t("gmail.forward")}
                        </button>
                      </div>
                    )}
                    <p className="mail-reading-note">
                      <Icon name="shield" />
                      {t("gmail.mailStaysWith", { email: accountOf(selected.account)?.email ?? "" })}
                    </p>
                  </div>
                </div>
              </>
            ) : (
              <div className="mail-empty mail-reader-empty">
                <Icon name="mail" />
                <h2>{t("gmail.readerEmptyTitle")}</h2>
                <p>{t("gmail.readerEmptyBody")}</p>
                <button type="button" onClick={newMail} disabled={!accounts.length}>
                  {t("gmail.writeEmailButton")} <Icon name="arrow-right" />
                </button>
              </div>
            )}
          </section>
        </div>
        <button type="button" className="mail-mobile-compose" aria-label={t("gmail.composeEmail")} onClick={newMail}>
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
            if (saved) setNote(t("gmail.draftSaved"));
          }}
        />
      )}
    </div>
  );
}
