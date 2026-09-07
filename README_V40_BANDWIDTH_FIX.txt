FORBES BOT — Render outbound bandwidth audit/fix

Confirmed root cause
--------------------
processDiscordQueue() runs every 60 seconds. It previously called writeDb(db)
even when the queue contained zero work. With Supabase enabled, writeDb() sends
the complete forbes_db JSON and then the complete forbes_members batch.

The observed rate is consistent with a roughly 410 KB combined payload:
410 KB * 60/hour = 24.0 MB/hour
24.0 MB/hour * 24 = 576 MB/day
576 MB/day * 7 = 4.03 GB/week

Additional amplifiers fixed
---------------------------
- Discord roster reads had no TTL cache.
- /api/members-autofill fetched the complete guild roster twice per request.
- Public read endpoints wrote the complete DB even when no member changed.
- Empty/failed Discord queue items retried every minute forever.
- Site autocomplete used cache-busting URLs and only a 10-second local cache.

Verification
------------
Authenticated family users can open:
GET /api/system/network-metrics

Render logs print [NETWORK METRICS] every 15 minutes. No token, cookie, member
name, Discord ID, or other personal data is included.

Expected idle state after deploy:
- rosterDbWrites stays unchanged
- rosterDbWritesSkipped may rise
- supabaseFullDbWrites stays unchanged while there are no real mutations
- estimatedSupabaseMB stays flat while idle
