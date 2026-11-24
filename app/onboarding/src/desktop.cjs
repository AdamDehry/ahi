// The desktop shell's decisions, kept out of main.cjs so they can be tested without Electron.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

/** What a page of this app may ask the main process for: the setup screens everything, the start screen only
 * "start" and "setup", anything else (AHI's own pages included) nothing. */
function allowedCall(pageUrl, method, { setupUrl, startUrl }) {
  if (pageUrl === setupUrl) return true;
  if (pageUrl === startUrl) return method === 'start' || method === 'setup';
  return false;
}

/** Sign the AHI window in with the owner's key through the server's own login (it sets its own session cookie in
 * the window's cookie store). Skipped when the window is already signed in or there is no key. `fetcher` is the
 * window session's fetch, so the cookie lands where the window reads it. Returns true if it signed in. */
async function signIn(fetcher, url, token) {
  if (!token) return false;
  // credentials: 'include' = send and keep this session's cookies (Electron's fetch keeps none by default).
  const session = await fetcher(new URL('ui/session', url).href, { credentials: 'include' });
  if (session.ok) return false;
  const r = await fetcher(new URL('ui/login', url).href, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  return r.ok;
}

/** Linux has no login-item API: an XDG autostart entry that starts the AppImage hidden. Removed when off. */
async function linuxAutostart(on, { appImage = process.env.APPIMAGE, dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart') } = {}) {
  const file = path.join(dir, 'ahi.desktop');
  if (!on || !appImage) return fs.rm(file, { force: true });
  await fs.mkdir(dir, { recursive: true });
  const quoted = `"${appImage.replace(/(["`$\\])/g, '\\$1')}"`;
  await fs.writeFile(file, `[Desktop Entry]\nType=Application\nName=AHI\nComment=Keeps AHI running\nExec=${quoted} --hidden\nX-GNOME-Autostart-enabled=true\n`);
}

module.exports = { allowedCall, signIn, linuxAutostart };
