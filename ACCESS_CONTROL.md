# FORBES Launcher access control

`GET /api/launcher/access` accepts only the signed Bearer session. It never
accepts a Discord ID from query parameters, headers, or the request body.

Required Render environment variable:

`FORBES_DISCORD_GUILD_ID=1504699361668497419`

Optional short membership cache:

`FORBES_MEMBERSHIP_CACHE_SECONDS=120`

Private Launcher notifications, preferences, statistics, capts, announcements,
AFK and presence heartbeat use `requireForbesMembership`. A valid session whose
user is no longer in the Guild receives HTTP 403 with
`FORBES_MEMBERSHIP_REQUIRED`. An expired/invalid session receives HTTP 401 with
`AUTH_REQUIRED`. Discord API failures return HTTP 503 and are not treated as a
membership rejection.
