#!/usr/bin/env node
// ahi-retrieval.mjs — UserPromptSubmit hook for AHI: cross-conversation memory search.
//
// Forwards the hook's stdin JSON to the compiled retrieval CLI (dist/retrieval-cli.js, see
// src/retrieval-cli.ts), buffers its answer and prints exactly ONE result: the CLI's hookSpecificOutput JSON
// when it exits cleanly with a valid one, otherwise an empty additionalContext. The CLI's stderr (telemetry
// marker) passes straight through. Plain Node, no shell: it runs the same on Mac, Windows and Linux.
// The server writes the hook command as `node "<this file>"` with an absolute path and puts its own Node first
// on PATH, so no shell syntax or bash is involved.
//
// Env: AHI_AGENT (set per turn by the server), AHI_GATEWAY_DIR (app folder override),
//      AHI_RETRIEVAL_TIMEOUT_MS (default 8000).
//
// Always exits 0: a failure means no retrieval for this turn, never a blocked turn.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EMPTY = '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":""}}';
const MAX_OUTPUT = 4 * 1024 * 1024; // far above any real context block; beyond it the answer is refused
const appDir = process.env.AHI_GATEWAY_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(appDir, 'dist', 'retrieval-cli.js');
const timeoutMs = Number(process.env.AHI_RETRIEVAL_TIMEOUT_MS) || 8000;

let done = false;
/** Print one result and exit 0 once it is flushed. */
function finish(json, marker) {
  if (done) return;
  done = true;
  if (marker) process.stderr.write(`[ahi-retrieval] ${marker}\n`);
  process.stdout.write(json, () => process.exit(0));
}

/** The CLI's answer if it is a well-formed UserPromptSubmit result, else null. */
function validated(text) {
  try {
    const out = JSON.parse(text);
    const h = out?.hookSpecificOutput;
    return h?.hookEventName === 'UserPromptSubmit' && typeof h.additionalContext === 'string' ? JSON.stringify(out) : null;
  } catch {
    return null;
  }
}

if (!existsSync(cli)) {
  finish(EMPTY, `cli-missing path=${cli}`);
} else {
  // Same node that runs this hook; cwd = the app folder so the CLI resolves paths as the server does.
  const child = spawn(process.execPath, [cli], { cwd: appDir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const chunks = [];
  let size = 0;
  child.stdout.on('data', (b) => { size += b.length; if (size <= MAX_OUTPUT) chunks.push(b); });
  child.stderr.pipe(process.stderr);
  child.stdin.on('error', () => {}); // a CLI that exits before reading stdin must not crash the hook
  process.stdin.pipe(child.stdin);
  child.on('error', (err) => finish(EMPTY, `spawn-failed ${err.message}`));
  // 'close' fires after the child's output has drained.
  child.on('close', (code, signal) => {
    process.stdin.unpipe(child.stdin);
    process.stdin.destroy();
    if (code !== 0) return finish(EMPTY, `cli-failed ${signal ? `signal=${signal}` : `code=${code}`}`);
    const answer = size <= MAX_OUTPUT ? validated(Buffer.concat(chunks).toString('utf8')) : null;
    finish(answer ?? EMPTY, answer ? null : 'bad-output');
  });
  // Hard ceiling so a stuck retrieval can never hang the user's turn; any partial answer is dropped.
  setTimeout(() => {
    if (done) return;
    child.kill();
    setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    finish(EMPTY, 'timeout');
  }, timeoutMs).unref();
}
