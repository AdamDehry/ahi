/* ============================================================
   phone-stream.test.ts — PhoneStream's own state machine, on a fake socket.

   The review fixes that live inside one call (10/14): a barge-in leaves no
   stale mark behind, a line rendering across a barge-in is dropped, a turn
   whose closing mark never comes back stops counting as audible, and
   goodbye is terminal (a passphrase check that lands during it is void; the
   goodbye itself is capped). Everything around the stream is faked; the
   passphrase check is the real scrypt one.
   ============================================================ */

import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { PhoneStream, type PhoneStreamOptions } from "../src/phone/stream.js";
import { hashPassphrase, matchesPassphrase, type PassphraseRecord } from "../src/phone/passphrase.js";
import type { CallTransport } from "../src/voice/call-transport.js";

const REC = hashPassphrase("copper lantern seven");

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Array<Record<string, any>> = [];
  closeCode: number | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code: number) {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closeCode = code;
    this.emit("close", code);
  }
  in(msg: Record<string, unknown>) {
    this.emit("message", Buffer.from(JSON.stringify(msg)), false);
  }
  of(event: string) {
    return this.sent.filter((m) => m.event === event);
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rig(
  opts: {
    direction?: "inbound" | "outbound";
    options?: Partial<PhoneStreamOptions>;
    say?: (text: string) => Promise<{ pcm: Buffer; sampleRate: number }>;
    checkPassphrase?: (heard: string, rec: PassphraseRecord) => Promise<boolean>;
  } = {},
) {
  const ws = new FakeWs();
  let clock = 1_000_000;
  const said: string[] = [];
  const logs: string[] = [];
  const interrupts: number[] = [];
  let transport!: CallTransport;
  let intercept!: (text: string) => boolean;
  const stream = new PhoneStream(ws as any, {
    claimTicket: (_t, callSid) => ({ callSid, direction: opts.direction ?? "outbound" }),
    openCall: (t, o) => {
      transport = t;
      intercept = o.interceptTurn!;
      return {
        voiceStreamId: o.voiceStreamId,
        audio() {},
        async endUtterance() {},
        interrupt: () => interrupts.push(1),
        async hangup() {},
      };
    },
    say:
      opts.say ??
      (async (text) => {
        said.push(text);
        return { pcm: Buffer.alloc(1_600), sampleRate: 8_000 }; // 0.1 s of silence
      }),
    passphrase: () => REC,
    checkPassphrase: opts.checkPassphrase,
    options: opts.options,
    log: (l) => logs.push(l),
    now: () => clock,
  });
  ws.in({ event: "start", start: { streamSid: "MZ1", callSid: "CA1", customParameters: { ticket: "t" } } });
  return {
    ws,
    stream,
    said,
    logs,
    interrupts,
    get transport() {
      return transport;
    },
    get intercept() {
      return intercept;
    },
    tick: (ms: number) => (clock += ms),
    /** Michael says something: a turn's downlink with audio, not yet done. */
    speak(seconds = 0.5) {
      const out = transport.audioOut({ voiceStreamId: "phone-CA1", bot: "michael" });
      out.start(8_000);
      out.frame(Buffer.alloc(Math.round(8_000 * seconds) * 2));
      return out;
    },
    bargeIn: () => transport.event({ type: "stt-interim", text: "wait stop that" }),
  };
}

/**
 * Passphrase checks the test releases by hand. Each check's verdict is the
 * real matcher's over the words it was handed; it only lands when the test
 * says so, so "words arrive while a check is running" is reproduced on
 * purpose, not by timing.
 */
function heldChecks() {
  const held: Array<{ heard: string; release: () => Promise<void> }> = [];
  const check = (heard: string, rec: PassphraseRecord) => {
    const d = deferred<boolean>();
    held.push({
      heard,
      release: async () => {
        d.resolve(await matchesPassphrase(heard, rec));
        await new Promise((r) => setImmediate(r)); // the result handler has run
      },
    });
    return d.promise;
  };
  return { held, check };
}

describe("phone stream: barge-in and marks", () => {
  it("after a barge-in the next reply counts as audible from its first frame — a second barge-in works", async () => {
    const r = rig();
    await sleep(5); // the greeting
    r.speak();
    assert.equal(r.stream.playing, true);
    r.bargeIn();
    assert.equal(r.ws.of("clear").length, 1);
    assert.equal(r.stream.playing, false);
    r.speak(); // the next reply, still streaming (no done yet)
    assert.equal(r.stream.playing, true, "a fresh mark, not the cut reply's stale one");
    r.bargeIn();
    assert.equal(r.ws.of("clear").length, 2, "the second barge-in is not ignored");
    assert.equal(r.interrupts.length, 2);
  });

  it("a line still rendering when he barges in is dropped, not spoken after the clear", async () => {
    const pending = deferred<{ pcm: Buffer; sampleRate: number }>();
    let calls = 0;
    const r = rig({ say: () => (++calls === 1 ? Promise.resolve({ pcm: Buffer.alloc(1_600), sampleRate: 8_000 }) : pending.promise) });
    await sleep(5);
    r.speak();
    const line = r.stream.sayLine("One more thing.");
    r.bargeIn();
    const afterClear = r.ws.sent.length;
    pending.resolve({ pcm: Buffer.alloc(3_200), sampleRate: 8_000 });
    await line;
    assert.equal(r.ws.sent.slice(afterClear).filter((m) => m.event === "media").length, 0);
  });

  it("a turn whose closing mark never comes (synthesis died) stops counting as audible", async () => {
    const r = rig();
    await sleep(5);
    r.speak(0.5); // no done(): the TTS error path
    assert.equal(r.stream.playing, true);
    r.tick(0.5 * 1_000 + 4_000);
    assert.equal(r.stream.playing, true, "within playback + 5 s it still counts");
    r.tick(2_000);
    assert.equal(r.stream.playing, false, "past it, the reserved mark is dropped");
    r.bargeIn();
    assert.equal(r.ws.of("clear").length, 0, "nothing to cut");
  });

  it("the idle watchdog re-arms while he is audible, then asks — and only silence after the question says goodbye", async () => {
    const r = rig({ options: { idleMs: 30, idleConfirmMs: 30 } });
    await sleep(5);
    r.speak(0.5); // stuck: no done()
    await sleep(45);
    assert.ok(!r.said.includes("Still with me?"), "not while audible");
    r.tick(10_000);
    await sleep(45);
    assert.ok(r.said.includes("Still with me?"), "the watchdog was not lost — and idle is a question now (voice step 2)");
    assert.ok(!r.said.includes("I'll let you go. Bye."), "the question is not a hang-up");
    r.tick(10_000); // the question's own (markless) audio is past
    await sleep(80);
    assert.ok(r.said.includes("I'll let you go. Bye."), "no sound from him after the question: goodbye");
  });
});

describe("phone stream: goodbye is terminal", () => {
  it("a passphrase check that lands during goodbye does not unlock", async () => {
    const r = rig({ direction: "inbound" });
    await sleep(5);
    assert.equal(r.stream.isLocked, true);
    assert.equal(r.intercept("Copper lantern seven."), true); // the (real, async) check starts
    void r.stream.sayThenHangup("Goodbye.");
    await sleep(400); // the scrypt check finishes inside this
    assert.ok(!r.said.includes("Got it. Go ahead."));
    assert.equal(r.stream.isLocked, true);
    assert.equal(r.intercept("Copper lantern seven."), true, "and later turns are still consumed");
  });

  it("the goodbye is capped: a line that never renders still ends the call", async () => {
    let calls = 0;
    const r = rig({
      options: { goodbyeCapMs: 50 },
      say: () => (++calls === 1 ? Promise.resolve({ pcm: Buffer.alloc(160), sampleRate: 8_000 }) : new Promise(() => {})),
    });
    await sleep(5);
    void r.stream.sayThenHangup("Bye.");
    await sleep(100);
    assert.equal(r.ws.closeCode, 1000);
  });
});

describe("phone stream: one mouth (voice step 3)", () => {
  it("goodbye during a reply still being synthesized: the reply is cut and cleared, the goodbye plays, and its own mark ends the call — not the cap (Codex P2)", async () => {
    const r = rig({ options: { goodbyeCapMs: 5_000 } });
    await sleep(5);
    r.tick(1_000); // the opener played out
    const reply = r.speak(0.5); // synthesis still running: no done, its mark not sent
    const bye = r.stream.sayThenHangup("Bye.");
    await sleep(5);
    assert.ok(r.ws.of("clear").length >= 1, "Twilio's buffer cleared");
    assert.ok(r.said.includes("Bye."));
    reply.frame(Buffer.alloc(1_600)); // the cut reply keeps synthesizing: nothing more of it leaves
    const marks = r.ws.of("mark");
    const last = marks[marks.length - 1];
    r.ws.in({ event: "mark", mark: { name: last.mark.name } });
    await bye;
    assert.ok(r.logs.some((l) => l.includes("ended: we hung up")), r.logs.join("\n"));
    assert.ok(!r.logs.some((l) => l.includes("goodbye cap")));
  });

  it("an error line said during a reply waits for the reply instead of shredding it (two downlinks never interleave)", async () => {
    const r = rig();
    await sleep(5);
    r.tick(1_000);
    const reply = r.speak(0.4);
    r.transport.event({ type: "voice-error", error: "My voice dropped." });
    await sleep(5);
    const before = r.ws.of("media").length;
    reply.frame(Buffer.alloc(8_000 * 0.2 * 2));
    reply.done();
    assert.equal(r.ws.of("media").length - before, 10, "the reply's frames, uninterrupted");
    r.tick(5_000); // the reply played out; the mouth's own timer re-checks the (fake) clock
    const t0 = Date.now();
    while (!r.said.includes("My voice dropped.") && Date.now() - t0 < 3_000) await sleep(10);
    assert.ok(r.said.includes("My voice dropped."));
  });
});

describe("phone stream: the passphrase buffer", () => {
  it("is capped at the last 16 words heard, and cleared on unlock", async () => {
    const { held, check } = heldChecks();
    const r = rig({ direction: "inbound", checkPassphrase: check });
    await sleep(5);
    r.intercept("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen");
    await held[0].release();
    const buf = (r.stream as any).heardWhileLocked as string[];
    assert.equal(buf.length, 16);
    assert.equal(buf[0], "2", "the oldest word fell off");
    r.intercept("copper lantern seven");
    await held[1].release();
    assert.equal(r.stream.isLocked, false);
    assert.deepEqual((r.stream as any).heardWhileLocked, []);
  });
});

describe("phone stream: words heard while a passphrase check runs", () => {
  const WRONG = "Sorry, that's not it. Try again.";
  const UNLOCKED = "Got it. Go ahead.";
  const GOODBYE = "I can't open this line. Goodbye.";

  function lockedRig() {
    const checks = heldChecks();
    const r = rig({ direction: "inbound", options: { wrongLine: WRONG, unlockedLine: UNLOCKED, goodbyeLine: GOODBYE }, checkPassphrase: checks.check });
    return { r, held: checks.held, tries: () => (r.stream as any).triesLeft as number };
  }

  it("the right phrase spoken during a check over a fragment is re-checked and unlocks, no try spent", async () => {
    const { r, held, tries } = lockedRig();
    r.intercept("it's"); // a fragment: the first check starts
    assert.equal(held.length, 1);
    r.intercept("copper lantern seven"); // lands while that check is running
    assert.equal(held.length, 1, "no second check while one is running");
    await held[0].release(); // the fragment check comes back wrong
    assert.equal(held.length, 2, "re-checked over the buffer as it stands now");
    assert.equal(tries(), 3, "no try counted before the re-check");
    assert.ok(!r.said.includes(WRONG));
    await held[1].release();
    assert.equal(r.stream.isLocked, false);
    assert.equal(tries(), 3);
    assert.ok(!r.said.includes(WRONG), "the wrong line was never said");
    assert.ok(r.said.includes(UNLOCKED));
    assert.deepEqual((r.stream as any).heardWhileLocked, []);
    assert.equal(r.logs.filter((l) => l.includes("passphrase re-checked")).length, 1);
  });

  it("a wrong attempt with more wrong words during its check costs exactly one try", async () => {
    const { r, held, tries } = lockedRig();
    r.intercept("hello");
    r.intercept("this is dana"); // also wrong, during the check
    await held[0].release();
    assert.equal(held.length, 2);
    await held[1].release(); // the re-check: also wrong
    assert.equal(r.stream.isLocked, true);
    assert.equal(tries(), 2, "one spoken attempt, one try");
    assert.equal(r.said.filter((l) => l === WRONG).length, 1, "the wrong line said once");
  });

  it("a re-check is never re-checked: its wrong result counts, and the next turn checks fresh", async () => {
    const { r, held, tries } = lockedRig();
    r.intercept("hello");
    r.intercept("um");
    await held[0].release();
    assert.equal(held.length, 2, "the one re-check");
    r.intercept("still talking"); // words keep arriving during the re-check
    await held[1].release();
    assert.equal(held.length, 2, "no second re-check from the same attempt");
    assert.equal(tries(), 2);
    assert.equal(r.said.filter((l) => l === WRONG).length, 1);
    r.intercept("copper lantern seven"); // the next turn: a fresh check
    assert.equal(held.length, 3);
    await held[2].release();
    assert.equal(r.stream.isLocked, false);
    assert.equal(tries(), 2);
  });

  it("three genuinely wrong attempts still end the call", async () => {
    const { r, held, tries } = lockedRig();
    for (const wrong of ["hello", "who is this", "open sesame"]) {
      r.intercept(wrong);
      await held[held.length - 1].release();
    }
    assert.equal(held.length, 3, "no re-checks when nothing arrived during a check");
    assert.equal(tries(), 0);
    assert.ok(r.said.includes(GOODBYE));
  });

  it("a re-check that lands after goodbye started neither unlocks nor counts", async () => {
    const { r, held, tries } = lockedRig();
    r.intercept("it's");
    r.intercept("copper lantern seven");
    await held[0].release(); // wrong → the re-check starts
    assert.equal(held.length, 2);
    void r.stream.sayThenHangup("Goodbye.");
    await held[1].release(); // a right verdict, but void
    assert.equal(r.stream.isLocked, true);
    assert.equal(tries(), 3);
    assert.ok(!r.said.includes(UNLOCKED));
    assert.ok(!r.said.includes(WRONG));
  });
});
