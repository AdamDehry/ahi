# Changelog

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
