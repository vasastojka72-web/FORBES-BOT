FORBES Dance Sync (Render backend)

- WebSocket endpoint: /ws/dance-sync (same HTTP server and PORT)
- Existing launcher bearer token is verified during the first WebSocket message
- Server-authoritative execution timestamp: server now + 1500 ms
- Commands: dance 5, 6, 7, 8, 9
- One global room, presence counter, heartbeat and stale-client cleanup
- Duplicate sessions replace the older connection
- Per-user command cooldown: 2000 ms
- Time synchronization and periodic re-synchronization are supported

Render does not need a second service or port. Deploy this bot version normally.
Build command: npm install (or npm ci when using package-lock.json)
Start command: npm start

Health/status after launcher authorization:
GET /api/dance-sync/status

Local backend verification:
npm run test:dance
