// The AHI runtime, installed and started by AHI Setup: the step from "setup saved" to "AHI is open in your browser".
// install() fills the hidden OS folder (<home>/AHI_OS) from the bundled seed: the agents' souls with the owner's name,
// the neshama and foundation, mission control's templates, empty documents / state / logs folders and, on Linux, the
// foreman (supervised build sessions); it creates the owner's sign-in once (a random token, shown to the owner once
// and never logged). start() runs the bundled AHI server with every path inside that folder and waits until it
// answers. Nothing here leaves the machine.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { publicSkills } = require('./public-skills.cjs');

const AGENTS = ['michael', 'tzali', 'avi', 'miriam'];
const DEFAULT_PORT = 18789;

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
async function copyTree(from, to, transform) {
  await fs.mkdir(to, { recursive: true, mode: 0o700 });
  for (const e of await fs.readdir(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) await copyTree(a, b, transform);
    else if (e.isFile() && !(await exists(b))) {
      const buf = await fs.readFile(a);
      const mode = (await fs.stat(a)).mode & 0o111 ? 0o700 : 0o600; // skill scripts stay runnable
      await fs.writeFile(b, transform && /\.md$/i.test(e.name) ? transform(buf.toString('utf8')) : buf, { mode });
    }
  }
}

/**
 * Fill <managed> (the hidden OS folder) from the seed. Never overwrites a file the owner or their agents changed.
 * Returns { token } the first time the owner's sign-in is made, else { token: null }.
 */
async function install({ managed, seed, owner, timezone, serverDir, port, platform = process.platform }) {
  const name = String(owner || '').trim() || 'Owner';
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  // Template placeholders in the agent files. Anything the owner sets later, the agent asks for and records.
  const fill = {
    '{{USER_NAME}}': name,
    '{{AHI_OS}}': managed,
    '{{USER_TIMEZONE}}': tz,
    '{{USER_PRIORITIES}}': `not set yet: ask ${name} for their order of priorities and record it here`,
    '{{NODE_SETUP}}': 'the Node runtime bundled with AHI Setup',
    '{{SERVICE_SETUP}}': 'the AHI server that AHI Setup starts (its log is AHI_OS/logs/ahi-server.log)',
  };
  const tailor = (text) => Object.entries(fill).reduce((t, [k, v]) => t.split(k).join(v), text);
  await copyTree(path.join(seed, 'agents'), path.join(managed, 'agents'), tailor);
  await copyTree(path.join(seed, 'mission-control'), path.join(managed, 'mission-control'), tailor);
  // The runtime reads the neshama and the foundation from their own places (src/claude-invoke.ts).
  const soul = path.join(managed, 'agents', 'soul');
  for (const [file, dest] of [['NESHAMA.md', path.join(managed, 'mission-control', 'AHI_NESHAMA.md')], ['AHI-FOUNDATION.md', path.join(managed, 'soul', 'AHI-FOUNDATION.md')]]) {
    if (await exists(path.join(soul, file)) && !(await exists(dest))) {
      await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await fs.copyFile(path.join(soul, file), dest);
    }
  }
  if (await exists(path.join(seed, 'torah'))) await copyTree(path.join(seed, 'torah'), path.join(managed, 'torah'));
  // The skills shelf (skills/<category>/<name>, plus MANIFEST.json the Updates page compares against): ONLY the
  // public skills (listed in the manifest and marked private: false), whatever else the seed folder holds.
  const seedSkills = path.join(seed, 'skills');
  if (await exists(path.join(seedSkills, 'MANIFEST.json'))) {
    const { manifest, skills } = publicSkills(seedSkills);
    for (const s of skills) await copyTree(path.join(seedSkills, s.category, s.name), path.join(managed, 'skills', s.category, s.name));
    const dest = path.join(managed, 'skills', 'MANIFEST.json');
    if (!(await exists(dest))) await fs.writeFile(dest, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    const readme = path.join(seedSkills, 'README.md');
    if ((await exists(readme)) && !(await exists(path.join(managed, 'skills', 'README.md')))) await fs.copyFile(readme, path.join(managed, 'skills', 'README.md'));
  }
  for (const dir of ['documents', 'state', 'logs', 'skills']) await fs.mkdir(path.join(managed, dir), { recursive: true, mode: 0o700 });
  // The foreman (supervised build sessions) needs Linux with a systemd user session; elsewhere it is not installed.
  if (platform === 'linux' && (await exists(path.join(seed, 'foreman', 'bin', 'fm_setup.sh')))) {
    await copyTree(path.join(seed, 'foreman'), path.join(managed, 'foreman'));
    setupForeman({ managed, serverDir, port });
  }

  const usersFile = path.join(managed, 'state', 'users.json');
  if (await exists(usersFile)) return { token: null, usersFile };
  const token = crypto.randomBytes(32).toString('hex');
  const users = [{ token, name, telegramChatId: null, timezone: tz, agents: AGENTS, admin: true, jewishCalendar: false }];
  await fs.writeFile(usersFile, JSON.stringify(users, null, 2) + '\n', { mode: 0o600 });
  return { token, usersFile };
}

/** The foreman's own paths. AHI_HOME is the owner's folder for the server; the foreman lives in AHI_OS. */
function foremanEnv({ managed, serverDir, port }) {
  return {
    FM_AHI_HOME: managed,
    FOREMAN_ROOT: path.join(managed, 'foreman'),
    FM_USERS_JSON: path.join(managed, 'state', 'users.json'),
    GATEWAY_URL: `http://127.0.0.1:${port || DEFAULT_PORT}`,
    FOREMAN_ANSWERED_SCRIPT: path.join(managed, 'foreman', 'bin', 'build_answered.sh'),
    ...(serverDir ? { FM_GATEWAY_DIR: serverDir } : {}),
  };
}

/** Prepare the foreman: runtime folders, the owner's QUEUE.md and ACTIVE-GATES.md if absent. Never fatal: rerun
 * AHI_OS/foreman/bin/fm_setup.sh by hand to see what it reports. */
function setupForeman({ managed, serverDir, port }) {
  spawnSync('bash', [path.join(managed, 'foreman', 'bin', 'fm_setup.sh')], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...foremanEnv({ managed, serverDir, port }) },
    stdio: 'ignore', timeout: 60000,
  });
}

// Operating-system context the server's own child processes need (Windows cannot start programs or find its temp
// folder without these). Copied when present; nothing else from Setup's environment is inherited.
const OS_ENV = ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'];

/** The environment the AHI server runs with: every path inside the hidden OS folder; the brain's own sign-in home. */
function serverEnv({ managed, root, port, claude, extra, serverDir }) {
  return {
    ...Object.fromEntries(OS_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
    PATH: [claude?.binDir, path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
    HOME: claude?.home || process.env.HOME || process.env.USERPROFILE || managed,
    USERPROFILE: claude?.home || process.env.USERPROFILE || managed,
    NODE_ENV: 'production',
    GATEWAY_PORT: String(port || DEFAULT_PORT),
    GATEWAY_MODE: 'polling',
    AHI_APP_URL: extra?.AHI_APP_URL || `http://localhost:${port || DEFAULT_PORT}`,
    AHI_AI_ROOT: managed,
    AHI_HOME: root,
    AHI_WORK_ROOT: root,
    AHI_USERS_FILE: path.join(managed, 'state', 'users.json'),
    AHI_GATEWAY_STATE_DIR: path.join(managed, 'state'),
    AHI_GATEWAY_BUSINESS_DIR: path.join(managed, 'state', 'business'),
    AHI_GATEWAY_LOCK_PATH: path.join(managed, 'logs', 'gateway.pid'),
    AHI_TURN_LOG_DIR: path.join(managed, 'logs'),
    ...(claude?.bin ? { AHI_CLAUDE_BIN: claude.bin } : {}),
    ...(existsSync(path.join(managed, 'foreman', 'bin', 'lib.sh'))
      ? { ...foremanEnv({ managed, serverDir, port }), ...(claude?.bin ? { AHI_FM_CLAUDE_BIN: claude.bin } : {}) } : {}),
    ...(extra || {}),
  };
}

/** Which AHI home a server belongs to, as its /health reports it (src/index.ts): a hash, never the path itself. */
const homeId = (managed) => crypto.createHash('sha256').update(managed).digest('hex').slice(0, 16);

/** The /health body of whatever answers on the port ({} if it is not an AHI server), or null if nothing answers. */
async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json().catch(() => ({})) : {};
  } catch { return null; }
}

/** Start the AHI server (unless THIS home's server already answers on the port) and wait for it. Returns { url, child|null }. */
async function start({ node, serverDir, managed, root, port = DEFAULT_PORT, claude, extra, log }) {
  const url = `http://localhost:${port}/`;
  const home = homeId(managed);
  const running = await health(port);
  if (running?.home === home) return { url, child: null };
  if (running) throw Error(`Another program is already using port ${port}. Close it, or start AHI Setup with AHI_PORT set to a free port.`);
  const cannotStart = (e) => Error(`AHI could not start (${e.code || e.name}). Reinstall AHI Setup and try again.`);
  const out = await fs.open(path.join(managed, 'logs', 'ahi-server.log'), 'a');
  const closeLog = () => out.close().catch(() => {}); // a second close is a no-op rejection
  let child, failure = null;
  try {
    child = spawn(node, [path.join(serverDir, 'dist', 'index.js')], {
      cwd: serverDir, env: serverEnv({ managed, root, port, claude, extra, serverDir }), stdio: ['ignore', out.fd, out.fd], windowsHide: true,
    });
  } catch (e) { closeLog(); throw cannotStart(e); }
  // A missing or unlaunchable Node arrives as 'error', not as an exception: report it instead of crashing Setup.
  child.once('error', (e) => { failure = e; closeLog(); });
  child.once('exit', closeLog);
  for (let i = 0; i < 120; i++) {
    if (failure) throw cannotStart(failure);
    if (child.exitCode !== null) throw Error('AHI stopped while starting. Its log is in AHI_OS/logs/ahi-server.log.');
    const h = await health(port);
    if (h?.home === home) { log?.(`AHI is running on ${url}`); return { url, child }; }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw Error('AHI did not answer within a minute. Its log is in AHI_OS/logs/ahi-server.log.');
}

module.exports = { install, start, serverEnv, foremanEnv, homeId, AGENTS, DEFAULT_PORT };
