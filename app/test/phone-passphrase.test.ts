/* phone-passphrase.test.ts — the spoken second factor: hash only, matched on words. */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { hashPassphrase, matchesPassphrase, normalizeWords, readPassphrase, writePassphrase } from "../src/phone/passphrase.js";

// Invented for the test; not anyone's passphrase.
const PHRASE = "Copper Lantern Seven";

describe("phone: passphrase", () => {
  const rec = hashPassphrase(PHRASE);

  it("stores a salted hash and a word count — never the phrase", () => {
    const json = JSON.stringify(rec).toLowerCase();
    for (const w of ["copper", "lantern", "seven"]) assert.ok(!json.includes(w), `${w} leaked into the record`);
    assert.equal(rec.words, 3);
    assert.notEqual(hashPassphrase(PHRASE).hash, rec.hash, "a fresh salt each time");
  });

  it("normalizes case, punctuation and number words", () => {
    assert.deepEqual(normalizeWords("Copper, LANTERN — seven!"), ["copper", "lantern", "7"]);
    assert.deepEqual(normalizeWords("it's 7"), ["its", "7"]);
  });

  it("matches what speech recognition actually returns", async () => {
    assert.equal(await matchesPassphrase("Copper lantern seven.", rec), true);
    assert.equal(await matchesPassphrase("copper lantern 7", rec), true, "digits for number words");
    assert.equal(await matchesPassphrase("Yeah, it's copper lantern seven", rec), true, "words around it");
    assert.equal(await matchesPassphrase("Copper lantern seven, Michael.", rec), true);
  });

  it("refuses anything else", async () => {
    assert.equal(await matchesPassphrase("copper lantern", rec), false, "too short");
    assert.equal(await matchesPassphrase("lantern copper seven", rec), false, "wrong order");
    assert.equal(await matchesPassphrase("copper lantern eight", rec), false);
    assert.equal(await matchesPassphrase("copper something lantern seven", rec), false, "not consecutive");
    assert.equal(await matchesPassphrase("", rec), false);
  });

  it("needs at least two words, and at most 16 (the check only ever hears the last 16)", () => {
    assert.throws(() => hashPassphrase("heron"), /two words/);
    const sixteen = Array.from({ length: 16 }, (_, i) => `word${i}`).join(" ");
    assert.equal(hashPassphrase(sixteen).words, 16);
    assert.throws(() => hashPassphrase(`${sixteen} one-more`), /at most 16 words/);
  });

  it("a record claiming more than 16 words reads as unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "phone-pass-long-"));
    const file = join(dir, "passphrase.json");
    writeFileSync(file, JSON.stringify({ ...rec, words: 17 }));
    assert.equal(readPassphrase(file), null);
  });

  it("persists owner-only and reads back; a damaged file reads as unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "phone-pass-"));
    const file = join(dir, "phone", "passphrase.json");
    writePassphrase(file, rec);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readPassphrase(file), rec);
    assert.ok(!readFileSync(file, "utf8").toLowerCase().includes("lantern"));
    writeFileSync(file, "{not json");
    assert.equal(readPassphrase(file), null);
    assert.equal(readPassphrase(join(dir, "absent.json")), null);
  });
});
