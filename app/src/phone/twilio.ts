/* ============================================================
   phone/twilio.ts — everything that speaks Twilio: request signatures, the
   caller gate, TwiML, and the four REST calls the phone leg makes.

   Pure functions and a thin fetch client. No sockets, no call state — those
   live in phone/stream.ts and phone/index.ts.

   CREDENTIALS. The account SID, auth token, Michael's number and the owner's cell
   live in the environment, or in the settings file named by TWILIO_ENV_FILE.
   They are read into this process's memory only — never copied into the
   gateway's .env, a log line, a test or a report. Values already in the
   environment win, so an isolated test instance can use a throwaway token.
   ============================================================ */

import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseEnv } from "dotenv";

export interface TwilioCreds {
  accountSid: string;
  authToken: string;
  /** Michael's number, E.164. */
  michaelNumber: string;
  /** the owner's cell, E.164. */
  ownerCell: string;
}

/**
 * The Twilio creds, or null if any are missing (the phone leg then stays
 * off). Environment first, then the secrets file.
 */
export function loadTwilioCreds(
  env: NodeJS.ProcessEnv = process.env,
  file: string = env.TWILIO_ENV_FILE || "",
): TwilioCreds | null {
  const pick = twilioSettings(env, file);
  const creds = {
    accountSid: pick("TWILIO_ACCOUNT_SID"),
    authToken: pick("TWILIO_AUTH_TOKEN"),
    michaelNumber: normalizePhone(pick("TWILIO_MICHAEL_NUMBER")),
    ownerCell: normalizePhone(pick("OWNER_CELL")),
  };
  if (!creds.accountSid || !creds.authToken || !creds.michaelNumber || !creds.ownerCell) return null;
  return creds;
}

/**
 * A reader for one Twilio setting: environment first, then the secrets file.
 * The file is read once per call of this function, values trimmed, "" when
 * missing.
 */
export function twilioSettings(
  env: NodeJS.ProcessEnv = process.env,
  file: string = env.TWILIO_ENV_FILE || "",
): (key: string) => string {
  let fromFile: Record<string, string> = {};
  try {
    if (existsSync(file)) fromFile = parseEnv(readFileSync(file));
  } catch {
    fromFile = {};
  }
  return (k: string) => (env[k] || fromFile[k] || "").trim();
}

/**
 * A US number in any common spelling → E.164 ("+19545551234"). Anything that
 * is not a plausible number comes back as "" so it can never match.
 */
export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const s = String(raw).trim();
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

// ── Request signatures ───────────────────────────────────────────────────

/**
 * X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + Σ sorted(key+value))).
 * `url` is the PUBLIC url Twilio requested (https://your-address/…, query
 * included), not the tunnel's internal http://127.0.0.1 one.
 */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string | string[]> = {},
): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    const v = params[key];
    for (const one of Array.isArray(v) ? [...v].sort() : [v]) data += key + one;
  }
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function validTwilioSignature(
  authToken: string,
  signature: string | null | undefined,
  url: string,
  params: Record<string, string | string[]> = {},
): boolean {
  if (!signature || !authToken) return false;
  const want = Buffer.from(twilioSignature(authToken, url, params));
  const got = Buffer.from(signature);
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * Read a Twilio form POST and check its signature against the PUBLIC url
 * Twilio requested (`publicBase` + the request's path and query — never the
 * tunnel's internal url). The params, or null when it is not from Twilio.
 */
export async function readSignedTwilioForm(
  req: { url: string; text(): Promise<string>; header(name: string): string | undefined },
  authToken: string,
  publicBase: string,
): Promise<Record<string, string> | null> {
  const raw = await req.text();
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v;
  const internal = new URL(req.url);
  const url = `${publicBase.replace(/\/+$/, "")}${internal.pathname}${internal.search}`;
  return validTwilioSignature(authToken, req.header("X-Twilio-Signature"), url, params) ? params : null;
}

// ── Who is on the line ───────────────────────────────────────────────────

export type CallerVerdict =
  /** the owner called Michael's number. Full Michael, after the passphrase. */
  | { kind: "owner-inbound" }
  /** Michael called the owner's cell (a call this gateway placed). */
  | { kind: "owner-outbound" }
  /** Anyone else. A polite line and a hang-up; customer routing is a later stage. */
  | { kind: "other"; reason: string };

/**
 * The From-gate. Only the owner's cell gets Michael: inbound when he calls the
 * number, outbound when the call is to his cell from the number. Everything
 * is compared in E.164.
 *
 * Caller ID is spoofable, so `owner-inbound` is NOT trusted on its own — the
 * stream holds OS context behind the spoken passphrase. An outbound call went
 * to the cell itself, so its other end is the phone in the owner's pocket.
 */
export function classifyCaller(
  params: Record<string, string>,
  creds: Pick<TwilioCreds, "michaelNumber" | "ownerCell">,
): CallerVerdict {
  const from = normalizePhone(params.From);
  const to = normalizePhone(params.To);
  const direction = (params.Direction || "").toLowerCase();
  if (!creds.ownerCell || !creds.michaelNumber) return { kind: "other", reason: "not configured" };
  if (direction.startsWith("outbound")) {
    if (to === creds.ownerCell && from === creds.michaelNumber) return { kind: "owner-outbound" };
    return { kind: "other", reason: "outbound to someone else" };
  }
  if (to && to !== creds.michaelNumber) return { kind: "other", reason: "not Michael's number" };
  if (from === creds.ownerCell) return { kind: "owner-inbound" };
  return { kind: "other", reason: "unknown caller" };
}

// ── TwiML ────────────────────────────────────────────────────────────────

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** A spoken line, then hang up. Twilio's own voice: no stream, no spend. */
export function sayAndHangupTwiml(line: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Say voice="Polly.Matthew">${xmlEscape(line)}</Say><Hangup/></Response>`
  );
}

/**
 * Bridge the call to the gateway's media stream. Twilio refuses query strings
 * on a Stream url, so the one-time ticket rides as a custom parameter and
 * comes back in the stream's `start` message.
 *
 * What happens when the stream closes is the instruction after `<Connect>`:
 * Twilio runs it only once the socket is gone. Without `redirectUrl` that is
 * `<Hangup/>` — a media socket that breaks ends the phone call (Twilio
 * alert 31903). With it, Twilio asks the gateway
 * what next on the SAME call, and the gateway answers with a fresh stream
 * that re-attaches to the call still running (voice step 2), or a hang-up
 * when the call is over.
 */
export function connectStreamTwiml(streamUrl: string, parameters: Record<string, string>, redirectUrl?: string): string {
  const ps = Object.entries(parameters)
    .map(([name, value]) => `<Parameter name="${xmlEscape(name)}" value="${xmlEscape(value)}"/>`)
    .join("");
  const after = redirectUrl ? `<Redirect method="POST">${xmlEscape(redirectUrl)}</Redirect>` : `<Hangup/>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Connect><Stream url="${xmlEscape(streamUrl)}">${ps}</Stream></Connect>${after}</Response>`
  );
}

/** End the call, silently: the answer to a re-attach request for a call that is over. */
export function hangupTwiml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
}

// ── REST ─────────────────────────────────────────────────────────────────

const API = "https://api.twilio.com/2010-04-01";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class TwilioRest {
  constructor(
    private readonly creds: Pick<TwilioCreds, "accountSid" | "authToken">,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async call<T>(method: "GET" | "POST", path: string, form?: Record<string, string>): Promise<T> {
    const auth = Buffer.from(`${this.creds.accountSid}:${this.creds.authToken}`).toString("base64");
    const res = await this.fetchImpl(`${API}/Accounts/${encodeURIComponent(this.creds.accountSid)}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) {
      // Twilio's error body names the problem (code + message), never a credential.
      let detail = text.slice(0, 200);
      try {
        const j = JSON.parse(text) as { code?: number; message?: string };
        detail = `${j.code ?? ""} ${j.message ?? ""}`.trim();
      } catch {
        /* keep the raw slice */
      }
      throw new Error(`twilio ${method} ${path.split("?")[0]} → ${res.status} ${detail}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Place a call. Returns the CallSid. */
  async createCall(opts: {
    to: string;
    from: string;
    url: string;
    statusCallback?: string;
    timeoutSec?: number;
  }): Promise<{ sid: string; status: string }> {
    const form: Record<string, string> = {
      To: opts.to,
      From: opts.from,
      Url: opts.url,
      Method: "POST",
      Timeout: String(opts.timeoutSec ?? 25),
    };
    if (opts.statusCallback) {
      form.StatusCallback = opts.statusCallback;
      form.StatusCallbackMethod = "POST";
    }
    const r = await this.call<{ sid: string; status: string }>("POST", "/Calls.json", form);
    return { sid: r.sid, status: r.status };
  }

  /** End a live call. */
  async hangup(callSid: string): Promise<void> {
    await this.call("POST", `/Calls/${encodeURIComponent(callSid)}.json`, { Status: "completed" });
  }

  async findNumber(e164: string): Promise<{
    sid: string;
    voiceUrl: string;
    voiceMethod: string;
    statusCallback: string;
    statusCallbackMethod: string;
  } | null> {
    const r = await this.call<{
      incoming_phone_numbers?: Array<{
        sid: string;
        voice_url: string;
        voice_method: string;
        status_callback: string;
        status_callback_method: string;
      }>;
    }>("GET", `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(e164)}`);
    const n = r.incoming_phone_numbers?.[0];
    return n
      ? {
          sid: n.sid,
          voiceUrl: n.voice_url ?? "",
          voiceMethod: n.voice_method ?? "",
          statusCallback: n.status_callback ?? "",
          statusCallbackMethod: n.status_callback_method ?? "",
        }
      : null;
  }

  /**
   * A recording's audio (mp3), fetched with the account's credentials. The url
   * comes from a webhook, so the credentials go ONLY to Twilio's own API host
   * over https — anything else is refused before a byte is sent.
   */
  async recordingAudio(recordingUrl: string): Promise<Buffer> {
    let u: URL;
    try {
      u = new URL(recordingUrl);
    } catch {
      throw new Error("twilio recording: not a url");
    }
    if (u.protocol !== "https:" || u.hostname !== "api.twilio.com" || !u.pathname.includes("/Recordings/")) {
      throw new Error(`twilio recording: refused a url outside api.twilio.com (${u.hostname})`);
    }
    if (!u.pathname.endsWith(".mp3")) u.pathname = u.pathname.replace(/\.(wav|json)$/, "") + ".mp3";
    const auth = Buffer.from(`${this.creds.accountSid}:${this.creds.authToken}`).toString("base64");
    const res = await this.fetchImpl(u.toString(), {
      method: "GET",
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`twilio recording → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async updateNumber(numberSid: string, fields: Record<string, string>): Promise<void> {
    await this.call("POST", `/IncomingPhoneNumbers/${encodeURIComponent(numberSid)}.json`, fields);
  }
}
