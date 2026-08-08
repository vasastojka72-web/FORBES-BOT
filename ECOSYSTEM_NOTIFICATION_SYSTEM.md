# FORBES ecosystem notification system

The current project stores its normalized application state inside the existing
`forbes_db.data` JSON document in Supabase. This update intentionally extends
that document and does not create a second competing set of SQL tables.

New persistent collections/fields:

- `notifications[]`: recipient-bound personal events with an idempotency key;
- `notificationPreferences{}`: per-user delivery preferences;
- `announcementReads{}`: server-side read IDs per Discord user;
- `captReminderDeliveries{}`: persisted `captId:20min` / `captId:10min` delivery records;
- `capts[].participants[]`: unique registration records keyed logically by
  `captId + discordUserId` while legacy `yes[]` remains compatible;
- `announcements[]`: `targetType`, `targetRoleIds[]`, `priority`, author and ISO date.

No SQL migration is required for the present storage architecture. Deploy the
updated Bot and ensure Render has `CAPT_REMINDER_CHANNEL_ID` set to the numeric
Discord channel ID. If it is absent, the existing FORBES reminder channel ID is
used as a backwards-compatible fallback.

Launcher endpoints:

- `GET /api/launcher/capts/me/upcoming`
- `GET /api/launcher/notifications`
- `PATCH /api/launcher/notifications/:id/read`
- `GET /api/launcher/announcements`
- `PATCH /api/launcher/announcements/:id/read`

All endpoints resolve identity from the signed Launcher bearer session. A
Discord ID supplied in query parameters or request bodies is never accepted as
proof of identity.
