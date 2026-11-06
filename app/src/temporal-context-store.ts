/**
 * temporal-context-store.ts — the canonical, versioned per-user temporal
 * context record (§4.1a): home base kept separate from the zone a given
 * device/session is actually in, with consent, override scope, freshness and
 * confidence carried explicitly.
 *
 * Home lives in users.json (the existing per-user `timezone` /
 * `locationLabel`) until the user edits it through `setHome`. Observations
 * NEVER move home.
 *
 * Storage: `<gatewayStateRoot>/temporal/context-<user>.json`, atomic
 * rename-into-place, mode 0600. No coordinates are accepted at all — only a
 * coarse label — so there is no coordinate history to leak or delete.
 *
 * Nothing here enables location services or changes a live setting: with no
 * record on disk, every user resolves to their users.json home exactly as
 * before. Device/browser zone reporting from the PWA is a follow-up wiring
 * task; this module is the contract it will call.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";

import { DEFAULT_TIMEZONE, isValidTimeZone } from "./local-time.js";
import { safeSegment } from "./multi-user-paths.js";
import { sanitizeLabel, temporalDir } from "./temporal-events.js";

export type ObservationSource = "device" | "browser" | "location-service" | "ip-hint";

export interface ZoneObservation {
  zone: string;
  source: ObservationSource;
  deviceId?: string;
  observedAtUtc: string;
  /** Device zones need consent to apply (automatic mode) or an explicit confirm. */
  confirmed: boolean;
  /** Coarse label only ("Los Angeles, CA"); location-service observations only. */
  coarseLocation?: string;
}

export interface ZoneOverride {
  zone: string;
  /** `session` = one session/device only; `until` = until expiresAtUtc; `indefinite` = until cleared. */
  scope: "session" | "until" | "indefinite";
  sessionId?: string;
  deviceId?: string;
  setAtUtc: string;
  expiresAtUtc?: string;
}

export interface UserStatement {
  zone: string;
  /** What the user said about where they are ("in LA this week"), coarse. */
  locationLabel?: string;
  statedAtUtc: string;
  expiresAtUtc?: string;
}

export interface TemporalContextRecord {
  schema: 1;
  version: number;
  userId: string;
  updatedAtUtc: string;
  home: { zone: string; label?: string; source: "users.json" | "user-edit" };
  /** Consent to apply a validated device-zone change without asking. */
  automaticZone: boolean;
  /** Consent to keep coarse location-service observations. */
  locationConsent: boolean;
  override?: ZoneOverride;
  statement?: UserStatement;
  /** Latest observation per device (bounded); at most one ip-hint and one location-service entry. */
  observations: ZoneObservation[];
}

export interface HomeDefault {
  zone?: string | null;
  label?: string | null;
}

const MAX_DEVICES = 8;

function contextPath(userId: string): string {
  return join(temporalDir(), `context-${safeSegment(userId, "unknown")}.json`);
}

function isoNow(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function homeFrom(def: HomeDefault | undefined): TemporalContextRecord["home"] {
  const zone = isValidTimeZone(def?.zone ?? null) ? (def!.zone as string) : DEFAULT_TIMEZONE;
  return { zone, label: def?.label ?? undefined, source: "users.json" };
}

/** A fresh, unsaved record that reproduces today's behaviour (home only). */
export function defaultTemporalContext(userId: string, home?: HomeDefault, now?: Date): TemporalContextRecord {
  return {
    schema: 1,
    version: 0,
    userId: safeSegment(userId, "unknown"),
    updatedAtUtc: isoNow(now),
    home: homeFrom(home),
    automaticZone: false,
    locationConsent: false,
    observations: [],
  };
}

/**
 * Load fresh from disk every call (no cache — the hook is a new process per
 * turn, and a change must reach the very next turn of every agent). A missing
 * or unreadable record yields the users.json default; it never throws.
 */
export function loadTemporalContext(userId: string, home?: HomeDefault): TemporalContextRecord {
  const fallback = defaultTemporalContext(userId, home);
  try {
    const path = contextPath(userId);
    if (!existsSync(path)) return fallback;
    const rec = JSON.parse(readFileSync(path, "utf-8")) as TemporalContextRecord;
    if (!rec || rec.schema !== 1 || typeof rec.version !== "number") return fallback;
    // Home edits are explicit; until then users.json stays authoritative for home.
    if (rec.home?.source !== "user-edit") rec.home = fallback.home;
    if (!isValidTimeZone(rec.home?.zone)) rec.home = fallback.home;
    rec.observations = Array.isArray(rec.observations) ? rec.observations.filter((o) => isValidTimeZone(o?.zone)) : [];
    return rec;
  } catch {
    return fallback;
  }
}

function save(rec: TemporalContextRecord, now?: Date): TemporalContextRecord {
  const next = { ...rec, version: rec.version + 1, updatedAtUtc: isoNow(now) };
  const dir = temporalDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = contextPath(rec.userId);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return next;
}

function requireZone(zone: string): void {
  if (!isValidTimeZone(zone)) throw new Error(`invalid IANA timezone: ${JSON.stringify(zone)}`);
}

export interface ObserveResult {
  record: TemporalContextRecord;
  /** "applied" (auto mode), "needs-confirmation", "hint-only", "ignored-no-consent", "unchanged". */
  disposition: "applied" | "needs-confirmation" | "hint-only" | "ignored-no-consent" | "unchanged";
  /** Restrained user-facing notice, when one is warranted. */
  notice?: string;
}

/**
 * Record a zone observation for one device/session. Invalid zones throw
 * (caller rejects the request); nothing is written in that case.
 */
export function observeZone(
  userId: string,
  obs: { zone: string; source: ObservationSource; deviceId?: string; observedAt?: Date; coarseLocation?: string },
  home?: HomeDefault,
): ObserveResult {
  requireZone(obs.zone);
  const rec = loadTemporalContext(userId, home);
  const observedAtUtc = isoNow(obs.observedAt);
  const deviceId = sanitizeLabel(obs.deviceId, 40);

  if (obs.source === "location-service" && !rec.locationConsent) {
    return { record: rec, disposition: "ignored-no-consent" };
  }

  const others = rec.observations.filter((o) => {
    if (obs.source === "ip-hint") return o.source !== "ip-hint";
    if (obs.source === "location-service") return o.source !== "location-service";
    return !(o.deviceId === deviceId && (o.source === "device" || o.source === "browser"));
  });
  const prev = rec.observations.find((o) => !others.includes(o));

  if (obs.source === "ip-hint") {
    const next: ZoneObservation = { zone: obs.zone, source: "ip-hint", observedAtUtc, confirmed: false };
    return { record: save({ ...rec, observations: [...others, next] }), disposition: "hint-only" };
  }

  const zoneChanged = !prev || prev.zone !== obs.zone;
  const confirmed = obs.source === "location-service" ? true : rec.automaticZone ? true : prev?.zone === obs.zone && prev.confirmed;
  const next: ZoneObservation = {
    zone: obs.zone,
    source: obs.source,
    deviceId,
    observedAtUtc,
    confirmed,
    coarseLocation: obs.source === "location-service" ? sanitizeLabel(obs.coarseLocation, 60) : undefined,
  };
  const devices = [...others, next].slice(-MAX_DEVICES - 2);
  const saved = save({ ...rec, observations: devices });
  if (!zoneChanged) return { record: saved, disposition: "unchanged" };
  if (confirmed) return { record: saved, disposition: "applied", notice: "Timezone updated" };
  return {
    record: saved,
    disposition: "needs-confirmation",
    notice: `Your device reports ${obs.zone}. Use it for times on this device?`,
  };
}

/** The user said yes to a pending device zone. */
export function confirmDeviceZone(userId: string, deviceId: string, home?: HomeDefault): TemporalContextRecord {
  const rec = loadTemporalContext(userId, home);
  const id = sanitizeLabel(deviceId, 40);
  return save({
    ...rec,
    observations: rec.observations.map((o) => (o.deviceId === id && o.source !== "ip-hint" ? { ...o, confirmed: true } : o)),
  });
}

export function setManualOverride(
  userId: string,
  ov: { zone: string; scope: ZoneOverride["scope"]; sessionId?: string; deviceId?: string; expiresAt?: Date },
  home?: HomeDefault,
  now?: Date,
): TemporalContextRecord {
  requireZone(ov.zone);
  if (ov.scope === "until" && !ov.expiresAt) throw new Error("override scope 'until' needs expiresAt");
  if (ov.scope === "session" && !ov.sessionId && !ov.deviceId) throw new Error("override scope 'session' needs sessionId or deviceId");
  const rec = loadTemporalContext(userId, home);
  return save(
    {
      ...rec,
      override: {
        zone: ov.zone,
        scope: ov.scope,
        sessionId: sanitizeLabel(ov.sessionId, 64),
        deviceId: sanitizeLabel(ov.deviceId, 40),
        setAtUtc: isoNow(now),
        expiresAtUtc: ov.expiresAt?.toISOString(),
      },
    },
    now,
  );
}

export function clearOverride(userId: string, home?: HomeDefault): TemporalContextRecord {
  const rec = loadTemporalContext(userId, home);
  const { override: _drop, ...rest } = rec;
  return save(rest as TemporalContextRecord);
}

/** An explicit statement ("I'm in LA through Friday"). The strongest non-override signal. */
export function setUserStatement(
  userId: string,
  st: { zone: string; locationLabel?: string; expiresAt?: Date },
  home?: HomeDefault,
  now?: Date,
): TemporalContextRecord {
  requireZone(st.zone);
  const rec = loadTemporalContext(userId, home);
  return save(
    {
      ...rec,
      statement: {
        zone: st.zone,
        locationLabel: sanitizeLabel(st.locationLabel, 60),
        statedAtUtc: isoNow(now),
        expiresAtUtc: st.expiresAt?.toISOString(),
      },
    },
    now,
  );
}

export function clearUserStatement(userId: string, home?: HomeDefault): TemporalContextRecord {
  const rec = loadTemporalContext(userId, home);
  const { statement: _drop, ...rest } = rec;
  return save(rest as TemporalContextRecord);
}

/** Return home: clears statement and override; device observations are kept (they are per device). */
export function returnHome(userId: string, home?: HomeDefault): TemporalContextRecord {
  const rec = loadTemporalContext(userId, home);
  const { statement: _s, override: _o, ...rest } = rec;
  return save(rest as TemporalContextRecord);
}

export function setAutomaticZone(userId: string, enabled: boolean, home?: HomeDefault): TemporalContextRecord {
  const rec = loadTemporalContext(userId, home);
  return save({ ...rec, automaticZone: enabled });
}

/** Revoking location consent also deletes every stored location observation. */
export function setLocationConsent(userId: string, enabled: boolean, home?: HomeDefault): TemporalContextRecord {
  const rec = loadTemporalContext(userId, home);
  return save({
    ...rec,
    locationConsent: enabled,
    observations: enabled ? rec.observations : rec.observations.filter((o) => o.source !== "location-service"),
  });
}

export function deleteLocationObservations(userId: string, home?: HomeDefault): TemporalContextRecord {
  const rec = loadTemporalContext(userId, home);
  return save({ ...rec, observations: rec.observations.filter((o) => o.source !== "location-service" && o.source !== "ip-hint") });
}

/** Explicit home edit (onboarding / settings). The only path that changes home. */
export function setHome(userId: string, zone: string, label?: string, home?: HomeDefault): TemporalContextRecord {
  requireZone(zone);
  const rec = loadTemporalContext(userId, home);
  return save({ ...rec, home: { zone, label: sanitizeLabel(label, 60), source: "user-edit" } });
}

// ── Resolution ────────────────────────────────────────────────────────────────

export type ZoneSource = "override" | "statement" | "device" | "home" | "fallback";

export interface EffectiveZone {
  zone: string;
  source: ZoneSource;
  confidence: "high" | "medium" | "low";
  homeZone: string;
  homeLabel?: string;
  contextVersion: number;
  observedAtUtc?: string;
  /** Age of the observation that set the zone, when one did. */
  observationAgeMs?: number;
  stale: boolean;
  /** True when the zone could not be established and a default was used. */
  uncertain: boolean;
  /** Supported by a statement or consented location — a zone mismatch alone never is. */
  awayFromHomeSupported: boolean;
  /** Coarse current location, only when stated or consented. */
  currentLocation?: { label: string; source: "statement" | "location-service" };
  notes: string[];
}

export interface ResolveOptions {
  now?: Date;
  deviceId?: string | null;
  sessionId?: string | null;
  /** Observations older than this are stale (still used, but disclosed). Default 72h. */
  staleAfterMs?: number;
}

const DEFAULT_STALE_MS = 72 * 3_600_000;

function unexpired(expiresAtUtc: string | undefined, now: Date): boolean {
  if (!expiresAtUtc) return true;
  const t = Date.parse(expiresAtUtc);
  return !Number.isFinite(t) || t > now.getTime();
}

/**
 * Resolve the zone that governs THIS turn for THIS device/session.
 * Priority: manual override in scope → explicit statement → this device's
 * confirmed zone → (no device bound) all fresh confirmed devices agreeing →
 * home. IP hints never decide; they are reported only when they disagree.
 */
export function resolveEffectiveZone(rec: TemporalContextRecord, opts: ResolveOptions = {}): EffectiveZone {
  const now = opts.now ?? new Date();
  const staleAfter = opts.staleAfterMs ?? DEFAULT_STALE_MS;
  const notes: string[] = [];
  const base = {
    homeZone: rec.home.zone,
    homeLabel: rec.home.label,
    contextVersion: rec.version,
  };
  const deviceId = opts.deviceId ? sanitizeLabel(opts.deviceId, 40) : undefined;
  const consentedLocation = rec.locationConsent
    ? rec.observations.find((o) => o.source === "location-service" && o.coarseLocation)
    : undefined;

  const finish = (r: Omit<EffectiveZone, keyof typeof base | "notes" | "awayFromHomeSupported"> & { awayFromHomeSupported?: boolean }): EffectiveZone => {
    const ip = rec.observations.find((o) => o.source === "ip-hint");
    if (ip && ip.zone !== r.zone) notes.push(`IP-based hint suggests ${ip.zone} (weak signal, often a VPN) — not used`);
    const away = r.awayFromHomeSupported ?? false;
    if (r.zone !== rec.home.zone && !away) {
      notes.push("timezone differs from home; that alone does not mean the user traveled — do not say they are away");
    }
    return { ...base, ...r, awayFromHomeSupported: away, notes };
  };

  const ov = rec.override;
  if (ov && isValidTimeZone(ov.zone) && unexpired(ov.expiresAtUtc, now)) {
    const inScope =
      ov.scope !== "session" ||
      (ov.sessionId && opts.sessionId && ov.sessionId === opts.sessionId) ||
      (ov.deviceId && deviceId && ov.deviceId === deviceId);
    if (inScope) {
      return finish({ zone: ov.zone, source: "override", confidence: "high", observedAtUtc: ov.setAtUtc, stale: false, uncertain: false });
    }
  }

  const st = rec.statement;
  if (st && isValidTimeZone(st.zone) && unexpired(st.expiresAtUtc, now)) {
    return finish({
      zone: st.zone,
      source: "statement",
      confidence: "high",
      observedAtUtc: st.statedAtUtc,
      stale: false,
      uncertain: false,
      awayFromHomeSupported: Boolean(st.locationLabel) || st.zone !== rec.home.zone,
      currentLocation: st.locationLabel ? { label: st.locationLabel, source: "statement" } : undefined,
    });
  }

  const deviceObs = rec.observations.filter((o) => (o.source === "device" || o.source === "browser") && o.confirmed);
  const locationFields = (zone: string) =>
    consentedLocation && consentedLocation.zone === zone && consentedLocation.coarseLocation
      ? {
          awayFromHomeSupported: zone !== rec.home.zone,
          currentLocation: { label: consentedLocation.coarseLocation, source: "location-service" as const },
        }
      : {};

  const fromObservation = (o: ZoneObservation): EffectiveZone => {
    const age = Math.max(0, now.getTime() - Date.parse(o.observedAtUtc));
    const stale = age > staleAfter;
    if (stale) notes.push(`device zone was last confirmed ${Math.round(age / 3_600_000)}h ago (stale) — kept as the last valid zone`);
    return finish({
      zone: o.zone,
      source: "device",
      confidence: stale ? "low" : "medium",
      observedAtUtc: o.observedAtUtc,
      observationAgeMs: age,
      stale,
      uncertain: stale,
      ...locationFields(o.zone),
    });
  };

  if (deviceId) {
    const mine = deviceObs.find((o) => o.deviceId === deviceId);
    if (mine) return fromObservation(mine);
    const pending = rec.observations.find((o) => o.deviceId === deviceId && !o.confirmed && o.source !== "ip-hint");
    if (pending) notes.push(`this device reports ${pending.zone}, not yet confirmed — using home until confirmed`);
  } else {
    // Fresh observations decide; with none fresh, the stale ones are the
    // "last valid zone" — still used, but disclosed as stale.
    const fresh = deviceObs.filter((o) => now.getTime() - Date.parse(o.observedAtUtc) <= staleAfter);
    const pool = fresh.length ? fresh : deviceObs;
    const zones = new Set(pool.map((o) => o.zone));
    if (zones.size === 1 && pool.length) {
      const newest = [...pool].sort((a, b) => Date.parse(b.observedAtUtc) - Date.parse(a.observedAtUtc))[0];
      return fromObservation(newest);
    }
    if (zones.size > 1) {
      notes.push(`devices disagree (${[...zones].join(" vs ")}) and this turn is not bound to one — using home; ask only if it matters`);
      return finish({ zone: rec.home.zone, source: "home", confidence: "low", stale: false, uncertain: true });
    }
  }

  if (consentedLocation && consentedLocation.zone) {
    return finish({
      zone: consentedLocation.zone,
      source: "device",
      confidence: "medium",
      observedAtUtc: consentedLocation.observedAtUtc,
      stale: false,
      uncertain: false,
      ...locationFields(consentedLocation.zone),
    });
  }

  return finish({ zone: rec.home.zone, source: "home", confidence: "high", stale: false, uncertain: false });
}
