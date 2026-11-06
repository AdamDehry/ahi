import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSendFileSentinels } from "../src/chat-files/sentinel.js";

test("send_file delivers an existing absolute path (the platform's own form) and rejects a relative one", () => {
  const file = join(mkdtempSync(join(tmpdir(), "ahi-sentinel-")), "report.pdf");
  writeFileSync(file, "%PDF");
  const parsed = parseSendFileSentinels(`Here it is.\n[[send_file: ${file}]]\n[[send_file: report.pdf]]\nDone.`);
  assert.deepEqual(parsed.paths, [file]);
  assert.deepEqual(parsed.rejected, ["report.pdf"]);
  assert.equal(parsed.cleaned, "Here it is.\nDone.");
});
