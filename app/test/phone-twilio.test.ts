/* phone-twilio.test.ts — request signatures, the From-gate, TwiML, creds, REST.
   No network: the REST client runs on a fake fetch. Every number and token
   below is invented for the test. */

import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  classifyCaller,
  connectStreamTwiml,
  loadTwilioCreds,
  normalizePhone,
  sayAndHangupTwiml,
  TwilioRest,
  twilioSignature,
  validTwilioSignature,
} from "../src/phone/twilio.js";

const TOKEN = "test-auth-token-not-real";
const URL_ = "https://ahi.example.test/api/phone/voice?ctx=abc";
const CREDS = { michaelNumber: "+16465550100", ownerCell: "+12125550199" };

describe("phone: Twilio request signatures", () => {
  const params = { CallSid: "CA00000000000000000000000000000001", From: "+12125550199", To: "+16465550100", Direction: "inbound" };

  it("is HMAC-SHA1 over the url then every key+value in key order, base64", () => {
    const by_hand =
      URL_ + "CallSid" + params.CallSid + "Direction" + params.Direction + "From" + params.From + "To" + params.To;
    const want = createHmac("sha1", TOKEN).update(by_hand).digest("base64");
    assert.equal(twilioSignature(TOKEN, URL_, params), want);
  });

  it("does not depend on the order the form arrived in", () => {
    const shuffled = { To: params.To, Direction: params.Direction, CallSid: params.CallSid, From: params.From };
    assert.equal(twilioSignature(TOKEN, URL_, shuffled), twilioSignature(TOKEN, URL_, params));
  });

  it("accepts the right signature and refuses every tampering", () => {
    const sig = twilioSignature(TOKEN, URL_, params);
    assert.equal(validTwilioSignature(TOKEN, sig, URL_, params), true);
    assert.equal(validTwilioSignature(TOKEN, sig, URL_, { ...params, From: "+13055550123" }), false, "spoofed From");
    assert.equal(validTwilioSignature(TOKEN, sig, URL_.replace("ctx=abc", "ctx=abd"), params), false, "other url");
    assert.equal(validTwilioSignature(TOKEN, sig, "http://127.0.0.1:18789/api/phone/voice?ctx=abc", params), false, "internal url");
    assert.equal(validTwilioSignature("another-token", sig, URL_, params), false, "other account");
    assert.equal(validTwilioSignature(TOKEN, undefined, URL_, params), false, "no header");
    assert.equal(validTwilioSignature(TOKEN, "", URL_, params), false, "empty header");
    assert.equal(validTwilioSignature(TOKEN, sig.slice(0, -2), URL_, params), false, "truncated");
    assert.equal(validTwilioSignature("", sig, URL_, params), false, "no token configured");
  });
});

describe("phone: the From-gate", () => {
  it("normalizes US numbers to E.164 and refuses junk", () => {
    assert.equal(normalizePhone("+1 (212) 555-0199"), "+12125550199");
    assert.equal(normalizePhone("212-555-0199"), "+12125550199");
    assert.equal(normalizePhone("12125550199"), "+12125550199");
    assert.equal(normalizePhone("anonymous"), "");
    assert.equal(normalizePhone("+266696687"), "+266696687");
    assert.equal(normalizePhone(""), "");
    assert.equal(normalizePhone(undefined), "");
  });

  it("the owner calling Michael's number is owner-inbound", () => {
    assert.deepEqual(classifyCaller({ From: "+12125550199", To: "+16465550100", Direction: "inbound" }, CREDS), { kind: "owner-inbound" });
  });

  it("anyone else calling is refused", () => {
    const v = classifyCaller({ From: "+13055550123", To: "+16465550100", Direction: "inbound" }, CREDS);
    assert.equal(v.kind, "other");
    assert.equal(classifyCaller({ From: "", To: "+16465550100", Direction: "inbound" }, CREDS).kind, "other", "withheld number");
    assert.equal(classifyCaller({ From: "Anonymous", To: "+16465550100", Direction: "inbound" }, CREDS).kind, "other");
  });

  it("the owner's cell calling some other number on the account is refused", () => {
    assert.equal(classifyCaller({ From: "+12125550199", To: "+18775550000", Direction: "inbound" }, CREDS).kind, "other");
  });

  it("Michael's own outbound call to the owner's cell is owner-outbound; to anyone else it is not", () => {
    assert.deepEqual(
      classifyCaller({ From: "+16465550100", To: "+12125550199", Direction: "outbound-api" }, CREDS),
      { kind: "owner-outbound" },
    );
    assert.equal(classifyCaller({ From: "+16465550100", To: "+13055550123", Direction: "outbound-api" }, CREDS).kind, "other");
  });

  it("is closed when not configured", () => {
    assert.equal(classifyCaller({ From: "+12125550199", To: "+16465550100" }, { michaelNumber: "", ownerCell: "" }).kind, "other");
  });
});

describe("phone: TwiML", () => {
  it("say-and-hang-up escapes the line", () => {
    const x = sayAndHangupTwiml(`Dana's <line> & "co"`);
    assert.match(x, /<Say voice="Polly\.Matthew">Dana&apos;s &lt;line&gt; &amp; &quot;co&quot;<\/Say><Hangup\/>/);
  });

  it("connect-stream carries the ticket as a custom parameter, then hangs up", () => {
    const x = connectStreamTwiml("wss://ahi.example.test/api/phone/stream", { ticket: "t&1" });
    assert.match(x, /<Connect><Stream url="wss:\/\/ahi\.example\.test\/api\/phone\/stream"><Parameter name="ticket" value="t&amp;1"\/><\/Stream><\/Connect><Hangup\/>/);
    assert.doesNotMatch(x, /stream\?/, "Twilio refuses query strings on a Stream url");
  });
});

describe("phone: creds", () => {
  const dir = mkdtempSync(join(tmpdir(), "phone-creds-"));
  const file = join(dir, "twilio.env");
  writeFileSync(
    file,
    "TWILIO_ACCOUNT_SID=AC_test_sid\nTWILIO_AUTH_TOKEN=file-token\nTWILIO_MICHAEL_NUMBER=+1 646 555 0100\nOWNER_CELL=212-555-0199\n",
  );

  it("loads from the secrets file and normalizes the numbers", () => {
    const c = loadTwilioCreds({}, file);
    assert.deepEqual(c, { accountSid: "AC_test_sid", authToken: "file-token", michaelNumber: "+16465550100", ownerCell: "+12125550199" });
  });

  it("environment wins over the file (an isolated instance uses a throwaway token)", () => {
    assert.equal(loadTwilioCreds({ TWILIO_AUTH_TOKEN: "env-token" }, file)?.authToken, "env-token");
  });

  it("is null when anything is missing — the line stays off", () => {
    assert.equal(loadTwilioCreds({}, join(dir, "absent.env")), null);
    assert.equal(loadTwilioCreds({ TWILIO_ACCOUNT_SID: "x", TWILIO_AUTH_TOKEN: "y", TWILIO_MICHAEL_NUMBER: "+16465550100" }, join(dir, "absent.env")), null);
  });
});

describe("phone: REST client (fake fetch)", () => {
  type Seen = { url: string; init: RequestInit };
  const fake = (status: number, body: unknown, seen: Seen[]) => async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  };

  it("places a call with basic auth and the right form", async () => {
    const seen: Seen[] = [];
    const rest = new TwilioRest({ accountSid: "AC123", authToken: "tok" }, fake(201, { sid: "CA999", status: "queued" }, seen));
    const r = await rest.createCall({ to: "+12125550199", from: "+16465550100", url: "https://x.test/api/phone/voice?ctx=1", statusCallback: "https://x.test/api/phone/status", timeoutSec: 20 });
    assert.deepEqual(r, { sid: "CA999", status: "queued" });
    assert.equal(seen[0].url, "https://api.twilio.com/2010-04-01/Accounts/AC123/Calls.json");
    assert.equal(seen[0].init.method, "POST");
    assert.equal((seen[0].init.headers as Record<string, string>).Authorization, `Basic ${Buffer.from("AC123:tok").toString("base64")}`);
    const form = new URLSearchParams(String(seen[0].init.body));
    assert.equal(form.get("To"), "+12125550199");
    assert.equal(form.get("From"), "+16465550100");
    assert.equal(form.get("Url"), "https://x.test/api/phone/voice?ctx=1");
    assert.equal(form.get("Method"), "POST");
    assert.equal(form.get("Timeout"), "20");
    assert.equal(form.get("StatusCallback"), "https://x.test/api/phone/status");
  });

  it("an error names Twilio's code and message, never the credential", async () => {
    const rest = new TwilioRest({ accountSid: "AC123", authToken: "secret-tok" }, fake(400, { code: 21211, message: "Invalid 'To' Phone Number" }, []));
    await assert.rejects(
      () => rest.createCall({ to: "x", from: "y", url: "u" }),
      (err: Error) => /21211 Invalid 'To' Phone Number/.test(err.message) && !err.message.includes("secret-tok"),
    );
  });

  it("finds and updates a number", async () => {
    const seen: Seen[] = [];
    const rest = new TwilioRest(
      { accountSid: "AC123", authToken: "tok" },
      fake(200, { incoming_phone_numbers: [{ sid: "PN1", voice_url: "https://old", voice_method: "POST", status_callback: "", status_callback_method: "GET" }] }, seen),
    );
    const n = await rest.findNumber("+16465550100");
    assert.deepEqual(n, { sid: "PN1", voiceUrl: "https://old", voiceMethod: "POST", statusCallback: "", statusCallbackMethod: "GET" });
    assert.match(seen[0].url, /IncomingPhoneNumbers\.json\?PhoneNumber=%2B16465550100$/);
    await rest.updateNumber("PN1", { VoiceUrl: "https://new" });
    assert.match(seen[1].url, /IncomingPhoneNumbers\/PN1\.json$/);
    assert.equal(new URLSearchParams(String(seen[1].init.body)).get("VoiceUrl"), "https://new");
  });
});
