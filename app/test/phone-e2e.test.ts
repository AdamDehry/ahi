/* ============================================================
   phone-e2e.test.ts — a phone call end to end, with a fake Twilio.

   REAL: the HTTP server, the Hono routes (phone/index.ts), Twilio request
   signatures, the TwiML, the WebSocket upgrade, the Media Streams protocol
   (phone/stream.ts), μ-law both ways, and the shared call core
   (websocket.ts openCall → composer → one dispatch point → call card).

   FAKE, at the edges only: Twilio itself (this file plays it: signs the
   webhook, opens the stream, sends μ-law, echoes or holds marks), the STT
   provider (stt-select's test seam), the line renderer `say` (a tone), the
   Twilio REST fetch, and the agent turn (a handler that speaks through the
   transport exactly the way index.ts does — TurnAudioSequencer over
   transport.audioOut). Nothing reaches the network or spawns Claude; the
   state roots point at a temp dir. Every token and number is invented.
   ============================================================ */

import { strict as assert } from "node:assert";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocket as WsClient } from "ws";
import type { UserConfig } from "../src/users.js";
import type { SttUsage } from "../src/voice/stt-cartesia.js";
import type { VoiceSttCallbacks, VoiceSttStream } from "../src/voice/stt-select.js";

const SANDBOX = mkdtempSync(join(tmpdir(), "ahi-phone-e2e-"));
process.env.AHI_GATEWAY_STATE_DIR = join(SANDBOX, "state");
process.env.AHI_GATEWAY_BUSINESS_DIR = join(SANDBOX, "business");
process.env.HOME = SANDBOX;

const ws = await import("../src/websocket.js");
const { __setVoiceSttFactoryForTests, __resetVoiceSttFactoryForTests } = await import("../src/voice/stt-select.js");
const { registerPhoneRoutes } = await import("../src/phone/index.js");
const { twilioSignature, TwilioRest } = await import("../src/phone/twilio.js");
const { hashPassphrase, writePassphrase } = await import("../src/phone/passphrase.js");
const { encodeMulaw } = await import("../src/phone/audio.js");
const { TurnAudioSequencer } = await import("../src/voice/turn-audio.js");

const BOT = "phonetestbot";
const AUTH = "phone-e2e-throwaway-auth-token";
const SVC = "phone-e2e-throwaway-service-token";
const PUBLIC = "https://ahi.example.test";
const CREDS = { accountSid: "AC_e2e", authToken: AUTH, michaelNumber: "+16465550100", ownerCell: "+12125550199" };
const PHRASE = "copper lantern seven";
const STREAM_URL = "wss://ahi.example.test/api/phone/stream";
const RETRY_LINE = "That's not it. Say it again, slowly, one word at a time.";
const DEADLINE_MS = 5_000;

const OWNER: UserConfig = {
  token: "phone-e2e-user-token-0000",
  name: "Dana",
  userId: "dana",
  telegramChatId: null,
  timezone: "America/New_York",
  locationLabel: "Austin, TX",
  agents: [BOT],
  admin: true,
};

// ── helpers ───────────────────────────────────────────────────────────

async function waitUntil(cond: () => boolean, what: string, ms = DEADLINE_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function tone(rate: number, seconds: number, freq = 440): Buffer {
  const n = Math.round(rate * seconds);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8_000 * Math.sin((2 * Math.PI * freq * i) / rate)), i * 2);
  return b;
}

class FakeStt implements VoiceSttStream {
  readonly provider = "cartesia" as const;
  readonly supportsPartials = true;
  readonly usage: SttUsage | null = null;
  readonly fed: Buffer[] = [];
  endUtterances = 0;
  closed = 0;
  constructor(private readonly cb: VoiceSttCallbacks) {}
  feed(frame: Buffer): void {
    this.fed.push(frame);
  }
  async endUtterance(): Promise<void> {
    this.endUtterances++;
  }
  async close(): Promise<SttUsage | null> {
    this.closed++;
    return null;
  }
  partial(text: string): void {
    this.cb.onSpeechStart?.();
    this.cb.onPartial?.(text);
  }
  /** One closed utterance; it commits after the composer's hold (finished sentences ~350 ms). */
  utterance(text: string): void {
    this.cb.onSpeechStart?.();
    this.cb.onSpeechEnd?.();
    this.cb.onTurnEnd?.(text, { sttMs: 80, audioSec: 1, nativeTurnEnd: true });
  }
}

/** Plays Twilio: one call's webhook + media stream. */
class FakeTwilio {
  readonly out: Array<Record<string, any>> = [];
  sock: WsClient | null = null;
  closeCode: number | null = null;
  /** Echo marks back at once (playback "finished"), or hold them (still playing). */
  echoMarks = true;
  readonly held: string[] = [];

  constructor(private readonly base: string) {
    clients.push(this);
  }

  async webhook(params: Record<string, string>, query = "", route = "/api/phone/voice"): Promise<{ status: number; body: string }> {
    const path = `${route}${query}`;
    const sig = twilioSignature(AUTH, `${PUBLIC}${path}`, params);
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig },
      body: new URLSearchParams(params).toString(),
    });
    return { status: res.status, body: await res.text() };
  }

  /** Open the media stream. `sig`: Twilio's handshake signature (default: the right one). */
  async connect(ticket: string, callSid: string, sig: string | null = twilioSignature(AUTH, STREAM_URL), streamSid = "MZ_e2e"): Promise<void> {
    const sock = new WsClient(`${this.base.replace("http", "ws")}/api/phone/stream`, {
      headers: sig === null ? {} : { "X-Twilio-Signature": sig },
    });
    this.sock = sock;
    sock.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      this.out.push(msg);
      if (msg.event === "mark") {
        if (this.echoMarks) this.send({ event: "mark", streamSid: "MZ_e2e", mark: msg.mark });
        else this.held.push(msg.mark.name);
      }
      if (msg.event === "clear") {
        // Twilio returns every outstanding mark after a clear.
        for (const name of this.held.splice(0)) this.send({ event: "mark", streamSid: "MZ_e2e", mark: { name } });
      }
    });
    sock.on("close", (code) => (this.closeCode = code));
    await once(sock, "open");
    this.send({ event: "connected", protocol: "Call", version: "1.0.0" });
    this.send({
      event: "start",
      sequenceNumber: "1",
      start: {
        streamSid,
        accountSid: CREDS.accountSid,
        callSid,
        tracks: ["inbound"],
        customParameters: { ticket },
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      },
      streamSid,
    });
  }

  send(msg: Record<string, unknown>): void {
    if (this.sock?.readyState === WsClient.OPEN) this.sock.send(JSON.stringify(msg));
  }

  media(ulaw: Buffer): void {
    this.send({ event: "media", streamSid: "MZ_e2e", media: { track: "inbound", chunk: "1", timestamp: "0", payload: ulaw.toString("base64") } });
  }

  of(event: string): Array<Record<string, any>> {
    return this.out.filter((m) => m.event === event);
  }

  /** Marks seen so far — one per line/turn played. */
  get marks(): number {
    return this.of("mark").length;
  }

  async stop(): Promise<void> {
    this.send({ event: "stop", streamSid: "MZ_e2e", stop: { callSid: "x" } });
  }
}

function ticketOf(twiml: string): string {
  const m = /<Parameter name="ticket" value="([^"]+)"\/>/.exec(twiml);
  assert.ok(m, `no ticket in ${twiml}`);
  return m![1];
}

// ── the rig ───────────────────────────────────────────────────────────

const stts: FakeStt[] = [];
/** Every fake call, so a failed test cannot leave a socket holding the process open. */
const clients: FakeTwilio[] = [];
const said: string[] = [];
const turns: any[] = [];
const interrupts: string[] = [];
const interruptReasons: Array<string | undefined> = [];
const records: any[] = [];
const restCalls: Array<{ url: string; body: URLSearchParams }> = [];
const logs: string[] = [];
/** The fake Twilio REST API; a test may swap it (slow, failing). */
const okRest = async (url: string, init: RequestInit) => {
  restCalls.push({ url, body: new URLSearchParams(String(init.body ?? "")) });
  return new Response(JSON.stringify({ sid: `CA_out_${restCalls.length}_${Date.now()}`, status: "queued" }), { status: 201 });
};
let restImpl: (url: string, init: RequestInit) => Promise<Response> = okRest;
let base = "";
let server: ReturnType<typeof serve>;
const passFile = join(SANDBOX, "state", "phone", "passphrase.json");
/** Every text offered for drafting (voice step 4). */
const drafts: string[] = [];

/** What index.ts does with a phone turn, minus the model: speak through the transport. */
function speakTurn(args: any, text: string, seconds = 0.5): void {
  const { transport, voiceStreamId, botName } = args;
  transport.event({ type: "voice-thinking", voiceStreamId, bot: botName });
  const seq = new TurnAudioSequencer(transport.audioOut({ voiceStreamId, bot: botName }), 24_000);
  transport.event({ type: "stream-chunk", streamId: voiceStreamId, chunk: text, voiceCall: voiceStreamId });
  seq.answerAudio(tone(24_000, seconds));
  seq.answerDone();
  ws.recordVoiceAgentTurn(voiceStreamId, text);
}

before(async () => {
  ws.setVoiceModeEnabled(BOT, true);
  ws.setVoiceTurnHandler((args) => {
    turns.push(args);
    speakTurn(args, "You have two meetings today.");
  });
  // Voice step 4: what the fast layer may draft on while he talks (voice/gate-draft.ts).
  ws.setVoiceDraftHandler((o) => drafts.push(o.text));
  ws.setVoiceInterruptHandler(({ voiceStreamId, reason }) => {
    interrupts.push(voiceStreamId);
    interruptReasons.push(reason);
  });
  ws.setVoiceSessionRecordHandler(({ record, user }) => records.push({ record, user: user.userId }));
  writePassphrase(passFile, hashPassphrase(PHRASE));

  const app = new Hono();
  const phone = registerPhoneRoutes(app, {
    creds: CREDS,
    publicUrl: PUBLIC,
    bot: BOT,
    user: () => OWNER,
    openCall: ws.openCall,
    say: async (text) => {
      said.push(text);
      return { pcm: tone(24_000, 0.1, 660), sampleRate: 24_000 };
    },
    passphraseFile: passFile,
    serviceToken: () => SVC,
    rest: new TwilioRest(CREDS, (url, init) => restImpl(url, init)),
    streamOptions: { startDeadlineMs: 300 },
    log: (l) => logs.push(l),
  });
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  server.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").startsWith("/api/phone/stream")) phone.handleUpgrade(req, socket as Socket, head);
    else socket.destroy();
  });
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  __resetVoiceSttFactoryForTests();
  // Keep-alive sockets from fetch() would otherwise hold the process open for seconds.
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  server?.close();
});

beforeEach(() => {
  stts.length = 0;
  said.length = 0;
  turns.length = 0;
  interrupts.length = 0;
  interruptReasons.length = 0;
  records.length = 0;
  restCalls.length = 0;
  logs.length = 0;
  restImpl = okRest;
  __setVoiceSttFactoryForTests((_bot, cb) => {
    const s = new FakeStt(cb);
    stts.push(s);
    return Promise.resolve(s);
  });
});

afterEach(() => {
  __resetVoiceSttFactoryForTests();
  for (const c of clients.splice(0)) c.sock?.terminate();
});

let callN = 0;
const nextSid = () => `CA_e2e_${++callN}_${Date.now()}`;

/** the owner calls; returns the open stream after the greeting has played. */
async function ownerCalls(): Promise<{ tw: FakeTwilio; stt: FakeStt; callSid: string }> {
  const callSid = nextSid();
  const tw = new FakeTwilio(base);
  const hook = await tw.webhook({ CallSid: callSid, From: CREDS.ownerCell, To: CREDS.michaelNumber, Direction: "inbound", AccountSid: CREDS.accountSid });
  assert.equal(hook.status, 200);
  await tw.connect(ticketOf(hook.body), callSid);
  await waitUntil(() => stts.length === 1, "the call's recognizer to open");
  await waitUntil(() => tw.marks >= 1, "the greeting to play");
  return { tw, stt: stts[0], callSid };
}

// ── the tests ─────────────────────────────────────────────────────────

describe("phone e2e: the webhook", () => {
  it("refuses an unsigned or mis-signed request", async () => {
    const res = await fetch(`${base}/api/phone/voice`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": "bogus" },
      body: new URLSearchParams({ CallSid: "CA1", From: CREDS.ownerCell, To: CREDS.michaelNumber }).toString(),
    });
    assert.equal(res.status, 403);
  });

  it("anyone but the owner hears a polite line and a hang-up — no stream, no ticket", async () => {
    const tw = new FakeTwilio(base);
    const r = await tw.webhook({ CallSid: nextSid(), From: "+13055550123", To: CREDS.michaelNumber, Direction: "inbound" });
    assert.equal(r.status, 200);
    assert.match(r.body, /<Say[^>]*>[^<]*This line is private\.[^<]*<\/Say><Hangup\/>/);
    assert.doesNotMatch(r.body, /<Stream|ticket/);
    assert.ok(!logs.join("\n").includes("3055550123"), "a caller's number is never logged");
  });

  it("the owner is bridged to the media stream with a one-time ticket", async () => {
    const tw = new FakeTwilio(base);
    const r = await tw.webhook({ CallSid: nextSid(), From: CREDS.ownerCell, To: CREDS.michaelNumber, Direction: "inbound" });
    assert.match(r.body, /<Connect><Stream url="wss:\/\/ahi\.example\.test\/api\/phone\/stream"><Parameter name="ticket" value="[^"]{20,}"\/><\/Stream><\/Connect><Redirect method="POST">https:\/\/ahi\.example\.test\/api\/phone\/reattach<\/Redirect>/);
  });
});

describe("phone e2e: the stream", () => {
  it("a stream without a valid ticket is closed before it is heard", async () => {
    const tw = new FakeTwilio(base);
    await tw.connect("forged-ticket", nextSid());
    await waitUntil(() => tw.closeCode !== null, "the server to close the stream");
    assert.equal(tw.closeCode, 4403);
    assert.equal(stts.length, 0, "no recognizer opened, nothing billed");
  });

  it("a ticket works once, and only for its own call", async () => {
    const callSid = nextSid();
    const tw = new FakeTwilio(base);
    const r = await tw.webhook({ CallSid: callSid, From: CREDS.ownerCell, To: CREDS.michaelNumber, Direction: "inbound" });
    const ticket = ticketOf(r.body);
    const wrongCall = new FakeTwilio(base);
    await wrongCall.connect(ticket, nextSid());
    await waitUntil(() => wrongCall.closeCode !== null, "the mismatched call to be refused");
    assert.equal(wrongCall.closeCode, 4403);
    // The mismatch did not burn it for the right call...
    await tw.connect(ticket, callSid);
    await waitUntil(() => stts.length === 1, "the right call to open");
    // ...but a replay is refused.
    const replay = new FakeTwilio(base);
    await replay.connect(ticket, callSid);
    await waitUntil(() => replay.closeCode !== null, "the replay to be refused");
    assert.equal(replay.closeCode, 4403);
    await tw.stop();
    await waitUntil(() => stts[0].closed === 1, "the call to finish hanging up");
  });
});

describe("phone e2e: the owner calls Michael", () => {
  it("passphrase gate → full turn → μ-law reply → barge-in → call card", async () => {
    const consoleLines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      consoleLines.push(a.map(String).join(" "));
    };
    try {
      const { tw, stt, callSid } = await ownerCalls();
      assert.deepEqual(said, ["Michael here. Passphrase?"]);

      // The greeting arrives as Twilio wants it: 20 ms μ-law frames, then a mark.
      const media = tw.of("media");
      assert.ok(media.length >= 4, "0.1 s of greeting is five frames");
      for (const m of media) {
        assert.equal(m.streamSid, "MZ_e2e");
        assert.equal(Buffer.from(m.media.payload, "base64").length, 160);
      }

      // Uplink: one 20 ms μ-law frame (160 bytes) becomes 20 ms of 16 kHz PCM (640 bytes).
      tw.media(encodeMulaw(tone(8_000, 0.02)));
      await waitUntil(() => stt.fed.length === 1, "caller audio to reach the recognizer");
      assert.equal(stt.fed[0].length, 640);

      // Wrong passphrase: no turn, a retry line.
      stt.utterance("Purple monkey dishwasher.");
      await waitUntil(() => said.length === 2 && tw.marks === 2, "the retry line to play");
      assert.equal(said[1], RETRY_LINE);
      assert.equal(turns.length, 0, "a locked call never reaches the agent");

      // Right passphrase: unlocked, still no turn.
      stt.utterance("It's copper lantern seven.");
      // Wait for the line's MARK, not just the render: its frames must all be in before the reply is counted.
      await waitUntil(() => said.length === 3 && tw.marks === 3, "the unlocked line to play");
      assert.equal(said[2], "Got it. Go ahead, Dana.");
      assert.equal(turns.length, 0, "the passphrase itself is not a turn");

      // A real turn reaches the agent through the phone transport.
      const marksBefore = tw.marks;
      const mediaBefore = tw.of("media").length;
      stt.utterance("What's on my calendar today?");
      await waitUntil(() => turns.length === 1, "the agent turn");
      assert.equal(turns[0].transcript, "What's on my calendar today?");
      assert.equal(turns[0].transport.kind, "phone");
      assert.equal(turns[0].voiceStreamId, `phone-${callSid}`);
      assert.equal(turns[0].user.userId, "dana");
      const hints = turns[0].transport.turnHints();
      assert.match(hints.extraSystemHint, /PHONE CALL\. Dana called your phone number and passed the spoken passphrase\./);
      assert.match(hints.extraSystemHint, /no deleting, deploying/);
      assert.ok(hints.disallowedTools.includes("Bash(rm:*)"));
      assert.ok(hints.disallowedTools.every((t: string) => !t.includes(" ")), "deny patterns stay one CLI token");

      // The reply comes back as μ-law: 0.5 s at 8 kHz = 25 frames, then its mark.
      await waitUntil(() => tw.marks === marksBefore + 1, "the reply's mark");
      const replyFrames = tw.of("media").length - mediaBefore;
      assert.ok(replyFrames >= 24 && replyFrames <= 26, `reply frames ${replyFrames}`);

      // Barge-in. Hold marks so Michael is "still playing".
      tw.echoMarks = false;
      stt.utterance("And tomorrow?");
      await waitUntil(() => turns.length === 2, "the second turn");
      await waitUntil(() => tw.held.length === 1, "the second reply to be playing");
      // Backchannel and his own words (speakerphone echo) do not cut him off.
      stt.partial("yeah");
      stt.partial("two meetings");
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(tw.of("clear").length, 0, "no barge-in on backchannel or echo");
      assert.equal(interrupts.filter((i) => i === `phone-${callSid}`).length, 0);
      // Real words do.
      stt.partial("Wait, hold on");
      await waitUntil(() => tw.of("clear").length === 1, "Twilio to be told to clear");
      assert.deepEqual(interrupts.filter((i) => i === `phone-${callSid}`), [`phone-${callSid}`], "the call core's interrupt fired");
      await waitUntil(() => tw.held.length === 0, "marks to be returned after the clear");
      tw.echoMarks = true;

      // Hang-up: the server writes the call card.
      await tw.stop();
      await waitUntil(() => records.length === 1, "the call card");
      // The hang-up stopped the agent too (blocker 4): an interrupt with reason "hangup".
      assert.deepEqual(interruptReasons.slice(-1), ["hangup"]);
      const { record, user } = records[0];
      assert.equal(user, "dana");
      assert.equal(record.channel, "phone");
      assert.equal(record.direction, "inbound");
      assert.equal(record.turns, 2);
      assert.deepEqual(
        record.transcript.map((t: any) => t.role),
        ["user", "agent", "user", "agent"],
      );
      assert.equal(record.transcript[0].text, "What's on my calendar today?");
      await waitUntil(() => stt.closed === 1, "the recognizer to close");

      // The passphrase never left a trace: not in the card, not in a log line.
      const everything = JSON.stringify(record) + consoleLines.join("\n") + logs.join("\n");
      for (const w of ["copper", "lantern", "Purple monkey"]) assert.ok(!everything.includes(w), `"${w}" leaked`);
      // Nor to the fast layer's drafts: nothing is drafted while the passphrase is owed; real turns are (voice step 4).
      for (const w of ["copper", "lantern", "Purple monkey"]) assert.ok(!drafts.join("\n").includes(w), `"${w}" drafted`);
      assert.ok(drafts.includes("What's on my calendar today?"), "a real turn is drafted before it commits");
    } finally {
      console.log = origLog;
    }
  });

  it("three wrong passphrases end the call", async () => {
    const { tw, stt } = await ownerCalls();
    for (const guess of ["red fox", "blue fox", "green fox"]) {
      const n = said.length;
      stt.utterance(guess);
      await waitUntil(() => said.length === n + 1, `a reply to ${guess}`);
    }
    assert.equal(said.at(-1), "I can't open this line. Goodbye.");
    await waitUntil(() => tw.closeCode !== null, "the server to end the call");
    assert.equal(turns.length, 0);
    assert.equal(records.length, 0, "a call that never opened writes no card");
  });

  it("with no passphrase set, the owner's call is refused at the webhook", async () => {
    const { renameSync } = await import("node:fs");
    renameSync(passFile, `${passFile}.away`);
    try {
      const tw = new FakeTwilio(base);
      const r = await tw.webhook({ CallSid: nextSid(), From: CREDS.ownerCell, To: CREDS.michaelNumber, Direction: "inbound" });
      assert.match(r.body, /line isn&apos;t set up yet/);
      assert.doesNotMatch(r.body, /<Stream/);
    } finally {
      renameSync(`${passFile}.away`, passFile);
    }
  });
});

describe("phone e2e: Michael calls the owner", () => {
  it("POST /api/phone/call needs the service token", async () => {
    const res = await fetch(`${base}/api/phone/call`, { method: "POST", body: "{}" });
    assert.equal(res.status, 401);
    const wrong = await fetch(`${base}/api/phone/call`, { method: "POST", headers: { Authorization: "Bearer nope" }, body: "{}" });
    assert.equal(wrong.status, 401);
  });

  it("places the call, opens with the reason, skips the passphrase, and rate-limits", async () => {
    const res = await fetch(`${base}/api/phone/call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "The phone build is done." }),
    });
    assert.equal(res.status, 200);
    const out = (await res.json()) as { callSid: string };
    assert.equal(restCalls.length, 1);
    const form = restCalls[0].body;
    assert.equal(form.get("To"), CREDS.ownerCell);
    assert.equal(form.get("From"), CREDS.michaelNumber);
    assert.equal(form.get("Timeout"), "20");
    assert.equal(form.get("StatusCallback"), `${PUBLIC}/api/phone/status`);
    const url = new URL(form.get("Url")!);
    assert.equal(`${url.origin}${url.pathname}`, `${PUBLIC}/api/phone/voice`);

    // Twilio fetches the webhook when the owner answers.
    const tw = new FakeTwilio(base);
    const hook = await tw.webhook(
      { CallSid: out.callSid, From: CREDS.michaelNumber, To: CREDS.ownerCell, Direction: "outbound-api" },
      url.search,
    );
    await tw.connect(ticketOf(hook.body), out.callSid);
    await waitUntil(() => said.length === 1, "the opening line");
    // One greeting, no self-introduction: he has caller ID (voice-speed, 10/27).
    assert.equal(said[0], "Hey Dana. The phone build is done.");
    const stt = stts[0];

    // No passphrase on a call Michael placed to the cell: the first words are a turn.
    stt.utterance("Great, what changed?");
    await waitUntil(() => turns.length === 1, "the agent turn");
    assert.match(turns[0].transport.turnHints().extraSystemHint, /placed this call to Dana's cell about: The phone build is done\./);
    // The turn knows what he already heard, so it never greets again.
    assert.match(turns[0].transport.turnHints().extraSystemHint, /You already opened the call by saying: "Hey Dana\. The phone build is done\."\. It was heard\. Do not greet again/);

    // A second call inside a minute is refused (a loop must not ring him all night).
    const again = await fetch(`${base}/api/phone/call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SVC}` },
      body: "{}",
    });
    assert.equal(again.status, 429);

    await tw.stop();
    await waitUntil(() => records.length === 1, "the call card");
    assert.equal(records[0].record.direction, "outbound");
  });

  it("the status callback is signed too", async () => {
    const res = await fetch(`${base}/api/phone/status`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=CA1&CallStatus=no-answer",
    });
    assert.equal(res.status, 403);
    const params = { CallSid: "CA_status_1", CallStatus: "no-answer", Direction: "outbound-api" };
    const ok = await fetch(`${base}/api/phone/status`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": twilioSignature(AUTH, `${PUBLIC}/api/phone/status`, params) },
      body: new URLSearchParams(params).toString(),
    });
    assert.equal(ok.status, 204);
    assert.ok(logs.some((l) => /status no-answer/.test(l)));
  });
});

// ── review fixes (10/14) ──────────────────────────────────────────────

/** Routes only (no server): a fresh rig with its own quota and contexts. */
function routesOnly(over: Record<string, unknown> = {}) {
  const app = new Hono();
  registerPhoneRoutes(app, {
    creds: CREDS,
    publicUrl: PUBLIC,
    bot: BOT,
    user: () => OWNER,
    openCall: ws.openCall,
    say: async () => ({ pcm: tone(24_000, 0.1), sampleRate: 24_000 }),
    passphraseFile: passFile,
    serviceToken: () => SVC,
    rest: new TwilioRest(CREDS, (url, init) => restImpl(url, init)),
    minOutboundGapMs: 0,
    log: (l) => logs.push(l),
    ...over,
  } as any);
  const call = (body: unknown = {}) =>
    app.request("http://gw.test/api/phone/call", {
      method: "POST",
      headers: { Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const webhook = (params: Record<string, string>, query = "") => {
    const path = `/api/phone/voice${query}`;
    return app.request(`http://gw.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": twilioSignature(AUTH, `${PUBLIC}${path}`, params) },
      body: new URLSearchParams(params).toString(),
    });
  };
  return { call, webhook };
}

const outboundParams = (CallSid: string) => ({ CallSid, From: CREDS.michaelNumber, To: CREDS.ownerCell, Direction: "outbound-api" });

describe("phone e2e: review fixes — stream admission", () => {
  async function rawStream(headers: Record<string, string>): Promise<{ status?: number; closeCode?: number; sock: WsClient }> {
    const sock = new WsClient(`${base.replace("http", "ws")}/api/phone/stream`, { headers });
    return new Promise((resolve) => {
      sock.once("unexpected-response", (_req, res) => resolve({ status: res.statusCode, sock }));
      sock.once("open", () => resolve({ sock }));
      sock.once("error", () => resolve({ sock }));
    });
  }

  it("a handshake with no Twilio signature, or a wrong one, is refused before the upgrade", async () => {
    const none = await rawStream({});
    assert.equal(none.status, 403);
    const wrong = await rawStream({ "X-Twilio-Signature": twilioSignature("not-the-token", STREAM_URL) });
    assert.equal(wrong.status, 403);
    assert.ok(logs.some((l) => /REFUSED a media-stream handshake with NO signature/.test(l)));
    assert.ok(logs.some((l) => /REFUSED a media-stream handshake with a WRONG signature/.test(l)));
  });

  it("a signed socket that never sends start is closed on the deadline", async () => {
    const r = await rawStream({ "X-Twilio-Signature": twilioSignature(AUTH, STREAM_URL) });
    clients.push({ sock: r.sock } as any);
    const [code] = (await once(r.sock, "close")) as [number];
    assert.equal(code, 4408);
    assert.equal(stts.length, 0);
  });

  it("valid JSON that is not a Twilio event closes that connection instead of throwing", async () => {
    for (const junk of ["null", "42", "[]", "{}"]) {
      const r = await rawStream({ "X-Twilio-Signature": twilioSignature(AUTH, STREAM_URL) });
      clients.push({ sock: r.sock } as any);
      r.sock.send(junk);
      const [code] = (await once(r.sock, "close")) as [number];
      assert.equal(code, 4400, `${junk} closes with 4400`);
    }
  });
});

describe("phone e2e: review fixes — outbound", () => {
  it("an outbound webhook needs a live context: none, unknown, or another call's → polite hang-up", async () => {
    const rig = routesOnly();
    const placed = await rig.call({ reason: "Test." });
    assert.equal(placed.status, 200);
    const { callSid } = (await placed.json()) as { callSid: string };
    const query = new URL(restCalls[0].body.get("Url")!).search;

    const noCtx = await (await rig.webhook(outboundParams("CA_replay_1"))).text();
    assert.match(noCtx, /can&apos;t be connected/);
    assert.doesNotMatch(noCtx, /<Stream/);
    const unknown = await (await rig.webhook(outboundParams("CA_replay_2"), "?ctx=forged")).text();
    assert.match(unknown, /can&apos;t be connected/);
    // The context was bound to Michael's call when it was placed: another CallSid cannot use it.
    const otherCall = await (await rig.webhook(outboundParams("CA_replay_3"), query)).text();
    assert.match(otherCall, /can&apos;t be connected/);

    // The real call gets its stream...
    const real = await (await rig.webhook(outboundParams(callSid), query)).text();
    assert.match(real, /<Stream/);
    // ...and Twilio's retry of that same webhook gets the SAME answer — no fresh ticket.
    const retry = await (await rig.webhook(outboundParams(callSid), query)).text();
    assert.equal(retry, real);
    assert.ok(logs.some((l) => /webhook retry — same answer/.test(l)));
  });

  it("the quota is reserved before Twilio is asked: three at once place exactly one call", async () => {
    restImpl = async (url, init) => {
      await new Promise((r) => setTimeout(r, 100));
      return okRest(url, init);
    };
    const rig = routesOnly({ maxOutboundPerDay: 1 });
    const statuses = (await Promise.all([rig.call(), rig.call(), rig.call()])).map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 429, 429]);
    assert.equal(restCalls.length, 1, "one paid call, not three");
  });

  it("a call Twilio refuses gives its slot back", async () => {
    restImpl = async () => new Response(JSON.stringify({ code: 21211, message: "Invalid 'To' Phone Number" }), { status: 400 });
    const rig = routesOnly({ maxOutboundPerDay: 1 });
    assert.equal((await rig.call()).status, 502);
    restImpl = okRest;
    assert.equal((await rig.call()).status, 200, "the failed attempt did not use up the day");
  });
});

describe("phone e2e: review fixes — the passphrase", () => {
  it("said again slowly, across turns, the passphrase is heard (rolling buffer)", async () => {
    const { tw, stt } = await ownerCalls();
    stt.utterance("Copalanthen 7.");
    await waitUntil(() => said.length === 2, "the retry line");
    assert.equal(said[1], RETRY_LINE);
    stt.utterance("Copper.");
    await waitUntil(() => said.length === 3, "a second retry");
    assert.equal(said[2], RETRY_LINE, "one word is not the phrase");
    stt.utterance("Lantern seven.");
    await waitUntil(() => said.length === 4, "the unlocked line");
    assert.equal(said[3], "Got it. Go ahead, Dana.", "copper + lantern seven, across two turns");
    assert.equal(turns.length, 0);
    stt.utterance("What's next on the list?");
    await waitUntil(() => turns.length === 1, "a real turn after unlocking");
    assert.equal(turns[0].transcript, "What's next on the list?");
    await tw.stop();
  });

  it("goodbye is terminal: the right passphrase after the third miss does not unlock", async () => {
    const { tw, stt } = await ownerCalls();
    for (const guess of ["red fox", "blue fox", "green fox"]) {
      const n = said.length;
      stt.utterance(guess);
      await waitUntil(() => said.length === n + 1, `a reply to ${guess}`);
    }
    stt.utterance("Copper lantern seven.");
    await waitUntil(() => tw.closeCode !== null, "the call to end");
    assert.ok(!said.includes("Got it. Go ahead, Dana."), "no unlock during goodbye");
    assert.equal(turns.length, 0);
  });
});

describe("phone e2e: the call outlives its stream (voice step 2)", () => {
  const OWNER_IN = (callSid: string) => ({ CallSid: callSid, From: CREDS.ownerCell, To: CREDS.michaelNumber, Direction: "inbound", AccountSid: CREDS.accountSid });

  /** Twilio's <Redirect> after the stream closed: POST /api/phone/reattach on the same call. */
  async function redirect(tw: FakeTwilio, callSid: string) {
    return tw.webhook(OWNER_IN(callSid), "", "/api/phone/reattach");
  }

  async function unlocked(): Promise<{ tw: FakeTwilio; stt: FakeStt; callSid: string }> {
    const call = await ownerCalls();
    call.stt.utterance("Copper lantern seven.");
    await waitUntil(() => said.includes("Got it. Go ahead, Dana.") && call.tw.marks >= 2, "the unlocked line");
    return call;
  }

  it("a broken stream re-attaches on the same call: same session, no opener, no passphrase again, one card", async () => {
    const consoleLines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      consoleLines.push(a.map(String).join(" "));
    };
    try {
      const { tw, stt, callSid } = await unlocked();
      stt.utterance("What's on my calendar today?");
      await waitUntil(() => turns.length === 1 && tw.marks >= 3, "the first turn's reply");
      const saidBefore = said.length;

      // The media socket breaks under the call (31903's shape: no stop, no hang-up).
      tw.sock!.terminate();
      await waitUntil(() => logs.some((l) => l.includes("parked: media stream closed")), "the call to park");
      assert.equal(records.length, 0, "no card: the call did not end");
      assert.equal(stt.closed, 0, "the recognizer stays open");
      assert.ok(logs.some((l) => l.startsWith("[door]") && l.includes(" phone closed code=1006")), "the step-0 door line still says why");

      // Twilio's redirect: a fresh ticket, and the redirect again behind it.
      const r = await redirect(tw, callSid);
      assert.equal(r.status, 200);
      assert.match(r.body, /<Connect><Stream url="wss:\/\/ahi\.example\.test\/api\/phone\/stream"><Parameter name="ticket" value="[^"]{20,}"\/><\/Stream><\/Connect><Redirect method="POST">https:\/\/ahi\.example\.test\/api\/phone\/reattach<\/Redirect>/);

      const tw2 = new FakeTwilio(base);
      await tw2.connect(ticketOf(r.body), callSid, undefined, "MZ_e2e_2");
      await waitUntil(() => logs.some((l) => l.includes("re-attached on a new stream (#1")), "the re-attach");
      assert.equal(stts.length, 1, "no second recognizer: the same call");
      assert.equal(said.length, saidBefore, "no opener, no passphrase prompt on re-attach");

      // Still unlocked: his next words are a turn, and the reply goes out on the NEW stream.
      stt.utterance("And tomorrow?");
      await waitUntil(() => turns.length === 2 && tw2.marks >= 1, "the reply on the new stream");
      assert.ok(tw2.of("media").every((m) => m.streamSid === "MZ_e2e_2"), "frames carry the new streamSid");

      await tw2.stop();
      await waitUntil(() => records.length === 1, "one call card");
      assert.equal(records[0].record.turns, 2, "both halves of the call on one card");
      const end = consoleLines.find((l) => l.startsWith(`[call-end] phone-${callSid}`)) ?? "";
      assert.match(end, /by=phone why=caller-hung-up/);
      assert.match(end, /resumed=1 gap=\d+s/);
      // After the call is over, a redirect gets a hang-up.
      const late = await redirect(tw2, callSid);
      assert.match(late.body, /<Response><Hangup\/><\/Response>/);
      assert.doesNotMatch(late.body, /<Stream/);
    } finally {
      console.log = origLog;
    }
  });

  it("what Michael says while the stream is down is held and played on the new one", async () => {
    const { tw, stt, callSid } = await unlocked();
    tw.sock!.terminate();
    await waitUntil(() => logs.some((l) => l.includes("parked: media stream closed")), "the call to park");
    // A turn lands while no stream is attached (his words were in before the break).
    stt.utterance("Read me the first one.");
    await waitUntil(() => turns.length === 1, "the turn, while parked");
    await new Promise((r) => setTimeout(r, 30));
    const r = await redirect(tw, callSid);
    const tw2 = new FakeTwilio(base);
    await tw2.connect(ticketOf(r.body), callSid, undefined, "MZ_e2e_3");
    await waitUntil(() => tw2.marks >= 1, "the held reply, then its mark");
    const frames = tw2.of("media").length;
    assert.ok(frames >= 24 && frames <= 26, `the whole 0.5 s reply arrived (${frames} frames)`);
    // Since voice step 3 a reply that STARTS while the door is shut waits for it in the
    // call's mouth (never a second lane behind the one that was on air) rather than in
    // the transport's hold: it goes on air right after the re-attach.
    assert.ok(logs.some((l) => /re-attached on a new stream \(#1, gap [\d.]+s, total [\d.]+s\): replayed \d+ frame/.test(l)));
    await tw2.stop();
    await waitUntil(() => records.length === 1, "the card");
  });

  it("a locked call keeps its passphrase state across a re-attach", async () => {
    const { tw, stt, callSid } = await ownerCalls();
    stt.utterance("Purple monkey.");
    await waitUntil(() => said.length === 2, "the retry line");
    tw.sock!.terminate();
    await waitUntil(() => logs.some((l) => l.includes("parked: media stream closed")), "the call to park");
    const r = await redirect(tw, callSid);
    const tw2 = new FakeTwilio(base);
    await tw2.connect(ticketOf(r.body), callSid, undefined, "MZ_e2e_4");
    await waitUntil(() => logs.some((l) => l.includes("re-attached on a new stream")), "the re-attach");
    assert.equal(said.length, 2, "no fresh greeting");
    stt.utterance("Still nothing.");
    await waitUntil(() => said.length === 3, "a reply to the next guess");
    assert.equal(turns.length, 0, "still locked: nothing reached the agent");
    stt.utterance("Copper lantern seven.");
    await waitUntil(() => said.includes("Got it. Go ahead, Dana."), "unlocked on the new stream");
    await tw2.stop();
  });

  it("a re-attach ticket works once, and only for its own call", async () => {
    const { tw, callSid } = await unlocked();
    tw.sock!.terminate();
    await waitUntil(() => logs.some((l) => l.includes("parked: media stream closed")), "the call to park");
    const ticket = ticketOf((await redirect(tw, callSid)).body);
    const wrong = new FakeTwilio(base);
    await wrong.connect(ticket, nextSid(), undefined, "MZ_e2e_w");
    await waitUntil(() => wrong.closeCode !== null, "a re-attach ticket on another CallSid to be refused");
    assert.equal(wrong.closeCode, 4403);
    const tw2 = new FakeTwilio(base);
    await tw2.connect(ticket, callSid, undefined, "MZ_e2e_r");
    await waitUntil(() => logs.some((l) => l.includes("re-attached on a new stream")), "the right stream to re-attach");
    const replay = new FakeTwilio(base);
    await replay.connect(ticket, callSid, undefined, "MZ_e2e_x");
    await waitUntil(() => replay.closeCode !== null, "a replayed re-attach ticket to be refused");
    assert.equal(replay.closeCode, 4403);
    assert.equal(tw2.closeCode, null, "the replay did not disturb the live stream");
    await tw2.stop();
  });

  it("re-attaches are bounded: past the limit, the redirect is a hang-up", async () => {
    const { tw, callSid } = await unlocked();
    tw.sock!.terminate();
    await waitUntil(() => logs.some((l) => l.includes("parked: media stream closed")), "the call to park");
    // Twilio's redirect, over and over — a stream that never connects.
    for (let i = 0; i < 5; i++) assert.match((await redirect(tw, callSid)).body, /<Stream/, `re-attach ${i + 1} allowed`);
    const sixth = await redirect(tw, callSid);
    assert.match(sixth.body, /<Response><Hangup\/><\/Response>/);
    assert.ok(logs.some((l) => l.includes("out of re-attaches")));
    // Twilio then says the call completed: the waiting call ends now.
    const st = await tw.webhook({ ...OWNER_IN(callSid), CallStatus: "completed", CallDuration: "40" }, "", "/api/phone/status");
    assert.equal(st.status, 204);
    await waitUntil(() => logs.some((l) => l.includes(`phone-${callSid} ended: call completed`)), "the waiting call to end when the call completed");
    await waitUntil(() => stts[0].closed === 1, "its recognizer to close");
  });

  it("an unsigned redirect is refused, and a redirect for an unknown call is a hang-up", async () => {
    const res = await fetch(`${base}/api/phone/reattach`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": "bogus" },
      body: new URLSearchParams(OWNER_IN("CA_nope")).toString(),
    });
    assert.equal(res.status, 403);
    const tw = new FakeTwilio(base);
    const r = await redirect(tw, "CA_never_seen");
    assert.match(r.body, /<Response><Hangup\/><\/Response>/);
  });

  it("a re-attach ticket for a call that is over is refused at the stream", async () => {
    const { tw, callSid } = await unlocked();
    tw.sock!.terminate();
    await waitUntil(() => logs.some((l) => l.includes("parked: media stream closed")), "the call to park");
    const r = await redirect(tw, callSid);
    // The call completes before the new stream arrives.
    await tw.webhook({ ...OWNER_IN(callSid), CallStatus: "completed" }, "", "/api/phone/status");
    await waitUntil(() => logs.some((l) => l.includes(`phone-${callSid} ended: call completed`)), "the call to end");
    const tw2 = new FakeTwilio(base);
    await tw2.connect(ticketOf(r.body), callSid, undefined, "MZ_e2e_5");
    await waitUntil(() => tw2.closeCode !== null, "the stream to be closed");
    assert.equal(tw2.closeCode, 4410);
    assert.equal(stts.length, 1, "no new call opened from a re-attach ticket");
  });
});
