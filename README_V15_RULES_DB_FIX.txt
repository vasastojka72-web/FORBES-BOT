V15 RULES/HISTORY DATABASE FIX
- Adds persistent top-level siteSettings in db.json/Supabase JSON.
- Mirrors history into familyHistory.text and familyInfo.history.
- Mirrors familyRules and legalUpdated into familyInfo and siteSettings.
- Uses awaited writeDbAsync; API returns error if Supabase write fails.
- GET merges legacy fields so old history remains visible in panel.
