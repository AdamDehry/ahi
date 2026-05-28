#!/usr/bin/env node
/**
 * AHI Suite — interactive install wizard.
 *
 * Cross-platform (macOS / Linux / Windows). No external dependencies — uses
 * only Node built-ins so it can run before `npm install` does anything.
 *
 * Flow (matches handoff §"install.sh — The Wizard"):
 *   1. About you (name + optional context)
 *   2. Claude Code reminder
 *   3. Agent selection
 *   4. Telegram (optional)
 *   5. Voice provider selection
 *   6. Install — copy/template files, write .env (chmod 600), npm ci,
 *      register LaunchAgent (mac) / scheduled task (Windows), start gateway
 *
 * Non-interactive mode: set AHI_NONINTERACTIVE=1 plus the answer env vars
 * documented at the bottom of this file. Used by the smoke test in CI and
 * by repeat installs.
 *
 * Refuses to install into dangerous AHI_HOME values (`/`, `~`, `$HOME`, "").
 */

'use strict';

const fs        = require('fs');
const fsp       = require('fs/promises');
const path      = require('path');
const os        = require('os');
const readline  = require('readline');
const { execSync, spawnSync } = require('child_process');
const crypto    = require('crypto');

// ─── Constants ────────────────────────────────────────────────────────────
const REPO_DIR  = path.resolve(__dirname, '..', '..');
const PLATFORM  = process.platform; // 'darwin' | 'linux' | 'win32'
const IS_MAC    = PLATFORM === 'darwin';
const IS_WIN    = PLATFORM === 'win32';
const NONINTER  = process.env.AHI_NONINTERACTIVE === '1';
const DEFAULT_HOME = path.join(os.homedir(), 'ahi');
const AGENTS = [
  { key: 'michael', label: 'Michael', role: 'coordinator / strategist', tokenEnv: 'MICHAEL_BOT_TOKEN' },
  { key: 'tzali', label: 'Tzali', role: 'builder / engineer', tokenEnv: 'TZALI_BOT_TOKEN' },
  { key: 'avi', label: 'Avi', role: 'designer / visual conscience', tokenEnv: 'AVI_BOT_TOKEN' },
];
const DEFAULT_AGENTS = AGENTS.map((a) => a.key);

const COLOR = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
};

function color(c, s) {
  if (!process.stdout.isTTY) return s;
  return `${COLOR[c] || ''}${s}${COLOR.reset}`;
}

function log(msg)   { process.stdout.write(msg + '\n'); }
function ok(msg)    { log(color('green', '  ✓ ') + msg); }
function info(msg)  { log(color('blue',  '  i ') + msg); }
function warn(msg)  { log(color('yellow','  ! ') + msg); }
function fail(msg)  { log(color('red',   '  ✗ ') + msg); }
function header(t)  { log(''); log(color('bold', t)); log('-'.repeat(t.length)); }

// ─── Readline helpers (with masked input) ─────────────────────────────────
let rl;
function getRl() {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}

function ask(prompt, defaultValue) {
  if (NONINTER) return Promise.resolve(defaultValue || '');
  return new Promise((resolve) => {
    const suffix = defaultValue ? color('dim', ` [${defaultValue}]`) : '';
    getRl().question(`${prompt}${suffix} `, (answer) => {
      resolve((answer || '').trim() || defaultValue || '');
    });
  });
}

/**
 * Ask for a secret — never echoed, never logged. Implemented by setting raw
 * mode and consuming bytes manually so paste-with-Enter still works.
 */
function askSecret(prompt) {
  if (NONINTER) return Promise.resolve('');
  return new Promise((resolve) => {
    process.stdout.write(prompt + ' ');
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      // Fallback for piped input — read one line plain (used in test mode).
      getRl().question('', (a) => resolve(a.trim()));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      // Ctrl-C
      if (ch === '') { process.stdout.write('\n'); process.exit(130); }
      // Enter
      if (ch === '\r' || ch === '\n') {
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write('\n');
        resolve(buf.trim());
        return;
      }
      // Backspace / delete
      if (ch === '' || ch === '\b') {
        if (buf.length > 0) buf = buf.slice(0, -1);
        return;
      }
      buf += ch;
      // Echo a mask char so the user sees keypresses register.
      process.stdout.write('*');
    };
    stdin.on('data', onData);
  });
}

async function confirm(prompt, defaultYes = false) {
  if (NONINTER) return defaultYes;
  const def = defaultYes ? 'Y/n' : 'y/N';
  // Loop on invalid input so a typo doesn't silently flip a destructive choice.
  while (true) {
    const ans = (await ask(`${prompt} (${def})`, '')).toLowerCase();
    if (!ans) return defaultYes;
    if (ans === 'y' || ans === 'yes') return true;
    if (ans === 'n' || ans === 'no') return false;
    log(color('yellow', '  Please answer y or n.'));
  }
}

// ─── Safety: AHI_HOME validation ──────────────────────────────────────────
//
// Resolves symlinks before checking against the dangerous-paths list, so a
// symlink at AHI_HOME → / can't slip past as a non-matching string. We
// realpath the deepest existing ancestor (the path itself may not exist
// yet on a fresh install) to catch symlinked parents.
function refuseDangerousHome(homePath) {
  const trimmed = (homePath || '').trim();
  if (!trimmed) throw new Error('AHI_HOME cannot be empty.');
  // Reject literal "~" / "$HOME" — these come from the user not expanding them.
  if (trimmed === '~' || trimmed === '$HOME' || trimmed === '%USERPROFILE%') {
    throw new Error(`AHI_HOME must be an expanded path, not a literal "${trimmed}".`);
  }
  let normalized = path.resolve(trimmed);
  // Walk up to the deepest ancestor that exists, realpath it, then re-append
  // the missing tail. This catches a symlinked parent like /tmp -> /.
  let cursor = normalized;
  let suffix = '';
  while (!fs.existsSync(cursor)) {
    const next = path.dirname(cursor);
    if (next === cursor) break; // hit filesystem root
    suffix = path.join(path.basename(cursor), suffix);
    cursor = next;
  }
  try {
    const realCursor = fs.realpathSync.native(cursor);
    normalized = suffix ? path.join(realCursor, suffix) : realCursor;
  } catch {
    // realpath failed (permissions, ENOENT race) — fall through with
    // the lexical resolve, which is still safer than nothing.
  }
  // EXACT-match list only. We do not block subdirectories — `/tmp/foo` is
  // fine, `/tmp` itself is not. A subdirectory of $HOME is fine; $HOME
  // itself would clobber dotfiles.
  const dangerous = new Set([
    '/',
    '/Users',
    '/home',
    '/root',
    '/tmp',
    '/var',
    '/etc',
    os.homedir(),
    'C:\\',
    'C:\\Users',
    'C:\\Windows',
  ]);
  if (dangerous.has(normalized) || normalized === path.parse(normalized).root) {
    throw new Error(
      `Refusing to install into "${normalized}" — too close to a system root. ` +
      `Pick a dedicated subdirectory (the default ~/ahi is safe).`
    );
  }
  return normalized;
}

// ─── Idempotency: detect existing install ────────────────────────────────
function detectExisting(homeDir) {
  const markers = [
    path.join(homeDir, 'gateway', 'package.json'),
    path.join(homeDir, '.env'),
    path.join(homeDir, 'agents', 'soul', 'MICHAEL.md'),
  ];
  return markers.filter((m) => fs.existsSync(m));
}

// ─── Step 1 — About you ──────────────────────────────────────────────────
async function stepAboutYou() {
  header('Step 1/6 — About you');
  log('');
  const name    = (await ask('What is your name?', process.env.AHI_USER_NAME || '')) || 'Friend';
  const ctx     = await ask('What do you do? (optional, press Enter to skip)',
                            process.env.AHI_USER_CONTEXT || '');
  return { name, context: ctx };
}

// ─── Step 2 — Claude Code reminder ───────────────────────────────────────
async function stepClaudeReminder() {
  header('Step 2/6 — Claude Code');
  log('');
  log('  Make sure Claude Code is installed and you are signed in with a');
  log('  Max subscription. Install from https://claude.ai/download');
  log('');
  if (!NONINTER) await ask('Press Enter when ready', '');
}

// ─── Step 3 — Agent selection ───────────────────────────────────────────
function parseAgentSelection(raw) {
  const normalized = (raw || '').trim().toLowerCase();
  if (!normalized || normalized === 'all') return [...DEFAULT_AGENTS];
  const selected = [];
  for (const part of normalized.split(',')) {
    const v = part.trim();
    if (!v) continue;
    const byIndex = /^\d+$/.test(v) ? AGENTS[parseInt(v, 10) - 1] : null;
    const byKey = AGENTS.find((a) => a.key === v || a.label.toLowerCase() === v);
    const agent = byIndex || byKey;
    if (!agent) continue;
    if (!selected.includes(agent.key)) selected.push(agent.key);
  }
  return selected.length > 0 ? selected : [...DEFAULT_AGENTS];
}

async function stepAgents() {
  header('Step 3/6 — Agents');
  log('');
  log('  Choose which AHI agents to enable for this install.');
  for (let i = 0; i < AGENTS.length; i++) {
    const a = AGENTS[i];
    log(`    [${i + 1}] ${a.label} — ${a.role}`);
  }
  log('');
  if (NONINTER) {
    const raw = process.env.AHI_AGENTS || process.env.AHI_ENABLED_AGENTS || '';
    if (raw) return parseAgentSelection(raw);
    const withTokens = AGENTS.filter((a) => process.env[a.tokenEnv]).map((a) => a.key);
    return withTokens.length > 0 ? withTokens : [...DEFAULT_AGENTS];
  }
  const answer = await ask('Enable agents (comma-separated names/numbers, or "all")', 'all');
  return parseAgentSelection(answer);
}

// ─── Step 4 — Telegram ──────────────────────────────────────────────────
async function stepTelegram(agents) {
  header('Step 4/6 — Telegram (optional)');
  log('');
  log('  Telegram lets you message your AHI agents from your phone.');
  log('  Each enabled agent uses its own Telegram bot token from @BotFather.');
  log('');
  const selected = AGENTS.filter((a) => agents.includes(a.key));
  const tokens = {};
  for (const a of selected) tokens[a.key] = '';
  // Non-interactive: honour provided per-agent token env vars.
  if (NONINTER) {
    for (const a of selected) tokens[a.key] = process.env[a.tokenEnv] || '';
    const userId = process.env.USER_TELEGRAM_ID || '';
    return { enabled: Object.values(tokens).some(Boolean), tokens, userId };
  }
  const useTg = await confirm('Connect selected agents to Telegram?', false);
  if (!useTg) return { enabled: false, tokens, userId: '' };
  log('');
  for (const a of selected) {
    tokens[a.key] = await askSecret(`Paste ${a.label}'s Telegram bot token (from BotFather):`);
  }
  log('  Find your numeric Telegram user id by messaging @userinfobot.');
  const userId = await ask('Your numeric Telegram user id:', process.env.USER_TELEGRAM_ID || '');
  return { enabled: true, tokens, userId };
}

// ─── Step 5 — Voice ─────────────────────────────────────────────────────
async function stepVoice() {
  header('Step 5/6 — Voice (optional)');
  log('');
  log('  Voice lets your AHI agents respond out loud. Choose a provider:');
  log('    [1] OpenAI');
  log('    [2] Gemini');
  log('    [3] Both');
  log('    [4] Skip');
  log('');
  const out = { openai: '', gemini: '' };
  // Non-interactive: read provided keys directly (never prompt; never echo).
  if (NONINTER) {
    out.openai = process.env.OPENAI_API_KEY || '';
    out.gemini = process.env.GEMINI_API_KEY || '';
    return out;
  }
  // Loop until a valid choice — silently accepting an invalid input as
  // "skip" hides setup mistakes that surface later as broken voice.
  let choice = '';
  while (true) {
    choice = (await ask('Choice', process.env.AHI_VOICE_CHOICE || '4')).trim();
    if (['1', '2', '3', '4'].includes(choice)) break;
    log(color('yellow', '  Please choose 1, 2, 3, or 4.'));
  }
  if (choice === '1' || choice === '3') {
    out.openai = await askSecret('Paste your OpenAI API key:');
  }
  if (choice === '2' || choice === '3') {
    out.gemini = await askSecret('Paste your Gemini API key:');
  }
  return out;
}

// ─── Step 6 — Install ────────────────────────────────────────────────────
async function stepInstall(answers) {
  header('Step 6/6 — Installing');
  log('');

  const homeDir = refuseDangerousHome(process.env.AHI_HOME || DEFAULT_HOME);
  info(`Target directory: ${homeDir}`);

  // Idempotency check.
  const existing = detectExisting(homeDir);
  if (existing.length > 0 && !NONINTER) {
    warn(`Detected an existing install at ${homeDir}.`);
    const cont = await confirm('Upgrade in place? (Your .env will be backed up)', true);
    if (!cont) {
      throw new Error('Aborted by user. Re-run when ready.');
    }
    // Back up .env if present
    const envPath = path.join(homeDir, 'gateway', '.env');
    if (fs.existsSync(envPath)) {
      const backup = `${envPath}.bak-${Date.now()}`;
      fs.copyFileSync(envPath, backup);
      ok(`Backed up existing gateway/.env -> ${path.basename(backup)}`);
    }
  }

  // Create the tree.
  await fsp.mkdir(homeDir, { recursive: true });
  await fsp.mkdir(path.join(homeDir, 'state'), { recursive: true });
  await fsp.mkdir(path.join(homeDir, 'state', 'logs'), { recursive: true });
  await fsp.mkdir(path.join(homeDir, 'state', 'primary'), { recursive: true });
  ok('Created directory tree at ' + homeDir);

  // Copy repo contents into homeDir (skip node_modules, dist, .git, .env files).
  await copyRepo(REPO_DIR, homeDir);
  ok('Copied AHI Suite source files');

  // Personalize CLAUDE.md and shipped soul files.
  await personalize(homeDir, answers);
  ok('Personalized CLAUDE.md and soul files');

  // Generate gateway/.env from template + answers, chmod 600.
  await writeEnv(homeDir, answers);
  ok('Wrote gateway/.env with user-only permissions (chmod 600)');

  // Generate gateway/config/users.json (single primary user, random token).
  await writeUsersConfig(homeDir, answers);
  ok('Wrote gateway/config/users.json');

  // Install gateway dependencies (npm ci preferred, fallback to npm install
  // when no lockfile is present in the shipped repo).
  info('Installing gateway dependencies — this may take a minute...');
  const gatewayDir = path.join(homeDir, 'gateway');
  const hasLock = fs.existsSync(path.join(gatewayDir, 'package-lock.json'));
  const npmCmd = hasLock ? 'ci' : 'install';
  const npmRes = spawnSync(IS_WIN ? 'npm.cmd' : 'npm', [npmCmd, '--no-audit', '--no-fund'], {
    cwd: gatewayDir,
    stdio: NONINTER ? 'pipe' : 'inherit',
    env: { ...process.env },
  });
  if (npmRes.status !== 0) {
    throw new Error(`npm ${npmCmd} failed in ${gatewayDir}`);
  }
  ok('Installed gateway dependencies');

  // Build TypeScript.
  info('Building gateway...');
  const buildRes = spawnSync(IS_WIN ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: gatewayDir,
    stdio: NONINTER ? 'pipe' : 'inherit',
    env: { ...process.env },
  });
  if (buildRes.status !== 0) {
    throw new Error('gateway build failed (npm run build)');
  }
  ok('Built gateway');

  // Register service (LaunchAgent on macOS; Linux/Windows guidance only).
  // In non-interactive mode (CI / smoke test) we skip service registration
  // so the test never overwrites a real production LaunchAgent on the
  // host machine. Set AHI_REGISTER_LAUNCHAGENT=1 to opt in explicitly.
  const registerService = !NONINTER || process.env.AHI_REGISTER_LAUNCHAGENT === '1';
  if (IS_MAC && registerService) {
    await registerLaunchAgent(homeDir);
  } else if (IS_MAC) {
    info('Skipped LaunchAgent registration (non-interactive mode). ' +
         'To register manually: launchctl load -w ~/Library/LaunchAgents/ai.ahi.gateway.plist');
  } else if (IS_WIN) {
    info('Windows: see README for scheduling the gateway with Task Scheduler.');
  } else {
    info('Linux: see README for systemd unit setup.');
  }

  log('');
  log(color('green', color('bold', 'Setup complete.')));
  log('');
  log('Open Claude Code, start a new session in this directory, and address the agent you need:');
  log(color('bold', `  Hi Michael, who are you?`));
  if (answers.agents.includes('tzali')) log(color('bold', `  Tzali, inspect this repo.`));
  if (answers.agents.includes('avi')) log(color('bold', `  Avi, review this interface.`));
  log('');
  log(`Your AHI install lives at: ${homeDir}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function copyRepo(src, dest) {
  const SKIP_DIRS = new Set([
    'node_modules', 'dist', '.git', '.DS_Store',
  ]);
  const SKIP_FILES = new Set([
    '.env', '.env.local',
  ]);
  async function walk(curSrc, curDest) {
    const entries = await fsp.readdir(curSrc, { withFileTypes: true });
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const s = path.join(curSrc, e.name);
      const d = path.join(curDest, e.name);
      // Skip symlinks defensively — they could point outside the repo and
      // we don't have a use case for shipping them.
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        await fsp.mkdir(d, { recursive: true });
        await walk(s, d);
      } else if (e.isFile()) {
        if (SKIP_FILES.has(e.name)) continue;
        await fsp.copyFile(s, d);
        // Preserve mode bits — install.sh / wizard.js / hooks need exec bit
        // on Unix, and copyFile uses 0o666 by default which strips it.
        if (!IS_WIN) {
          try {
            const st = await fsp.stat(s);
            await fsp.chmod(d, st.mode & 0o777);
          } catch { /* best-effort */ }
        }
      }
    }
  }
  await walk(src, dest);
}

async function personalize(homeDir, answers) {
  const claudeMd = path.join(homeDir, '.claude', 'CLAUDE.md');
  const soulDir  = path.join(homeDir, 'agents', 'soul');
  const replacements = {
    '{{USER_NAME}}': answers.about.name,
    '{{USER_PRIORITY_FILTER}}': 'Define your own priority filter as you work with Michael.',
    '{{USER_CONTEXT_BLOCK}}': answers.about.context
      ? `- **Context:** ${answers.about.context}`
      : '',
  };
  // Collect every soul file shipped in the repo, not just MICHAEL.md — NESHAMA
  // and AHI-FOUNDATION carry the same {{USER_NAME}} marker and are loaded by
  // claude-invoke on every turn. Missing the substitution there would leave
  // literal "{{USER_NAME}}" tokens in the runtime prompt.
  const targets = [claudeMd];
  try {
    const soulFiles = await fsp.readdir(soulDir);
    for (const f of soulFiles) {
      if (f.endsWith('.md')) targets.push(path.join(soulDir, f));
    }
  } catch { /* soul dir may not exist on a partial install — best-effort */ }
  for (const file of targets) {
    if (!fs.existsSync(file)) continue;
    let text = await fsp.readFile(file, 'utf-8');
    for (const [k, v] of Object.entries(replacements)) {
      text = text.split(k).join(v);
    }
    await fsp.writeFile(file, text);
  }

  // Claude Code's permission rules and hook commands are read literally —
  // the harness does NOT expand $AHI_HOME at request time. Template the
  // settings.json into a runtime copy with the absolute install path so
  // permissions and hooks bind correctly on this machine.
  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    let text = await fsp.readFile(settingsPath, 'utf-8');
    text = text.split('$AHI_HOME').join(homeDir);
    await fsp.writeFile(settingsPath, text);
  }
}

/**
 * Parse a simple KEY=VALUE .env file into an object. Comments and blanks
 * are dropped. Used to merge an existing .env on re-run so a re-install
 * never silently nukes secrets the user added by hand.
 */
function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2];
  }
  return out;
}

async function writeEnv(homeDir, answers) {
  const envPath = path.join(homeDir, 'gateway', '.env');

  // Start by inheriting any existing .env so we never silently lose a key
  // the user pasted by hand. Wizard answers only OVERWRITE when non-empty.
  let existing = {};
  if (fs.existsSync(envPath)) {
    try {
      existing = parseEnvFile(await fsp.readFile(envPath, 'utf-8'));
    } catch {}
  }

  const merged = { ...existing };
  // Always update the canonical install location and user name.
  merged.AHI_HOME = homeDir;
  merged.AHI_USER_NAME = answers.about.name;
  // Only overwrite secrets when we have a fresh value from this run.
  if (answers.telegram.enabled) {
    for (const a of AGENTS) {
      const token = answers.telegram.tokens?.[a.key];
      if (token) merged[a.tokenEnv] = token;
    }
    if (answers.telegram.userId) merged.USER_TELEGRAM_ID = answers.telegram.userId;
  }
  if (answers.voice.openai) {
    merged.OPENAI_API_KEY = answers.voice.openai;
    if (!merged.MICHAEL_TTS_PROVIDER) merged.MICHAEL_TTS_PROVIDER = 'openai';
  }
  if (answers.voice.gemini) {
    merged.GEMINI_API_KEY = answers.voice.gemini;
    if (!merged.MICHAEL_TTS_PROVIDER) merged.MICHAEL_TTS_PROVIDER = 'gemini';
  }
  if (!merged.GATEWAY_PORT) merged.GATEWAY_PORT = '18789';
  if (!merged.GATEWAY_MODE) merged.GATEWAY_MODE = 'polling';

  const header = [
    '# Generated/updated by the AHI Suite install wizard.',
    '# Edit by hand at any time. Restart the gateway after changes.',
    '# Re-running the wizard preserves keys you set here unless you supplied',
    '# a fresh value during the new run.',
    '',
  ].join('\n');
  // Stable ordering for diffability.
  const orderedKeys = [
    'AHI_HOME', 'AHI_USER_NAME',
    'USER_TELEGRAM_ID', 'EXTRA_TELEGRAM_IDS',
    'MICHAEL_BOT_TOKEN', 'TZALI_BOT_TOKEN', 'AVI_BOT_TOKEN',
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_TTS_API_KEY',
    'MICHAEL_TTS_PROVIDER',
    'GATEWAY_PORT', 'GATEWAY_MODE',
  ];
  const seen = new Set();
  const body = [];
  for (const k of orderedKeys) {
    if (k in merged) { body.push(`${k}=${merged[k]}`); seen.add(k); }
  }
  for (const k of Object.keys(merged)) {
    if (seen.has(k)) continue;
    body.push(`${k}=${merged[k]}`);
  }

  // Write to a tmp file with restrictive perms first, then rename — avoids
  // leaving a world-readable .env on the disk while we're writing it.
  const tmp = `${envPath}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, header + body.join('\n') + '\n');
  if (!IS_WIN) {
    await fsp.chmod(tmp, 0o600);
  } else {
    warn('Windows: .env permission hardening is delegated to NTFS ACLs. ' +
         'Verify only your user account can read gateway\\.env.');
  }
  await fsp.rename(tmp, envPath);
}

async function writeUsersConfig(homeDir, answers) {
  const cfgPath = path.join(homeDir, 'gateway', 'config', 'users.json');
  // Preserve the existing primary user's token across re-runs — rotating it
  // every install would invalidate any saved dashboard sessions or external
  // clients keyed off the token. Only mint a new token on a fresh install.
  let existingPrimary = null;
  if (fs.existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(await fsp.readFile(cfgPath, 'utf-8'));
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0].token === 'string') {
        existingPrimary = parsed[0];
      }
    } catch { /* malformed file — fall through and overwrite */ }
  }
  const token = existingPrimary?.token || crypto.randomBytes(32).toString('hex');
  const tgId = parseInt(answers.telegram.userId || '0', 10);
  // Wizard answers OVERWRITE telegram id only when a new value was supplied
  // (mirrors the .env merge policy); otherwise keep what was there.
  const telegramChatId = Number.isFinite(tgId) && tgId > 0
    ? tgId
    : (existingPrimary?.telegramChatId ?? null);
  const chosenAgents = Array.isArray(answers.agents) && answers.agents.length > 0
    ? answers.agents
    : (existingPrimary?.agents || ['michael']);
  const users = [
    {
      token,
      name: answers.about.name || existingPrimary?.name || 'Primary',
      telegramChatId,
      agents: chosenAgents,
      admin: true,
    },
  ];
  await fsp.mkdir(path.dirname(cfgPath), { recursive: true });
  await fsp.writeFile(cfgPath, JSON.stringify(users, null, 2) + '\n');
  if (!IS_WIN) {
    await fsp.chmod(cfgPath, 0o600);
  }
}

async function registerLaunchAgent(homeDir) {
  const tplPath = path.join(homeDir, 'gateway', 'launchagent', 'ai.ahi.gateway.plist.template');
  if (!fs.existsSync(tplPath)) {
    warn('LaunchAgent template missing — skipping autostart registration.');
    return;
  }
  const nodeBin = process.execPath;
  const userName = os.userInfo().username;
  let tpl = await fsp.readFile(tplPath, 'utf-8');
  tpl = tpl.split('__AHI_HOME__').join(homeDir);
  tpl = tpl.split('__USER__').join(userName);
  tpl = tpl.split('__NODE_BIN__').join(nodeBin);
  const dest = path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.ahi.gateway.plist');
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, tpl);
  ok(`Wrote ${dest}`);

  // Idempotent: unload any prior instance, then load.
  try {
    spawnSync('launchctl', ['unload', dest], { stdio: 'pipe' });
  } catch {}
  const load = spawnSync('launchctl', ['load', '-w', dest], { stdio: 'pipe' });
  if (load.status === 0) {
    ok('Registered LaunchAgent — gateway will start automatically on login');
  } else {
    warn(`launchctl load returned ${load.status} — load it manually with:`);
    log(`    launchctl load -w ${dest}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────
(async function main() {
  log('');
  log(color('bold', '┌─────────────────────────────────────┐'));
  log(color('bold', '│   AHI Suite — Setup Wizard          │'));
  log(color('bold', '└─────────────────────────────────────┘'));
  try {
    const answers = {
      about: await stepAboutYou(),
      agents: [],
      telegram: { enabled: false, tokens: {}, userId: '' },
      voice: { openai: '', gemini: '' },
    };
    await stepClaudeReminder();
    answers.agents = await stepAgents();
    answers.telegram = await stepTelegram(answers.agents);
    answers.voice = await stepVoice();
    await stepInstall(answers);
    if (rl) rl.close();
    process.exit(0);
  } catch (err) {
    log('');
    fail(err && err.message ? err.message : String(err));
    if (rl) rl.close();
    process.exit(1);
  }
})();

/*
 * Non-interactive mode reference (set AHI_NONINTERACTIVE=1 to enable):
 *   AHI_HOME              — install destination (default ~/ahi)
 *   AHI_USER_NAME         — Step 1 name (default "Friend")
 *   AHI_USER_CONTEXT      — Step 1 free-form context (default empty)
 *   AHI_AGENTS            — comma-separated enabled agents; default uses
 *                           provided bot tokens, then all agents
 *   USER_TELEGRAM_ID      — Step 4 numeric Telegram id (optional)
 *   MICHAEL_BOT_TOKEN     — optional Telegram token for Michael
 *   TZALI_BOT_TOKEN       — optional Telegram token for Tzali
 *   AVI_BOT_TOKEN         — optional Telegram token for Avi
 *   AHI_VOICE_CHOICE      — Step 5 choice "1"|"2"|"3"|"4" (default "4")
 * In non-interactive mode all secret prompts return empty (no stdin
 * available), so Telegram/voice keys must be set via .env afterward.
 */
