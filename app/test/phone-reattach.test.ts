/* ============================================================
   phone-reattach.test.ts — voice step 2, the phone door, on a fake socket.

   The call outlives its media stream: a stream that breaks parks the call;
   the stream Twilio's redirect brings re-attaches to it. What is pinned
   here, beside the end-to-end run in phone-e2e: a door that never comes
   back ends the call honestly (door-lost, and the line is cut from our side
   too); speech held while parked is bounded and a barge-in drops it; a
   new stream that arrives before the old one is seen closing takes over and
   the old one's late events are ignored; a re-attach doorway hands its
   socket over without ending anything; and with no re-attach wired, a
   broken stream ends the call exactly as before.
   ============================================================ */

import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { PhoneStream, phoneEndToken, type PhoneCallInfo, type PhoneStreamOptions } from "../src/phone/stream.js";
import { hashPassphrase } from "../src/phone/passphrase.js";
import type { CallTransport } from "../src/voice/call-transport.js";

const REC = hashPassphrase("copper lantern seven");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Poll for an outcome instead of betting on a timer's exact lateness. */
async function waitUntil(cond: () => boolean, what: string, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Array<Record<string, any>> = [];
  closeCode: number | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code: number) {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closeCode = code;
    this.emit("close", code, Buffer.from(""));
  }
  /** The closing handshake started; the close event comes later. */
  closing() {
    this.readyState = 2;
  }
  /** The network breaks: no close frame from us, the socket is just gone. */
  drop() {
    this.readyState = 3;
    this.emit("close", 1006, Buffer.from(""));
  }
  in(msg: Record<string, unknown>) {
    this.emit("message", Buffer.from(JSON.stringify(msg)), false);
  }
  of(event: string) {
    return this.sent.filter((m) => m.event === event);
  }
}

function rig(opts: { options?: Partial<PhoneStreamOptions>; adopt?: boolean; direction?: "inbound" | "outbound"; hangupFails?: boolean } = {}) {
  const ws = new FakeWs();
  const logs: string[] = [];
  const hangups: Array<string | undefined> = [];
  const restHangups: string[] = [];
  const reattached: number[] = [];
  const said: string[] = [];
  let transport!: CallTransport;
  let ended = 0;
  const stream: PhoneStream = new PhoneStream(ws as any, {
    claimTicket: (_t, callSid) => ({ callSid, direction: opts.direction ?? "outbound" }),
    openCall: (t, o) => {
      transport = t;
      return {
        voiceStreamId: o.voiceStreamId,
        audio() {},
        async endUtterance() {},
        interrupt() {},
        async hangup(why?: string) {
          hangups.push(why);
          if (opts.hangupFails) throw new Error("teardown blew up");
        },
        reattached: (gap: number) => reattached.push(gap),
      };
    },
    say: async (text) => {
      said.push(text);
      return { pcm: Buffer.alloc(1_600), sampleRate: 8_000 }; // 0.1 s
    },
    passphrase: () => REC,
    ...(opts.adopt === false
      ? {}
      : {
          adopt: () => true,
          onEnded: () => ended++,
          hangupCall: async (sid: string) => {
            restHangups.push(sid);
          },
        }),
    options: { reattachWindowMs: 60, ...(opts.options ?? {}) },
    log: (l) => logs.push(l),
  });
  ws.in({ event: "start", start: { streamSid: "MZ1", callSid: "CA1", customParameters: { ticket: "t" } } });
  return {
    ws,
    stream,
    logs,
    hangups,
    restHangups,
    reattached,
    said,
    get ended() {
      return ended;
    },
    speak(seconds: number) {
      const out = transport.audioOut({ voiceStreamId: "phone-CA1", bot: "michael" });
      out.start(8_000);
      out.frame(Buffer.alloc(Math.round(8_000 * seconds) * 2));
      out.done();
    },
    /** A turn's downlink, left open: the caller drives frames and done. */
    turn() {
      const out = transport.audioOut({ voiceStreamId: "phone-CA1", bot: "michael" });
      out.start(8_000);
      return out;
    },
    bargeIn: () => transport.event({ type: "stt-interim", text: "wait stop that" }),
  };
}

describe("phone re-attach: the door that never comes back", () => {
  it("ends the call after the window, says so, and cuts the line from our side", async () => {
    const r = rig();
    await sleep(5);
    r.ws.drop();
    assert.equal(r.stream.isParked, true);
    assert.equal(r.hangups.length, 0, "not ended at the break");
    await waitUntil(() => r.stream.isOver, "the window to run out");
    assert.deepEqual(r.hangups, ["door-lost"], "the end line says the door never came back");
    assert.deepEqual(r.restHangups, ["CA1"], "the phone call itself is ended too");
    assert.equal(r.ended, 1);
    assert.ok(r.logs.some((l) => l.includes("no new stream within")));
  });

  it("each redirect Twilio makes restarts the wait (a stream that failed to connect tries again)", async () => {
    const r = rig({ options: { reattachWindowMs: 1_000 } });
    await sleep(5);
    r.ws.drop();
    await sleep(600);
    assert.equal(r.stream.requestReattach(), true);
    await sleep(600); // 1.2 s since the break, 0.6 s since the redirect: inside the new window
    assert.equal(r.stream.isOver, false, "the redirect restarted the wait");
    await waitUntil(() => r.stream.isOver, "the restarted window to run out");
    assert.deepEqual(r.hangups, ["door-lost"]);
  });

  it("a teardown that throws still unfiles the call (Codex P2)", async () => {
    const r = rig({ hangupFails: true });
    await sleep(5);
    r.ws.drop();
    await waitUntil(() => r.ended === 1, "the call to be unfiled");
    assert.ok(r.logs.some((l) => l.includes("call teardown failed")));
  });

  it("the caller hanging up is not ours to cut: no REST hang-up", async () => {
    const r = rig();
    await sleep(5);
    r.ws.in({ event: "stop" });
    await sleep(5);
    assert.deepEqual(r.hangups, ["caller-hung-up"]);
    assert.deepEqual(r.restHangups, []);
  });

  it("with no re-attach wired, a broken stream ends the call as before", async () => {
    const r = rig({ adopt: false });
    await sleep(5);
    r.ws.drop();
    await sleep(5);
    assert.equal(r.stream.isOver, true);
    assert.deepEqual(r.hangups, ["socket-closed"]);
  });
});

describe("phone re-attach: a break in the middle of a reply", () => {
  it("the rest of the reply and its final mark, sent while parked, arrive on the new stream; audible until that mark returns", async () => {
    const r = rig({ options: { reattachWindowMs: 5_000 } });
    // The greeting (0.1 s) plays out first: the reply never goes on air over it (voice/mouth.ts).
    await waitUntil(() => r.ws.of("media").length >= 5 && (r.stream as any).mouth.free, "the greeting to play out");
    const out = r.turn();
    out.frame(Buffer.alloc(8_000 * 0.1 * 2)); // 0.1 s on the old stream
    assert.equal(r.stream.playing, true);
    r.ws.drop();
    assert.equal(r.stream.playing, false, "what the dead socket had queued is not playing anywhere");
    out.frame(Buffer.alloc(8_000 * 0.1 * 2)); // the rest, while parked
    out.done(); // and the closing mark
    const ws2 = new FakeWs();
    r.stream.attach(ws2 as any, "MZ2");
    assert.equal(ws2.of("media").length, 5, "the unsent half, not the whole reply again");
    assert.equal(ws2.of("mark").length, 1);
    assert.equal(r.stream.playing, true, "the held mark is outstanding on the new stream");
    ws2.in({ event: "mark", mark: { name: ws2.of("mark")[0].mark.name } });
    assert.equal(r.stream.playing, false);
    await r.stream.end("caller hung up");
  });
});

describe("phone re-attach: what Twilio never played is re-said, once, from the sentence start (voice step 3)", () => {
  it("Twilio confirmed 1 s of a 2 s reply; the stream died: the new stream gets the reply again from its second sentence", async () => {
    const r = rig({ options: { reattachWindowMs: 5_000 } });
    await waitUntil(() => r.ws.of("media").length >= 5 && (r.stream as any).mouth.free, "the greeting to play out");
    const out = r.turn();
    out.frame(Buffer.alloc(8_000 * 0.8 * 2, 1)); // sentence one: 0.8 s
    out.words({ words: ["Done", "here."], start: [0, 0.4], end: [0.3, 0.7] });
    out.frame(Buffer.alloc(8_000 * 1.2 * 2, 2)); // sentence two: 1.2 s
    out.words({ words: ["Now", "the", "rest."], start: [0.8, 1.2, 1.6], end: [1.1, 1.5, 1.9] });
    // Twilio echoes the mark at 1 s of this reply (the greeting's end mark and two acks went out):
    // it played that far, then the stream dies.
    const marks = r.ws.of("mark");
    assert.equal(marks.length, 3, "the greeting's end mark, then one at 1 s and one at 2 s of the reply");
    r.ws.in({ event: "mark", mark: { name: marks[1].mark.name } });
    r.ws.drop();
    const ws2 = new FakeWs();
    r.stream.attach(ws2 as any, "MZ2");
    assert.equal(ws2.of("media").length, 60, "1.2 s from the second sentence's start = 60 frames, not the whole reply");
    assert.ok(r.logs.some((l) => l.includes("re-saying turn from 0.8s (heard 1.0s of 2.0s sent)")), r.logs.join("\n"));
    // A second break on the same reply is not re-said again.
    ws2.drop();
    const ws3 = new FakeWs();
    r.stream.attach(ws3 as any, "MZ3");
    assert.equal(ws3.of("media").length, 0, "once");
    await r.stream.end("caller hung up");
  });
});

describe("phone re-attach: what is held while the door is shut", () => {
  it("held speech replays on the new stream with its streamSid, and counts as audible until its mark returns", async () => {
    const r = rig({ options: { reattachWindowMs: 5_000 } });
    await sleep(5);
    r.ws.drop();
    r.speak(0.2);
    assert.equal(r.ws.of("media").length, 5, "nothing more went to the dead socket (the greeting only)");
    const ws2 = new FakeWs();
    assert.equal(r.stream.attach(ws2 as any, "MZ2"), true);
    assert.equal(ws2.of("media").length, 10, "0.2 s = ten frames");
    assert.ok(ws2.sent.every((m) => m.streamSid === "MZ2"));
    const mark = ws2.of("mark")[0];
    assert.ok(mark, "the reply's mark follows its frames");
    assert.equal(r.stream.playing, true);
    ws2.in({ event: "mark", mark: { name: mark.mark.name } });
    assert.equal(r.stream.playing, false);
    assert.equal(r.reattached.length, 1);
    assert.deepEqual(r.stream.reattachStats.reattaches, 1);
    await r.stream.end("caller hung up");
  });

  it("is bounded: past the hold, newer speech is dropped and the re-attach line says so", async () => {
    const r = rig({ options: { reattachWindowMs: 5_000, reattachHoldSec: 0.1 } });
    await waitUntil(() => r.ws.of("media").length >= 5 && (r.stream as any).mouth.free, "the greeting to play out");
    const out = r.turn(); // a reply on air when the door breaks: its rest is what the transport holds
    out.frame(Buffer.alloc(1_600));
    r.ws.drop();
    out.frame(Buffer.alloc(Math.round(8_000 * 0.3) * 2));
    out.done();
    const ws2 = new FakeWs();
    r.stream.attach(ws2 as any, "MZ2");
    assert.equal(ws2.of("media").length, 5, "0.1 s held, the rest dropped");
    assert.ok(r.logs.some((l) => l.includes("some held audio dropped")));
    await r.stream.end("caller hung up");
  });

  it("speech that starts while the door is shut waits for it in the mouth, then goes on air on the new stream — never a second start behind the first", async () => {
    const r = rig({ options: { reattachWindowMs: 5_000 } });
    await waitUntil(() => r.ws.of("media").length >= 5, "the greeting");
    r.ws.drop();
    r.speak(0.2);
    r.speak(0.2);
    const ws2 = new FakeWs();
    r.stream.attach(ws2 as any, "MZ2");
    await waitUntil(() => ws2.of("media").length >= 20, "both, one after the other");
    assert.ok(ws2.sent.every((m) => m.streamSid === "MZ2"));
    await r.stream.end("caller hung up");
  });

  it("a cut while parked drops what was held", async () => {
    const r = rig({ options: { reattachWindowMs: 5_000 } });
    await sleep(5);
    r.ws.drop();
    r.speak(0.2);
    (r.stream as any).clearPlayback();
    const ws2 = new FakeWs();
    r.stream.attach(ws2 as any, "MZ2");
    assert.equal(ws2.of("media").length, 0);
    assert.equal(ws2.of("clear").length, 0, "nothing to clear on a fresh stream");
    await r.stream.end("caller hung up");
  });
});

describe("phone re-attach: takeover and the doorway", () => {
  it("a new stream before the old one closed takes over; the old socket's late events are ignored", async () => {
    const r = rig({ options: { reattachWindowMs: 5_000 } });
    await sleep(5);
    const ws2 = new FakeWs();
    assert.equal(r.stream.attach(ws2 as any, "MZ2"), true);
    assert.equal(r.ws.closeCode, 1000, "the old socket is let go");
    assert.equal(r.stream.isOver, false, "its close did not end the call");
    r.ws.emit("message", Buffer.from(JSON.stringify({ event: "stop" })), false);
    assert.equal(r.stream.isOver, false, "a stop from the old socket is not the caller hanging up");
    assert.ok(r.logs.some((l) => l.startsWith("[door]") && l.includes(" phone closed code=1000")), "the old door still gets its line");
    assert.ok(r.logs.some((l) => l.includes("still open — taking over")), "and the takeover is its own line");
    ws2.in({ event: "stop" });
    await sleep(5);
    assert.deepEqual(r.hangups, ["caller-hung-up"]);
  });

  it("a re-attach doorway gives its socket to the call and ends nothing", async () => {
    const ws = new FakeWs();
    const adopted: Array<{ info: PhoneCallInfo; streamSid: string }> = [];
    let opened = 0;
    const door = new PhoneStream(ws as any, {
      claimTicket: (_t, callSid) => ({ callSid, direction: "inbound", reattach: true }),
      openCall: () => {
        opened++;
        return { error: "never" };
      },
      say: async () => ({ pcm: Buffer.alloc(0), sampleRate: 8_000 }),
      passphrase: () => REC,
      adopt: (info, _sock, streamSid) => {
        adopted.push({ info, streamSid });
        return true;
      },
      log: () => {},
    });
    ws.in({ event: "start", start: { streamSid: "MZ9", callSid: "CA1", customParameters: { ticket: "t" } } });
    assert.equal(adopted.length, 1);
    assert.equal(adopted[0].streamSid, "MZ9");
    assert.equal(opened, 0, "no second call opened");
    assert.equal(door.isOver, true, "the doorway is done");
    assert.equal(ws.closeCode, null, "and the socket is NOT closed — the call has it now");
  });

  it("the last allowed re-attach, granted before the old socket closed, is not voided by that close (Codex P1)", async () => {
    const r = rig({ options: { reattachWindowMs: 5_000, maxReattaches: 1 } });
    await sleep(5);
    assert.equal(r.stream.requestReattach(), true, "Twilio's redirect arrives first");
    r.ws.drop(); // then the old socket's close
    assert.equal(r.stream.isOver, false, "the granted re-attach still has a call to land on");
    assert.equal(r.stream.isParked, true);
    const ws2 = new FakeWs();
    assert.equal(r.stream.attach(ws2 as any, "MZ2"), true);
    ws2.drop(); // and now it is really out of re-attaches
    assert.equal(r.stream.isOver, true);
  });

  it("taking over from a socket that is still CLOSING keeps its own close code and earlier error in the door line (Codex P2)", async () => {
    const r = rig({ options: { reattachWindowMs: 5_000 } });
    await sleep(5);
    r.ws.emit("error", new Error("ECONNRESET"));
    r.ws.closing();
    const ws2 = new FakeWs();
    assert.equal(r.stream.attach(ws2 as any, "MZ2"), true);
    assert.ok(r.logs.some((l) => l.includes("still closing — taking over")));
    assert.equal(r.ws.closeCode, null, "a closing socket is not closed again");
    r.ws.emit("close", 1011, Buffer.from("going away"));
    const door = r.logs.find((l) => l.startsWith("[door]"));
    assert.ok(door && door.includes("code=1011") && door.includes("going away error ECONNRESET"), `both the reason and the error: ${door}`);
    assert.equal(r.stream.isOver, false);
    await r.stream.end("caller hung up");
  });

  it("past maxReattaches the call stops parking: the next break ends it", async () => {
    const r = rig({ options: { reattachWindowMs: 5_000, maxReattaches: 1 } });
    await sleep(5);
    assert.equal(r.stream.requestReattach(), true);
    assert.equal(r.stream.requestReattach(), false, "one allowed");
    r.stream.attach(new FakeWs() as any, "MZ2"); // the one it was granted
    ((r.stream as any).ws as FakeWs).drop();
    await sleep(5);
    assert.equal(r.stream.isOver, true);
    assert.deepEqual(r.hangups, ["socket-closed"]);
  });

  it("no cap on call length by default; the cap still works when set", async () => {
    const r = rig();
    assert.equal((r.stream as any).maxTimer, null, "voice step 2: no 60-minute cut");
    const capped = rig({ options: { maxCallMs: 20, goodbyeCapMs: 50 } });
    await sleep(60);
    assert.ok(capped.said.includes("We've hit the call limit. Talk soon."));
    await r.stream.end("caller hung up");
  });
});

describe("phone end tokens", () => {
  it("are short lowercase tokens", () => {
    assert.equal(phoneEndToken("caller hung up"), "caller-hung-up");
    assert.equal(phoneEndToken("door lost"), "door-lost");
    assert.equal(phoneEndToken(""), "hangup");
  });
});
