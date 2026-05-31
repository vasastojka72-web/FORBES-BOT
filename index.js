import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import { Client, GatewayIntentBits, Partials, EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes, SlashCommandBuilder } from "discord.js";
import { CONFIG } from "./config.js";
import {readDb, writeDb, id, initDb, getDbInfo} from "./storage.js";


process.on("unhandledRejection", (err)=>console.error("UNHANDLED REJECTION:", err));
process.on("uncaughtException", (err)=>console.error("UNCAUGHT EXCEPTION:", err));

const app = express();
const PORT = Number(process.env.PORT || 10000);
const SITE_ORIGIN = process.env.SITE_ORIGIN || "https://fluffy-madeleine-c15914.netlify.app";
const API_SECRET = process.env.API_SECRET || "";
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || "https://forbes-bot.onrender.com/auth/discord/callback";
const NETLIFY_SITE_URL = process.env.NETLIFY_SITE_URL || process.env.SITE_ORIGIN || "https://fluffy-madeleine-c15914.netlify.app";


const ALLOWED_ORIGINS = new Set([
  SITE_ORIGIN,
  NETLIFY_SITE_URL,
  "https://forbes-fam.netlify.app",
  "https://fluffy-madeleine-c15914.netlify.app"
].filter(Boolean));

app.use(cors({
  origin(origin, cb){
    if(!origin) return cb(null, true);
    if(SITE_ORIGIN === "*" || ALLOWED_ORIGINS.has(origin) || origin.endsWith(".netlify.app")){
      return cb(null, true);
    }
    return cb(null, true); // keep API usable; auth still protected by x-api-secret
  },
  methods:["GET","POST","PUT","DELETE","OPTIONS"],
  allowedHeaders:["Content-Type","x-api-secret","x-discord-user-id","Authorization"]
}));
app.options("*", cors());

app.use(express.json({ limit: "35mb" }));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message]
});

const money = n => `${Number(n || 0).toLocaleString("uk-UA")}$`;
const now = () => new Date().toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" });

function protect(req, res, next){
  if(!API_SECRET) return next();
  if(req.headers["x-api-secret"] !== API_SECRET) return res.status(401).json({ok:false,error:"Unauthorized"});
  next();
}
function ownerOnly(req, res, next){
  const userId = req.headers["x-discord-user-id"] || req.body.discordUserId;
  if(String(userId) !== CONFIG.ownerId) return res.status(403).json({ok:false,error:"Only owner can do this"});
  next();
}
async function channel(id){ return client.channels.fetch(id).catch(()=>null); }
function embed(title, description, color = 0xf1b83a){ return new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setFooter({text:"FORBES Family"}).setTimestamp(new Date()); }


function row(buttons){
  return new ActionRowBuilder().addComponents(
    buttons.map(b =>
      new ButtonBuilder()
        .setCustomId(String(b.id))
        .setLabel(String(b.label))
        .setStyle(b.style || ButtonStyle.Secondary)
    )
  );
}



function screenshotAttachment(body, fallbackName="screenshot.png"){
  try{
    const s = body && body.screenshotData;
    if(!s || !s.data) return null;

    const buf = Buffer.from(s.data, "base64");
    const maxBytes = 7.8 * 1024 * 1024;

    if(buf.length > maxBytes){
      return {
        tooLarge: true,
        sizeMb: (buf.length / 1024 / 1024).toFixed(1),
        maxMb: "7.8"
      };
    }

    const safeName = (s.name || fallbackName || "screenshot.png").replace(/[^\w.\-() ]+/g, "_");
    return {
      attachment: buf,
      name: safeName || fallbackName
    };
  }catch(e){
    console.error("screenshotAttachment error:", e);
    return null;
  }
}

async function sendWithOptionalScreenshot(ch, payload, body, fallbackName="screenshot.png"){
  if(!ch) throw new Error("discord_channel_missing");
  const att = screenshotAttachment(body, fallbackName);
  try{
    if(att && att.tooLarge){
      await ch.send({content:"⚠️ Скрін був завеликий навіть після стискання. Надішліть JPG/WebP менше 8MB.", ...payload});
      return {ok:true,tooLarge:true};
    }
    if(att){
      await ch.send({...payload, files:[att]});
      return {ok:true,withFile:true};
    }
    await ch.send(payload);
    return {ok:true,withFile:false};
  }catch(e){
    console.error("Discord send error:", e);
    throw e;
  }
}

app.get("/", (req,res)=>res.json({ok:true,name:"FORBES BOT API",time:now()}));
app.get("/health", (req,res)=>res.json({ok:true,botReady:client.isReady(),time:now()}));

// Discord OAuth login
app.get("/auth/discord", (req, res) => {
  if (!DISCORD_CLIENT_ID) return res.status(500).send("DISCORD_CLIENT_ID is missing");
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify guilds.members.read"
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

app.get("/auth/discord/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.redirect(`${NETLIFY_SITE_URL}?login=no_code`);

    const params = new URLSearchParams();
    params.append("client_id", DISCORD_CLIENT_ID);
    params.append("client_secret", DISCORD_CLIENT_SECRET);
    params.append("grant_type", "authorization_code");
    params.append("code", code);
    params.append("redirect_uri", DISCORD_REDIRECT_URI);

    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.log("OAuth token error:", tokenData);
      return res.redirect(`${NETLIFY_SITE_URL}?login=token_error`);
    }

    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const user = await userRes.json();
    if (!userRes.ok || !user.id) return res.redirect(`${NETLIFY_SITE_URL}?login=user_error`);

    let roles = [];
    let serverNick = "";

    try {
      const guild = await client.guilds.fetch(CONFIG.guildId);
      const member = await guild.members.fetch(user.id);

      serverNick = member.nickname || member.displayName || user.global_name || user.username;

      roles = member.roles.cache
        .filter(r => r.name !== "@everyone")
        .sort((a, b) => b.position - a.position)
        .map(r => ({ id: r.id, name: r.name, position: r.position }));
    } catch (e) {
      console.log("Guild member fetch failed:", e?.message || e);
      serverNick = user.global_name || user.username || "Discord";
      roles = [];
    }

    const payload = Buffer.from(JSON.stringify({
      id: user.id,
      name: serverNick,
      username: user.username,
      globalName: user.global_name,
      avatar: user.avatar,
      roles
    })).toString("base64url");

    return res.redirect(`${NETLIFY_SITE_URL}?discord_user=${payload}`);
  } catch (err) {
    console.error("OAuth callback error", err);
    return res.redirect(`${NETLIFY_SITE_URL}?login=server_error`);
  }
});


app.get("/api/contracts", (req,res)=>res.json({ok:true,contracts:readDb().contracts}));
app.post("/api/contracts", protect, ownerOnly, async (req,res)=>{
  const db=readDb();
  const item={id:id("contract"),name:String(req.body.name||"").trim(),amount:Number(req.body.amount||0),active:Boolean(req.body.active ?? true),createdAt:now()};
  if(!item.name || !item.amount) return res.status(400).json({ok:false,error:"name and amount required"});
  db.contracts.unshift(item); writeDb(db); await log(`📋 Додано контракт: **${item.name}** — **${money(item.amount)}**`);
  res.json({ok:true,contract:item});
});
app.put("/api/contracts/:id", protect, ownerOnly, (req,res)=>{
  const db=readDb(); const c=db.contracts.find(x=>x.id===req.params.id); if(!c) return res.status(404).json({ok:false});
  if(req.body.name!==undefined) c.name=String(req.body.name).trim(); if(req.body.amount!==undefined) c.amount=Number(req.body.amount); if(req.body.active!==undefined) c.active=Boolean(req.body.active);
  writeDb(db); res.json({ok:true,contract:c});
});
app.delete("/api/contracts/:id", protect, ownerOnly, (req,res)=>{ const db=readDb(); db.contracts=db.contracts.filter(x=>x.id!==req.params.id); writeDb(db); res.json({ok:true}); });


app.get("/api/applications", protect, (req,res)=>{
  const db = readDb();
  res.json({ok:true,applications:db.applications || []});
});

app.post("/api/applications", protect, async (req,res)=>{
  const db=readDb();
  const item={
    id:id("app"),
    type:req.body.type||"family",
    nickname:req.body.nickname||req.body.nick||"",
    staticId:req.body.staticId||req.body.playerId||"",
    discord:req.body.discord||"",
    discordUserId:req.body.discordUserId||"",
    discordName:req.body.discordName||"",
    comment:req.body.comment||"",
    screenshotUrl:req.body.screenshotUrl||"",
    status:"pending",
    createdAt:now()
  };
  db.applications.unshift(item);
  writeDb(db);

  const chId = item.type.includes("фарм") || item.type==="farm"
    ? CONFIG.channels.applicationsFarm
    : item.type.includes("капт") || item.type==="capt"
      ? CONFIG.channels.applicationsCapt
      : CONFIG.channels.applicationsFamily;

  const ch=await channel(chId);
  if(ch) await sendWithOptionalScreenshot(ch, {
    embeds:[embed("📝 Нова заявка",
      `**Тип:** ${item.type}
` +
      `**Нік:** ${item.nickname}
` +
      `**ID:** ${item.staticId}
` +
      `**Discord:** ${item.discord}
` +
      `**Discord user:** ${item.discordUserId ? `<@${item.discordUserId}>` : "не авторизований"}
` +
      `**Коментар:** ${item.comment||"-"}`
    )],
    components:[row([
      {id:`app_approve:${item.id}`,label:"✅ Одобрити",style:ButtonStyle.Success},
      {id:`app_reject:${item.id}`,label:"❌ Відхилити",style:ButtonStyle.Danger}
    ])]
  }, req.body, "application.png");

  res.json({ok:true,application:item});
});


app.get("/api/farm-reports", protect, (req,res)=>{
  const db = readDb();
  res.json({ok:true,reports:db.farmReports || []});
});

app.post("/api/farm-reports", protect, async (req,res)=>{
  const db = readDb();
  const contract = db.contracts.find(c => c.id === req.body.contractId) || null;
  const players = Array.isArray(req.body.players) ? req.body.players.slice(0, CONFIG.payout.maxPlayers) : [];
  const amount = contract ? contract.amount : Number(req.body.amount || 0);
  const pool = Math.floor(amount * CONFIG.payout.playersPercent / 100);
  const each = players.length ? Math.floor(pool / players.length) : 0;
  const createdAt = now();

  const item = {
    id: id("farm"),
    localId: req.body.localId || "",
    contractId: contract?.id || req.body.contractId || "",
    contractName: contract?.name || req.body.contractName || "",
    amount,
    players,
    each,
    screenshotUrl: req.body.screenshotUrl || "",
    comment: req.body.comment || "",
    status: "pending",
    createdAt
  };

  db.farmReports.unshift(item);
  writeDb(db);

  const ch = await channel(CONFIG.channels.farmReports);
  if(ch){
    const playersText = players.map(p => "• " + (p.nick || "-") + " | " + (p.id || "-")).join("\n") || "-";
    const desc =
      "**№ звіту:** " + item.id + "\n" +
      "**Дата/час:** " + item.createdAt + "\n" +
      "**Контракт:** " + item.contractName + "\n" +
      "**Сума:** " + money(item.amount) + "\n" +
      "**Гравцям 75%:** " + money(pool) + "\n" +
      "**Кожному:** " + money(each) + "\n\n" +
      "**Гравці:**\n" + playersText + "\n\n" +
      "**Коментар:** " + (item.comment || "-");

    await sendWithOptionalScreenshot(ch, {
      embeds: [embed("📦 Новий фарм-звіт", desc)],
      components: [row([
        {id: "farm_approve:" + item.id, label: "✅ Одобрити", style: ButtonStyle.Success},
        {id: "farm_reject:" + item.id, label: "❌ Відхилити", style: ButtonStyle.Danger}
      ])]
    }, req.body, "farm-report.png");
  }

  res.json({ok:true, report:item});
});


app.get("/api/capts", protect, (req,res)=>{
  const db=readDb();
  res.json({ok:true,capts:db.capts||[]});
});

app.post("/api/capts", protect, async (req,res)=>{
  const item={id:id("capt"),date:req.body.date||"",time:req.body.time||"",enemy:req.body.enemy||"",neededPlayers:Number(req.body.neededPlayers||req.body.need||0),comment:req.body.comment||"",yes:[],no:[],maybe:[],status:"open",messageId:"",createdAt:now()};
  const db=readDb(); db.capts.unshift(item); writeDb(db);
  const ch=await channel(CONFIG.channels.captSignup);
  if(ch){ const msg=await ch.send({embeds:[embed("⚔️ Запис на капт", `**Дата:** ${item.date}\n**Час:** ${item.time}\n**Проти:** ${item.enemy||"-"}\n**Потрібно людей:** ${item.neededPlayers||"-"}\n**Коментар:** ${item.comment||"-"}`)],components:[row([{id:`capt_yes:${item.id}`,label:"✅ Буду",style:ButtonStyle.Success},{id:`capt_no:${item.id}`,label:"❌ Не буду",style:ButtonStyle.Danger},{id:`capt_maybe:${item.id}`,label:"❓ Не знаю",style:ButtonStyle.Secondary}])]}); item.messageId=msg.id; const db2=readDb(); const saved=db2.capts.find(x=>x.id===item.id); if(saved) saved.messageId=msg.id; writeDb(db2); }
  scheduleCaptReminder(item.id);
res.json({ok:true,capt:item});
});


async function apiMemberFromRequest(req){
  const userId = req.headers["x-discord-user-id"] || req.body.discordUserId || "";
  if(!userId) return null;
  const guild = await client.guilds.fetch(CONFIG.guildId);
  return await guild.members.fetch(userId).catch(()=>null);
}

app.post("/api/capts/:id/list-now", protect, async (req,res)=>{
  try {
    const member = await apiMemberFromRequest(req);
    if(!canManageCaptLists(member)) return res.status(403).json({ok:false,error:"no_permission"});
    const ok = await postCaptList(req.params.id);
    if(!ok) return res.status(404).json({ok:false,error:"capt_or_channel_not_found"});
    return res.json({ok:true,message:"capt_list_sent"});
  } catch(e) {
    console.error("capt list now error:", e);
    return res.status(500).json({ok:false,error:"capt_list_failed"});
  }
});


app.post("/api/capts/:id/absent", protect, async (req,res)=>{
  try{
    const member = await apiMemberFromRequest(req);
    if(!canManageCaptLists(member)) return res.status(403).json({ok:false,error:"no_permission"});

    const db = readDb();
    const c = db.capts.find(x => x.id === req.params.id);
    if(!c) return res.status(404).json({ok:false,error:"capt_not_found"});

    const userId = String(req.body.userId || "").replace(/[<@!>]/g, "").trim();
    if(!userId) return res.status(400).json({ok:false,error:"user_id_required"});

    if(!(c.yes || []).includes(userId)){
      return res.status(400).json({ok:false,error:"user_not_in_yes_list"});
    }

    c.absent = Array.isArray(c.absent) ? c.absent : [];
    if(!c.absent.includes(userId)) c.absent.push(userId);

    const guild = await client.guilds.fetch(CONFIG.guildId);
    const target = await guild.members.fetch(userId).catch(()=>null);
    const nickname = target?.displayName || `Discord ${userId}`;

    const fine = {
      id: id("fine"),
      nickname,
      staticId: userId,
      discordUserId: userId,
      amount: 50000,
      reason: `Неявка на капт ${c.date || ""} ${c.time || ""} проти ${c.enemy || "-"}`,
      status: "unpaid",
      createdAt: now(),
      source: "capt_absent",
      captId: c.id
    };

    db.fines.unshift(fine);
    writeDb(db);

    const ch = await channel(CONFIG.channels.fines);
    if(ch){
      await ch.send({embeds:[embed("🚨 Штраф за неявку на капт",
        `**Гравець:** ${nickname} | <@${userId}>\n` +
        `**Сума:** ${money(50000)}\n` +
        `**Капт:** ${c.date || "-"} ${c.time || "-"} проти ${c.enemy || "-"}\n` +
        `**Причина:** поставив ✅ Буду, але не прийшов`
      )]});
    }

    if(typeof addLog === "function") addLog(`Штраф 50к за неявку на капт: ${nickname}`, {captId:c.id,userId});
    return res.json({ok:true,fine,capt:c});
  }catch(e){
    console.error("capt absent fine error:", e);
    return res.status(500).json({ok:false,error:"capt_absent_failed"});
  }
});

app.post("/api/capts/:id/close", protect, async (req,res)=>{
  try {
    const member = await apiMemberFromRequest(req);
    if(!canManageCaptLists(member)) return res.status(403).json({ok:false,error:"no_permission"});
    const db = readDb();
    const c = db.capts.find(x => x.id === req.params.id);
    if(!c) return res.status(404).json({ok:false,error:"capt_not_found"});
    c.status = "closed";
    c.closedAt = now();
    writeDb(db);
    return res.json({ok:true,capt:c});
  } catch(e) {
    console.error("capt close error:", e);
    return res.status(500).json({ok:false,error:"capt_close_failed"});
  }
});




app.get("/api/fines", protect, (req,res)=>{
  const db = readDb();
  res.json({ok:true,fines:db.fines || []});
});

app.get("/api/warnings", protect, (req,res)=>{
  const db = readDb();
  res.json({ok:true,warnings:db.warnings || []});
});

app.post("/api/fines", protect, async (req,res)=>{
  const db=readDb(); const item={id:id("fine"),nickname:req.body.nickname||req.body.nick||"",staticId:req.body.staticId||req.body.playerId||"",amount:Number(req.body.amount||0),reason:req.body.reason||"",screenshotUrl:req.body.screenshotUrl||"",status:"unpaid",createdAt:now()};
  db.fines.unshift(item); writeDb(db); const ch=await channel(CONFIG.channels.fines); if(ch) sendWithOptionalScreenshot(ch, {embeds:[embed("🚨 Новий штраф", `**№:** ${item.id}\n**Гравець:** ${item.nickname} | ${item.staticId}\n**Сума:** ${money(item.amount)}\n**Причина:** ${item.reason}`)]}, req.body, "fine.png"); res.json({ok:true,fine:item});
});
app.post("/api/fine-payments", protect, async (req,res)=>{
  const db=readDb();
  const item={
    id:id("finepay"),
    fineId:req.body.fineId||"",
    nickname:req.body.nickname||req.body.nick||"",
    staticId:req.body.staticId||req.body.playerId||"",
    screenshotUrl:req.body.screenshotUrl||"",
    status:"pending",
    createdAt:now()
  };

  db.fines.unshift(item);

  const original = (db.fines || []).find(f => f.id === item.fineId);
  if(original && original.status !== "paid"){
    original.status = "payment_pending";
    original.paymentId = item.id;
  }

  writeDb(db);

  const ch=await channel(CONFIG.channels.finePayments);
  if(ch) await sendWithOptionalScreenshot(ch, {
    embeds:[embed("💳 Оплата штрафу на перевірку",
      `**Оплата №:** ${item.id}
` +
      `**Штраф №:** ${item.fineId}
` +
      `**Гравець:** ${item.nickname} | ${item.staticId}`
    )],
    components:[row([
      {id:`finepay_approve:${item.id}`,label:"✅ Одобрити оплату",style:ButtonStyle.Success},
      {id:`finepay_reject:${item.id}`,label:"❌ Відхилити",style:ButtonStyle.Danger}
    ])]
  }, req.body, "fine-payment.png");

  res.json({ok:true,payment:item});
});
app.post("/api/warnings", protect, async (req,res)=>{
  const db=readDb(); const expires=new Date(Date.now()+CONFIG.warnings.days*86400000); const item={id:id("warn"),nickname:req.body.nickname||req.body.nick||"",staticId:req.body.staticId||req.body.playerId||"",reason:req.body.reason||"",screenshotUrl:req.body.screenshotUrl||"",status:"active",expiresAt:expires.toISOString(),createdAt:now()};
  db.warnings.unshift(item); writeDb(db); const count=db.warnings.filter(w=>w.staticId===item.staticId&&w.status==="active").length; const ch=await channel(CONFIG.channels.warnings); if(ch) sendWithOptionalScreenshot(ch, {embeds:[embed("🚫 Нова догана", `**№:** ${item.id}\n**Гравець:** ${item.nickname} | ${item.staticId}\n**Причина:** ${item.reason}\n**Діє до:** ${expires.toLocaleDateString("uk-UA")}\n**Активних доган:** ${count}${count>=CONFIG.warnings.kickAt?"\n\n⚠️ **3 догани — кікнути / на розгляд**":""}`)]}, req.body, "warning.png"); 
app.post("/api/warning-payments", protect, async (req,res)=>{
  const db=readDb();
  const item={
    id:id("warnpay"),
    warningId:req.body.warningId||req.body.warnId||"",
    nickname:req.body.nickname||req.body.nick||"",
    staticId:req.body.staticId||req.body.playerId||"",
    screenshotUrl:req.body.screenshotUrl||"",
    status:"pending",
    createdAt:now()
  };
  db.warnings.unshift(item);
  writeDb(db);
  const ch=await channel(CONFIG.channels.warningRemoval);
  if(ch) sendWithOptionalScreenshot(ch, {
    embeds:[embed("💳 Запит на зняття догани", `**Догана №:** ${item.warningId}\n**Гравець:** ${item.nickname} | ${item.staticId}`)],
    components:[row([
      {id:`warnpay_approve:${item.id}`,label:"✅ Одобрити",style:ButtonStyle.Success},
      {id:`warnpay_reject:${item.id}`,label:"❌ Відхилити",style:ButtonStyle.Danger}
    ])]
  }, req.body, "warning-payment.png");
  res.json({ok:true,payment:item});
});
res.json({ok:true,warning:item});
});


app.get("/api/warnings", protect, (req,res)=>{
  const db = readDb();
  res.json({ok:true,warnings:db.warnings || []});
});

app.post("/api/fines/:id/remind", protect, async (req,res)=>{
  try{
    const db = readDb();
    const f = (db.fines || []).find(x => x.id === req.params.id);
    if(!f) return res.status(404).json({ok:false,error:"fine_not_found"});
    const ch = await channel(CONFIG.channels.fines);
    if(ch){
      await ch.send({embeds:[embed("🔔 Нагадування про штраф",
        `**Гравець:** ${f.nickname || f.nick || "-"} | ${f.staticId || f.playerId || "-"}\n` +
        `**Сума:** ${money(f.amount || 0)}\n` +
        `**Причина:** ${f.reason || "-"}\n\n` +
        `⚠️ Будь ласка, оплатіть штраф і надішліть скрін оплати.`
      )]});
    }
    f.lastRemindedAt = now();
    writeDb(db);
    addLog(`Штраф ${f.id} оновлено: ${f.status}`, {fineId:f.id});
    return res.json({ok:true,fine:f});
  }catch(e){
    console.error("fine remind error:", e);
    return res.status(500).json({ok:false,error:"fine_remind_failed"});
  }
});

app.post("/api/fines/:id/paid", protect, async (req,res)=>{
  try{
    const db = readDb();
    const f = (db.fines || []).find(x => x.id === req.params.id);
    if(!f) return res.status(404).json({ok:false,error:"fine_not_found"});
    f.status = "paid";
    f.paidAt = now();
    const ch = await channel(CONFIG.channels.fines);
    if(ch){
      await ch.send({embeds:[embed("✅ Штраф оплачено",
        `**Гравець:** ${f.nickname || f.nick || "-"} | ${f.staticId || f.playerId || "-"}\n` +
        `**Сума:** ${money(f.amount || 0)}\n` +
        `**Статус:** оплачено`
      )]});
    }
    writeDb(db);
    addLog(`Штраф ${f.id} оновлено: ${f.status}`, {fineId:f.id});
    return res.json({ok:true,fine:f});
  }catch(e){
    console.error("fine paid error:", e);
    return res.status(500).json({ok:false,error:"fine_paid_failed"});
  }
});

app.post("/api/fines/:id/close", protect, async (req,res)=>{
  try{
    const db = readDb();
    const f = (db.fines || []).find(x => x.id === req.params.id);
    if(!f) return res.status(404).json({ok:false,error:"fine_not_found"});
    f.status = "closed";
    f.closedAt = now();
    writeDb(db);
    addLog(`Штраф ${f.id} оновлено: ${f.status}`, {fineId:f.id});
    return res.json({ok:true,fine:f});
  }catch(e){
    console.error("fine close error:", e);
    return res.status(500).json({ok:false,error:"fine_close_failed"});
  }
});
app.post("/api/warnings/:id/remind", protect, async (req,res)=>{
  try{
    const db = readDb();
    const w = (db.warnings || []).find(x => x.id === req.params.id);
    if(!w) return res.status(404).json({ok:false,error:"warning_not_found"});
    const ch = await channel(CONFIG.channels.warnings);
    if(ch){
      await ch.send({embeds:[embed("🔔 Нагадування про догану",
        `**Гравець:** ${w.nickname || w.nick || "-"} | ${w.staticId || w.playerId || "-"}\n` +
        `**Причина:** ${w.reason || "-"}\n` +
        `**Статус:** активна догана`
      )]});
    }
    w.lastRemindedAt = now();
    writeDb(db);
    addLog(`Догану ${w.id} оновлено: ${w.status}`, {warningId:w.id});
    return res.json({ok:true,warning:w});
  }catch(e){
    console.error("warning remind error:", e);
    return res.status(500).json({ok:false,error:"warning_remind_failed"});
  }
});

app.post("/api/warnings/:id/close", protect, async (req,res)=>{
  try{
    const db = readDb();
    const w = (db.warnings || []).find(x => x.id === req.params.id);
    if(!w) return res.status(404).json({ok:false,error:"warning_not_found"});
    w.status = "closed";
    w.closedAt = now();
    const ch = await channel(CONFIG.channels.warnings);
    if(ch){
      await ch.send({embeds:[embed("✅ Догану закрито",
        `**Гравець:** ${w.nickname || w.nick || "-"} | ${w.staticId || w.playerId || "-"}\n` +
        `**Причина:** ${w.reason || "-"}\n` +
        `**Статус:** закрито`
      )]});
    }
    writeDb(db);
    addLog(`Догану ${w.id} оновлено: ${w.status}`, {warningId:w.id});
    return res.json({ok:true,warning:w});
  }catch(e){
    console.error("warning close error:", e);
    return res.status(500).json({ok:false,error:"warning_close_failed"});
  }
});

app.get("/api/members", protect, async (req,res)=>{
  try {
    const guild = await client.guilds.fetch(CONFIG.guildId);
    await guild.members.fetch();
    const members = guild.members.cache
      .filter(m => !m.user.bot)
      .map(m => ({
        id: m.user.id,
        username: m.user.username,
        nick: m.nickname || m.displayName || m.user.globalName || m.user.username,
        avatar: m.user.displayAvatarURL({ extension: "png", size: 128 }),
        roles: m.roles.cache
          .filter(r => r.name !== "@everyone")
          .sort((a,b)=>b.position-a.position)
          .map(r => r.name)
      }))
      .sort((a,b)=>(a.nick||"").localeCompare(b.nick||"", "uk"));
    res.json({ok:true,members});
  } catch(e) {
    console.error("Members fetch error:", e?.message || e);
    res.status(500).json({ok:false,error:"members_fetch_failed"});
  }
});


function roleForApplicationType(type){
  const t = String(type || "").toLowerCase();
  if(t.includes("фарм") || t.includes("farm")) return { roleId: CONFIG.roles.farmer, prefix: "farm" };
  if(t.includes("капт") || t.includes("capt") || t.includes("cpt")) return { roleId: CONFIG.roles.capt, prefix: "cpt" };
  return { roleId: CONFIG.roles.member, prefix: "" };
}

function nicknameForApplication(app){
  const nick = String(app.nickname || app.nick || "FORBES").trim();
  const staticId = String(app.staticId || app.playerId || "").trim();
  const { prefix } = roleForApplicationType(app.type);
  const base = prefix ? `${prefix} | ${nick} | ${staticId}` : `${nick} | ${staticId}`;
  return base.slice(0, 32);
}

async function applyApplicationApprove(app){
  if(!app || !app.discordUserId) return {ok:false, reason:"no_discord_user_id"};

  const guild = await client.guilds.fetch(CONFIG.guildId);
  const member = await guild.members.fetch(app.discordUserId).catch(()=>null);
  if(!member) return {ok:false, reason:"member_not_found"};

  const { roleId } = roleForApplicationType(app.type);
  if(roleId){
    await member.roles.add(roleId).catch(e => {
      console.log("Role add failed:", e?.message || e);
      throw e;
    });
  }

  const newNick = nicknameForApplication(app);
  await member.setNickname(newNick).catch(e => {
    console.log("Nickname set failed:", e?.message || e);
  });

  return {ok:true, nickname:newNick, roleId};
}


function userHasAnyRole(member, roleIds = []){
  if(!member) return false;
  if(String(member.id) === String(CONFIG.ownerId)) return true;
  return roleIds.filter(Boolean).some(roleId => member.roles.cache.has(roleId));
}


function canManageBlacklist(member){
  return userHasAnyRole(member, [
    CONFIG.roles.deputy,
    CONFIG.roles.rightHand
  ]);
}

function canModerateApplications(member){
  return userHasAnyRole(member, [
    CONFIG.roles.deputy,
    CONFIG.roles.rightHand,
    CONFIG.roles.seniorCapt,
    CONFIG.roles.farmManager
  ]);
}

function canModerateFarmReports(member){
  return userHasAnyRole(member, [
    CONFIG.roles.deputy,
    CONFIG.roles.rightHand,
    CONFIG.roles.farmManager
  ]);
}

function canUseCaptSignup(member){
  return userHasAnyRole(member, [
    CONFIG.roles.deputy,
    CONFIG.roles.rightHand,
    CONFIG.roles.seniorCapt,
    CONFIG.roles.capt
  ]);
}

function canManageCaptLists(member){
  return userHasAnyRole(member, [
    CONFIG.roles.deputy,
    CONFIG.roles.rightHand,
    CONFIG.roles.seniorCapt
  ]);
}

function canModerateWarningsAndFines(member){
  return userHasAnyRole(member, [
    CONFIG.roles.deputy,
    CONFIG.roles.rightHand
  ]);
}

async function interactionMember(interaction){
  if(interaction.member && interaction.member.roles && interaction.member.roles.cache) return interaction.member;
  const guild = await client.guilds.fetch(CONFIG.guildId);
  return await guild.members.fetch(interaction.user.id).catch(()=>null);
}

async function denyNoPerm(interaction, text="❌ У вас немає прав для цієї дії."){
  if(interaction.replied || interaction.deferred) return;
  return interaction.reply({content:text, ephemeral:true});
}

client.on("interactionCreate", async interaction=>{
  try{
    if(interaction.isChatInputCommand()){
      if(interaction.commandName==="ping") return interaction.reply({content:"✅ FORBES BOT онлайн",ephemeral:true});
      if(interaction.commandName==="stats"){
        const db=readDb();
        return interaction.reply({content:`📊 Контракти: ${db.contracts.length}
📦 Фарм-звіти: ${db.farmReports.length}
🚨 Штрафи: ${db.fines.length}
🚫 Догани: ${db.warnings.length}`,ephemeral:true});
      }
    }

    if(!interaction.isButton()) return;

    const [action,itemId]=interaction.customId.split(":");
    const db=readDb();
    const member = await interactionMember(interaction);

    // ЗАЯВКИ: тільки Лідер / Зам / Права рука / Старший каптер / Фарм менеджер
    if(action==="app_approve"||action==="app_reject"){
      if(!canModerateApplications(member)){
        return denyNoPerm(interaction, "❌ Заявки можуть одобряти тільки Лідер, Зам.лідера, Права рука, Старший каптер або Фарм менеджер.");
      }

      const app=db.applications.find(x=>x.id===itemId);
      if(!app) return interaction.reply({content:"Заявку не знайдено",ephemeral:true});

      app.status = action==="app_approve" ? "approved" : "rejected";

      let resultText = "";
      if(action==="app_approve"){
        try {
          const result = await applyApplicationApprove(app);
          if(result.ok){
            resultText = `\n✅ Роль видана, нік встановлено: **${result.nickname}**`;
          } else {
            resultText = `\n⚠️ Заявку одобрено, але роль/нік не видано: ${result.reason}`;
          }
        } catch(e) {
          console.error("Application approve role/nick failed:", e);
          resultText = "\n⚠️ Заявку одобрено, але бот не зміг видати роль або змінити нік. Перевір права бота і позицію ролі.";
        }
      }

      writeDb(db);
      return interaction.update({
        content:`Заявку ${app.status==="approved"?"✅ одобрено":"❌ відхилено"} модератором ${interaction.user}.${resultText}`,
        components:[],
        embeds:interaction.message.embeds
      });
    }

    // ФАРМ-ЗВІТИ: тільки Лідер / Зам / Права рука / Фарм менеджер
    if(action==="farm_approve"||action==="farm_reject"){
      if(!canModerateFarmReports(member)){
        return denyNoPerm(interaction, "❌ Фарм-звіти можуть одобряти тільки Лідер, Зам.лідера, Права рука або Фарм менеджер.");
      }

      const r=db.farmReports.find(x=>x.id===itemId);
      if(!r) return interaction.reply({content:"Не знайдено звіт",ephemeral:true});
      r.status=action==="farm_approve"?"approved":"rejected"; r.reviewedBy=interaction.user.id; r.reviewedAt=now(); writeDb(db);
      return interaction.update({
        content:`Фарм-звіт ${r.status==="approved"?"✅ одобрено":"❌ відхилено"} модератором ${interaction.user}`,
        components:[],
        embeds:interaction.message.embeds
      });
    }

    // КАПТ-КНОПКИ "Буду/Не буду/Не знаю": тільки каптери і старші
    if(action==="capt_yes"||action==="capt_no"||action==="capt_maybe"){
      if(!canUseCaptSignup(member)){
        return denyNoPerm(interaction, "❌ На капт можуть записуватись тільки Каптер, Старший каптер, Зам.лідера, Права рука або Лідер.");
      }

      const c=db.capts.find(x=>x.id===itemId);
      if(!c) return interaction.reply({content:"Не знайдено капт",ephemeral:true});

      c.yes=(c.yes||[]).filter(x=>x!==interaction.user.id);
      c.no=(c.no||[]).filter(x=>x!==interaction.user.id);
      c.maybe=(c.maybe||[]).filter(x=>x!==interaction.user.id);

      if(action==="capt_yes") c.yes.push(interaction.user.id);
      if(action==="capt_no") c.no.push(interaction.user.id);
      if(action==="capt_maybe") c.maybe.push(interaction.user.id);

      writeDb(db);
      return interaction.reply({content:"✅ Твій вибір записано",ephemeral:true});
    }

    // ЗНЯТТЯ ДОГАНИ: тільки Лідер / Зам / Права рука
    if(action==="warnpay_approve"||action==="warnpay_reject"){
      if(!canModerateWarningsAndFines(member)){
        return denyNoPerm(interaction, "❌ Зняття доган можуть одобряти тільки старші.");
      }

      const p=db.warnings.find(x=>x.id===itemId);
      if(!p) return interaction.reply({content:"Не знайдено запит на зняття догани",ephemeral:true});

      p.status=action==="warnpay_approve"?"approved":"rejected";
      p.reviewedBy=interaction.user.id;
      p.reviewedAt=now();

      const original = db.warnings.find(x => String(x.id) === String(p.warningId));
      if(original && action==="warnpay_approve"){
        original.status = "closed";
        original.closedAt = now();
      }

      writeDb(db);

      return interaction.update({
        content:`Запит на зняття догани ${p.status==="approved"?"✅ одобрено":"❌ відхилено"} модератором ${interaction.user}`,
        components:[],
        embeds:interaction.message.embeds
      });
    }

    // ОПЛАТА ШТРАФУ: тільки Лідер / Зам / Права рука
    if(action==="finepay_approve"||action==="finepay_reject"){
      if(!canModerateWarningsAndFines(member)){
        return denyNoPerm(interaction, "❌ Оплату штрафів можуть одобряти тільки Лідер, Зам.лідера або Права рука.");
      }

      const p=db.fines.find(x=>x.id===itemId);
      if(!p) return interaction.reply({content:"Не знайдено оплату",ephemeral:true});

      p.status=action==="finepay_approve"?"paid":"rejected";
      p.reviewedBy=interaction.user.id;
      p.reviewedAt=now();

      const original = db.fines.find(x => x.id === p.fineId);
      if(original){
        original.status = action==="finepay_approve" ? "paid" : "unpaid";
        if(action==="finepay_approve") original.paidAt = now();
      }

      writeDb(db);

      const fineCh = await channel(CONFIG.channels.fines);
      if(fineCh && original && action==="finepay_approve"){
        fineCh.send({embeds:[embed("✅ Штраф оплачено",
          `**Штраф №:** ${original.id}\n` +
          `**Гравець:** ${original.nickname || p.nickname} | ${original.staticId || p.staticId}\n` +
          `**Сума:** ${money(original.amount || 0)}`
        )]}).catch(()=>{});
      }

      return interaction.update({
        content:`Оплату штрафу ${p.status==="paid"?"✅ одобрено":"❌ відхилено"} модератором ${interaction.user}`,
        components:[],
        embeds:interaction.message.embeds
      });
    }

  }catch(err){
    console.error(err);
    if(!interaction.replied&&!interaction.deferred) interaction.reply({content:"❌ Помилка бота",ephemeral:true}).catch(()=>{});
  }
});


function kyivOffsetMinutesUtc(dateUtc){
  // Europe/Kyiv: UTC+2 winter, UTC+3 summer.
  // Intl correctly handles DST rules.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Kyiv",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(dateUtc).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  return (asUtc - dateUtc.getTime()) / 60000;
}

function kyivLocalToDate(year, month, day, hour, minute){
  // Convert Kyiv local wall time to real UTC Date.
  // Do two passes so DST offset is correct.
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let offset = kyivOffsetMinutesUtc(new Date(utcMs));
  utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - offset * 60000;
  offset = kyivOffsetMinutesUtc(new Date(utcMs));
  utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0) - offset * 60000;
  return new Date(utcMs);
}


async function resolveMemberLabel(userId){
  try{
    const guild = await client.guilds.fetch(CONFIG.guildId);
    const member = await guild.members.fetch(userId).catch(()=>null);
    if(member){
      return `${member.displayName} (<@${userId}>)`;
    }
  }catch(e){}
  return `<@${userId}>`;
}

async function formatCaptIds(ids){
  if(!ids || !ids.length) return "Поки нікого";
  const labels = [];
  for(const id of ids){
    labels.push(await resolveMemberLabel(id));
  }
  return labels.join("\n");
}

function parseCaptDateTime(c){
  try{
    const date = String(c.date || "").trim();
    const time = String(c.time || "").trim();
    if(!date || !time) return null;

    let y, m, d;
    const iso = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const ua = date.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);

    if(iso){
      y = Number(iso[1]);
      m = Number(iso[2]);
      d = Number(iso[3]);
    }else if(ua){
      d = Number(ua[1]);
      m = Number(ua[2]);
      y = Number(ua[3]);
    }else{
      return null;
    }

    const tm = time.match(/^(\d{1,2}):(\d{2})/);
    if(!tm) return null;

    const hh = Number(tm[1]);
    const mm = Number(tm[2]);

    // ВАЖЛИВО: капти рахуються по Києву / Europe/Kyiv.
    // Якщо на сайті вказано 17:30, бот нагадує о 17:15 по Києву.
    return kyivLocalToDate(y, m, d, hh, mm);
  }catch(e){
    console.error("parseCaptDateTime error:", e);
    return null;
  }
}

async function sendCaptReminder15(captId){
  const db = readDb();
  const c = db.capts.find(x => x.id === captId);
  if(!c || c.status === "closed" || c.reminded15) return false;

  const ch = await channel(CONFIG.channels.captSignup);
  if(!ch) return false;

  const yes = await formatCaptIds(c.yes || []);
  const no = await formatCaptIds(c.no || []);
  const maybe = await formatCaptIds(c.maybe || []);

  await ch.send({
    embeds:[embed("⏰ Нагадування за 15 хв до капта",
      `**Капт №:** ${c.id}\n` +
      `**Час:** ${c.time || "-"} по Києву\n` +
      `**Проти:** ${c.enemy || "-"}\n` +
      `**Потрібно людей:** ${c.neededPlayers || "-"}\n\n` +
      `✅ **Будуть:**\n${yes}\n\n` +
      `❓ **Не знають:**\n${maybe}\n\n` +
      `❌ **Не будуть:**\n${no}\n\n` +
      `Каптери, перевірте список і заходьте готуватись.`
    )]
  });

  c.reminded15 = true;
  c.reminded15At = now();
  writeDb(db);
  return true;
}

function scheduleCaptReminder(captId){
  const db = readDb();
  const c = db.capts.find(x => x.id === captId);
  if(!c) return;

  const dt = parseCaptDateTime(c);
  if(!dt) return;

  const remindAt = dt.getTime() - 15 * 60 * 1000;
  const delay = remindAt - Date.now();

  if(delay <= 0 && Date.now() <= dt.getTime() && !c.reminded15){
    sendCaptReminder15(captId).catch(console.error);
    return;
  }

  if(delay > 0){
    setTimeout(()=>sendCaptReminder15(captId).catch(console.error), delay);
  }
}

async function checkCaptReminders(){
  try{
    const db = readDb();
    const nowMs = Date.now();

    for(const c of (db.capts || [])){
      if(!c || c.status === "closed" || c.reminded15) continue;
      const dt = parseCaptDateTime(c);
      if(!dt) continue;

      const remindAt = dt.getTime() - 15 * 60 * 1000;
      // Send when current time is between 15 minutes before and start time.
      if(nowMs >= remindAt && nowMs <= dt.getTime()){
        await sendCaptReminder15(c.id);
      }
    }
  }catch(e){
    console.error("checkCaptReminders error:", e);
  }
}

function restoreCaptReminderTimers(){
  try{
    const db = readDb();
    for(const c of (db.capts || [])){
      if(c && c.status !== "closed" && !c.reminded15){
        scheduleCaptReminder(c.id);
      }
    }
  }catch(e){
    console.error("restoreCaptReminderTimers error:", e);
  }
}

async function postCaptList(captId){
  const db = readDb();
  const c = db.capts.find(x => x.id === captId);
  if(!c) return false;

  const ch = await channel(CONFIG.channels.captList);
  if(!ch) return false;

  const yes = await formatCaptIds(c.yes || []);
  const no = await formatCaptIds(c.no || []);
  const maybe = await formatCaptIds(c.maybe || []);

  await ch.send({
    embeds:[embed("📋 Список на капт",
      `**Капт №:** ${c.id}\n` +
      `**Дата:** ${c.date || "-"}\n` +
      `**Час:** ${c.time || "-"} по Києву\n` +
      `**Проти:** ${c.enemy || "-"}\n` +
      `**Потрібно:** ${c.neededPlayers || "-"}\n\n` +
      `✅ **Будуть:**\n${yes}\n\n` +
      `❌ **Не будуть:**\n${no}\n\n` +
      `❓ **Не знають:**\n${maybe}`
    )]
  });

  c.listSentAt = now();
  writeDb(db);
  return true;
}


cron.schedule("0 12 * * *", async()=>{ const db=readDb(); const unpaid=db.fines.filter(f=>f.status==="unpaid"); if(!unpaid.length) return; const ch=await channel(CONFIG.channels.fines); if(ch) ch.send({embeds:[embed("⏰ Нагадування про неоплачені штрафи", unpaid.map(f=>`• **${f.id}** — ${f.nickname} | ${f.staticId} — ${money(f.amount)}`).join("\n"))]}).catch(()=>{}); });
async function registerCommands(){ if(!client.user) return; const commands=[new SlashCommandBuilder().setName("ping").setDescription("Перевірити чи бот онлайн"),new SlashCommandBuilder().setName("stats").setDescription("Статистика FORBES")].map(c=>c.toJSON()); const rest=new REST({version:"10"}).setToken(process.env.DISCORD_BOT_TOKEN); await rest.put(Routes.applicationGuildCommands(client.user.id, CONFIG.guildId), {body:commands}); }


app.get("/api/salary/archive/latest", protect, (req,res)=>{
  const db = readDb();
  cleanupOldSalaryArchive(db);
  writeDb(db);
  const archive = Array.isArray(db.farmReportsArchive) ? db.farmReportsArchive : [];
  res.json({ok:true,latest:archive[0] || null,archiveCount:archive.length});
});



function addLog(text, extra = {}){
  try{
    const db = readDb();
    db.logs = Array.isArray(db.logs) ? db.logs : [];
    db.logs.unshift({id:id("log"), text, extra, createdAt:now()});
    db.logs = db.logs.slice(0,100);
    writeDb(db);
  }catch(e){
    console.error("addLog failed:", e);
  }
}

async function log(message, data = {}){
  try{
    console.log(message, data && Object.keys(data).length ? data : "");
    addLog(message, data);
  }catch(e){
    console.log(message);
  }
}

app.get("/api/logs", protect, (req,res)=>{
  const db=readDb();
  res.json({ok:true,logs:(db.logs||[]).slice(0,100)});
});


app.get("/api/salary/archive", protect, (req,res)=>{
  const db=readDb();
  cleanupOldSalaryArchive(db);
  writeDb(db);
  res.json({ok:true,archive:Array.isArray(db.farmReportsArchive)?db.farmReportsArchive:[]});
});


app.post("/api/reminders/debtors", protect, async (req,res)=>{
  try{
    const db=readDb();
    const unpaid=(db.fines||[]).filter(f=>f.status!=="paid"&&f.status!=="closed"&&f.id&&f.amount);
    const active=(db.warnings||[]).filter(w=>w.status==="active");
    const chF=await channel(CONFIG.channels.fines);
    const chW=await channel(CONFIG.channels.warnings);
    if(chF && unpaid.length){
      await chF.send({embeds:[embed("🔔 Нагадування всім за штрафи",
        unpaid.map(f=>`• **${f.nickname||f.nick||"-"} | ${f.staticId||f.playerId||"-"}** — ${money(f.amount||0)} — ${f.reason||"-"}`).join("\\n").slice(0,3900)
      )]});
    }
    if(chW && active.length){
      await chW.send({embeds:[embed("🔔 Нагадування всім за догани",
        active.map(w=>`• **${w.nickname||w.nick||"-"} | ${w.staticId||w.playerId||"-"}** — ${w.reason||"-"}`).join("\\n").slice(0,3900)
      )]});
    }
    addLog(`Нагадування боржникам: штрафи ${unpaid.length}, догани ${active.length}`);
    res.json({ok:true,fines:unpaid.length,warnings:active.length});
  }catch(e){
    console.error("debtors reminder failed:", e);
    res.status(500).json({ok:false,error:"debtors_reminder_failed"});
  }
});


async function sendSystemBackup(){
  try{
    const db = readDb();
    const backupData = {
      createdAt: now(),
      type: "FORBES_SYSTEM_BACKUP",
      data: {
        contracts: db.contracts || [],
        farmReports: db.farmReports || [],
        farmReportsArchive: db.farmReportsArchive || [],
        fines: db.fines || [],
        warnings: db.warnings || [],
        blacklist: db.blacklist || [],
        applications: db.applications || [],
        logs: db.logs || [],
        captLists: db.captLists || [],
        giveaways: db.giveaways || []
      }
    };

    const ch = await channel(CONFIG.channels.backup);
    if(!ch) return;

    const payload = Buffer.from(JSON.stringify(backupData, null, 2), "utf8");

    await ch.send({
      content: `🗂️ Backup системи FORBES\\n📅 ${now()}\\n⏳ Автоматичний backup кожні 3 дні`,
      files: [{
        attachment: payload,
        name: `forbes-backup-${Date.now()}.json`
      }]
    });

    if(typeof addLog === "function"){
      addLog("Автоматичний backup відправлено");
    }

    console.log("Backup uploaded.");
  }catch(e){
    console.error("Backup send failed:", e);
  }
}


app.get("/api/system/status", protect, (req,res)=>{
  try{
    const db = readDb();
    const info = typeof getDbInfo === "function" ? getDbInfo() : {supabaseConfigured:false};
    const jsonSizeBytes = Buffer.byteLength(JSON.stringify(db), "utf8");

    res.json({
      ok:true,
      cloud:{
        supabaseConfigured:Boolean(info.supabaseConfigured),
        mode: info.supabaseConfigured ? "supabase" : "local-db-json",
        dbKey: info.supabaseDbKey || "forbes_main"
      },
      size:{
        bytes: jsonSizeBytes,
        mb: Number((jsonSizeBytes / 1024 / 1024).toFixed(3))
      },
      counts:{
        contracts:(db.contracts||[]).length,
        farmReports:(db.farmReports||[]).length,
        farmArchive:(db.farmReportsArchive||[]).length,
        fines:(db.fines||[]).length,
        warnings:(db.warnings||[]).length,
        blacklist:(db.blacklist||[]).length,
        applications:(db.applications||[]).length,
        capts:(db.capts||[]).length,
        logs:(db.logs||[]).length,
        giveaways:(db.giveaways||[]).length
      }
    });
  }catch(e){
    console.error("system status error:", e);
    res.status(500).json({ok:false,error:"system_status_failed"});
  }
});

client.once("ready", async()=>{
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands().catch(console.error);
  await log("✅ FORBES BOT запущений і онлайн");
  restoreCaptReminderTimers();
  setInterval(()=>checkCaptReminders().catch(console.error), 60 * 1000);

  try{
    await sendSystemBackup();
  }catch(e){ console.error("Initial backup failed:", e); }

  setInterval(()=>{
    sendSystemBackup().catch(console.error);
  }, 3 * 24 * 60 * 60 * 1000);
});





function cleanupOldSalaryArchive(db){
  db.farmReportsArchive = Array.isArray(db.farmReportsArchive) ? db.farmReportsArchive : [];
  const maxAgeMs = 14 * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();

  db.farmReportsArchive = db.farmReportsArchive.filter(w => {
    const t = Date.parse(w.closedAt || w.createdAt || "");
    if(!t) return true;
    return nowMs - t <= maxAgeMs;
  });
}



app.post("/api/salary/send-now", protect, async (req,res)=>{
  try{
    const salaryChannelId = CONFIG.channels?.salary || CONFIG.salaryChannelId;
    if(!salaryChannelId) return res.status(400).json({ok:false,error:"salary_channel_missing"});

    const ch = await client.channels.fetch(salaryChannelId).catch(()=>null);
    if(!ch) return res.status(404).json({ok:false,error:"salary_channel_not_found"});

    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    let text = String(req.body.text || "").trim();

    if(!text){
      if(rows.length){
        text = "💰 **Список зарплат**\n\n" + rows.map((r,i)=>{
          const player = r.player || r.nickname || r.name || "Гравець";
          const contracts = Number(r.contracts || r.count || 0);
          const sum = Number(r.sum || r.amount || 0);
          return `${i+1}. **${player}** — ${contracts} контракт(ів) — **${money(sum)}**`;
        }).join("\n");
      }else{
        text = "💰 **Список зарплат**\n\nНемає учасників.";
      }
    }

    const chunks = [];
    let current = "";
    for(const line of text.split("\n")){
      if((current + "\n" + line).length > 1800){
        chunks.push(current);
        current = line;
      }else{
        current += (current ? "\n" : "") + line;
      }
    }
    if(current) chunks.push(current);

    for(const chunk of chunks){
      await ch.send(chunk);
    }

    if(typeof addLog === "function") addLog("ЗП відправлено в Discord", {count:rows.length});
    return res.json({ok:true,sent:true,count:rows.length});
  }catch(e){
    console.error("salary send error:", e);
    return res.status(500).json({ok:false,error:"salary_send_failed",details:e.message});
  }
});



app.post("/api/salary/close-week", protect, async (req,res)=>{
  try{
    if(req.body?.confirmSent !== true){
      return res.status(400).json({ok:false,error:"salary_not_confirmed"});
    }

    const member = await apiMemberFromRequest(req);
    if(!canModerateFarmReports(member) && !canModerateWarningsAndFines(member)){
      return res.status(403).json({ok:false,error:"no_permission"});
    }

    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    const closedAt = req.body.closedAt || now();
    const text = String(req.body.text || "").trim();

    const db = readDb();
    const archived = db.farmReports || [];
    db.farmReportsArchive = Array.isArray(db.farmReportsArchive) ? db.farmReportsArchive : [];
    db.farmReportsArchive.unshift({
      id: id("week"),
      closedAt,
      rows,
      reports: archived,
      text,
      salaryHash: req.body.salaryHash || ""
    });

    if(typeof cleanupOldSalaryArchive === "function") cleanupOldSalaryArchive(db);

    db.farmReports = [];
    writeDb(db);

    const salaryChannelId = CONFIG.channels?.salary || CONFIG.salaryChannelId;
    const ch = salaryChannelId ? await client.channels.fetch(salaryChannelId).catch(()=>null) : null;
    if(ch){
      await ch.send("🔒 **Тиждень закрито. Старі farm-звіти очищено. Новий тиждень відкрито.**");
    }

    if(typeof addLog === "function") addLog("Тиждень ЗП закрито", {count:rows.length});
    return res.json({ok:true,closed:true,count:rows.length});
  }catch(e){
    console.error("salary close week error:", e);
    return res.status(500).json({ok:false,error:"salary_close_week_failed",details:e.message});
  }
});





app.get("/api/blacklist", protect, (req,res)=>{
  const db=readDb();
  res.json({ok:true,blacklist:db.blacklist || []});
});

app.post("/api/blacklist", protect, async (req,res)=>{
  try{
    const member = await apiMemberFromRequest(req);
    if(!canManageBlacklist(member)) return res.status(403).json({ok:false,error:"no_permission"});

    const db=readDb();
    const staticId = String(req.body.staticId || req.body.playerId || "").trim();
    if(!staticId) return res.status(400).json({ok:false,error:"static_id_required"});

    const item={
      id:id("black"),
      nickname:req.body.nickname||req.body.nick||"",
      staticId,
      dangerLevel:req.body.dangerLevel||req.body.level||"🟡 Підозрілий",
      reason:req.body.reason||"",
      createdBy:req.headers["x-discord-user-id"] || "",
      createdAt:now()
    };

    const existing = (db.blacklist || []).find(x => String(x.staticId) === String(staticId));
    if(existing){
      existing.nickname = item.nickname || existing.nickname;
      existing.dangerLevel = item.dangerLevel;
      existing.reason = item.reason;
      existing.updatedAt = now();
    } else {
      db.blacklist.unshift(item);
    }

    writeDb(db);
    const ch=await channel(CONFIG.channels.blacklist);
    if(ch) ch.send({embeds:[embed("🛑 Додано в чорний список",
      `**Гравець:** ${item.nickname} | ${item.staticId}\n` +
      `**Рівень:** ${item.dangerLevel}\n` +
      `**Причина:** ${item.reason || "-"}`
    )]});

    if(typeof addLog === "function") addLog(`ЧС: додано ${item.nickname} | ${item.staticId}`);
    res.json({ok:true,item:existing || item});
  }catch(e){
    console.error("blacklist add error:", e);
    res.status(500).json({ok:false,error:"blacklist_add_failed"});
  }
});

app.get("/api/blacklist/:staticId", protect, (req,res)=>{
  const found=readDb().blacklist.find(x=>String(x.staticId)===String(req.params.staticId));
  res.json({ok:true,found:found||null});
});

app.delete("/api/blacklist/:id", protect, async (req,res)=>{
  try{
    const member = await apiMemberFromRequest(req);
    if(!canManageBlacklist(member)) return res.status(403).json({ok:false,error:"no_permission"});

    const reason = String(req.body?.reason || "").trim();
    if(!reason) return res.status(400).json({ok:false,error:"reason_required"});

    const db=readDb();
    const removed=(db.blacklist||[]).find(x=>String(x.id)===String(req.params.id));
    if(!removed) return res.status(404).json({ok:false,error:"blacklist_not_found"});

    db.blacklist=(db.blacklist||[]).filter(x=>String(x.id)!==String(req.params.id));
    removed.removedAt = now();
    removed.removedBy = req.headers["x-discord-user-id"] || "";
    removed.removeReason = reason;

    db.blacklistRemoved = Array.isArray(db.blacklistRemoved) ? db.blacklistRemoved : [];
    db.blacklistRemoved.unshift(removed);
    db.blacklistRemoved = db.blacklistRemoved.slice(0,100);

    writeDb(db);

    const ch=await channel(CONFIG.channels.blacklist);
    if(ch) ch.send({embeds:[embed("✅ Знято з чорного списку",
      `**Гравець:** ${removed.nickname || "-"} | ${removed.staticId || "-"}
` +
      `**Зняв:** <@${removed.removedBy || "невідомо"}>
` +
      `**Причина:** ${reason}
` +
      `**Час:** ${removed.removedAt}`
    )]});

    if(typeof addLog === "function") addLog(`ЧС: знято ${removed.nickname} | ${removed.staticId}. Причина: ${reason}`);
    res.json({ok:true,removed});
  }catch(e){
    console.error("blacklist delete error:", e);
    res.status(500).json({ok:false,error:"blacklist_delete_failed"});
  }
});

// ---- Robust Render boot: open port immediately ----
app.listen(PORT, ()=>{
  console.log(`✅ API running on port ${PORT}`);
});

initDb()
  .then(()=>console.log("✅ DB initialized"))
  .catch(e=>console.error("⚠️ DB init failed, continuing:", e?.message || e))
  .finally(()=>{
    if(!process.env.DISCORD_BOT_TOKEN){
      console.error("❌ DISCORD_BOT_TOKEN is missing");
    }else{
      client.login(process.env.DISCORD_BOT_TOKEN).catch(e=>console.error("❌ Discord login failed:", e));
    }
  });

