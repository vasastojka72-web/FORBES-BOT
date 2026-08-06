# FORBES Launcher integration

This build adds a private notification inbox shared by the site, Discord bot,
and Windows launcher.

## Authentication

The launcher must send the existing signed Discord token:

```http
Authorization: Bearer <forbesAuthToken>
```

The token is produced by `/auth/discord/callback`. The current website stores
it under `localStorage.forbesAuthToken`.

## Endpoints

```http
GET /api/launcher/notifications?limit=50&since=<ISO timestamp>
POST /api/launcher/notifications/:id/read
```

Both endpoints reject guest access. Results are filtered on the server using
the Discord ID inside the verified signed token. A client-provided Discord ID
is never trusted for inbox reads.

## Events currently emitted

- application approved or rejected;
- farm report approved or rejected, including Discord review buttons;
- fine created;
- warning created.

Notifications are stored in the existing database object under
`notifications` and bounded to the newest 2000 records.

## Deployment

Deploy this bot build to the existing Render service with the same environment
variables. Do not commit or upload `.env` or real secrets.
