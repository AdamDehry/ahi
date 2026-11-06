/* ============================================================
   phone-idle-working.test.ts — the phone leg's idle fuse learns "working"
   (always-on slice 1, goal A2; the follow-up fenced off in voice-call-drop §6).

   Before: the idle timer was re-armed by caller speech and by audio sent to
   the caller only. A turn silent for idleMs — Michael running tools — got
   "I'll let you go. Bye." under the work. Now: not idle while turns are in
   flight on the call. One condition.
   ============================================================ */

import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { PhoneStream } from "../src/phone/stream.js";
import { hashPassphrase } from "../src/phone/passphrase.js";

const REC = hashPassphrase("copper lantern seven");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Array<Record<string, any>> = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code: number) {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit("close", code);
  }
  in(msg: Record<string, unknown>) {
    this.emit("message", Buffer.from(JSON.stringify(msg)), false);
  }
}

function rig(opts: { inFlight: () => number; idleMs: number }) {
  const ws = new FakeWs();
  const said: string[] = [];
  let hungUp = 0;
  const stream = new PhoneStream(ws as any, {
    claimTicket: (_t, callSid) => ({ callSid, direction: "outbound" }),
    openCall: (_t, o) => ({
      voiceStreamId: o.voiceStreamId,
      audio() {},
      async endUtterance() {},
      interrupt() {},
      async hangup() {
        hungUp++;
      },
    }),
    say: async (text) => {
      said.push(text);
      return { pcm: Buffer.alloc(160), sampleRate: 8_000 }; // 10 ms
    },
    passphrase: () => REC,
    turnsInFlight: opts.inFlight,
    options: { idleMs: opts.idleMs, idleConfirmMs: opts.idleMs },
    log: () => {},
  });
  ws.in({ event: "start", start: { streamSid: "MZ1", callSid: "CA1", customParameters: { ticket: "t" } } });
  return { ws, stream, said, hungUp: () => hungUp };
}

describe("phone idle fuse: not idle while Michael is working", () => {
  it("a silent working turn re-arms the fuse; once the work ends, silence says goodbye", async () => {
    let working = 1;
    const r = rig({ inFlight: () => working, idleMs: 30 });
    await sleep(5); // the greeting line
    // Drain the greeting's mark so `playing` is false — the only thing that
    // used to keep the fuse from firing.
    for (const m of r.ws.sent.filter((x) => x.event === "mark")) r.ws.in({ event: "mark", mark: { name: m.mark.name } });
    await sleep(120); // four idle windows of pure silence, with a turn in flight
    assert.ok(!r.said.includes("I'll let you go. Bye."), "the fuse fired under running work");
    assert.equal(r.hungUp(), 0);
    working = 0;
    await sleep(60);
    assert.ok(r.said.includes("Still with me?"), "with the work done, silence is idle again — he is asked first (voice step 2)");
    for (const m of r.ws.sent.filter((x) => x.event === "mark")) r.ws.in({ event: "mark", mark: { name: m.mark.name } });
    await sleep(80);
    assert.ok(r.said.includes("I'll let you go. Bye."), "and silence after the question says goodbye");
  });

  it("without the dependency the fuse behaves as before (idle = not playing)", async () => {
    const ws = new FakeWs();
    const said: string[] = [];
    new PhoneStream(ws as any, {
      claimTicket: (_t, callSid) => ({ callSid, direction: "outbound" }),
      openCall: (_t, o) => ({ voiceStreamId: o.voiceStreamId, audio() {}, async endUtterance() {}, interrupt() {}, async hangup() {} }),
      say: async (text) => {
        said.push(text);
        return { pcm: Buffer.alloc(160), sampleRate: 8_000 };
      },
      passphrase: () => REC,
      options: { idleMs: 30, idleConfirmMs: 30 },
      log: () => {},
    });
    ws.in({ event: "start", start: { streamSid: "MZ1", callSid: "CA1", customParameters: { ticket: "t" } } });
    await sleep(5);
    for (const m of ws.sent.filter((x) => x.event === "mark")) ws.in({ event: "mark", mark: { name: m.mark.name } });
    await sleep(60);
    assert.ok(said.includes("Still with me?"));
    for (const m of ws.sent.filter((x) => x.event === "mark")) ws.in({ event: "mark", mark: { name: m.mark.name } });
    await sleep(80);
    assert.ok(said.includes("I'll let you go. Bye."));
  });
});
