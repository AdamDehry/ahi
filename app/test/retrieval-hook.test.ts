// The memory-search hook (hooks/ahi-retrieval.mjs) is plain Node so it runs the same on Mac, Windows and Linux.
// These tests run it exactly as Claude Code does — `node <hook>` with the hook JSON on stdin — in a clean
// environment: nothing inherited (no live keys) and every data root inside a scratch folder beside this file.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const APP = resolve(import.meta.dirname, "..");
const HOOK = join(APP, "hooks", "ahi-retrieval.mjs");
const scratch = mkdtempSync(join(import.meta.dirname, ".tmp-hook-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const EMPTY = { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "" } };
const INPUT = JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "what did we decide?" });

function runHook(extraEnv: Record<string, string>) {
  const home = join(scratch, "home");
  // The roots must exist: the app refuses a configured root that is missing rather than fall back to a live one.
  for (const d of ["home", "ai", "state", "business", "sessions"]) mkdirSync(join(scratch, d), { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, AHI_AGENT: "michael",
    AHI_AI_ROOT: join(scratch, "ai"), AHI_HOME: home, AHI_GATEWAY_STATE_DIR: join(scratch, "state"),
    AHI_GATEWAY_BUSINESS_DIR: join(scratch, "business"), AHI_SESSIONS_ROOT: join(scratch, "sessions"), ...extraEnv,
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot; // Windows needs it to start processes
  const r = spawnSync(process.execPath, [HOOK], { input: INPUT, env, encoding: "utf8", timeout: 30_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function fakeApp(name: string, cli: string) {
  const dir = join(scratch, name);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "retrieval-cli.js"), cli);
  return dir;
}

test("relays the CLI's answer and stderr, and hands it the hook input on stdin", () => {
  const dir = fakeApp("echo", `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).prompt;
    process.stderr.write("[ahi-retrieval] fired\\n");
    process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:"saw: "+p}}));});`);
  const r = runHook({ AHI_GATEWAY_DIR: dir });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).hookSpecificOutput.additionalContext, "saw: what did we decide?");
  assert.match(r.err, /\[ahi-retrieval\] fired/);
});

test("a missing CLI degrades to empty context and exit 0, never blocking the turn", () => {
  const r = runHook({ AHI_GATEWAY_DIR: join(scratch, "nowhere") });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), EMPTY);
  assert.match(r.err, /cli-missing/);
});

test("a CLI that crashes after partial output yields empty context and exit 0, never broken JSON", () => {
  const dir = fakeApp("crash", `process.stdout.write('{"hookSpecificOutput":{"hookEv'); process.exit(3);`);
  const r = runHook({ AHI_GATEWAY_DIR: dir });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), EMPTY);
  assert.match(r.err, /cli-failed code=3/);
});

test("a clean exit with output that is not a hook result is refused", () => {
  const dir = fakeApp("junk", `process.stdout.write("hello");`);
  const r = runHook({ AHI_GATEWAY_DIR: dir });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), EMPTY);
  assert.match(r.err, /bad-output/);
});

test("a stuck CLI is cut off at the ceiling with empty context, its partial output dropped", () => {
  const dir = fakeApp("stuck", `process.stdout.write('{"hookSpecificOutput":'); setInterval(() => {}, 1000);`);
  const started = Date.now();
  const r = runHook({ AHI_GATEWAY_DIR: dir, AHI_RETRIEVAL_TIMEOUT_MS: "400" });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), EMPTY);
  assert.match(r.err, /timeout/);
  assert.ok(Date.now() - started < 10_000);
});

test("the real retrieval CLI answers through the hook on a fresh, empty AHI home", { skip: !existsSync(join(APP, "dist", "retrieval-cli.js")) && "build the server first (npm run build)" }, () => {
  const r = runHook({});
  assert.equal(r.code, 0);
  const out = JSON.parse(r.out);
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.ok(!String(out.hookSpecificOutput.additionalContext).includes("<retrieved-session"), "an isolated run must not see any real sessions");
});
