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
import "./settings-final.css";

export type SettingsSection = "appearance" | "agents" | "notifications" | "passkeys" | "updates" | "account";
export const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string; icon: IconName; owner?: boolean }> = [
  { id: "appearance", label: "Appearance", icon: "sun" },
  { id: "agents", label: "Agents", icon: "people" },
  { id: "notifications", label: "Notifications", icon: "bell" },
  { id: "passkeys", label: "Passkeys", icon: "fingerprint", owner: true },
  { id: "updates", label: "Updates", icon: "download", owner: true },
  { id: "account", label: "Account", icon: "settings" },
];
const HEADS: Record<SettingsSection, [string, string]> = {
  appearance: ["A space that feels like you.", "Choose the light that suits your day."],
  agents: ["A mind and a voice for each role.", "Choose how your agents think and sound."],
  notifications: ["The right things, at the right time.", "Choose what reaches you, from which apps and agents."],
  passkeys: ["Your approval. Your devices.", "Manage the devices you use for protected approvals."],
  updates: ["New tools, when they are ready.", "Check for a newer AHI and update your skills shelf."],
  account: ["Your personal workspace.", "Your identity and access, in one place."],
};

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
  const { user } = useAppState();
  const owner = !!user?.admin;
  let section = useSettingsSection();
  if ((section === "passkeys" || section === "updates") && !owner) section = "account";
  const [saved, setSaved] = useState("");
  const flash = (t = "Saved") => {
    setSaved(t);
    window.setTimeout(() => setSaved(""), 1500);
  };
  const [title, sub] = HEADS[section];
  return (
    <div className="rs-page">
      <div className="rs-content">
        <header>
          <h2>{title}</h2>
          <p>{sub}</p>
        </header>
        {section === "appearance" && <Appearance name={user?.name ?? ""} owner={owner} />}
        {section === "agents" && <Agents owner={owner} onSaved={flash} />}
        {section === "notifications" && <Notifications agents={availableBots(user)} owner={owner} onSaved={flash} />}
        {section === "passkeys" && <Passkeys />}
        {section === "updates" && <Updates />}
        {section === "account" && <Account name={user?.name ?? ""} owner={owner} />}
        <footer className="rs-footer">
          <span role="status" aria-live="polite">{saved || "Preferences save automatically"}</span>
        </footer>
      </div>
    </div>
  );
}

const initials = (n: string) => n.split(/\s+/).filter(Boolean).map((x) => x[0]).slice(0, 2).join("").toUpperCase() || "?";

function Appearance({ name, owner }: { name: string; owner: boolean }) {
  const [mode, setMode] = useState<ThemeMode>(getThemeMode());
  return (
    <>
      <div className="rs-theme-grid" role="radiogroup" aria-label="Application appearance">
        {(
          [
            ["light", "Light", "sun"],
            ["dark", "Dark", "moon"],
            ["system", "System", "monitor"],
          ] as Array<[ThemeMode, string, IconName]>
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
              <strong>{label}</strong>
              {mode === id && <Icon name="check" />}
            </span>
          </button>
        ))}
      </div>
      <p className="rs-note">System follows your device’s light or dark appearance. Your petrol navigation stays consistent with the rest of AHI.</p>
      <div className="rs-card rs-shortcuts">
        <Row title="Make your team feel familiar" sub={owner ? "Choose a model and voice for each agent." : "See who you work with and how they are set up."}>
          <Btn onClick={() => setSettingsSection("agents")}>
            Your agents <Icon name="arrow-right" />
          </Btn>
        </Row>
        <Row title="Keep the useful things close" sub="Choose notifications by app, activity and agent.">
          <Btn onClick={() => setSettingsSection("notifications")}>
            Notifications <Icon name="arrow-right" />
          </Btn>
        </Row>
      </div>
      <div className="rs-account-shortcut">
        <span className="profile-avatar">{initials(name)}</span>
        <div>
          <strong>{name}</strong>
          <small>{owner ? "Owner" : "Member"} · Personal workspace</small>
        </div>
        <Btn onClick={() => setSettingsSection("account")}>
          Account <Icon name="arrow-right" />
        </Btn>
      </div>
    </>
  );
}

/** An agent's identity lives in its managed identity file on the host, which the app doesn't write; the change
 *  goes to Michael, who keeps those files (the draft waits for the owner to send it). */
function editIdentity(bot: string) {
  actions.setDraft("michael", `I'd like to change ${BOT_LABELS[bot] ?? bot}'s identity: `);
  actions.toggleSettings(false);
  actions.setView("messages");
  actions.openMobileThread("michael");
}

function Agents({ owner, onSaved }: { owner: boolean; onSaved: (t?: string) => void }) {
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [health, setHealth] = useState<HealthPayload | null>(null);
  useEffect(() => {
    if (owner) void fetchSettings().then(setSettings);
    else void fetchHealth().then(setHealth);
  }, [owner]);
  const patch = async (bot: string, p: { model?: string; voice?: string }) => {
    if (await saveBotSetting(bot, p)) {
      onSaved(`${BOT_LABELS[bot] ?? bot} saved`);
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
                      Edit identity
                    </button>
                  )}
                </div>
              </div>
              {owner && settings ? (
                <div className="rs-agent-controls">
                  <label className="rs-select">
                    <span>Model</span>
                    <select aria-label={`${BOT_LABELS[name] ?? name} model`} value={b.model} onChange={(e) => void patch(name, { model: e.target.value })}>
                      {settings.availableModels.map((m) => (
                        <option key={m} value={m}>
                          {MODEL_LABELS[m] ?? m}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="rs-select">
                    <span>Voice</span>
                    <select aria-label={`${BOT_LABELS[name] ?? name} voice`} value={b.voice} onChange={(e) => void patch(name, { voice: e.target.value })}>
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
                  {MODEL_LABELS[b.model] ?? b.model} · online. Models and voices are managed by the workspace owner.
                </p>
              )}
            </article>
          );
        })}
      </div>
      {owner && <p className="rs-note">A change applies to the agent’s next turn; a call in progress keeps its voice until it ends.</p>}
    </>
  );
}

/** Notifications (the reference one for one): In-app, Apps & activity (one card
 *  per app; the card opens an attached list of its activities), Your agents, Sound & timing. Every switch is a
 *  real preference the gateway enforces when a push goes out (src/push.ts pushVerdict); In-app and the app
 *  choices also govern the bell. */
function Notifications({ agents, owner, onSaved }: { agents: string[]; owner: boolean; onSaved: (t?: string) => void }) {
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
    } else onSaved("Couldn’t save — try again");
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
    ? "Checking this device…"
    : !view.configured
      ? "Device alerts need this gateway’s push keys, and they aren’t set. In-app notifications still work."
      : support === "needs-install"
        ? "Add AHI to your Home Screen first; iPhone only delivers alerts to installed apps."
        : support === "unsupported"
          ? "This browser can’t receive device alerts. In-app notifications still work."
          : subscribed
            ? "Device delivery is on for this device."
            : typeof Notification !== "undefined" && Notification.permission === "denied"
              ? "Permission denied. Delivery must be enabled in your browser or app."
              : "Connect device delivery when you’re ready.";
  const q = s?.quietHours;
  const setQuiet = (k: "start" | "end", v: string) => {
    if (!q || !v) return;
    if (v === (k === "start" ? q.end : q.start)) return setQuietErr("Choose different start and end times.");
    setQuietErr(null);
    void patch({ quietHours: { [k]: v, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
  };
  return (
    <>
      <div className="rs-card">
        <Row title="In-app notifications" sub="New activity in your notification inbox.">
          <Switch on={s?.inApp !== false} label="In-app notifications" disabled={!s} onChange={(v) => void patch({ inApp: v })} />
        </Row>
        <Row title="This device" sub={deviceLine}>
          <Btn onClick={() => void device()} disabled={busy || !view || !view.configured || support !== "ok"}>
            {busy ? "Working…" : subscribed ? "Turn off here" : "Set up"}
          </Btn>
        </Row>
      </div>
      {note && <p className="rs-notice">{note}</p>}
      {s?.inApp === false && <p className="rs-notice">In-app delivery is paused. Your app and agent choices are kept for when you turn it back on.</p>}
      {s && view && (
        <>
          <div className="rs-section-title">
            <h3>Apps & activity</h3>
            <p>Turn an app on or off, then choose the activities inside it.</p>
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
                      <span className="rs-event-count">{p.enabled ? `${count} selected` : "Off"}</span>
                      <Icon name="chevron" />
                    </button>
                    <Switch on={p.enabled} label={`${src.name} notifications`} onChange={(v) => void patch({ sources: { [src.id]: { enabled: v } } })} />
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
            <h3>Your agents</h3>
            <p>These choices apply to agent messages. App alerts keep their own controls above.</p>
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
                <Switch on={s.perAgent[bot] !== false} label={`${BOT_LABELS[bot] ?? bot} notifications`} onChange={(v) => void patch({ perAgent: { [bot]: v } })} />
              </Row>
            ))}
          </div>
          <div className="rs-section-title">
            <h3>Sound & timing</h3>
            <p>Quiet hours use your device’s local time.</p>
          </div>
          <div className="rs-card">
            <Row title="Sound" sub="A subtle cue for new activity.">
              <span className="rs-row-tail">
                <select
                  className="rs-tone"
                  aria-label="Notification sound"
                  value={s.tone}
                  disabled={!s.sound}
                  onChange={(e) => {
                    playTone(e.target.value);
                    void patch({ tone: e.target.value });
                  }}
                >
                  {view.tones.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <Switch on={s.sound} label="Notification sound" onChange={(v) => void patch({ sound: v })} />
              </span>
            </Row>
            <Row title="Vibration" sub="When your device supports it.">
              <Switch on={s.vibration} label="Notification vibration" onChange={(v) => void patch({ vibration: v })} />
            </Row>
            <Row title="Quiet hours" sub="Hold device alerts until your quiet time ends.">
              <Switch on={!!q?.enabled} label="Quiet hours" onChange={(v) => void patch({ quietHours: { enabled: v, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } })} />
            </Row>
            <div className="rs-quiet" hidden={!q?.enabled}>
              <label>
                From
                <input type="time" defaultValue={q?.start} aria-label="Quiet hours start" onChange={(e) => setQuiet("start", e.target.value)} />
              </label>
              <label>
                Until
                <input type="time" defaultValue={q?.end} aria-label="Quiet hours end" onChange={(e) => setQuiet("end", e.target.value)} />
              </label>
            </div>
            {quietErr && <p className="rs-notice">{quietErr}</p>}
            <Row title="Time-sensitive alerts during quiet hours" sub="Only alerts specifically marked time-sensitive. Other alerts wait.">
              <Switch on={s.urgent} label="Time-sensitive alerts during quiet hours" onChange={(v) => void patch({ urgent: v })} />
            </Row>
          </div>
          <p className="rs-note">{owner ? "Saved on the gateway and applied when an alert is about to go out, on every device you use." : "Saved on the gateway and applied to every device you use."} Sound and vibration can only quiet what your device would do.</p>
        </>
      )}
    </>
  );
}

function Passkeys() {
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
  const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
  const add = async () => {
    if (busy || !list) return;
    setBusy(true);
    setNote(null);
    const r = await addThisDevice(list.length > 0, !!enrollUntil);
    setBusy(false);
    if (r.ok) {
      setNote({ tone: "ok", text: `${r.value.passkey.label} added. Protected approvals can now use it.` });
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
      setNote({ tone: "ok", text: `${p.label} removed.` });
      load();
    } else setNote({ tone: "err", text: r.error });
  };
  const closedFirst = list !== null && list.length === 0 && !enrollUntil;
  return (
    <>
      <div className="rs-security-note">
        <Icon name="fingerprint" />
        <div>
          <strong>For the decisions that need you.</strong>
          <p>Passkeys verify sensitive approvals. Your device may use a fingerprint, face or PIN.</p>
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
                  {p.label}
                </span>
              }
              sub={`Added ${day(p.created)} · ${p.last_used ? `used ${day(p.last_used)}` : "not used yet"}`}
            >
              <Btn onClick={() => void remove(p)} disabled={busy}>
                Remove
              </Btn>
            </Row>
          ))
        ) : (
          <div className="rs-empty">
            <h3>No passkeys yet.</h3>
            <p>Protected approvals stay waiting until a verification method is set up.</p>
          </div>
        )}
      </div>
      <div className="rs-enrollment">
        <div>
          <h3>{enrollUntil ? "Enrollment is open." : "Add another device."}</h3>
          <p>
            {!supported
              ? "This browser can’t create passkeys. Use the installed app on your phone."
              : enrollUntil
                ? `Your 15-minute window is open until ${new Date(enrollUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Confirm on the device you want to add.`
                : list && list.length
                  ? "Confirm with a passkey you already have, then add this one."
                  : "Michael opens a 15-minute enrollment window before a device can be added."}
          </p>
        </div>
        {closedFirst ? (
          <Btn
            primary
            onClick={() => {
              actions.setDraft("michael", "Please open a 15-minute passkey enrollment window for this device.");
              actions.toggleSettings(false);
              actions.setView("messages");
              actions.openMobileThread("michael");
            }}
          >
            Request enrollment
          </Btn>
        ) : (
          <Btn primary onClick={() => void add()} disabled={busy || !supported || list === null}>
            {busy ? "Waiting for your passkey…" : "Add this device"}
          </Btn>
        )}
      </div>
      {note && <p className={note.tone === "err" ? "rs-notice" : "rs-note"}>{note.text}</p>}
    </>
  );
}

function Updates() {
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
        ? `Skills update failed: ${r.error}`
        : `Updated ${installed.length} skill${installed.length === 1 ? "" : "s"}.${kept.length ? ` Kept your own copy of ${kept.join(", ")}.` : ""}`,
    );
    await check();
  };
  if (!info) return <p className="rs-note">{busy ? "Checking for updates…" : "Updates are unavailable right now."}</p>;
  const { current, latest } = info;
  return (
    <>
      <div className="rs-card">
        <Row title={`AHI ${current.version}`} sub={info.configured ? (latest ? `Latest release: ${latest.name}, published ${new Date(latest.publishedAt).toLocaleDateString()}.` : info.error ?? "") : "This install does not know which release channel to check."}>
          {info.appUpdate && latest ? (
            <Btn primary onClick={() => window.open(latest.url, "_blank", "noopener")}>
              Get AHI {latest.version} <Icon name="download" />
            </Btn>
          ) : (
            <Btn onClick={() => void check(true)} disabled={!!busy || !info.configured}>
              Check now <Icon name="refresh" />
            </Btn>
          )}
        </Row>
        <Row
          title="Skills shelf"
          sub={info.skills?.length ? `${info.skills.length} newer: ${info.skills.map((s) => `${s.name} ${s.version}`).join(", ")}.` : `Up to date${current.skillsRelease ? ` (release ${current.skillsRelease})` : ""}.`}
        >
          {!!info.skills?.length && (
            <Btn primary onClick={() => void install()} disabled={!!busy}>
              {busy === "skills" ? "Updating…" : "Update skills"} <Icon name="download" />
            </Btn>
          )}
        </Row>
      </div>
      {note && <p className="rs-note" role="status">{note}</p>}
    </>
  );
}

function Account({ name, owner }: { name: string; owner: boolean }) {
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
          <h3>{name}</h3>
          <p>Personal workspace</p>
          <span>{owner ? "Owner" : "Member"}</span>
        </div>
      </div>
      <div className="rs-card">
        <Row title="Workspace" sub="Your team, connected apps and preferences.">
          <Btn onClick={() => goPage("connections")}>
            Connections <Icon name="arrow-right" />
          </Btn>
        </Row>
        <Row title="Verification" sub="Devices for protected approvals.">
          {owner ? (
            <Btn onClick={() => setSettingsSection("passkeys")}>
              Passkeys <Icon name="arrow-right" />
            </Btn>
          ) : (
            <span className="rs-note">Managed by the owner</span>
          )}
        </Row>
      </div>
      <div className="rs-signout-row">
        <div>
          <h3>Sign out</h3>
          <p>Leave your account on this device.</p>
        </div>
        {confirming ? (
          <span className="rs-signout-confirm">
            <Btn onClick={() => setConfirming(false)}>Cancel</Btn>
            <Btn primary onClick={() => void signOut()}>
              Log out
            </Btn>
          </span>
        ) : (
          <Btn onClick={() => setConfirming(true)}>
            Sign out <Icon name="exit" />
          </Btn>
        )}
      </div>
    </>
  );
}
