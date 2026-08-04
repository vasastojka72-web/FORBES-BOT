FORBES BOT V32 — CHARGE ITEMS/REPORTS ACCESS FIX

Fixed the actual reason regular members saw an empty Charge Reports page:
GET /api/charge/items and GET /api/charge/reports used requireFamilyRole(),
which rejected accounts that were logged in and in the guild but did not have
a separately detectable non-managed role. The frontend then kept empty caches.

Now every authenticated Discord guild account can:
- load all charge item cards;
- see shared charge report history;
- submit a charge report.

Owner-only item management and staff-only moderation stay unchanged.
