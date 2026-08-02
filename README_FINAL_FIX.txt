FORBES FINAL STABLE FIX

Implemented:
1. Main access is Discord ID (CONFIG.ownerId / cfg.ownerUserId). Existing ownerOnly/requireOwner/isOwner wrappers now check main Discord ID.
2. Role checks use ANY matching role logic; extra roles do not block access.
3. Farm screenshots are not saved to DB; screenshot can be sent to Discord only.
4. Discord queue strips large payloads.
5. Farm send has wakeup, button loading, clear errors, no form wipe on error.
6. Salary formula: 20% family bank, 80% divided among players.
7. Farm statuses sync with Discord and manual status change route exists.
8. Family info, mansion/office URL, cars URL, gallery URL.
9. Cars max 15.
10. Backup strips base64/heavy fields and skips too-large payloads.
11. Auto-sync avoids rerender while editing forms.
12. Detailed errors and debug logs added.

Syntax checked:
- site script.js OK
- bot index.js OK
- bot storage.js OK
