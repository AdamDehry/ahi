# Native setup checklist

Run this checklist only on a fresh test installation with an empty test home. It is an acceptance test: it does not migrate an existing installation, restart a production service, rotate keys or publish anything.

> Stop and ask the owner before any of these, whatever a step says: live credential rotation, a production deploy or cutover, deleting material that may be the only copy, permanently removing a worktree, rewriting history, or migrating a live installation.

**Execution ownership:** the owner directly performs every account sign-in, key entry, keychain prompt and authenticated Cloudflare operation. No agent receives, reads, screenshots, echoes or transmits a live credential; an agent records only pass/fail and non-secret observations.

1. Use a fresh macOS test user or a disposable Mac with no current AHI state. Build the matching architecture using the manual installer workflow, or run the following commands from a fresh checkout. Do not push a tag or publish a release. The workflow’s DMG is unsigned review output; notarized distribution is separate work.

   ```sh
   cd onboarding
   npm ci --include=dev
   npm test
   npm run stage:runtime
   npm run test:native
   npm run dist -- --mac --arm64
   ```

   On Intel, replace `--arm64` with `--x64`. The automated native smoke opens a test window, overrides only its folder chooser to a temporary folder inside the checkout, and proves the real service creates the expected directories. It does not log in or write to Keychain. Screenshots contain only that sandbox.

2. Mount the DMG, drag AHI Setup to Applications, and open it. It must open Your space without requiring a separately installed Node, npm or browser app. Test the Intel DMG on Intel and the Apple Silicon DMG on Apple Silicon. Verify the application icon and installer artifact names.
3. Enter a test name/workspace, quit, reopen, and verify the draft resumes. Use an empty test parent with spaces and punctuation. Verify the resolved AHI root, Personal, Work and AHI_OS. Try a parent containing an existing nonempty AHI folder: the app must refuse and preserve its contents. Cancel the picker and verify no folder appears. Never select the existing production AHI root.
4. **the owner directly:** connect Gemini alone first. Install its official CLI, open sign-in, and complete the provider’s browser/terminal flow. Check connection; it must succeed, yet Continue must stay blocked until Claude is connected (the agents run on Claude). Repeat with Codex, then Claude, including a cancelled browser login and an account without quota. A login that cannot answer must remain unavailable. Verify current provider terms and account eligibility through the linked official guides.
5. Confirm Claude is the default brain. Back/forward, quit/reopen, and verify the chosen provider and unfinished model queue survive. Open Review beside a connected model and recheck it. Do not log out of or revoke any production provider account for this test; use only the test account/session.
6. **the owner directly:** enter a test voice key, verify and save. Confirm it is in macOS Keychain under the app service, absent from setup JSON/handoff and absent from screenshots/terminal history. Close/reopen the app and confirm the credential can be retrieved by the native binding under the same app signature. No screenshot of Keychain details or provider dashboards is needed. A failed/restricted key must not appear connected. ElevenLabs requires permission for the account endpoint used by verification. Real speech playback remains a separate runtime acceptance test.
7. With the test user’s keychain locked/unavailable, verify saving refuses by default. Only after **the owner directly** checks the explicit environment-file consent should fallback be written. Inspect permissions by mode/ACL only, never by printing the key. Do not rotate any live key. Skip voice and confirm setup still finishes.
8. Skip remote access and all connections once. Finish twice; confirm one stable setup handoff and no duplicate home. The saved page must say the agent runtime is pending, without inventing a chat, owner token or connected account.
9. **the owner directly, on an authorized test domain/account only:** install cloudflared, complete its official browser login, and create a named tunnel. Try routing before an authenticated test AHI runtime is available: it must refuse without DNS changes. Once the proposed readiness/session contract is implemented on that separate test runtime, connect the hostname and explicitly start the tunnel. Verify HTTPS and owner authentication in a private browser before testing on a phone. Stop the tunnel and close/reopen the app. Verify partial DNS failure and retry preserve the named tunnel; app cancellation must not claim remote resources were deleted. No production DNS, tunnel or gateway is used.
10. On iOS and Android, open that authenticated test hostname and use Add to Home Screen/install. Verify owner session/recovery, launch, and a real conversation. This proves the PWA path only after the runtime integration exists. There is no native APK in this deliverable.
11. Select optional Gmail/Calendar/Drive/GitHub/WhatsApp requests. Finish; verify they are pending in the handoff and require explicit provider permissions later. Nothing should claim an account connected merely because its checkbox was selected.
12. Repeat basic install/open/folder/CLI/keychain/fallback/quit-resume on Windows x64 using the NSIS artifact. Verify Credential Manager persistence, PowerShell sign-in windows, path quoting and user-only ACL on the explicit fallback directory. Repeat Linux AppImage on a supported desktop with libsecret and on a VPS using `--ozone-platform=headless --disable-gpu --headless-setup` with an SSH local forward. In headless mode, ensure wrong pairing, hostile Origin/Host and expired server session are rejected. Keep pairing codes out of screenshots and reports.

Record results as pass/fail per step with OS/architecture, artifact checksum and non-secret error classification. Do not mark signed-in accounts, durable OS keychain behavior, full speech or phone access as proven until those steps actually pass. Dependency advisories and signing/notarization remain release concerns in DECISIONS and REPORT.
