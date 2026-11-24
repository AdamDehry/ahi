/**
 * Settings — the FINAL sectioned page one for one (the owner's walkthrough opened here): the nav picks a
 * section, each section has its own heading. Every control is the real one it replaces:
 * theme (local, as before), agent model + voice (gateway bot settings, owner), Web Push for this
 * device + per-agent / sound / vibration / quiet hours (enforced on the gateway), passkeys (add this
 * device, remove with a fingerprint), and Log out.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { actions, availableBots, useAppState } from "../store";
import { fetchHealth, fetchSettings, fetchUpdates, installSkillUpdates, logout, saveBotSetting, type HealthPayload, type SettingsPayload, type UpdatesPayload } from "../lib/api";
import { applyThemeMode, getThemeMode, type ThemeMode } from "../theme";
import { BOT_LABELS, BOT_SUBTITLES } from "../lib/types";
import { addThisDevice, fetchPasskeys, removePasskey, webauthnSupported, type Passkey } from "../lib/review";
import { fetchPushSettings, isSubscribed, pushPrefsChanged, pushSupport, savePushSettings, subscribeThisDevice, unsubscribeThisDevice, type PushSettingsPatch, type PushSettingsView } from "../lib/push";
import { playTone } from "../lib/tones";
import { Icon, type IconName } from "./icons";
import { AgentAvatar } from "./AgentRail";
import { railOrder } from "./agents";
import { MODEL_LABELS } from "../views/Settings";
import { goPage } from "./Shell";
import LanguageSettings from "./LanguageSettings";
import { getLang, locale, t, tn, useT, type Key } from "../i18n";
import "./settings-final.css";

export type SettingsSection = "appearance" | "language" | "agents" | "notifications" | "passkeys" | "updates" | "account";
/** `label` is a catalog key, translated where the list is rendered (Team.tsx SettingsNav). */
export const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: Key; icon: IconName; owner?: boolean }> = [
  { id: "appearance", label: "settings.section.appearance", icon: "sun" },
  { id: "language", label: "lang.section", icon: "globe" },
  { id: "agents", label: "settings.section.agents", icon: "people" },
  { id: "notifications", label: "shell.notifications", icon: "bell" },
  { id: "passkeys", label: "settings.section.passkeys", icon: "fingerprint", owner: true },
  { id: "updates", label: "settings.section.updates", icon: "download", owner: true },
  { id: "account", label: "settings.section.account", icon: "settings" },
];
const HEADS: Record<SettingsSection, [Key, Key]> = {
  appearance: ["settings.head.appearance", "settings.head.appearanceSub"],
  language: ["lang.headTitle", "lang.headSub"],
  agents: ["settings.head.agents", "settings.head.agentsSub"],
  notifications: ["settings.head.notifications", "settings.head.notificationsSub"],
  passkeys: ["settings.head.passkeys", "settings.head.passkeysSub"],
  updates: ["settings.head.updates", "settings.head.updatesSub"],
  account: ["settings.head.account", "settings.head.accountSub"],
};

/** English keeps the browser's own date format, as before; other languages format in their locale. */
const dateLoc = (): string | string[] => (getLang() === "en" ? [] : locale());

let current: SettingsSection = "appearance";
const subs = new Set<() => void>();
export function setSettingsSection(s: SettingsSection) {
  current = s;
  subs.forEach((f) => f());
  document.querySelector(".rd-page[data-page='settings']")?.scrollTo?.({ top: 0 });
}
export const useSettingsSection = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => current);

const Btn = ({ children, onClick, primary, disabled, label }: { children: React.ReactNode; onClick: () => void; primary?: boolean; disabled?: boolean; label?: string }) => (
  <button type="button" className={`vault-button${primary ? " primary" : ""}`} onClick={onClick} disabled={disabled} aria-label={label}>
    {children}
  </button>
);
const Switch = ({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean }) => (
  <button type="button" role="switch" aria-checked={on} aria-label={label} className="rs-switch" disabled={disabled} onClick={() => onChange(!on)}>
    <i />
  </button>
);
const Row = ({ title, sub, children }: { title: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }) => (
  <div className="rs-row">
    <div>
      <strong>{title}</strong>
      {sub && <p>{sub}</p>}
    </div>
    {children}
  </div>
);

export default function SettingsPage() {
  const t = useT();
  const { user } = useAppState();
  const owner = !!user?.admin;
  let section = useSettingsSection();
  if ((section === "passkeys" || section === "updates") && !owner) section = "account";
  const [saved, setSaved] = useState("");
  const flash = (text: string = t("common.saved")) => {
    setSaved(text);
    window.setTimeout(() => setSaved(""), 1500);
  };
  const [title, sub] = HEADS[section];
  return (
    <div className="rs-page">
      <div className="rs-content">
        <header>
          <h2>{t(title)}</h2>
          <p>{t(sub)}</p>
        </header>
        {section === "appearance" && <Appearance name={user?.name ?? ""} owner={owner} />}
        {section === "language" && <LanguageSettings onSaved={flash} />}
        {section === "agents" && <Agents owner={owner} onSaved={flash} />}
        {section === "notifications" && <Notifications agents={availableBots(user)} owner={owner} onSaved={flash} />}
        {section === "passkeys" && <Passkeys />}
        {section === "updates" && <Updates />}
        {section === "account" && <Account name={user?.name ?? ""} owner={owner} />}
        <footer className="rs-footer">
          <span role="status" aria-live="polite">{saved || t("settings.autoSave")}</span>
        </footer>
      </div>
    </div>
  );
}

const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((x) => x[0]).slice(0, 2).join("").toUpperCase() || "?";

function Appearance({ name, owner }: { name: string; owner: boolean }) {
  const t = useT();
  const [mode, setMode] = useState<ThemeMode>(getThemeMode());
  return (
    <>
      <div className="rs-theme-grid" role="radiogroup" aria-label={t("settings.appearanceGroup")}>
        {(
          [
            ["light", "settings.theme.light", "sun"],
            ["dark", "settings.theme.dark", "moon"],
            ["system", "settings.theme.system", "monitor"],
          ] as Array<[ThemeMode, Key, IconName]>
        ).map(([id, label, glyph]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={mode === id}
            aria-pressed={mode === id}
            className={`rs-theme ${id}`}
            onClick={() => {
              setMode(id);
              applyThemeMode(id);
            }}
          >
            <span className="rs-theme-preview">
              <i />
              <span>
                <b />
                <em />
                <em />
              </span>
            </span>
            <span>
              <Icon name={glyph} />
              <strong>{t(label)}</strong>
              {mode === id && <Icon name="check" />}
            </span>
          </button>
        ))}
      </div>
      <p className="rs-note">{t("settings.theme.note")}</p>
      <div className="rs-card rs-shortcuts">
        <Row title={t("settings.familiarTitle")} sub={owner ? t("settings.familiarOwner") : t("settings.familiarMember")}>
          <Btn onClick={() => setSettingsSection("agents")}>
            {t("lang.agentsTitle")} <Icon name="arrow-right" />
          </Btn>
        </Row>
        <Row title={t("settings.closeTitle")} sub={t("settings.closeSub")}>
          <Btn onClick={() => setSettingsSection("notifications")}>
            {t("shell.notifications")} <Icon name="arrow-right" />
          </Btn>
        </Row>
      </div>
      <div className="rs-account-shortcut">
        <span className="profile-avatar">{initials(name)}</span>
        <div>
          <strong dir="auto">{name}</strong>
          <small>{owner ? t("settings.owner") : t("shell.member")} · {t("shell.personalWorkspace")}</small>
        </div>
        <Btn onClick={() => setSettingsSection("account")}>
          {t("settings.section.account")} <Icon name="arrow-right" />
        </Btn>
      </div>
    </>
  );
}

/** An agent's identity lives in its managed identity file on the host, which the app doesn't write; the change
 *  goes to Michael, who keeps those files (the draft waits for the owner to send it). */
function editIdentity(bot: string) {
  actions.setDraft("michael", t("settings.identityDraft", { name: BOT_LABELS[bot] ?? bot }));
  actions.toggleSettings(false);
  actions.setView("messages");
  actions.openMobileThread("michael");
}

function Agents({ owner, onSaved }: { owner: boolean; onSaved: (text?: string) => void }) {
  const t = useT();
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [health, setHealth] = useState<HealthPayload | null>(null);
  useEffect(() => {
    if (owner) void fetchSettings().then(setSettings);
    else void fetchHealth().then(setHealth);
  }, [owner]);
  const patch = async (bot: string, p: { model?: string; voice?: string }) => {
    if (await saveBotSetting(bot, p)) {
      onSaved(t("settings.agentSaved", { name: BOT_LABELS[bot] ?? bot }));
      void fetchSettings().then(setSettings);
    }
  };
  const bots = owner ? settings?.bots ?? null : health?.bots.map((b) => ({ name: b.name, model: b.model, voice: "" })) ?? null;
  if (!bots) return <div className="rs-card skeleton-card" style={{ minHeight: 200 }} />;
  const order = railOrder(bots.map((b) => b.name));
  return (
    <>
      <div className="rs-agent-list">
        {order.map((name) => {
          const b = bots.find((x) => x.name === name)!;
          return (
            <article key={name} className="rs-agent">
              <div className="rs-agent-name">
                <AgentAvatar bot={name} />
                <div>
                  <h3>{BOT_LABELS[name] ?? name}</h3>
                  <p>{BOT_SUBTITLES[name] ?? ""}</p>
                  {owner && (
                    <button type="button" className="identity-edit-link" onClick={() => editIdentity(name)}>
                      {t("settings.editIdentity")}
                    </button>
                  )}
                </div>
              </div>
              {owner && settings ? (
                <div className="rs-agent-controls">
                  <label className="rs-select">
                    <span>{t("settings.model")}</span>
                    <select aria-label={t("settings.agentModel", { name: BOT_LABELS[name] ?? name })} value={b.model} onChange={(e) => void patch(name, { model: e.target.value })}>
                      {settings.availableModels.map((m) => (
                        <option key={m} value={m}>
                          {MODEL_LABELS[m] ?? m}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="rs-select">
                    <span>{t("settings.voice")}</span>
                    <select aria-label={t("settings.agentVoice", { name: BOT_LABELS[name] ?? name })} value={b.voice} onChange={(e) => void patch(name, { voice: e.target.value })}>
                      {settings.voiceGroups
                        .filter((g) => !g.bots || g.bots.includes(name))
                        .map((g) => (
                          <optgroup key={g.label} label={g.label}>
                            {g.voices.map((v) => (
                              <option key={v} value={v}>
                                {v}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                    </select>
                  </label>
                </div>
              ) : (
                <p className="rs-note">
                  {t("settings.memberModelLine", { model: MODEL_LABELS[b.model] ?? b.model })}
                </p>
              )}
            </article>
          );
        })}
      </div>
      {owner && <p className="rs-note">{t("settings.agentChangeNote")}</p>}
    </>
  );
}

/** Notifications (the reference one for one): In-app, Apps & activity (one card
 *  per app; the card opens an attached list of its activities), Your agents, Sound & timing. Every switch is a
 *  real preference the gateway enforces when a push goes out (src/push.ts pushVerdict); In-app and the app
 *  choices also govern the bell. */
function Notifications({ agents, owner, onSaved }: { agents: string[]; owner: boolean; onSaved: (text?: string) => void }) {
  const t = useT();
  const support = pushSupport();
  const [subscribed, setSubscribed] = useState(false);
  const [view, setView] = useState<PushSettingsView | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [quietErr, setQuietErr] = useState<string | null>(null);
  useEffect(() => {
    void isSubscribed().then(setSubscribed);
    void fetchPushSettings().then((r) => r && setView(r));
  }, []);
  const s = view?.settings;
  const patch = async (p: PushSettingsPatch) => {
    const next = await savePushSettings(p);
    if (next) {
      setView((v) => (v ? { ...v, settings: next } : v));
      pushPrefsChanged(next);
      onSaved();
    } else onSaved(t("settings.couldntSave"));
  };
  const device = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    if (subscribed) {
      await unsubscribeThisDevice();
      setSubscribed(false);
    } else {
      const err = await subscribeThisDevice();
      if (err) setNote(err);
      else setSubscribed(true);
    }
    setBusy(false);
  };
  // Says plainly what is missing when this device can't take alerts (the owner: "Set up does nothing").
  const deviceLine = !view
    ? t("settings.device.checking")
    : !view.configured
      ? t("settings.device.noKeys")
      : support === "needs-install"
        ? t("settings.device.needsInstall")
        : support === "unsupported"
          ? t("settings.device.unsupported")
          : subscribed
            ? t("settings.device.on")
            : typeof Notification !== "undefined" && Notification.permission === "denied"
              ? t("settings.device.denied")
              : t("settings.device.connect");
  const q = s?.quietHours;
  const setQuiet = (k: "start" | "end", v: string) => {
    if (!q || !v) return;
    if (v === (k === "start" ? q.end : q.start)) return setQuietErr(t("settings.quiet.sameTimes"));
    setQuietErr(null);
    void patch({ quietHours: { [k]: v, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
  };
  return (
    <>
      <div className="rs-card">
        <Row title={t("settings.inApp")} sub={t("settings.inAppSub")}>
          <Switch on={s?.inApp !== false} label={t("settings.inApp")} disabled={!s} onChange={(v) => void patch({ inApp: v })} />
        </Row>
        <Row title={t("settings.thisDevice")} sub={deviceLine}>
          <Btn onClick={() => void device()} disabled={busy || !view || !view.configured || support !== "ok"}>
            {busy ? t("settings.working") : subscribed ? t("settings.turnOffHere") : t("settings.setUp")}
          </Btn>
        </Row>
      </div>
      {note && <p className="rs-notice">{note}</p>}
      {s?.inApp === false && <p className="rs-notice">{t("settings.inAppPaused")}</p>}
      {s && view && (
        <>
          <div className="rs-section-title">
            <h3>{t("settings.appsTitle")}</h3>
            <p>{t("settings.appsSub")}</p>
          </div>
          <div className="rs-sources">
            {view.sources.map((src) => {
              const p = s.sources[src.id] ?? { enabled: true, events: {} };
              const isOpen = open.has(src.id);
              const count = src.events.filter((e) => p.events[e.id] ?? e.on).length;
              return (
                <article key={src.id} className="rs-source">
                  <header>
                    <button
                      type="button"
                      className="rs-source-open"
                      aria-expanded={isOpen}
                      aria-controls={`rs-events-${src.id}`}
                      onClick={() => setOpen((o) => {
                        const n = new Set(o);
                        if (n.has(src.id)) n.delete(src.id);
                        else n.add(src.id);
                        return n;
                      })}
                    >
                      <span className="rs-source-icon">
                        <Icon name={src.icon as IconName} />
                      </span>
                      <span>
                        <strong>{src.name}</strong>
                        <small>{src.blurb}</small>
                      </span>
                      <span className="rs-event-count">{p.enabled ? t("settings.selected", { n: count }) : t("common.off")}</span>
                      <Icon name="chevron" />
                    </button>
                    <Switch on={p.enabled} label={t("settings.sourceNotifications", { name: src.name })} onChange={(v) => void patch({ sources: { [src.id]: { enabled: v } } })} />
                  </header>
                  <div className="rs-source-events" id={`rs-events-${src.id}`} hidden={!isOpen}>
                    {src.events.map((e) => (
                      <Row key={e.id} title={e.label}>
                        <Switch on={p.events[e.id] ?? e.on} disabled={!p.enabled} label={`${src.name} · ${e.label}`} onChange={(v) => void patch({ sources: { [src.id]: { events: { [e.id]: v } } } })} />
                      </Row>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
          <div className="rs-section-title">
            <h3>{t("lang.agentsTitle")}</h3>
            <p>{t("settings.agentsNotifSub")}</p>
          </div>
          <div className="rs-card">
            {railOrder(agents).map((bot) => (
              <Row
                key={bot}
                title={
                  <span className="rs-agent-inline">
                    <AgentAvatar bot={bot} size="sm" />
                    {BOT_LABELS[bot] ?? bot}
                  </span>
                }
                sub={BOT_SUBTITLES[bot]}
              >
                <Switch on={s.perAgent[bot] !== false} label={t("settings.sourceNotifications", { name: BOT_LABELS[bot] ?? bot })} onChange={(v) => void patch({ perAgent: { [bot]: v } })} />
              </Row>
            ))}
          </div>
          <div className="rs-section-title">
            <h3>{t("settings.soundTitle")}</h3>
            <p>{t("settings.soundSub")}</p>
          </div>
          <div className="rs-card">
            <Row title={t("settings.sound")} sub={t("settings.soundRowSub")}>
              <span className="rs-row-tail">
                <select
                  className="rs-tone"
                  aria-label={t("settings.notificationSound")}
                  value={s.tone}
                  disabled={!s.sound}
                  onChange={(e) => {
                    playTone(e.target.value);
                    void patch({ tone: e.target.value });
                  }}
                >
                  {view.tones.map((tone) => (
                    <option key={tone}>{tone}</option>
                  ))}
                </select>
                <Switch on={s.sound} label={t("settings.notificationSound")} onChange={(v) => void patch({ sound: v })} />
              </span>
            </Row>
            <Row title={t("settings.vibration")} sub={t("settings.vibrationSub")}>
              <Switch on={s.vibration} label={t("settings.notificationVibration")} onChange={(v) => void patch({ vibration: v })} />
            </Row>
            <Row title={t("settings.quietHours")} sub={t("settings.quietHoursSub")}>
              <Switch on={!!q?.enabled} label={t("settings.quietHours")} onChange={(v) => void patch({ quietHours: { enabled: v, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } })} />
            </Row>
            <div className="rs-quiet" hidden={!q?.enabled}>
              <label>
                {t("settings.quiet.from")}
                <input type="time" defaultValue={q?.start} aria-label={t("settings.quiet.start")} onChange={(e) => setQuiet("start", e.target.value)} />
              </label>
              <label>
                {t("settings.quiet.until")}
                <input type="time" defaultValue={q?.end} aria-label={t("settings.quiet.end")} onChange={(e) => setQuiet("end", e.target.value)} />
              </label>
            </div>
            {quietErr && <p className="rs-notice">{quietErr}</p>}
            <Row title={t("settings.urgent")} sub={t("settings.urgentSub")}>
              <Switch on={s.urgent} label={t("settings.urgent")} onChange={(v) => void patch({ urgent: v })} />
            </Row>
          </div>
          <p className="rs-note">{owner ? t("settings.savedGatewayOwner") : t("settings.savedGatewayMember")} {t("settings.soundOnlyQuiets")}</p>
        </>
      )}
    </>
  );
}

function Passkeys() {
  const t = useT();
  const [list, setList] = useState<Passkey[] | null>(null);
  const [enrollUntil, setEnrollUntil] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const supported = webauthnSupported();
  const load = () =>
    void fetchPasskeys().then((r) => {
      if (!r) return;
      setList(r.passkeys);
      setEnrollUntil(r.enroll_open_until);
    });
  useEffect(load, []);
  const day = (iso: string) => new Date(iso).toLocaleDateString(dateLoc(), { month: "short", day: "numeric" });
  const add = async () => {
    if (busy || !list) return;
    setBusy(true);
    setNote(null);
    const r = await addThisDevice(list.length > 0, !!enrollUntil);
    setBusy(false);
    if (r.ok) {
      setNote({ tone: "ok", text: t("settings.passkey.added", { label: r.value.passkey.label }) });
      load();
    } else setNote({ tone: "err", text: r.error });
  };
  const remove = async (p: Passkey) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const r = await removePasskey(p.id);
    setBusy(false);
    if (r.ok) {
      setNote({ tone: "ok", text: t("settings.passkey.removed", { label: p.label }) });
      load();
    } else setNote({ tone: "err", text: r.error });
  };
  const closedFirst = list !== null && list.length === 0 && !enrollUntil;
  return (
    <>
      <div className="rs-security-note">
        <Icon name="fingerprint" />
        <div>
          <strong>{t("settings.passkey.title")}</strong>
          <p>{t("settings.passkey.body")}</p>
        </div>
      </div>
      <div className="rs-card">
        {list === null ? (
          <div className="rs-empty skeleton-card" />
        ) : list.length ? (
          list.map((p) => (
            <Row
              key={p.id}
              title={
                <span className="rs-key-name">
                  <Icon name="fingerprint" />
                  <bdi dir="auto">{p.label}</bdi>
                </span>
              }
              sub={p.last_used ? t("settings.passkey.addedUsed", { added: day(p.created), used: day(p.last_used) }) : t("settings.passkey.addedNotUsed", { added: day(p.created) })}
            >
              <Btn onClick={() => void remove(p)} disabled={busy}>
                {t("common.remove")}
              </Btn>
            </Row>
          ))
        ) : (
          <div className="rs-empty">
            <h3>{t("settings.passkey.none")}</h3>
            <p>{t("settings.passkey.noneSub")}</p>
          </div>
        )}
      </div>
      <div className="rs-enrollment">
        <div>
          <h3>{enrollUntil ? t("settings.passkey.enrollOpen") : t("settings.passkey.addAnother")}</h3>
          <p>
            {!supported
              ? t("settings.passkey.unsupported")
              : enrollUntil
                ? t("settings.passkey.windowOpen", { time: new Date(enrollUntil).toLocaleTimeString(dateLoc(), { hour: "numeric", minute: "2-digit" }) })
                : list && list.length
                  ? t("settings.passkey.confirmExisting")
                  : t("settings.passkey.michaelOpens")}
          </p>
        </div>
        {closedFirst ? (
          <Btn
            primary
            onClick={() => {
              actions.setDraft("michael", t("settings.passkey.enrollDraft"));
              actions.toggleSettings(false);
              actions.setView("messages");
              actions.openMobileThread("michael");
            }}
          >
            {t("settings.passkey.request")}
          </Btn>
        ) : (
          <Btn primary onClick={() => void add()} disabled={busy || !supported || list === null}>
            {busy ? t("settings.passkey.waiting") : t("settings.passkey.addThis")}
          </Btn>
        )}
      </div>
      {note && <p className={note.tone === "err" ? "rs-notice" : "rs-note"}>{note.text}</p>}
    </>
  );
}

function Updates() {
  const t = useT();
  const [info, setInfo] = useState<UpdatesPayload | null>(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const check = async (refresh = false) => {
    setBusy("check");
    setInfo(await fetchUpdates(refresh));
    setBusy("");
  };
  useEffect(() => {
    void check();
  }, []);
  const install = async () => {
    setBusy("skills");
    const r = await installSkillUpdates();
    const installed = r.installed ?? [], kept = r.keptOwn ?? [];
    setNote(
      !r.ok
        ? t("settings.updates.failed", { error: r.error ?? "" })
        : tn("settings.updates.updated", installed.length) + (kept.length ? t("settings.updates.kept", { names: kept.join(", ") }) : ""),
    );
    await check();
  };
  if (!info) return <p className="rs-note">{busy ? t("settings.updates.checking") : t("settings.updates.unavailable")}</p>;
  const { current, latest } = info;
  return (
    <>
      <div className="rs-card">
        <Row title={<bdi dir="ltr">{`AHI ${current.version}`}</bdi>} sub={info.configured ? (latest ? t("settings.updates.latest", { name: latest.name, date: new Date(latest.publishedAt).toLocaleDateString(dateLoc()) }) : info.error ?? "") : t("settings.updates.noChannel")}>
          {info.appUpdate && latest ? (
            <Btn primary onClick={() => window.open(latest.url, "_blank", "noopener")}>
              {t("settings.updates.get", { version: latest.version })} <Icon name="download" />
            </Btn>
          ) : (
            <Btn onClick={() => void check(true)} disabled={!!busy || !info.configured}>
              {t("settings.updates.checkNow")} <Icon name="refresh" />
            </Btn>
          )}
        </Row>
        <Row
          title={t("settings.updates.shelf")}
          sub={info.skills?.length ? t("settings.updates.newer", { n: info.skills.length, list: info.skills.map((s) => `${s.name} ${s.version}`).join(", ") }) : current.skillsRelease ? t("settings.updates.upToDateRelease", { release: current.skillsRelease }) : t("settings.updates.upToDate")}
        >
          {!!info.skills?.length && (
            <Btn primary onClick={() => void install()} disabled={!!busy}>
              {busy === "skills" ? t("settings.updates.updating") : t("settings.updates.updateSkills")} <Icon name="download" />
            </Btn>
          )}
        </Row>
      </div>
      {note && <p className="rs-note" role="status">{note}</p>}
    </>
  );
}

function Account({ name, owner }: { name: string; owner: boolean }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const signOut = async () => {
    await logout();
    actions.loggedOut();
    try {
      localStorage.removeItem("ahi-web-snapshot-v1");
    } catch {}
  };
  return (
    <>
      <div className="rs-account-card">
        <span className="profile-avatar">{initials(name)}</span>
        <div>
          <h3 dir="auto">{name}</h3>
          <p>{t("shell.personalWorkspace")}</p>
          <span>{owner ? t("settings.owner") : t("shell.member")}</span>
        </div>
      </div>
      <div className="rs-card">
        <Row title={t("settings.account.workspace")} sub={t("settings.account.workspaceSub")}>
          <Btn onClick={() => goPage("connections")}>
            {t("shell.nav.connections")} <Icon name="arrow-right" />
          </Btn>
        </Row>
        <Row title={t("settings.account.verification")} sub={t("settings.account.verificationSub")}>
          {owner ? (
            <Btn onClick={() => setSettingsSection("passkeys")}>
              {t("settings.section.passkeys")} <Icon name="arrow-right" />
            </Btn>
          ) : (
            <span className="rs-note">{t("settings.account.managedByOwner")}</span>
          )}
        </Row>
      </div>
      <div className="rs-signout-row">
        <div>
          <h3>{t("common.signOut")}</h3>
          <p>{t("settings.account.signOutSub")}</p>
        </div>
        {confirming ? (
          <span className="rs-signout-confirm">
            <Btn onClick={() => setConfirming(false)}>{t("common.cancel")}</Btn>
            <Btn primary onClick={() => void signOut()}>
              {t("settings.account.logOut")}
            </Btn>
          </span>
        ) : (
          <Btn onClick={() => setConfirming(true)}>
            {t("common.signOut")} <Icon name="exit" />
          </Btn>
        )}
      </div>
    </>
  );
}
