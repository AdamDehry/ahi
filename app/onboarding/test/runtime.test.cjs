const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { install, serverEnv, start, homeId } = require('../src/ahi-runtime.cjs');
const { stagePublicSkills } = require('../src/public-skills.cjs');

async function seed() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ahi-seed-'));
  await fs.mkdir(path.join(dir, 'agents', 'soul'), { recursive: true });
  await fs.mkdir(path.join(dir, 'mission-control'), { recursive: true });
  await fs.writeFile(path.join(dir, 'agents', 'soul', 'MICHAEL.md'), '# Michael\n- **{{USER_NAME}}** — your human\n- Mission control: `{{AHI_OS}}/mission-control/`\n');
  await fs.writeFile(path.join(dir, 'agents', 'soul', 'NESHAMA.md'), 'Learning with {{USER_NAME}}.\n');
  await fs.writeFile(path.join(dir, 'agents', 'soul', 'AHI-FOUNDATION.md'), 'Foundation.\n');
  await fs.writeFile(path.join(dir, 'mission-control', 'TODO.md'), '# Todo\n');
  return dir;
}

test('install makes the owner key once, keeps it private, tailors the souls and places the neshama', async (t) => {
  const s = await seed(), managed = await fs.mkdtemp(path.join(os.tmpdir(), 'ahi-os-'));
  t.after(() => Promise.all([fs.rm(s, { recursive: true, force: true }), fs.rm(managed, { recursive: true, force: true })]));
  const first = await install({ managed, seed: s, owner: 'Dana', timezone: 'Europe/London' });
  assert.match(first.token, /^[0-9a-f]{64}$/);
  const users = JSON.parse(await fs.readFile(first.usersFile, 'utf8'));
  assert.equal(users.length, 1);
  assert.deepEqual({ name: users[0].name, admin: users[0].admin, agents: users[0].agents, jewishCalendar: users[0].jewishCalendar, timezone: users[0].timezone }, { name: 'Dana', admin: true, agents: ['michael', 'tzali', 'avi', 'miriam'], jewishCalendar: false, timezone: 'Europe/London' });
  if (process.platform !== 'win32') assert.equal((await fs.stat(first.usersFile)).mode & 0o077, 0);
  assert.equal(await fs.readFile(path.join(managed, 'agents', 'soul', 'MICHAEL.md'), 'utf8'), `# Michael\n- **Dana** — your human\n- Mission control: \`${managed}/mission-control/\`\n`);
  assert.equal(await fs.readFile(path.join(managed, 'mission-control', 'AHI_NESHAMA.md'), 'utf8'), 'Learning with Dana.\n');
  assert.equal(await fs.readFile(path.join(managed, 'soul', 'AHI-FOUNDATION.md'), 'utf8'), 'Foundation.\n');
  // A second run makes no new key and never overwrites what the owner or their agents changed.
  await fs.writeFile(path.join(managed, 'agents', 'soul', 'MICHAEL.md'), 'edited by Michael\n');
  const again = await install({ managed, seed: s, owner: 'Dana' });
  assert.equal(again.token, null);
  assert.equal(await fs.readFile(path.join(managed, 'agents', 'soul', 'MICHAEL.md'), 'utf8'), 'edited by Michael\n');
});

test('the server runs with every path inside the hidden OS folder and the brain\'s own sign-in home', () => {
  const env = serverEnv({ managed: '/h/AHI/AHI_OS', root: '/h/AHI', port: 18789, claude: { home: '/h/AHI/AHI_OS/providers/claude', bin: '/h/AHI/AHI_OS/tools/claude' } });
  assert.equal(env.AHI_AI_ROOT, '/h/AHI/AHI_OS');
  assert.equal(env.AHI_USERS_FILE, path.join('/h/AHI/AHI_OS', 'state', 'users.json'));
  assert.equal(env.HOME, '/h/AHI/AHI_OS/providers/claude');
  assert.equal(env.AHI_CLAUDE_BIN, '/h/AHI/AHI_OS/tools/claude');
  assert.equal(env.AHI_APP_URL, 'http://localhost:18789');
  for (const k of ['AHI_GATEWAY_STATE_DIR', 'AHI_GATEWAY_BUSINESS_DIR', 'AHI_GATEWAY_LOCK_PATH', 'AHI_TURN_LOG_DIR']) assert.ok(env[k].startsWith('/h/AHI/AHI_OS'), k);
  assert.ok(!Object.keys(env).some((k) => /API_KEY|TOKEN|SECRET/.test(k)), 'no provider secrets are passed by setup');
});

test('voice keys go only to the server, with the voice turned on when it can both speak and hear', async (t) => {
  const { SetupService } = require('../src/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ahi-voice-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fallback = path.join(dir, 'cartesia.env');
  await fs.writeFile(fallback, 'CARTESIA_API_KEY="ck-test-0000000000"\n', { mode: 0o600 });
  const svc = new SetupService({ dataDir: dir, keyring: { get: async (ref) => (ref === 'setup-1:openai' ? 'sk-test-0000000000' : null) } });
  svc.state = { voice: {
    openai: { storage: 'keychain', reference: 'setup-1:openai', status: 'key-verified' },
    cartesia: { storage: 'env', reference: fallback, status: 'key-verified' },
  } };
  const env = await svc.voiceEnv();
  assert.equal(env.OPENAI_API_KEY, 'sk-test-0000000000');
  assert.equal(env.CARTESIA_API_KEY, 'ck-test-0000000000');
  assert.equal(env.MICHAEL_TTS_PROVIDER, 'openai');
  assert.equal(env.MIRIAM_TTS_PROVIDER, 'openai');
  assert.equal(env.VOICE_STT_PROVIDER, 'cartesia');
  assert.equal(env.VOICE_MODE_ENABLED, 'true');
  // Only a speaking voice (no transcription): replies can be spoken, but calls stay off.
  svc.state = { voice: { elevenlabs: { storage: 'keychain', reference: 'setup-1:elevenlabs', status: 'key-verified' } } };
  svc.keyring = { get: async () => 'el-test-0000000000' };
  const speakOnly = await svc.voiceEnv();
  assert.equal(speakOnly.TZALI_TTS_PROVIDER, 'elevenlabs');
  assert.equal(speakOnly.VOICE_STT_PROVIDER, undefined);
  assert.equal(speakOnly.VOICE_MODE_ENABLED, undefined);
  // An unreadable key is skipped, never thrown.
  svc.keyring = { get: async () => { throw new Error('locked'); } };
  assert.deepEqual(await svc.voiceEnv(), {});
});

// A seed shelf with one public skill, one private skill listed in the manifest, and one folder the manifest omits.
async function shelf(s) {
  const skill = (cat, name, priv) => fs.mkdir(path.join(s, 'skills', cat, name, 'scripts'), { recursive: true })
    .then(() => fs.writeFile(path.join(s, 'skills', cat, name, 'SKILL.md'), `---\nname: ${name}\nversion: 1.0.0\nprivate: ${priv}\n---\n`));
  await skill('code-quality', 'oom-safe-runs', false);
  await skill('ops-infra', 'house-secrets', true);
  await skill('ops-infra', 'unlisted', false);
  await fs.writeFile(path.join(s, 'skills', 'code-quality', 'oom-safe-runs', 'scripts', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  const entry = (category, name) => ({ name, category, version: '1.0.0' });
  await fs.writeFile(path.join(s, 'skills', 'MANIFEST.json'), JSON.stringify({ release: '0.2.0', skills: [entry('code-quality', 'oom-safe-runs'), entry('ops-infra', 'house-secrets')] }));
}

test('install places only public skills (listed AND private: false), with a manifest of just those, scripts runnable', async (t) => {
  const s = await seed(), managed = await fs.mkdtemp(path.join(os.tmpdir(), 'ahi-os-'));
  t.after(() => Promise.all([fs.rm(s, { recursive: true, force: true }), fs.rm(managed, { recursive: true, force: true })]));
  await shelf(s);
  await install({ managed, seed: s, owner: 'Dana' });
  assert.match(await fs.readFile(path.join(managed, 'skills', 'code-quality', 'oom-safe-runs', 'SKILL.md'), 'utf8'), /version: 1.0.0/);
  const manifest = JSON.parse(await fs.readFile(path.join(managed, 'skills', 'MANIFEST.json'), 'utf8'));
  assert.equal(manifest.release, '0.2.0');
  assert.deepEqual(manifest.skills.map((x) => x.name), ['oom-safe-runs']);
  await assert.rejects(fs.access(path.join(managed, 'skills', 'ops-infra')), 'neither the private nor the unlisted skill is installed');
  if (process.platform !== 'win32') {
    assert.ok((await fs.stat(path.join(managed, 'skills', 'code-quality', 'oom-safe-runs', 'scripts', 'run.sh'))).mode & 0o100);
    assert.equal((await fs.stat(path.join(managed, 'skills', 'code-quality', 'oom-safe-runs', 'SKILL.md'))).mode & 0o111, 0);
  }
});

test('the installer build stages only public skills and refuses a manifest that lists a private one', async (t) => {
  const s = await seed(), out = await fs.mkdtemp(path.join(os.tmpdir(), 'ahi-staged-'));
  t.after(() => Promise.all([fs.rm(s, { recursive: true, force: true }), fs.rm(out, { recursive: true, force: true })]));
  await shelf(s);
  assert.throws(() => stagePublicSkills(path.join(s, 'skills'), out), /house-secrets/);
  const m = JSON.parse(await fs.readFile(path.join(s, 'skills', 'MANIFEST.json'), 'utf8'));
  m.skills = m.skills.filter((x) => x.name !== 'house-secrets');
  await fs.writeFile(path.join(s, 'skills', 'MANIFEST.json'), JSON.stringify(m));
  assert.equal(stagePublicSkills(path.join(s, 'skills'), out), 1);
  assert.deepEqual((await fs.readdir(out)).sort(), ['MANIFEST.json', 'code-quality']);
});

test('the server keeps the operating system context Windows needs, and nothing else from Setup', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { SystemRoot: 'C:\\Windows', COMSPEC: 'C:\\Windows\\cmd.exe', TEMP: 'C:\\Temp', OPENAI_API_KEY: 'synthetic' });
    const env = serverEnv({ managed: '/h/AHI/AHI_OS', root: '/h/AHI', port: 18789 });
    assert.equal(env.SystemRoot, 'C:\\Windows');
    assert.equal(env.COMSPEC, 'C:\\Windows\\cmd.exe');
    assert.equal(env.TEMP, 'C:\\Temp');
    assert.equal(env.OPENAI_API_KEY, undefined);
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});

async function fakeServer(body) {
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

test('start adopts a server already on the port only when it serves this same AHI home', async (t) => {
  const managed = await fs.mkdtemp(path.join(os.tmpdir(), 'ahi-os-'));
  await fs.mkdir(path.join(managed, 'logs'));
  const mine = await fakeServer({ ok: true, home: homeId(managed) }), other = await fakeServer({ ok: true, home: homeId('/another/AHI_OS') });
  t.after(() => Promise.all([new Promise((r) => mine.close(r)), new Promise((r) => other.close(r)), fs.rm(managed, { recursive: true, force: true })]));
  const opts = { node: process.execPath, serverDir: managed, managed, root: managed };
  assert.deepEqual(await start({ ...opts, port: mine.address().port }), { url: `http://localhost:${mine.address().port}/`, child: null });
  await assert.rejects(start({ ...opts, port: other.address().port }), /already using port/);
});

test('a Node that cannot be launched is reported as a setup error, not a crash', async (t) => {
  const managed = await fs.mkdtemp(path.join(os.tmpdir(), 'ahi-os-'));
  await fs.mkdir(path.join(managed, 'logs'));
  t.after(() => fs.rm(managed, { recursive: true, force: true }));
  const probe = await fakeServer({}); const port = probe.address().port; await new Promise((r) => probe.close(r)); // a free port
  await assert.rejects(start({ node: path.join(managed, 'no-such-node'), serverDir: managed, managed, root: managed, port }), /could not start \(ENOENT\)/);
});
