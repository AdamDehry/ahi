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
 * the window's cookie store), and confirm the session holds. `fetcher` is the window session's fetch, so the cookie
 * lands where the window reads it. Call it only after the server proved it is this home's (ahi-runtime serves()).
 * Resolves 'already' or 'signed-in'; anything else throws a reason for the start screen (never an unsigned window).
 * No redirects (a 307 would carry the key elsewhere) and every request is bounded in time. */
async function signIn(fetcher, url, token, timeoutMs = 10000) {
  if (!token) throw Error('This AHI home has no owner key. Open setup and finish it again.');
  // credentials: 'include' = send and keep this session's cookies (Electron's fetch keeps none by default).
  const ask = async (pathname, extra = {}) => {
    try { return await fetcher(new URL(pathname, url).href, { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), ...extra }); }
    catch { throw Error('AHI started but did not answer the sign-in. Press Retry.'); }
  };
  if ((await ask('ui/session')).ok) return 'already';
  const login = await ask('ui/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  if (!login.ok) throw Error(login.status === 401 ? 'AHI did not accept this home\'s owner key. Open setup and finish it again.' : `AHI could not sign you in (it answered ${login.status}). Press Retry.`);
  if (!(await ask('ui/session')).ok) throw Error('AHI accepted the key but the window could not stay signed in. Press Retry.');
  return 'signed-in';
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
