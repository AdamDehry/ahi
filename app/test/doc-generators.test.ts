// The documents skill's generators (skills/design/documents) must print an ABSOLUTE path even when --out-dir is
// relative: the send_file sentinel (chat-files/sentinel.ts) refuses a relative one. The PDF renderers are stubbed so
// the test needs only python3; the Excel generator runs for real when openpyxl is installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

const DOCS = resolve(import.meta.dirname, "..", "..", "skills", "design", "documents");
// One environment for the probes and the runs: no keys inherited, but what Python and Windows need to start.
const ENV = Object.fromEntries(
  ["PATH", "PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG"]
    .filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]!]),
);
// The runs happen in a temp folder, so each relative or empty (= current folder) PYTHONPATH entry must mean the same folder there.
if (ENV.PYTHONPATH) ENV.PYTHONPATH = ENV.PYTHONPATH.split(delimiter).map((d) => resolve(d)).join(delimiter);
const py = (args: string[], opts: { cwd?: string; input?: string } = {}) => spawnSync("python3", args, { ...opts, encoding: "utf8", env: ENV });
const hasPython = py(["--version"]).status === 0;
const STUB = `
import sys, types, runpy
md = types.ModuleType("markdown"); md.markdown = lambda s, **k: "<p>x</p>"
wp = types.ModuleType("weasyprint")
class HTML:
    def __init__(self, string=None, **k): pass
    def write_pdf(self, path, **k): open(path, "wb").write(b"%PDF")
wp.HTML = HTML; wp.CSS = lambda **k: None
sys.modules.update(markdown=md, weasyprint=wp)
script = sys.argv[1]; sys.argv = sys.argv[1:]
runpy.run_path(script, run_name="__main__")
`;

function run(args: string[], input: string, stub: boolean) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ahi-docs-"))); // macOS tmp is behind a symlink; resolve() follows it
  const r = py(stub ? ["-c", STUB, ...args] : args, { cwd, input });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim();
  assert.ok(isAbsolute(out), `printed path is not absolute: ${out}`);
  assert.ok(existsSync(out));
  assert.equal(out, join(cwd, "rel", out.split(/[\\/]/).pop()!));
}

test("gen_pdf and gen_booklet print an absolute path for a relative --out-dir", { skip: !hasPython && "python3 not installed" }, () => {
  run([join(DOCS, "gen_pdf.py"), "--title", "T", "--body", "hi", "--out-dir", "rel"], "", true);
  run([join(DOCS, "gen_booklet.py"), "--out-dir", "rel"], '{"title":"B","sections":[{"heading":"h","body_md":"x"}]}', true);
});

const hasOpenpyxl = hasPython && py(["-c", "import openpyxl"]).status === 0;
test("gen_excel prints an absolute path for a relative --out-dir", { skip: !hasOpenpyxl && "openpyxl not installed" }, () => {
  run([join(DOCS, "gen_excel.py"), "--out-dir", "rel"], '{"title":"T","sheets":[{"name":"S","headers":["a"],"rows":[[1]]}]}', false);
});
