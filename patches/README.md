# Baileys rc14 selective fixes

`baileys+7.0.0-rc14.patch` retains the existing media connection fix and selectively backports companion registration refresh from [Baileys PR #2765](https://github.com/WhiskeySockets/Baileys/pull/2765), pinned to `042fe1f3ddacf63ac2288837fbc8a395556bbb6e` (open/unmerged when inspected on 2026-11-04).

The backport updates three installed JavaScript files: `Socket/socket.js`, `Socket/messages-recv.js`, and `Utils/companion-reg-client-utils.js`. It accepts only the two upstream child forms, preserves any `creds.me` (including pending pairing-code identities), rotates the advertisement secret using 32 CSPRNG bytes, emits the credential update and renders the same QR reference without resetting its timer. Notification ACKs work before identity exists; message ACKs still require identity. Upstream diagnostic logs are sanitized: no stanza contents, IDs, QR references, or keys are logged. The Evolution marker logs only the notification type and instance for the current unpaired client.

Offline verification on the pinned current image dependencies: the existing media patch was reversed in a disposable container, the complete tracked patch applied through `patch-package`, syntax checks and a full Baileys import passed. The selective delta also applied to the already media-patched image. The 67 focused tests and TypeScript/tsup build passed with network disabled. The unpatched image fails six protocol cases; authenticated-session and QR cadence cases remain passing.

This verifies handling of synthetic protocol nodes, not successful pairing against WhatsApp. The production diagnosis remains a hypothesis until the sanitized marker and a new phone scan demonstrate the flow. Do not install the moving fork branch. Remove/reconcile this backport after a verified upstream release includes the fix.

An image based on an already media-patched base must apply only the three new file sections, then copy both `dist` and those three patched dependency files into the final image. The complete patch remains for fresh dependency installations; never copy only `dist` for this change.
