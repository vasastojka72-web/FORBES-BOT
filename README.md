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
