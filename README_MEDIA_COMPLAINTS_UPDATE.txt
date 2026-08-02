FORBES update

1. Gallery and music uploads use Supabase Storage through /api/v2 endpoints.
2. Only OWNER_ID may upload, edit, or delete gallery/music/content media.
3. Gallery albums support categories: estate, cars, office, other.
4. Closing a complaint on the site moves it to reviewed complaints and sends the full result to Discord channel 1527177727919001722.
5. The Discord result contains submitter, target, description, evidence, timecode, admin conclusion, reviewer, submitted date, and closed date.

Required Render environment variables:
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_IMAGE_BUCKET=forbes-images
SUPABASE_MUSIC_BUCKET=forbes-music
OWNER_ID=502825427761365026 (or your Discord ID)
