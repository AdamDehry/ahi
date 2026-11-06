import { useEffect, useState } from "react";
import { actions, useAppState } from "../store";
import { fetchSettings, fetchHealth, saveBotSetting, logout, type SettingsPayload, type HealthPayload } from "../lib/api";
import { applyThemeMode, getThemeMode, type ThemeMode } from "../theme";
import { BOT_LABELS } from "../lib/types";
import { addThisDevice, fetchPasskeys, removePasskey, webauthnSupported, type Passkey } from "../lib/review";
import { IconFingerprint } from "../components/icons";
import {
  pushSupport,
  isSubscribed,
  subscribeThisDevice,
  unsubscribeThisDevice,
  fetchPushSettings,
  savePushSettings,
  type PushSettings,
} from "../lib/push";

/** NOTIFICATIONS (Step 8): subscribe THIS device to Web Push and manage
 *  the user's notification settings — per-agent on/off, sound, vibration,
 *  quiet hours. Settings are stored and ENFORCED on the gateway (a muted
 *  agent or quiet hours = no push is sent at all); sound/vibration only
 *  ever reduce what the phone OS itself would do — OS per-app settings
 *  stay authoritative. */
function NotificationsSection({ agents }: { agents: string[] }) {
  const support = pushSupport();
  const [subscribed, setSubscribed] = useState(false);
  const [settings, setSettings] = useState<PushSettings | null>(null);
  const [configured, setConfigured] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void isSubscribed().then(setSubscribed);
    void fetchPushSettings().then((r) => {
      if (r) {
        setSettings(r.settings);
        setConfigured(r.configured);
      }
    });
  }, []);

  async function patch(p: Partial<PushSettings>) {
    const next = await savePushSettings({
      ...p,
      // Pin quiet-hours evaluation to the device's timezone.
      ...(p.quietHours ? { quietHours: { ...p.quietHours, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } } : {}),
    });
    if (next) {
      setSettings(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    }
  }

  async function toggleDevice() {
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
  }

  const q = settings?.quietHours;

  return (
    <section className="settings-section">
      <div className="mono-label">
        NOTIFICATIONS {saved && <span className="mono-label saved">SAVED</span>}
      </div>

      {!configured && <div className="settings-row"><span className="settings-hint">Push is not configured on the gateway (VAPID keys missing).</span></div>}

      <div className="settings-row">
        <span className="settings-bot-name">This device</span>
        <button className="segment" onClick={() => void toggleDevice()} disabled={busy || support !== "ok"}>
          {subscribed ? "Enabled — tap to disable" : "Enable notifications"}
        </button>
      </div>
      {support === "needs-install" && (
        <div className="settings-row">
          <span className="settings-hint">Install the app first: Share → Add to Home Screen. iOS only delivers push to installed apps.</span>
        </div>
      )}
      {note && <div className="settings-row"><span className="settings-hint">{note}</span></div>}

      {settings && (
        <>
          {agents.map((bot) => (
            <div key={bot} className="settings-row">
              <span className="agent-dot" data-bot={bot} />
              <span className="settings-bot-name">{BOT_LABELS[bot] ?? bot}</span>
              <input
                type="checkbox"
                checked={settings.perAgent[bot] !== false}
                onChange={(e) => void patch({ perAgent: { [bot]: e.target.checked } })}
                aria-label={`Notifications from ${BOT_LABELS[bot] ?? bot}`}
              />
            </div>
          ))}
          <div className="settings-row">
            <span className="settings-bot-name">Sound</span>
            <input type="checkbox" checked={settings.sound} onChange={(e) => void patch({ sound: e.target.checked })} aria-label="Notification sound" />
          </div>
          <div className="settings-row">
            <span className="settings-bot-name">Vibration</span>
            <input type="checkbox" checked={settings.vibration} onChange={(e) => void patch({ vibration: e.target.checked })} aria-label="Notification vibration" />
          </div>
          <div className="settings-row">
            <span className="settings-bot-name">Quiet hours</span>
            <input
              type="checkbox"
              checked={q?.enabled ?? false}
              onChange={(e) => q && void patch({ quietHours: { ...q, enabled: e.target.checked } })}
              aria-label="Quiet hours"
            />
            {q?.enabled && (
              <>
                <input type="time" value={q.start} onChange={(e) => void patch({ quietHours: { ...q, start: e.target.value } })} aria-label="Quiet hours start" />
                <span className="settings-hint">to</span>
                <input type="time" value={q.end} onChange={(e) => void patch({ quietHours: { ...q, end: e.target.value } })} aria-label="Quiet hours end" />
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** PASSKEYS (review desk): the phone's fingerprint, for approving RED items.
 *  The gateway stores only each passkey's PUBLIC key. The first one needs an
 *  enrollment window Michael opens from the box; every later one needs a
 *  fingerprint from one you already have — so a stolen login can't add its
 *  own. Removing one also asks for a fingerprint. */
function PasskeysSection() {
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

  async function add() {
    if (busy || !list) return;
    setBusy(true);
    setNote(null);
    const r = await addThisDevice(list.length > 0, !!enrollUntil);
    setBusy(false);
    if (r.ok) {
      setNote({ tone: "ok", text: `${r.value.passkey.label} added. RED items can now be approved with this fingerprint.` });
      load();
    } else {
      setNote({ tone: "err", text: r.error });
    }
  }

  async function remove(p: Passkey) {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const r = await removePasskey(p.id);
    setBusy(false);
    if (r.ok) {
      setNote({ tone: "ok", text: `${p.label} removed.` });
      load();
    } else setNote({ tone: "err", text: r.error });
  }

  const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
  const closedFirst = list !== null && list.length === 0 && !enrollUntil;

  return (
    <section className="settings-section" id="settings-passkeys">
      <div className="mono-label">PASSKEYS</div>
      <div className="settings-row">
        <span className="settings-hint">RED items — money, messages in your name, credentials — are approved with your fingerprint. The gateway checks it; the fingerprint never leaves the phone.</span>
      </div>
      {list === null ? (
        <div className="settings-row skeleton-card" />
      ) : (
        list.map((p) => (
          <div key={p.id} className="settings-row passkey-row">
            <span className="passkey-glyph"><IconFingerprint size={18} /></span>
            <span className="settings-bot-name">
              {p.label}
              <span className="passkey-meta mono-label">
                ADDED {day(p.created).toUpperCase()}
                {p.last_used ? ` · USED ${day(p.last_used).toUpperCase()}` : " · NOT USED YET"}
              </span>
            </span>
            <button className="segment passkey-remove" disabled={busy} onClick={() => void remove(p)}>
              Remove
            </button>
          </div>
        ))
      )}
      {list !== null && list.length === 0 && (
        <div className="settings-row">
          <span className="settings-hint">No passkey yet. Until there is one, RED items wait in Review and can't be approved in the app.</span>
        </div>
      )}
      {!supported ? (
        <div className="settings-row"><span className="settings-hint">This browser can't create passkeys. Use the installed app on your phone.</span></div>
      ) : (
        <>
          <button className="passkey-add" disabled={busy || closedFirst || list === null} onClick={() => void add()}>
            <IconFingerprint size={18} />
            {busy ? "Waiting for your fingerprint…" : list && list.length ? "Add this device" : "Add this phone's fingerprint"}
          </button>
          {enrollUntil ? (
            <div className="settings-row"><span className="settings-hint positive">Enrollment open until {new Date(enrollUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.</span></div>
          ) : closedFirst ? (
            <div className="settings-row"><span className="settings-hint">To add the first one, ask Michael to open enrollment. It stays open 15 minutes.</span></div>
          ) : null}
        </>
      )}
      {note && <div className={`settings-row passkey-note ${note.tone}`}><span>{note.text}</span></div>}
    </section>
  );
}

// Mirrors CLAUDE_MODEL_OPTIONS in src/claude-models.ts 1:1 (test/claude-models.test.ts
// fails on drift). Bare aliases label the model they normalize to.
export const MODEL_LABELS: Record<string, string> = {
  "claude-opus-5-5": "Opus 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-fable-5-1": "Fable 5.1",
  "claude-opus-5": "Opus 5",
  "claude-sonnet-5": "Sonnet 5",
  "claude-fable-5": "Fable 5",
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-4-7": "Opus 4.7",
  "claude-opus-4-6": "Opus 4.6",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-opus-4-5": "Opus 4.5 (legacy)",
  "claude-sonnet-4-5": "Sonnet 4.5 (legacy)",
  fable: "Fable 5.1",
  opus: "Opus 5.5",
  sonnet: "Sonnet 5.5",
  haiku: "Haiku 4.5",
};

/** Settings (design 1·6): a single centered 560px column with mono
 *  section labels — APPEARANCE (Light/Dark/System segmented), BOTS
 *  (model + voice, admin), ACCOUNT (quiet logout in warn, at the bottom).
 *  Theme + logout moved here from the chrome, per the design. */
export default function Settings() {
  const { user } = useAppState();
  const [mode, setMode] = useState<ThemeMode>(getThemeMode());
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (user?.admin) fetchSettings().then(setSettings);
    else fetchHealth().then(setHealth);
  }, [user?.admin]);

  function pickMode(next: ThemeMode) {
    setMode(next);
    applyThemeMode(next);
  }

  async function patchBot(bot: string, patch: { model?: string; voice?: string }) {
    if (await saveBotSetting(bot, patch)) {
      setSaved(bot + JSON.stringify(patch));
      setTimeout(() => setSaved(null), 1500);
      fetchSettings().then(setSettings);
    }
  }

  async function doLogout() {
    await logout();
    actions.loggedOut();
    try {
      localStorage.removeItem("ahi-web-snapshot-v1");
    } catch {}
  }

  return (
    <div className="settings-page">
      <section className="settings-section">
        <div className="mono-label">APPEARANCE</div>
        <div className="segmented" role="radiogroup" aria-label="Theme">
          {(["light", "dark", "system"] as ThemeMode[]).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              className={`segment${mode === m ? " active" : ""}`}
              onClick={() => pickMode(m)}
            >
              {m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <div className="mono-label">BOTS</div>
        {user?.admin && settings ? (
          settings.bots.map((bot) => (
            <div key={bot.name} className="settings-row">
              <span className="agent-dot" data-bot={bot.name} />
              <span className="settings-bot-name">{BOT_LABELS[bot.name] ?? bot.name}</span>
              <select value={bot.model} onChange={(e) => patchBot(bot.name, { model: e.target.value })}>
                {settings.availableModels.map((m) => (
                  <option key={m} value={m}>
                    {MODEL_LABELS[m] ?? m}
                  </option>
                ))}
              </select>
              <select value={bot.voice} onChange={(e) => patchBot(bot.name, { voice: e.target.value })}>
                {settings.voiceGroups
                  .filter((g) => !g.bots || g.bots.includes(bot.name))
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
              {saved?.startsWith(bot.name) && <span className="mono-label saved">SAVED</span>}
            </div>
          ))
        ) : health ? (
          health.bots.map((bot) => (
            <div key={bot.name} className="settings-row">
              <span className="agent-dot" data-bot={bot.name} />
              <span className="settings-bot-name">{BOT_LABELS[bot.name] ?? bot.name}</span>
              <span className="mono-label">{(MODEL_LABELS[bot.model] ?? bot.model).toUpperCase()}</span>
              <span className="mono-label positive">ONLINE</span>
            </div>
          ))
        ) : (
          <div className="settings-row skeleton-card" />
        )}
      </section>

      <NotificationsSection agents={user?.agents ?? []} />

      {user?.admin && <PasskeysSection />}

      <section className="settings-section">
        <div className="mono-label">ACCOUNT</div>
        <div className="settings-row">
          <span className="settings-bot-name">{user?.name}</span>
          <span className="mono-label">{user?.admin ? "ADMIN" : "MEMBER"}</span>
        </div>
        <button className="logout-btn" onClick={doLogout}>
          Log out
        </button>
      </section>
    </div>
  );
}
