#!/usr/bin/env node
/**
 * AHI Suite — uninstaller.
 *
 *   - Unloads the LaunchAgent (macOS) and removes the plist.
 *   - Backs up gateway/.env to ~/ahi.env.bak-<timestamp>.
 *   - Removes the install directory (default ~/ahi, or AHI_HOME if set).
 *
 * Refuses to delete dangerous paths (`/`, `~`, `$HOME`, etc.).
 */

'use strict';

const fs   = require('fs');
const fsp  = require('fs/promises');
const path = require('path');
const os   = require('os');
const readline = require('readline');
const { spawnSync } = require('child_process');

const PLATFORM = process.platform;
const IS_MAC   = PLATFORM === 'darwin';
const HOME_DIR = process.env.AHI_HOME || path.join(os.homedir(), 'ahi');

function refuseDangerousHome(homePath) {
  const trimmed = (homePath || '').trim();
  if (!trimmed) throw new Error('AHI_HOME cannot be empty.');
  if (trimmed === '~' || trimmed === '$HOME' || trimmed === '%USERPROFILE%') {
    throw new Error(`AHI_HOME must be an expanded path, not literal "${trimmed}".`);
  }
  let normalized = path.resolve(trimmed);
  // Resolve symlinks so a symlinked AHI_HOME -> / can't smuggle through.
  try {
    normalized = fs.realpathSync.native(normalized);
  } catch { /* path may not exist; lexical resolve is the fallback */ }
  const dangerous = new Set([
    '/', '/Users', '/home', '/root', '/tmp', '/var', '/etc',
    os.homedir(), 'C:\\', 'C:\\Users', 'C:\\Windows',
  ]);
  if (dangerous.has(normalized) || normalized === path.parse(normalized).root) {
    throw new Error(`Refusing to delete "${normalized}" — too close to a system root.`);
  }
  return normalized;
}

/**
 * Confirm the directory looks like an AHI install before we delete it. A
 * typo in AHI_HOME could otherwise nuke an unrelated project. Require both
 * the gateway package.json and Michael's soul to be present, unless the
 * caller sets AHI_FORCE_UNINSTALL=1.
 */
function requireInstallMarkers(target) {
  if (process.env.AHI_FORCE_UNINSTALL === '1') return;
  const markers = [
    path.join(target, 'gateway', 'package.json'),
    path.join(target, 'agents', 'soul', 'MICHAEL.md'),
  ];
  const missing = markers.filter((m) => !fs.existsSync(m));
  if (missing.length > 0) {
    throw new Error(
      `${target} does not look like an AHI install (missing markers: ` +
      `${missing.map((m) => path.relative(target, m)).join(', ')}). ` +
      `Set AHI_FORCE_UNINSTALL=1 to override.`
    );
  }
}

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (a) => { rl.close(); resolve((a || '').trim()); });
  });
}

(async function main() {
  try {
    const target = refuseDangerousHome(HOME_DIR);
    if (!fs.existsSync(target)) {
      console.log(`No install found at ${target}. Nothing to do.`);
      process.exit(0);
    }
    requireInstallMarkers(target);
    if (process.env.AHI_NONINTERACTIVE !== '1') {
      const ans = await ask(`Remove AHI install at ${target}? Type YES to confirm: `);
      if (ans !== 'YES') {
        console.log('Aborted.');
        process.exit(1);
      }
    }

    // Unload + remove LaunchAgent (macOS). Only when this install owns it —
    // we check the plist's WorkingDirectory points at the same target, so a
    // separate AHI install on the same machine won't be killed by our
    // uninstall.
    if (IS_MAC && process.env.AHI_NONINTERACTIVE !== '1') {
      const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.ahi.gateway.plist');
      if (fs.existsSync(plist)) {
        let owned = false;
        try {
          const text = fs.readFileSync(plist, 'utf-8');
          // Simple substring match — the plist format is XML, but the
          // WorkingDirectory entry contains the target as a literal string.
          owned = text.includes(`<string>${target}/gateway</string>`) ||
                  text.includes(`<string>${target}</string>`);
        } catch { /* unreadable plist — leave it alone */ }
        if (owned) {
          spawnSync('launchctl', ['unload', plist], { stdio: 'pipe' });
          await fsp.unlink(plist);
          console.log(`  removed ${plist}`);
        } else {
          console.log(`  left ${plist} alone (does not point at ${target})`);
        }
      }
    } else if (IS_MAC) {
      console.log('  skipped LaunchAgent removal (non-interactive mode)');
    }

    // Back up .env if present.
    const envPath = path.join(target, 'gateway', '.env');
    if (fs.existsSync(envPath)) {
      const backup = path.join(os.homedir(), `ahi.env.bak-${Date.now()}`);
      await fsp.copyFile(envPath, backup);
      console.log(`  backed up gateway/.env -> ${backup}`);
    }

    // Remove install dir.
    await fsp.rm(target, { recursive: true, force: true });
    console.log(`  removed ${target}`);
    console.log('AHI uninstalled.');
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
})();
