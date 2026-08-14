# FORBES member relation deployment

1. In Supabase SQL Editor run `supabase-member-relation.sql` once.
2. Deploy this Backend archive to Render and perform a full restart.
3. Confirm the Render log contains `DB initialized` and does not contain
   `forbes_members table unavailable`.
4. Deploy the matching Website archive as a fresh Netlify deploy.
5. Sign in once through Discord. OAuth creates/updates the central member row.
6. Open a Website form once so `/api/members-autofill` synchronizes the active
   Discord roster and backfills legacy records.

The Website receives only `memberId`, nickname, Game ID and safe display
metadata. Hidden Discord IDs remain in Backend/Supabase. Existing records keep
their legacy Discord fields during the compatibility period.

Rollback is safe: the legacy fields and the existing `forbes_db` JSON record
are still written. The new `forbes_members` table is additive.
