/**
 * passkeys.ts — WebAuthn (passkey) registration + verification for RED.
 *
 * All verification is SERVER-SIDE through @simplewebauthn/server. The client
 * hands over the raw authenticator response and nothing it says about
 * itself is believed: no "verified" flag, no channel claim. A RED approval is
 * a valid assertion over a challenge this process issued, for this user,
 * for this exact item, within 5 minutes, used once, from a credential this
 * user registered, with user verification (the fingerprint) asserted, from
 * an allowed origin — or it is refused.
 *
 * Stored: credential id + PUBLIC key + signature counter + metadata. Never a
 * private key, never biometric data (that never leaves the phone).
 *
 * Enrollment is the soft spot of any passkey scheme: if a stolen session
 * token could register its own authenticator, the fingerprint would protect
 * nothing. So:
 *   - the FIRST passkey needs an enrollment window opened with the gateway's
 *     service token (`scripts/review.mjs enroll-open`), i.e. from the box;
 *   - every further passkey needs a fingerprint from an existing one first
 *     (or a fresh window, for a lost phone);
 *   - removal needs a fingerprint (or the service token).
 * Every add/remove is written to the decision log and pushed to the owner.
 */
import { APP_HOST, APP_URL } from "../app-url.js";
import { randomBytes } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { atomicWriteJson, ensureDir, safeSegment } from "../multi-user-paths.js";
import type { PasskeyEvidence } from "./types.js";

export interface PasskeyConfig {
  rpID: string;
  rpName: string;
  /** Exact origins a ceremony may come from (scheme + host + port). */
  origins: string[];
}

/**
 * The passkey RP ID is this install's own host (AHI_APP_URL), and the only allowed origin is the app's
 * own origin. A passkey is bound to its RP ID forever; this is the value to register under.
 */
export const RULED_RP_ID = APP_HOST;
export const RULED_ORIGINS: readonly string[] = [new URL(APP_URL).origin];

/**
 * REVIEW_WEBAUTHN_RP_ID / REVIEW_WEBAUTHN_ORIGINS exist only for isolated
 * runs under a DIFFERENT RP ID. Under the ruled RP ID the
 * allowlist cannot be widened: any other origin in the env is dropped, loudly.
 */
export function passkeyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PasskeyConfig {
  const rpID = (env.REVIEW_WEBAUTHN_RP_ID || RULED_RP_ID).trim();
  let origins = env.REVIEW_WEBAUTHN_ORIGINS
    ? env.REVIEW_WEBAUTHN_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : rpID === RULED_RP_ID
      ? [...RULED_ORIGINS]
      : [`https://${rpID}`];
  if (rpID === RULED_RP_ID) {
    const dropped = origins.filter((o) => !RULED_ORIGINS.includes(o));
    if (dropped.length) console.warn(`[review] passkey origins outside the ruled allowlist ignored: ${dropped.join(", ")}`);
    origins = origins.filter((o) => RULED_ORIGINS.includes(o));
    if (!origins.length) origins = [...RULED_ORIGINS];
  }
  return { rpID, rpName: "AHI", origins };
}

interface StoredPasskey {
  id: string;
  public_key: string;
  counter: number;
  transports: string[];
  device_type: string;
  backed_up: boolean;
  label: string;
  created: string;
  last_used: string | null;
}

interface UserPasskeys {
  webauthn_user_id: string;
  credentials: StoredPasskey[];
}

export interface PublicPasskey {
  id: string;
  label: string;
  created: string;
  last_used: string | null;
  device_type: string;
  backed_up: boolean;
}

export type Refusal = { ok: false; code: string; reason: string };
export type AssertionResult = { ok: true; evidence: PasskeyEvidence } | Refusal;

const CHALLENGE_TTL_MS = 5 * 60_000;
const ENROLL_GRANT_TTL_MS = 3 * 60_000;

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromB64u(s: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(s, "base64url");
  const out = new Uint8Array(new ArrayBuffer(buf.length));
  out.set(buf);
  return out;
}

function isAssertionShape(x: unknown): x is AuthenticationResponseJSON {
  const r = x as AuthenticationResponseJSON;
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.id === "string" &&
    typeof r.rawId === "string" &&
    r.type === "public-key" &&
    !!r.response &&
    typeof r.response.clientDataJSON === "string" &&
    typeof r.response.authenticatorData === "string" &&
    typeof r.response.signature === "string"
  );
}

function isRegistrationShape(x: unknown): x is RegistrationResponseJSON {
  const r = x as RegistrationResponseJSON;
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.id === "string" &&
    typeof r.rawId === "string" &&
    r.type === "public-key" &&
    !!r.response &&
    typeof r.response.clientDataJSON === "string" &&
    typeof r.response.attestationObject === "string"
  );
}

export class PasskeyService {
  private challenges = new Map<string, { challenge: string; expires: number }>();
  private enrollWindows = new Map<string, number>();
  private enrollGrants = new Map<string, number>();

  constructor(
    private readonly root: string,
    readonly config: PasskeyConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ── storage ────────────────────────────────────────────────────────────

  private path(userId: string): string {
    return join(this.root, "passkeys", `${safeSegment(userId, "unknown")}.json`);
  }

  private load(userId: string): UserPasskeys {
    const p = this.path(userId);
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      return { webauthn_user_id: raw.webauthn_user_id, credentials: Array.isArray(raw.credentials) ? raw.credentials : [] };
    }
    return { webauthn_user_id: b64u(randomBytes(32)), credentials: [] };
  }

  private save(userId: string, data: UserPasskeys): void {
    ensureDir(join(this.root, "passkeys"));
    atomicWriteJson(this.path(userId), data);
  }

  list(userId: string): PublicPasskey[] {
    return this.load(userId).credentials.map((c) => ({
      id: c.id,
      label: c.label,
      created: c.created,
      last_used: c.last_used,
      device_type: c.device_type,
      backed_up: c.backed_up,
    }));
  }

  count(userId: string): number {
    return this.load(userId).credentials.length;
  }

  // ── challenges (single use, bound to user + purpose) ───────────────────

  private key(userId: string, purpose: string): string {
    return `${userId}|${purpose}`;
  }

  private remember(userId: string, purpose: string, challenge: string): void {
    this.challenges.set(this.key(userId, purpose), { challenge, expires: this.now().getTime() + CHALLENGE_TTL_MS });
  }

  /** Take (and burn) the outstanding challenge — a failed attempt burns it too. */
  private take(userId: string, purpose: string): string | null {
    const k = this.key(userId, purpose);
    const c = this.challenges.get(k);
    this.challenges.delete(k);
    if (!c || c.expires < this.now().getTime()) return null;
    return c.challenge;
  }

  // ── enrollment gate ────────────────────────────────────────────────────

  /** Service-token only (the caller enforces that). */
  openEnrollment(userId: string, minutes = 15): Date {
    const until = this.now().getTime() + Math.min(Math.max(minutes, 1), 60) * 60_000;
    this.enrollWindows.set(userId, until);
    return new Date(until);
  }

  enrollmentOpenUntil(userId: string): Date | null {
    const until = this.enrollWindows.get(userId);
    if (!until || until < this.now().getTime()) return null;
    return new Date(until);
  }

  // ── authentication (fingerprint) ───────────────────────────────────────

  async authOptions(userId: string, purpose: string): Promise<PublicKeyCredentialRequestOptionsJSON | Refusal> {
    const data = this.load(userId);
    if (data.credentials.length === 0) {
      return { ok: false, code: "no-passkey", reason: "No passkey registered — add one in Settings → Passkeys" };
    }
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpID,
      userVerification: "required",
      allowCredentials: data.credentials.map((c) => ({ id: c.id, transports: c.transports as never })),
      timeout: 60_000,
    });
    this.remember(userId, purpose, options.challenge);
    return options;
  }

  async verifyAssertion(userId: string, purpose: string, response: unknown): Promise<AssertionResult> {
    // Burn the challenge first: a replayed response, or a second try with
    // the same one, finds nothing.
    const expectedChallenge = this.take(userId, purpose);
    if (!expectedChallenge) {
      return { ok: false, code: "no-challenge", reason: "No live fingerprint request for this — start again" };
    }
    if (!isAssertionShape(response)) {
      return { ok: false, code: "malformed", reason: "Not a passkey assertion" };
    }
    const data = this.load(userId);
    const cred = data.credentials.find((c) => c.id === response.id);
    if (!cred) {
      return { ok: false, code: "unknown-credential", reason: "That passkey isn't registered to you" };
    }
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.config.origins,
        expectedRPID: this.config.rpID,
        credential: { id: cred.id, publicKey: fromB64u(cred.public_key), counter: cred.counter, transports: cred.transports },
        requireUserVerification: true,
      });
    } catch (err) {
      return { ok: false, code: "verify-failed", reason: (err as Error).message };
    }
    const info = result.authenticationInfo;
    if (!result.verified || !info.userVerified) {
      return { ok: false, code: "verify-failed", reason: "Signature did not verify" };
    }
    cred.counter = info.newCounter;
    cred.last_used = this.now().toISOString();
    this.save(userId, data);
    return {
      ok: true,
      evidence: {
        credential_id: cred.id,
        verified: true,
        user_verified: info.userVerified,
        new_counter: info.newCounter,
        origin: info.origin,
        rp_id: info.rpID,
      },
    };
  }

  // ── registration ───────────────────────────────────────────────────────

  /**
   * Options for adding a passkey. `proof` = an assertion over an "enroll"
   * challenge from an EXISTING passkey; not needed while a service-opened
   * enrollment window is live.
   */
  async registrationOptions(
    userId: string,
    displayName: string,
    proof?: unknown,
  ): Promise<{ ok: true; options: PublicKeyCredentialCreationOptionsJSON; via: "window" | "fingerprint" } | Refusal> {
    const data = this.load(userId);
    let via: "window" | "fingerprint";
    if (this.enrollmentOpenUntil(userId)) {
      via = "window";
    } else if (data.credentials.length > 0 && proof !== undefined) {
      const r = await this.verifyAssertion(userId, "enroll", proof);
      if (!r.ok) return r;
      via = "fingerprint";
    } else if (data.credentials.length > 0) {
      return { ok: false, code: "needs-fingerprint", reason: "Confirm with a passkey you already have first" };
    } else {
      return {
        ok: false,
        code: "enrollment-closed",
        reason: "Adding your first passkey needs an enrollment window — ask Michael to open one (it lasts 15 minutes)",
      };
    }
    const options = await generateRegistrationOptions({
      rpName: this.config.rpName,
      rpID: this.config.rpID,
      userName: displayName,
      userDisplayName: displayName,
      userID: fromB64u(data.webauthn_user_id),
      attestationType: "none",
      excludeCredentials: data.credentials.map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
        authenticatorAttachment: "platform",
      },
      preferredAuthenticatorType: "localDevice",
      timeout: 120_000,
    });
    this.remember(userId, "register", options.challenge);
    // Grant lives with the challenge: one registration per proof/window use.
    this.enrollGrants.set(userId, this.now().getTime() + ENROLL_GRANT_TTL_MS);
    if (!data.credentials.length) this.save(userId, data); // pin webauthn_user_id
    return { ok: true, options, via };
  }

  async verifyRegistration(userId: string, response: unknown, label: string): Promise<{ ok: true; passkey: PublicPasskey } | Refusal> {
    const expectedChallenge = this.take(userId, "register");
    const grant = this.enrollGrants.get(userId);
    this.enrollGrants.delete(userId);
    if (!expectedChallenge || !grant || grant < this.now().getTime()) {
      return { ok: false, code: "no-challenge", reason: "Registration expired — start again" };
    }
    if (!isRegistrationShape(response)) {
      return { ok: false, code: "malformed", reason: "Not a passkey registration" };
    }
    let result;
    try {
      result = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.config.origins,
        expectedRPID: this.config.rpID,
        requireUserVerification: true,
      });
    } catch (err) {
      return { ok: false, code: "verify-failed", reason: (err as Error).message };
    }
    if (!result.verified) return { ok: false, code: "verify-failed", reason: "Registration did not verify" };
    const info = result.registrationInfo;
    const data = this.load(userId);
    if (data.credentials.some((c) => c.id === info.credential.id)) {
      return { ok: false, code: "duplicate", reason: "That passkey is already registered" };
    }
    const stored: StoredPasskey = {
      id: info.credential.id,
      public_key: b64u(info.credential.publicKey),
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      device_type: info.credentialDeviceType,
      backed_up: info.credentialBackedUp,
      label: (label || "Passkey").replace(/[^\p{L}\p{N} .'’_-]/gu, "").trim().slice(0, 40) || "Passkey",
      created: this.now().toISOString(),
      last_used: null,
    };
    data.credentials.push(stored);
    this.save(userId, data);
    this.enrollWindows.delete(userId); // a window admits one passkey
    return { ok: true, passkey: this.list(userId).find((p) => p.id === stored.id)! };
  }

  remove(userId: string, credentialId: string): boolean {
    const data = this.load(userId);
    const before = data.credentials.length;
    data.credentials = data.credentials.filter((c) => c.id !== credentialId);
    if (data.credentials.length === before) return false;
    this.save(userId, data);
    return true;
  }
}
