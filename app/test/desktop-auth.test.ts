// The real AHI server, booted the way the desktop app boots it (onboarding/src/ahi-runtime.cjs serverEnv) in a
// throwaway home: the sign-in boundary the app's window relies on, the /health proof it checks before trusting a
// server, the Claude settings file it points the server at, and the clean stop it sends over IPC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { serverEnv } = require("../onboarding/src/ahi-runtime.cjs");
const APP = resolve(import.meta.dirname, "..");

const freePort = () => new Promise<number>((done) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => done(port)); });
});

test("real server: a fresh client is denied, the login cookie is the only way in, /health proves the owner key without revealing it", { timeout: 120_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ahi auth-")); // a space in the home, like "My AI"
  const managed = join(root, "AHI_OS");
  for (const d of ["state", "logs", "skills", "documents"]) mkdirSync(join(managed, d), { recursive: true });
  const token = randomBytes(32).toString("hex"), family = randomBytes(32).toString("hex");
  writeFileSync(join(managed, "state", "users.json"), JSON.stringify([
    { token, name: "Owner", telegramChatId: null, timezone: "UTC", agents: ["michael"], admin: true },
    { token: family, name: "Family", telegramChatId: null, timezone: "UTC", agents: ["michael"], admin: false },
  ]));
  const port = await freePort();
  const env = { ...serverEnv({ managed, root, port }), HOME: root };
  const server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: APP, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let log = "";
  server.stdout!.on("data", (b) => { log += b; });
  server.stderr!.on("data", (b) => { log += b; });
  t.after(() => { if (server.exitCode === null) server.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (server.exitCode !== null) assert.fail(`server exited while starting:\n${log.slice(-2000)}`);
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    if (i > 200) assert.fail(`server did not answer:\n${log.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 300));
  }

  // /health: the home id, and a proof only for a well-formed challenge, keyed by the owner's (not the family's) key.
  const plain = await (await fetch(`${base}/health`)).json();
  assert.equal(plain.home, createHash("sha256").update(managed).digest("hex").slice(0, 16));
  assert.equal(plain.proof, undefined);
  assert.equal((await (await fetch(`${base}/health?challenge=not-hex`)).json()).proof, undefined);
  const challenge = randomBytes(32).toString("hex");
  const proved = await (await fetch(`${base}/health?challenge=${challenge}`)).json();
  assert.equal(proved.proof, createHmac("sha256", token).update("ahi-desktop-proof:" + challenge).digest("hex"));
  assert.ok(!JSON.stringify(proved).includes(token) && !JSON.stringify(proved).includes(family), "no key in /health");

  // The sign-in boundary.
  assert.equal((await fetch(`${base}/ui/session`)).status, 401, "a fresh client is denied");
  const wrong = await fetch(`${base}/ui/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "wrong" }) });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("set-cookie"), null);
  const login = await fetch(`${base}/ui/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie") ?? "";
  assert.match(cookie, new RegExp(`^ahi_token=${token};`));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.equal((await fetch(`${base}/ui/session`, { headers: { cookie: `ahi_token=${token}` } })).status, 200, "the cookie signs in");
  assert.equal((await fetch(`${base}/ui/session`)).status, 401, "a fresh client is still denied after the owner signed in");
  assert.equal((await fetch(`${base}/ui/session`, { headers: { cookie: "ahi_token=wrong" } })).status, 401);

  // Claude's settings went to the file the app named, inside the home, not into the server folder.
  const settingsFile = join(managed, "state", "claude-settings.json");
  assert.ok(existsSync(settingsFile), "settings written where the app pointed");
  assert.match(readFileSync(settingsFile, "utf8"), /"node \\".*hooks\/ahi-retrieval\.mjs\\""/);

  // The app's clean stop: the server exits and removes its own lock.
  const exited = new Promise<number | null>((done) => server.once("exit", done));
  server.send("ahi:stop");
  assert.equal(await exited, 0);
  assert.ok(!existsSync(join(managed, "logs", "gateway.pid")), "the lock is gone");
});
