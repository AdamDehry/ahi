/* phone-card.test.ts — a phone call's card in the chat says PHONE CALL (and which way). */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { recordTitle } from "../web/src/components/voice/SessionRecordCard.js";

describe("phone: the call card's title", () => {
  it("an app call is unchanged", () => {
    assert.equal(recordTitle({}), "ENTERED VOICE MODE");
  });
  it("a phone call says so, and which way it went", () => {
    assert.equal(recordTitle({ channel: "phone", direction: "inbound" }), "PHONE CALL · YOU CALLED");
    assert.equal(recordTitle({ channel: "phone", direction: "outbound" }), "PHONE CALL · MICHAEL CALLED");
    assert.equal(recordTitle({ channel: "phone" }), "PHONE CALL");
  });
});
