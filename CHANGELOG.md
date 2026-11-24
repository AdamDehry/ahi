# Changelog

## 0.2.5

**AHI speaks Hebrew.** A new **Settings → Language** switches the whole of AHI between English and עברית at
once, with no reload: chat, every page and setting, the sign-in, setup, and the desktop app's start screen, tray
menu and messages. Setup's first screen offers the choice too, and starts in Hebrew when your computer's
language is Hebrew. Your choice is saved with your account, so a new phone or browser opens in it.

**Right to left, properly.** In Hebrew the menu sits on the right, back and forward arrows and the send button
point the other way, and your messages and the agent's swap sides the way WhatsApp does. Names, numbers, links,
code and file names keep reading left to right inside Hebrew sentences. In either language, every message
reads in its own direction, paragraph by paragraph, and so does the message box as you type.

**Agents answer in your language.** When you choose Hebrew, the agents answer in Hebrew, and switch when you
write to them in another language. In English nothing changes.

**Voice in Hebrew where your setup can.** Calls listen and speak in the language of the person calling. With an
OpenAI key, calls understand spoken Hebrew (Cartesia's live listener hears English only). Google recognition
listens in Hebrew. Cartesia speaks each reply in the language it is written in. Settings → Language tells you
plainly what your voice setup can do in Hebrew; calls keep working either way.

**Still in English:** some error messages that come from the server itself, remote-access pairing errors and the
terminal sign-in prompt.

**Skills.** New: rtl-language-switch (make an app switchable to Hebrew or another right-to-left language).

## 0.2.4

**One app called AHI.** After setup, opening the app *is* opening AHI: it starts quietly and shows AHI in its
own window, already signed in, instead of the setup screens and a browser tab. Setup appears only the first
time, or from the tray menu. The app, its window, the Start menu entry and the desktop shortcut are all named AHI.
Your saved setup, folder and sign-ins carry over when you install this over 0.2.3.

**AHI keeps running.** Closing the window leaves AHI running in the tray (the menu bar on a Mac), so the browser
and your phone keep working. AHI starts by itself when you log in; turn that off in the tray menu. **Quit AHI**
in the tray menu really stops it, cleanly. Opening AHI a second time brings up the window that is already open.

**When AHI can't start, it says why.** The window shows the reason in plain words with **Retry**, and the reason
is written to AHI's log. A lock left behind by an AHI that was shut down abruptly is cleared and the start tried
once more by itself.

**Windows fixes.**
- AHI no longer tries to write its settings into the Program Files folder. On Windows that failed on every
  start, which switched off memory search between conversations and the agents' permission to run their skills.
  The settings now live in your AHI folder, and folder names with spaces (like "My AI") work.
- The installer adds AHI to the Start menu on every install and update.

**Safer sign-in.** Before the app hands AHI your key, the server on AHI's port has to prove it is your own AHI,
using a check only your AHI can answer; the key itself is never sent to anything that hasn't passed it. A failed
or slow sign-in shows on the start screen with Retry, never as a signed-out window.

**After updating from 0.2.3.** Delete any Startup shortcut you made by hand (AHI starts at login by itself now).
If you installed AHI from the browser as a web app, you can uninstall that copy: the AHI app opens signed in. It
still works if you keep it, because AHI stays running.

**Skills.** New: wordmark-social-icon (turn a site's text logo into a matching square social profile icon) and
zero-dep-pdf-sheet (print-quality PDFs from Node with no dependencies). headless-browser-on-vps 1.5.0: drive a
real Electron desktop app headless on a server. safe-shell-hygiene 1.0.1.

## 0.2.3

**The builder is now Zali.** The builder agent is renamed from Tzali to Zali, because the old name is
hard to say to voice dictation and hard to hear. Same agent, same role. Existing installs migrate on
their own the first time the server starts: folders, files and settings keys that use the old name are
renamed once, nothing is overwritten or deleted, and old environment variable names and briefs still work.

**Better on a phone.**
- Home fits the screen and never scrolls sideways.
- A banner you dismiss stays dismissed, after a refresh and across tabs, until there is a new question.
  Marking a notification as seen dismisses its banner too.
- An open conversation takes the whole screen, with Back at the top left and the message box at the bottom.
  Banners no longer cover a chat or the top of a page.
- Pictures in a chat are sharp, sit in tidy fixed tiles, and a long page shows its top instead of a thin strip.
- Voice notes are a clean player with no outline or bubble around them.
- The picture viewer opens full screen above everything: swipe on a phone, arrows on a computer,
  Save, and Show in chat.
- Shared media is a square thumbnail grid that opens the viewer, and shows "Loading..." instead of "0 items".

**Setup.** The installers are now named with the release version (they said 0.1.0 before), and a release
refuses to build if the app, web app, Setup app and skills disagree on the version.

**Skills.** headless-browser-on-vps 1.4.0: render real components and the whole web app with demo data in
a throwaway harness, and measure before/after instead of eyeballing.
