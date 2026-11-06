// Document previews must work on Mac and Windows too, where there is no /proc to ask which file a descriptor holds.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { descriptorPath, openInside, previewDoc } from "../src/doc-tree.js";

const scratch = mkdtempSync(join(import.meta.dirname, ".tmp-doctree-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const root = realpathSync(scratch);
mkdirSync(join(root, "Work"));
writeFileSync(join(root, "Work", "notes.md"), "# Notes\n");

test("a text preview opens inside the root", () => {
  const p = previewDoc(root, "Work/notes.md");
  assert.equal(p?.kind, "text");
  assert.equal(p && "text" in p ? p.text : "", "# Notes\n");
});

for (const platform of ["linux", "darwin", "win32"]) {
  test(`${platform}: the descriptor's real path is found, and a file swapped after opening is not trusted`, () => {
    const file = join(root, "Work", "notes.md");
    const fd = openSync(file, "r");
    try {
      assert.equal(descriptorPath(fd, file, platform), file);
      if (platform !== "linux") {
        // Swap a different file in under the same name: the open descriptor no longer IS the named file.
        renameSync(file, join(root, "Work", "moved.md"));
        writeFileSync(file, "other\n");
        assert.equal(descriptorPath(fd, file, platform), null);
        rmSync(join(root, "Work", "moved.md"));
      }
    } finally {
      closeSync(fd);
    }
  });
}

test("openInside refuses a file outside the root", () => {
  const outside = mkdtempSync(join(import.meta.dirname, ".tmp-doctree-out-"));
  try {
    writeFileSync(join(outside, "x.md"), "x");
    assert.equal(openInside(root, join(outside, "x.md")), null);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
