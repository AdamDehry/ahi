import { useEffect, useSyncExternalStore } from "react";
/**
 * push.ts — client side of Web Push (Step 8).
 *
 * Subscribe/unsubscribe THIS device and read/write the user's
 * notification settings (per-agent on/off, sound, vibration, quiet
 * hours — stored and enforced server-side). Same-origin cookie auth,
 * like everything in lib/api.ts.
 *
 * iOS reality: push works only for installed-to-home-screen PWAs
 * (16.4+), and Notification.requestPermission MUST come from a user
 * gesture — subscribeThisDevice is called from the Settings toggle tap.
 */

export interface PushQuietHours {
  enabled: boolean;
  start: string;
  end: string;
  tz: string;
}

export type SourcePrefs = Record<string, { enabled: boolean; events: Record<string, boolean> }>;
export interface NotifySource { id: string; name: string; icon: string; blurb: string; events: Array<{ id: string; label: string; on: boolean }> }

/** Server-enforced (src/push.ts): `enabled` = device delivery, `inApp` = the bell, `sources` per app and activity. */
export interface PushSettings {
  enabled: boolean;
  inApp: boolean;
  perAgent: Record<string, boolean>;
  sources: SourcePrefs;
  sound: boolean;
  tone: string;
  vibration: boolean;
  quietHours: PushQuietHours;
  urgent: boolean;
  deviceCount?: number;
}
export type PushSettingsPatch = Partial<Omit<PushSettings, "sources" | "quietHours">> & {
  sources?: Record<string, { enabled?: boolean; events?: Record<string, boolean> }>;
  quietHours?: Partial<PushQuietHours>;
};

export type PushSupport = "ok" | "needs-install" | "unsupported";

/** Can this browser do Web Push right now? */
export function pushSupport(): PushSupport {
  const hasApis = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (hasApis) return "ok";
  // iOS Safari BROWSER tab: no Push API until installed to Home Screen.
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone = window.matchMedia("(display-mode: standalone)").matches
    || (navigator as { standalone?: boolean }).standalone === true;
  if (isIOS && !standalone) return "needs-install";
  return "unsupported";
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  return "Notification" in window ? Notification.permission : "unsupported";
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) arr[i] = raw.charCodeAt(i);
  return arr;
}

/** Is this device currently subscribed? */
export async function isSubscribed(): Promise<boolean> {
  if (pushSupport() !== "ok") return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    return (await reg.pushManager.getSubscription()) !== null;
  } catch {
    return false;
  }
}

/**
 * Subscribe THIS device. Must be called from a user gesture (the
 * permission prompt requires it on iOS). Returns an error string for the
 * UI, or null on success.
 */
export async function subscribeThisDevice(): Promise<string | null> {
  if (pushSupport() !== "ok") {
    return pushSupport() === "needs-install"
      ? "Install the app to your Home Screen first (Share → Add to Home Screen)."
      : "This browser does not support push notifications.";
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return "Notification permission was not granted. Enable it in the phone's settings for this app.";
  }
  const keyRes = await fetch("/app/push/vapid-public-key");
  if (!keyRes.ok) return "The gateway has no push keys configured.";
  const { key } = (await keyRes.json()) as { key: string };

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    } catch (err) {
      return `Subscription failed: ${(err as Error).message}`;
    }
  }
  const res = await fetch("/app/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });
  if (!res.ok) return "The gateway rejected the subscription.";
  return null;
}

/** Unsubscribe THIS device (other devices keep their subscriptions). */
export async function unsubscribeThisDevice(): Promise<void> {
  if (pushSupport() !== "ok") return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await fetch("/app/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    /* best-effort — a dead subscription gets pruned server-side anyway */
  }
}

export interface PushSettingsView { settings: PushSettings; configured: boolean; sources: NotifySource[]; tones: string[] }
export async function fetchPushSettings(): Promise<PushSettingsView | null> {
  try {
    const res = await fetch("/app/push/settings", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as PushSettingsView;
  } catch {
    return null;
  }
}

export async function savePushSettings(patch: PushSettingsPatch): Promise<PushSettings | null> {
  try {
    const res = await fetch("/app/push/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { settings: PushSettings };
    return data.settings;
  } catch {
    return null;
  }
}

/* The signed-in user's notification preferences, shared with the bell (In-app, app choices, sound + tone). */
let prefs: PushSettings | null = null;
let loading = false;
const prefSubs = new Set<() => void>();
export function pushPrefsChanged(next: PushSettings | null): void {
  prefs = next;
  prefSubs.forEach((f) => f());
}
/** Current preferences (null until loaded); `key` (the session) reloads them when the user changes. */
export function usePushPrefs(key: string): PushSettings | null {
  const v = useSyncExternalStore((f) => (prefSubs.add(f), () => prefSubs.delete(f)), () => prefs);
  useEffect(() => {
    if (loading) return;
    loading = true;
    pushPrefsChanged(null);
    void fetchPushSettings().then((r) => {
      loading = false;
      pushPrefsChanged(r?.settings ?? null);
    });
  }, [key]);
  return v;
}
