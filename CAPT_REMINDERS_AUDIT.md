# FORBES automatic capt reminders

## Runtime flow

1. The website registration checkbox updates the capt's server-side `participants` list.
2. `checkCaptReminders()` polls scheduled capts every 60 seconds.
3. At 20 and 10 minutes it reloads the current capt and current registrations.
4. Discord receives real user mentions in `CAPT_REMINDER_CHANNEL_ID`.
5. `captReminderDeliveries[captId:threshold]` is persisted through `writeDbAsync` to the existing Supabase-backed database document.
6. The Launcher refreshes `/api/launcher/capts/me/upcoming` every minute before evaluating its local 20/10-minute reminder.

## Safety properties

- No manual reminder button is required.
- No long-lived `setTimeout` is used.
- The old 15-minute reminder implementation has been removed.
- `allowedMentions` permits only the current participant Discord user IDs.
- `@everyone`, `@here`, and role mentions are disabled for capt reminders.
- Legacy `yes` data is used only when a capt has no `participants` array at all.
- Europe/Kyiv conversion remains the single capt-time conversion used by API and Bot scheduler.

## Render environment

```env
CAPT_REMINDER_CHANNEL_ID=1505002988429901935
```

The existing Supabase variables remain required for restart-safe persistence.
