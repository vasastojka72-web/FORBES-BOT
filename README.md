# FORBES BOT FIXED

Важливо: токени не зберігати в GitHub. Усі секрети тільки в Render → Environment.

## Render Environment Variables

Обов'язково має бути 7 змінних:

```env
DISCORD_BOT_TOKEN=новий токен з вкладки Bot
DISCORD_CLIENT_ID=1505104206393249873
DISCORD_CLIENT_SECRET=секретний ключ клієнта OAuth2
DISCORD_REDIRECT_URI=https://forbes-bot.onrender.com/auth/discord/callback
GUILD_ID=1504699361668497419
OWNER_ID=502825427761365026
NETLIFY_SITE_URL=https://fluffy-madeleine-c15914.netlify.app
```

## Commands

Build command:
```bash
npm install
```

Start command:
```bash
npm start
```

## Ролі

- BOT / FORBES BOT
- Учасник
- новобранець
- Фармер
- Фарм менеджер
- Боєць
- Каптер
- Старший каптер
- Права рука
- Зам.лідера

## OAuth Discord

Discord Developer Portal → OAuth2 → Redirects:
```txt
https://forbes-bot.onrender.com/auth/discord/callback
```


V5: автопарк підтримує детальні поля карток машин (опис, потужність, двигун, привід, швидкість, розгін, місця, статус).

V9: signed Discord auth, owner-only admin API, CORS, rate limit, security headers, application/capt/discipline permissions fixed. Re-login after deploy.

V10: підписаний Discord-токен без автоматичного строку дії. Він перестає працювати після виходу користувача або зміни AUTH_SIGNING_SECRET. Подання фарм-звітів доступне всім авторизованим учасникам, включно з каптерами.
# Launcher Web SSO

The Launcher requests a one-time 60-second ticket through
`POST /api/launcher/web-session`. The ticket is exchanged by WebView2 at
`GET /auth/launcher`; the backend then creates the `forbes_web_session`
Secure/HttpOnly cookie and redirects to the website. The persistent Launcher
token is never placed in a URL.

Render must keep the existing `AUTH_SIGNING_SECRET`. Set
`PUBLIC_API_URL=https://forbes-bot.onrender.com` and include
`https://forbes-fam.netlify.app` in `ALLOWED_ORIGINS`. No new secret is needed.
