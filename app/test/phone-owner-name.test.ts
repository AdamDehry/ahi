/* The phone line greets the owner by the name setup gave them, and falls back to generic lines without one.
   The call prompt names the caller when known and carries no pronoun either way. */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { PHONE_STREAM_DEFAULTS, phoneLinesFor, phoneOpener, phoneSystemHint } from "../src/phone/stream.js";

const PRONOUN = /\b(he|him|his|she|her|hers|they|them|their)\b/i;

describe("phone: the owner's name", () => {
  it("with a name: greeting and unlock line use it", () => {
    const lines = { ...PHONE_STREAM_DEFAULTS, ...phoneLinesFor("Dana") };
    assert.equal(lines.ownerName, "Dana");
    assert.equal(lines.unlockedLine, "Got it. Go ahead, Dana.");
    assert.equal(phoneOpener(undefined, lines), "Hey Dana.");
    assert.equal(phoneOpener("The build is done.", lines), "Hey Dana. The build is done.");
  });

  it("without a name (missing or blank): the generic lines", () => {
    for (const name of [null, undefined, "", "   "]) {
      const lines = { ...PHONE_STREAM_DEFAULTS, ...phoneLinesFor(name) };
      assert.equal(lines.ownerName, null);
      assert.equal(lines.unlockedLine, "Got it. Go ahead.");
      assert.equal(phoneOpener(undefined, lines), "Hey.");
      assert.equal(phoneOpener("The build is done.", lines), "Hey. The build is done.");
    }
  });

  it("the call prompt names the caller when known, says 'the owner' when not, and has no pronoun", () => {
    const named = phoneSystemHint({ direction: "inbound" }, undefined, "Dana");
    const generic = phoneSystemHint({ direction: "inbound" }, undefined, null);
    const out = phoneSystemHint({ direction: "outbound", reason: "The build is done." }, "Hey Dana. The build is done.", "Dana");
    const outGeneric = phoneSystemHint({ direction: "outbound" }, "Hey.", null);
    assert.match(named, /^PHONE CALL\. Dana called your phone number and passed the spoken passphrase\./);
    assert.match(generic, /^PHONE CALL\. The owner called your phone number and passed the spoken passphrase\./);
    assert.match(out, /placed this call to Dana's cell about: The build is done\./);
    assert.match(out, /You already opened the call by saying: "Hey Dana\. The build is done\."\. It was heard\. Do not greet again/);
    assert.match(outGeneric, /placed this call to the owner's cell\./);
    for (const hint of [named, generic, out, outGeneric]) assert.doesNotMatch(hint, PRONOUN, hint);
  });
});
