const COMPLAINT_ADMIN_ROLE_ID='1527167132696313866';
import "dotenv/config";
import express from "express";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import cors from "cors";
import cron from "node-cron";
import { Client, GatewayIntentBits, Partials, EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes, SlashCommandBuilder } from "discord.js";
import { CONFIG } from "./config.js";
import {readDb, writeDb, writeDbAsync, id, initDb, getDbInfo} from "./storage.js";
import {ensureMediaSystem, uploadBase64Media, deleteMedia, getMediaPublicUrl, MEDIA_PATHS, mediaConfigured, downloadMedia} from "./media-storage.js";


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

app.disable("x-powered-by");
app.use((req,res,next)=>{res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("X-Frame-Options","DENY");res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");res.setHeader("Permissions-Policy","camera=(), microphone=(), geolocation=(), payment=()");res.setHeader("Cache-Control","no-store");next();});
const allowedOrigins=String(process.env.ALLOWED_ORIGINS||SITE_ORIGIN||"").split(",").map(x=>x.trim()).filter(Boolean);
app.use(cors({origin(origin,cb){if(!origin||allowedOrigins.includes("*")||allowedOrigins.includes(origin))return cb(null,true);return cb(new Error("CORS blocked"));}}));
app.use(express.json({ limit: "50mb" }));
const rateBuckets=new Map();
app.use((req,res,next)=>{if(req.path==="/health"||req.path==="/")return next();const key=(req.headers["x-forwarded-for"]||req.socket.remoteAddress||"unknown").toString().split(",")[0].trim();const n=Date.now(),max=req.method==="GET"?300:180;let x=rateBuckets.get(key);if(!x||n-x.start>60000)x={start:n,count:0};x.count++;rateBuckets.set(key,x);if(x.count>max)return res.status(429).json({ok:false,error:"rate_limited",message:"Забагато запитів. Спробуй через хвилину."});next();});
const AUTH_SIGNING_SECRET=process.env.AUTH_SIGNING_SECRET||API_SECRET||DISCORD_CLIENT_SECRET;
function signAuthPayload(payload){if(!AUTH_SIGNING_SECRET)throw new Error("AUTH_SIGNING_SECRET is missing");const body=Buffer.from(JSON.stringify(payload)).toString("base64url");const sig=crypto.createHmac("sha256",AUTH_SIGNING_SECRET).update(body).digest("base64url");return `${body}.${sig}`;}
function verifyAuthToken(token){try{if(!AUTH_SIGNING_SECRET||!token||!token.includes("."))return null;const [body,sig]=token.split(".");const expected=crypto.createHmac("sha256",AUTH_SIGNING_SECRET).update(body).digest("base64url");if(sig.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;const data=JSON.parse(Buffer.from(body,"base64url").toString("utf8"));if(!data?.id)return null;return data;}catch(e){return null;}}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message]
});

const money = n => `${Number(n || 0).toLocaleString("uk-UA")}$`;
const now = () => new Date().toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" });

function nextSimpleId(db, prefix, collections = []){
  const values = [];
  for(const name of collections){
    const list = Array.isArray(db?.[name]) ? db[name] : [];
    for(const item of list){
      const value = String(item?.id || "");
      const match = value.match(new RegExp(`^${prefix}_(\\d+)$`));
      if(match) values.push(Number(match[1]));
    }
  }
  const next = (values.length ? Math.max(...values) : 0) + 1;
  return `${prefix}_${next}`;
}

function protect(req, res, next){
  const bearer=String(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
  const verified=verifyAuthToken(bearer);
  if(verified){req.user={...req.user,...verified};return next();}
  if(API_SECRET && req.headers["x-api-secret"]===API_SECRET)return next();
  return res.status(401).json({ok:false,error:"auth_required",message:"Потрібен повторний вхід через Discord."});
}
function ownerOnly(req, res, next){
  const userId=String(req.user?.id||"");
  if(!userId||String(userId)!==String(CONFIG.ownerId))return res.status(404).json({ok:false,error:"not_found"});
  next();
}
async function channel(id){ return client.channels.fetch(id).catch(()=>null); }
function embed(title, description, color = 0xf1b83a){ return new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setFooter({text:"FORBES Family"}).setTimestamp(new Date()); }



function row(buttons){
  return new ActionRowBuilder().addComponents(
    buttons.map(b => new ButtonBuilder()
      .setCustomId(String(b.id))
      .setLabel(String(b.label))
      .setStyle(b.style)
    )
  );
}
function screenshotAttachment(body, fallbackName="screenshot.png"){
  try{
    let s = body && body.screenshotData;
    if(!s) return null;
    if(typeof s === "string"){
      const match = s.match(/^data:([^;]+);base64,(.+)$/s);
      if(!match) return null;
      s = {type:match[1], data:match[2], name:fallbackName};
    }
    if(!s.data) return null;

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
  try{
    const file = screenshotAttachment(body, fallbackName);

    if(file && file.tooLarge){
      const warn = `\n\n⚠️ **Скріншот не прикріплено:** файл ${file.sizeMb}MB, максимум ~${file.maxMb}MB. Змініть формат на JPG/JPEG або стисніть фото і відправте ще раз.`;
      if(payload.embeds && payload.embeds[0] && typeof payload.embeds[0].setDescription === "function"){
        const oldDesc = payload.embeds[0].data?.description || "";
        payload.embeds[0].setDescription(oldDesc + warn);
      } else {
        payload.content = (payload.content || "") + warn;
      }
      await ch.send(payload);
      return {ok:true, screenshot:false, tooLarge:true};
    }

    if(file){
      payload.files = [file];
    }

    await ch.send(payload);
    return {ok:true, screenshot:!!file};
  }catch(e){
    console.error("Discord send error:", e);
    return {ok:false, error:e?.message || String(e)};
  }
}


/* === FORBES unified role permissions === */
function _roleNorm(v){ return String(v||"").toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim(); }
function _roleNames(member){
  try{
    if(member?.roles?.cache?.map) return member.roles.cache.map(r=>_roleNorm(r.name));
    if(Array.isArray(member?.roles)) return member.roles.map(r=>_roleNorm(r.name||r));
  }catch(e){}
  return [];
}
function _hasAnyRole(member,names){
  const roles=_roleNames(member), want=names.map(_roleNorm);
  return roles.some(r=>want.some(w=>r===w || r.includes(w)));
}
function _mainId(req){
  const id = String(req?.user?.id || req?.headers?.["x-discord-user-id"] || req?.headers?.["x-user-id"] || req?.headers?.["x-discord-id"] || req?.body?.discordUserId || req?.query?.discordUserId || "");
  const main = String(process.env.MAIN_DISCORD_ID || process.env.OWNER_DISCORD_ID || process.env.OWNER_ID || "502825427761365026");
  return Boolean(id && main && id === main);
}
function canCaptAll(member,req){
  return _mainId(req)
    || userHasAnyRole(member, [
      CONFIG.roles.leader,
      CONFIG.roles.owner,
      CONFIG.roles.deputy,
      CONFIG.roles.rightHand,
      CONFIG.roles.seniorCapt
    ])
    || _hasAnyRole(member,["лідер","leader","зам","права рука","старший каптер"]);
}
function canDisciplineAll(member,req){ return forbes2026Discipline(member,req); }

function denyPerm(res,msg){return res.status(403).json({ok:false,error:"no_permission",message:msg||"Недостатньо прав."});}


/* === FORBES MEMBERS AUTOFILL HARD API === */
function _autoParseNickId(raw){
  raw = String(raw || "").trim();
  let nick = raw;
  let staticId = "";
  const patterns = [
    /^(.+?)\s*\|\s*(\d{1,10})\s*$/,
    /^(.+?)\s*#\s*(\d{1,10})\s*$/,
    /^(.+?)\s*\[\s*(\d{1,10})\s*\]\s*$/,
    /^(.+?)\s*\(\s*(\d{1,10})\s*\)\s*$/
  ];
  for(const p of patterns){
    const m = raw.match(p);
    if(m){ nick = m[1].trim(); staticId = m[2].trim(); break; }
  }
  const parts = raw.split("|").map(x=>x.trim()).filter(Boolean);
  const num = parts.find(x=>/^\d{1,10}$/.test(x));
  if(num) staticId = num;
  const textPart = parts.find(x=>!/^\d{1,10}$/.test(x) && !/^(cpt|farm|фарм|учасник|капер|каптер)$/i.test(x));
  if(textPart) nick = textPart;
  nick = String(nick || raw).replace(/\s+/g," ").trim();
  if(/^\d{15,25}$/.test(staticId)) staticId = "";
  return {nick, staticId};
}
function _autoAddMember(map, nick, staticId, roles=[], source="db"){
  const parsed = _autoParseNickId(nick);
  nick = parsed.nick || nick;
  staticId = String(staticId || parsed.staticId || "").trim();
  if(!nick || nick === "-") return;
  if(/^\d{15,25}$/.test(staticId)) staticId = "";
  const key = (staticId ? "id:"+staticId : "nick:"+nick.toLowerCase());
  const prev = map.get(key) || map.get("nick:"+nick.toLowerCase());
  const item = prev || {nick, nickname:nick, staticId:"", playerId:"", roles:[], sources:[]};
  if(staticId && !item.staticId){ item.staticId = staticId; item.playerId = staticId; }
  const roleNames = new Set((item.roles||[]).map(r=>String(r.name||r)));
  for(const r of roles || []){
    const name = typeof r === "string" ? r : r?.name;
    if(name && !roleNames.has(name)){ item.roles.push({name}); roleNames.add(name); }
  }
  if(source && !item.sources.includes(source)) item.sources.push(source);
  map.set("nick:"+nick.toLowerCase(), item);
  if(item.staticId) map.set("id:"+item.staticId, item);
}
function _autoCollectPlayersFromAny(map, obj, source){
  if(!obj || typeof obj !== "object") return;
  const directNick = obj.nick || obj.nickname || obj.player || obj.name || obj.username || obj.staticNick;
  const directId = obj.staticId || obj.playerId || obj.id || obj.gtaId || obj.gameId;
  if(directNick) _autoAddMember(map, directNick, directId, [], source);
  if(Array.isArray(obj.players)){
    for(const p of obj.players){
      _autoCollectPlayersFromAny(map, p, source);
    }
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

    const userPayload={id:user.id,name:serverNick,username:user.username,globalName:user.global_name,avatar:user.avatar,roles};
    const payload=Buffer.from(JSON.stringify(userPayload)).toString("base64url");
    const discordToken=signAuthPayload({...userPayload,iat:Date.now()});
    return res.redirect(`${NETLIFY_SITE_URL}?discord_user=${payload}&discord_token=${encodeURIComponent(discordToken)}`);
  } catch (err) {
    console.error("OAuth callback error", err);
    return res.redirect(`${NETLIFY_SITE_URL}?login=server_error`);
  }
});





function forbesMainIdFromReq(req){
  const idv = String(req?.user?.id || req?.headers?.["x-discord-user-id"] || req?.headers?.["x-user-id"] || req?.headers?.["x-discord-id"] || req?.body?.discordUserId || "");
  const main = String(process.env.MAIN_DISCORD_ID || process.env.OWNER_DISCORD_ID || process.env.OWNER_ID || "502825427761365026");
  return Boolean(idv && main && idv === main);
}



/* === FORBES MEMBERS STATIC ID + ALL ROLES FIX === */
function parseForbesStaticNick(raw){
  raw = String(raw || "").trim();
  let nick = raw;
  let staticId = "";

  const patterns = [
    /^(.+?)\s*\|\s*(\d{1,10})\s*$/,
    /^(.+?)\s*#\s*(\d{1,10})\s*$/,
    /^(.+?)\s*\[\s*(\d{1,10})\s*\]\s*$/,
    /^(.+?)\s*\(\s*(\d{1,10})\s*\)\s*$/
  ];
  for(const p of patterns){
    const m = raw.match(p);
    if(m){
      nick = m[1].trim();
      staticId = m[2].trim();
      break;
    }
  }

  // cpt | Maksim_Hunter | 19962 => Maksim_Hunter / 19962
  const parts = raw.split("|").map(x=>x.trim()).filter(Boolean);
  if(parts.length >= 2){
    const numeric = parts.find(x=>/^\d{1,10}$/.test(x));
    if(numeric) staticId = numeric;
    const possibleNick = parts.find(x=>!/^\d{1,10}$/.test(x) && !/^(cpt|farm|фарм|фармер|учасник|боєць|капер|каптер)$/i.test(x));
    if(possibleNick) nick = possibleNick;
  }

  nick = String(nick || raw)
    .replace(/^(cpt|farm)\s*[|:-]\s*/i,"")
    .replace(/\s+/g," ")
    .trim();

  return {nick, staticId};
}
function cleanPublicRolesForbes(member){
  try{
    return Array.from(member.roles.cache.values())
      .filter(r=>r && r.name && r.name !== "@everyone")
      .sort((a,b)=>(b.position||0)-(a.position||0))
      .map(r=>({id:r.id,name:r.name}))
      .filter(r=>!/^@everyone$/i.test(r.name));
  }catch(e){ return []; }
}


/* === FORBES MEMBERS STATIC ID FINAL SOURCE === */
function parseForbesStaticNickFinal(raw){
  raw = String(raw || "").trim();
  let nick = raw;
  let staticId = "";
  const parts = raw.split("|").map(x=>x.trim()).filter(Boolean);
  const numeric = parts.find(x=>/^\d{1,10}$/.test(x));
  if(numeric) staticId = numeric;
  const possibleNick = parts.find(x=>!/^\d{1,10}$/.test(x) && !/^(cpt|farm|фарм|учасник|боєць|капер|каптер)$/i.test(x));
  if(possibleNick) nick = possibleNick;
  const m = raw.match(/^(.+?)\s*(?:#|\||\[|\()\s*(\d{1,10})\s*(?:\]|\))?$/);
  if(m){ nick = m[1].trim(); staticId = m[2].trim(); }
  return {nick:nick.replace(/\s+/g," ").trim(), staticId};
}
function cleanForbesRolesFinal(member){
  try{
    return Array.from(member.roles.cache.values())
      .filter(r=>r && r.name && r.name !== "@everyone")
      .sort((a,b)=>(b.position||0)-(a.position||0))
      .map(r=>({id:r.id,name:r.name}));
  }catch(e){ return []; }
}

async function getPublicMembersFromDiscord(){
  try{
    const guildId = CONFIG.guildId || process.env.GUILD_ID || process.env.DISCORD_GUILD_ID || CONFIG.serverId;
    const guild = guildId ? await client.guilds.fetch(guildId).catch(()=>null) : client.guilds.cache.first();
    if(!guild) return [];
    const fetched = await guild.members.fetch().catch(()=>null);
    const collection = fetched || guild.members.cache;
    return Array.from(collection.values())
      .filter(m=>!m.user?.bot)
      .map(m=>{
        const display = m.displayName || m.nickname || m.user?.username || "Unknown";
        const parsed = parseForbesStaticNickFinal(display);
        const roles = cleanForbesRolesFinal(m);
        return {
          nick: parsed.nick,
          nickname: parsed.nick,
          username: m.user?.username || parsed.nick,
          staticId: parsed.staticId,
          playerId: parsed.staticId,
          id: parsed.staticId,
          role: roles[0]?.name || "Учасник",
          roles,
          status: m.presence?.status || "offline",
          presence: m.presence?.status || "offline",
          online: Boolean(m.presence && m.presence.status && m.presence.status !== "offline"),
          isOnline: Boolean(m.presence && m.presence.status && m.presence.status !== "offline")
        };
      })
      .sort((a,b)=>String(a.nick).localeCompare(String(b.nick),"uk"));
  }catch(e){
    console.error("getPublicMembersFromDiscord failed", e);
    return [];
  }
}

function publicCleanGallery(db){
  const raw = Array.isArray(db.gallery) ? db.gallery : [];
  const seen = new Set();
  return raw.map(g=>({
      id:g.id || g._id || "",
      title:g.title || g.name || "Фото FORBES",
      url:g.url || g.photoUrl || g.imageUrl || "",
      photoUrl:g.photoUrl || g.url || g.imageUrl || "",
      createdAt:g.createdAt || ""
    }))
    .filter(g=>{
      const u = g.url || g.photoUrl;
      if(!u || !/^https?:\/\//i.test(u) || seen.has(u)) return false;
      seen.add(u);
      return true;
    });
}
function publicCleanCars(db){
  const raw = Array.isArray(db.cars) ? db.cars : [];
  return raw.map(c=>({
    id:c.id,
    name:c.name||c.title||"",
    number:c.number||"",
    place:c.place||c.location||"",
    rank:c.rank||c.profileRankRemoved||c.accessRank||"",
    category:c.category||c.type||c.segment||"premium",
    categoryName:c.categoryName||"",
    description:c.description||c.subtitle||"",
    specPower:c.specPower||c.power||"",
    specEngine:c.specEngine||c.engine||"",
    specDrive:c.specDrive||c.drive||"",
    specSpeed:c.specSpeed||c.maxSpeed||"",
    specAccel:c.specAccel||c.accel||c.acceleration||"",
    specSeats:c.specSeats||c.seats||"",
    status:c.status||c.availability||"",
    photoUrl:c.photoUrl||c.url||c.imageUrl||c.media?.publicUrl||c.media?.url||"",
    media:c.media||null,
    createdAt:c.createdAt||""
  }));
}
function mergedSiteSettings(db){
  const legacy=(db && db.familyInfo && typeof db.familyInfo==="object")?db.familyInfo:{};
  const dedicated=(db && db.siteSettings && typeof db.siteSettings==="object")?db.siteSettings:{};
  const historyObj=(db && db.familyHistory && typeof db.familyHistory==="object")?db.familyHistory:{};
  const history=String(dedicated.history ?? legacy.history ?? legacy.description ?? historyObj.text ?? "");
  const rules=String(dedicated.familyRules ?? legacy.familyRules ?? "");
  const legalUpdated=String(dedicated.legalUpdated ?? legacy.legalUpdated ?? "");
  return {
    ...legacy,
    ...dedicated,
    history,
    description:String(dedicated.description ?? legacy.description ?? history),
    familyRules:rules,
    legalUpdated
  };
}

function siteSettingsPayload(body, old){
  const has=(key)=>Object.prototype.hasOwnProperty.call(body,key);
  const text=(v,max=200000)=>String(v??"").slice(0,max);
  const keep=(key, max=200000)=>has(key)?text(body[key],max):text(old[key],max);
  return {
    ...old,
    aboutDescription:keep("aboutDescription",20000),
    aboutWho:keep("aboutWho",20000),
    aboutValues:keep("aboutValues",20000),
    aboutNo:keep("aboutNo",20000),
    history:has("history")?text(body.history,200000):(has("description")?text(body.description,200000):text(old.history||old.description,200000)),
    description:has("description")?text(body.description,200000):(has("history")?text(body.history,200000):text(old.description||old.history,200000)),
    familyRules:keep("familyRules",300000),
    legalContact:has("legalContact")?text(body.legalContact,5000):text(old.legalContact||"Discord сервер FORBES",5000),
    legalUpdated:keep("legalUpdated",40),
    familySignUrl:has("familySignUrl")?text(body.familySignUrl,5000):text(old.familySignUrl,5000),
    houseLocation:keep("houseLocation",10000),
    housePrimeTime:keep("housePrimeTime",10000),
    houseRole:keep("houseRole",10000),
    houseMode:keep("houseMode",10000),
    housePriority:keep("housePriority",10000),
    houseDescription:keep("houseDescription",100000),
    housePhotoUrl:has("housePhotoUrl")?text(body.housePhotoUrl,5000):text(old.housePhotoUrl,5000),
    leadership:Array.isArray(body.leadership)?body.leadership.slice(0,20).map(x=>({
      role:text(x?.role,100),name:text(x?.name,100),staticId:text(x?.staticId,40),
      description:text(x?.description,500),photoUrl:text(x?.photoUrl,5000),visible:x?.visible!==false
    })):(Array.isArray(old.leadership)?old.leadership:[]),
    updatedAt:now()
  };
}

async function persistSiteSettings(db, body){
  const old=mergedSiteSettings(db);
  const saved=siteSettingsPayload(body||{},old);
  db.siteSettings={...saved};
  db.familyInfo={...(db.familyInfo||{}),...saved};
  db.familyHistory={
    ...(db.familyHistory||{}),
    title:(db.familyHistory&&db.familyHistory.title)||"Історія сім’ї",
    text:saved.history,
    photos:Array.isArray(db.familyHistory?.photos)?db.familyHistory.photos:[],
    updatedAt:saved.updatedAt
  };
  const wr=await writeDbAsync(db);
  if(!wr.ok) throw new Error(wr.error||"db_write_failed");
  return mergedSiteSettings(readDb());
}

app.get("/api/family-info", async (req,res)=>{
  try{const db=readDb();const info=mergedSiteSettings(db);res.json({ok:true,familyInfo:info,siteSettings:info,info});}
  catch(e){console.error("family info get error",e);res.status(500).json({ok:false,error:"family_info_get_failed",message:e.message});}
});

app.post("/api/family-info", protect, async (req,res)=>{
  try{
    if(!forbesMainIdFromReq(req)) return res.status(403).json({ok:false,error:"no_permission",message:"Ваш Discord ID не має доступу."});
    const saved=await persistSiteSettings(readDb(),req.body||{});
    res.json({ok:true,familyInfo:saved,siteSettings:saved,info:saved,persisted:true});
  }catch(e){console.error("family info save error",e);res.status(500).json({ok:false,error:"family_info_save_failed",message:e.message});}
});

app.get("/api/site-settings", async (req,res)=>{
  try{const info=mergedSiteSettings(readDb());res.json({ok:true,siteSettings:info,familyInfo:info,info});}
  catch(e){console.error("site settings get error",e);res.status(500).json({ok:false,error:"site_settings_get_failed",message:e.message});}
});

app.post("/api/site-settings", protect, async (req,res)=>{
  try{
    if(!forbesMainIdFromReq(req)) return res.status(403).json({ok:false,error:"no_permission",message:"Ваш Discord ID не має доступу."});
    const saved=await persistSiteSettings(readDb(),req.body||{});
    res.json({ok:true,siteSettings:saved,familyInfo:saved,info:saved,persisted:true});
  }catch(e){console.error("site settings save error",e);res.status(500).json({ok:false,error:"site_settings_save_failed",message:e.message});}
});

app.get("/api/cars", async (req,res)=>{
  try{ const db=readDb(); const cars=publicCleanCars(db); res.json({ok:true,cars,count:cars.length}); }
  catch(e){ console.error("cars get error",e); res.status(500).json({ok:false,error:"cars_get_failed",message:e.message}); }
});

app.post("/api/cars", protect, async (req,res)=>{
  try{
    if(!forbesMainIdFromReq(req)) return res.status(403).json({ok:false,error:"no_permission",message:"Додавати машини може тільки головний Discord ID."});
    const db=readDb(); db.cars=Array.isArray(db.cars)?db.cars:[]; if(db.cars.length>=60) return res.status(400).json({ok:false,error:"cars_limit",message:"Максимум 60 машин."});
    let media=null;
    const filePayload=req.body.file||req.body.photo||req.body.photoData||req.body.imageData||null;
    if(filePayload && typeof uploadBase64Media==="function") media=await uploadBase64Media("car",filePayload);
    const rank=String(req.body.rank||req.body.profileRankRemoved||req.body.accessRank||"").trim();
    const photoUrl=media?.publicUrl||req.body.photoUrl||req.body.url||req.body.imageUrl||"";
    const car={id:id("car"),name:req.body.name||"",category:req.body.category||"premium",categoryName:req.body.categoryName||"",number:req.body.number||"",place:req.body.place||"",rank,profileRankRemoved:rank,accessRank:rank,description:req.body.description||"",specPower:req.body.specPower||req.body.power||"",specEngine:req.body.specEngine||req.body.engine||"",specDrive:req.body.specDrive||req.body.drive||"",specSpeed:req.body.specSpeed||req.body.maxSpeed||"",specAccel:req.body.specAccel||req.body.accel||req.body.acceleration||"",specSeats:req.body.specSeats||req.body.seats||"",status:req.body.status||req.body.availability||"",photoUrl,url:photoUrl,media,createdAt:now()};
    db.cars.unshift(car);
    const wr=typeof writeDbAsync==="function"?await writeDbAsync(db):(writeDb(db),{ok:true});
    if(wr && wr.ok===false) throw new Error(wr.error||"car_db_write_failed");
    const cars=publicCleanCars(db); res.json({ok:true,car:publicCleanCars({cars:[car]})[0],cars,count:cars.length});
  }catch(e){ console.error("car add error",e); res.status(500).json({ok:false,error:"car_add_failed",message:e.message}); }
});

app.delete("/api/cars/:id", protect, async (req,res)=>{
  try{
    if(!forbesMainIdFromReq(req)) return res.status(403).json({ok:false,error:"no_permission",message:"Видаляти машини може тільки головний Discord ID."});
    const db=readDb(); db.cars=Array.isArray(db.cars)?db.cars:[]; db.cars=db.cars.filter(x=>String(x.id)!==String(req.params.id)); writeDb(db); const cars=publicCleanCars(db); res.json({ok:true,cars,count:cars.length});
  }catch(e){ console.error("car delete error",e); res.status(500).json({ok:false,error:"car_delete_failed",message:e.message}); }
});

app.get("/api/contracts", (req,res)=>{
  res.set("Cache-Control","no-store, no-cache, must-revalidate, private");
  const db = readDb();
  db.contracts = Array.isArray(db.contracts) ? db.contracts : [];
  res.json({ok:true,contracts:db.contracts,serverTime:new Date().toISOString()});
});
app.put("/api/contracts/:id", protect, ownerOnly, async (req,res)=>{
  try{
    const db=readDb();
    db.contracts=Array.isArray(db.contracts)?db.contracts:[];
    const c=db.contracts.find(x=>String(x.id)===String(req.params.id));
    if(!c) return res.status(404).json({ok:false,error:"contract_not_found"});
    c.name=String(req.body.name||c.name||"").trim();
    c.amount=Number(req.body.amount || c.amount || c.contractAmount || 0);
    c.contractAmount=c.amount;
    c.active=Boolean(req.body.active ?? c.active);
    c.updatedAt=now();
    const wr = typeof writeDbAsync==="function" ? await writeDbAsync(db) : (writeDb(db), {ok:true});
    if(!wr.ok) return res.status(500).json({ok:false,error:"contracts_db_write_failed",message:wr.error||"write failed"});
    const fresh=readDb();
    res.json({ok:true,contract:c,contracts:Array.isArray(fresh.contracts)?fresh.contracts:db.contracts,writeResult:wr});
  }catch(e){
    console.error("contracts put failed",e);
    res.status(500).json({ok:false,error:"contracts_put_failed",message:e.message});
  }
});
app.delete("/api/contracts/:id", protect, ownerOnly, async (req,res)=>{
  try{
    const db=readDb();
    db.contracts=(Array.isArray(db.contracts)?db.contracts:[]).filter(x=>String(x.id)!==String(req.params.id));
    const wr = typeof writeDbAsync==="function" ? await writeDbAsync(db) : (writeDb(db), {ok:true});
    if(!wr.ok) return res.status(500).json({ok:false,error:"contracts_db_write_failed",message:wr.error||"write failed"});
    const fresh=readDb();
    res.json({ok:true,contracts:Array.isArray(fresh.contracts)?fresh.contracts:db.contracts,writeResult:wr});
  }catch(e){
    console.error("contracts delete failed",e);
    res.status(500).json({ok:false,error:"contracts_delete_failed",message:e.message});
  }
});



// V25 — owner birthday management
app.get("/api/admin/birthdays", protect, ownerOnly, async (req,res)=>{
  try{
    const db=readDb();
    const birthdays=(Array.isArray(db.birthdays)?db.birthdays:[])
      .slice()
      .sort((a,b)=>(Number(a.month)-Number(b.month))||(Number(a.day)-Number(b.day))||String(a.nickname||"").localeCompare(String(b.nickname||"")));
    res.json({ok:true,birthdays});
  }catch(e){res.status(500).json({ok:false,error:"birthday_list_failed",message:e.message});}
});

app.put("/api/admin/birthdays/:id", protect, ownerOnly, async (req,res)=>{
  try{
    const db=readDb(); db.birthdays=Array.isArray(db.birthdays)?db.birthdays:[];
    const item=db.birthdays.find(x=>String(x.id)===String(req.params.id));
    if(!item)return res.status(404).json({ok:false,error:"birthday_not_found",message:"Запис дня народження не знайдено."});
    const nickname=String(req.body.nickname||"").trim();
    const staticId=String(req.body.staticId||"").trim();
    const day=Number(req.body.day||req.body.birthdayDay||0);
    const month=Number(req.body.month||req.body.birthdayMonth||0);
    if(!nickname)return res.status(400).json({ok:false,error:"nickname_required",message:"Вкажи нік."});
    if(!staticId)return res.status(400).json({ok:false,error:"static_id_required",message:"Вкажи Static ID."});
    if(!Number.isInteger(day)||day<1||day>31||!Number.isInteger(month)||month<1||month>12)return res.status(400).json({ok:false,error:"invalid_birthday",message:"Вкажи правильний день і місяць."});
    item.nickname=nickname; item.staticId=staticId; item.day=day; item.month=month;
    item.enabled=req.body.enabled!==false; item.updatedAt=now(); item.updatedBy=String(req.user?.id||"");
    const wr=await writeDbAsync(db); if(!wr.ok)return res.status(500).json({ok:false,error:"birthday_db_write_failed",message:wr.error||"Не вдалося зберегти."});
    try{const ch=await channel(CONFIG.channels.birthdays);if(ch)await ch.send({embeds:[embed("✏️ День народження відредаговано",`**Нік:** ${item.nickname}
**Static ID:** ${item.staticId}
**Дата:** ${String(day).padStart(2,"0")}.${String(month).padStart(2,"0")}
**Змінив:** <@${req.user.id}>`)],allowedMentions:{users:[String(req.user.id)]}});}catch(e){console.warn("birthday edit discord skipped",e.message)}
    res.json({ok:true,birthday:item});
  }catch(e){res.status(500).json({ok:false,error:"birthday_update_failed",message:e.message});}
});

app.delete("/api/admin/birthdays/:id", protect, ownerOnly, async (req,res)=>{
  try{
    const db=readDb(); db.birthdays=Array.isArray(db.birthdays)?db.birthdays:[];
    const item=db.birthdays.find(x=>String(x.id)===String(req.params.id));
    if(!item)return res.status(404).json({ok:false,error:"birthday_not_found",message:"Запис дня народження не знайдено."});
    db.birthdays=db.birthdays.filter(x=>x!==item);
    db.birthdayAnnouncements=(Array.isArray(db.birthdayAnnouncements)?db.birthdayAnnouncements:[]).filter(x=>String(x.birthdayId)!==String(item.id));
    const wr=await writeDbAsync(db); if(!wr.ok)return res.status(500).json({ok:false,error:"birthday_db_write_failed",message:wr.error||"Не вдалося видалити."});
    res.json({ok:true,deleted:item.id});
  }catch(e){res.status(500).json({ok:false,error:"birthday_delete_failed",message:e.message});}
});

app.post("/api/birthdays", protect, async (req,res)=>{
  try{
    const nickname=String(req.body.nickname||req.body.nick||"").trim();
    const staticId=String(req.body.staticId||req.body.playerId||"").trim();
    const day=Number(req.body.birthdayDay||req.body.day||0);
    const month=Number(req.body.birthdayMonth||req.body.month||0);
    if(!nickname) return res.status(400).json({ok:false,error:"nickname_required",message:"Вкажи RP-нік."});
    if(!staticId) return res.status(400).json({ok:false,error:"static_id_required",message:"Вкажи Static ID."});
    if(!Number.isInteger(day)||day<1||day>31||!Number.isInteger(month)||month<1||month>12) return res.status(400).json({ok:false,error:"invalid_birthday",message:"Вкажи правильний день і місяць."});
    const db=readDb(); db.birthdays=Array.isArray(db.birthdays)?db.birthdays:[];
    const discordId=String(req.user?.id||req.body.discordUserId||"");
    const existing=db.birthdays.find(x=>discordId&&String(x.discordUserId||"")===discordId)||db.birthdays.find(x=>String(x.staticId||"")===staticId);
    const birthday={id:existing?.id||id("birthday"),nickname,staticId,discordUserId:discordId,discordName:req.body.discordName||req.body.discord||"",day,month,enabled:true,createdAt:existing?.createdAt||now(),updatedAt:now()};
    if(existing)Object.assign(existing,birthday);else db.birthdays.unshift(birthday);
    const wr=typeof writeDbAsync==="function"?await writeDbAsync(db):(writeDb(db),{ok:true});
    if(!wr.ok)return res.status(500).json({ok:false,error:"birthday_db_write_failed",message:wr.error||"Не вдалося зберегти."});
    let discordSent=false,discordError="";
    try{const ch=await channel(CONFIG.channels.birthdays);if(ch){await ch.send({embeds:[embed("🎂 Додано день народження",`**Нік:** ${birthday.nickname}
**Static ID:** ${birthday.staticId}
**Discord:** ${birthday.discordUserId?`<@${birthday.discordUserId}>`:birthday.discordName||"-"}
**Дата:** ${String(day).padStart(2,"0")}.${String(month).padStart(2,"0")}`)],allowedMentions:{users:birthday.discordUserId?[birthday.discordUserId]:[]}});discordSent=true}else discordError="Канал днів народження не знайдено"}catch(e){discordError=e.message||String(e)}
    res.json({ok:true,birthday,application:birthday,discordSent,discordError});
  }catch(e){console.error("birthday post failed",e);res.status(500).json({ok:false,error:"birthday_post_failed",message:e.message})}
});

app.post("/api/applications", protect, async (req,res)=>{
  try{
    const db=readDb();
    db.applications = Array.isArray(db.applications) ? db.applications : [];

    const item={
      id:id("app"),
      type:req.body.type||"family",
      nickname:req.body.nickname||req.body.nick||"",
      staticId:req.body.staticId||req.body.playerId||"",
      discord:req.body.discord||"",
      discordUserId:req.body.discordUserId||"",
      discordName:req.body.discordName||"",
      age:req.body.age||"",
      level:req.body.level||"",
      serverExperience:req.body.serverExperience||"",
      dailyHours:req.body.dailyHours||"",
      experience:req.body.experience||"",
      motivation:req.body.motivation||"",
      microphone:req.body.microphone||"",
      additionalComment:req.body.additionalComment||"",
      comment:req.body.comment||"",
      startDate:req.body.startDate||"",
      endDate:req.body.endDate||"",
      reason:req.body.reason||"",
      birthdayDay:Number(req.body.birthdayDay||0),
      birthdayMonth:Number(req.body.birthdayMonth||0),
      confirmed:Boolean(req.body.confirmed),
      status:"pending",
      createdAt:now()
    };

    const typeLower = String(item.type || "").toLowerCase();
    const isBirthdayApplication = typeLower.includes("день народ") || typeLower === "birthday";
    if(isBirthdayApplication){
      const day=Number(item.birthdayDay);
      const month=Number(item.birthdayMonth);
      if(!Number.isInteger(day)||day<1||day>31||!Number.isInteger(month)||month<1||month>12){
        return res.status(400).json({ok:false,error:"invalid_birthday",message:"Вкажіть правильний день і місяць."});
      }
      db.birthdays=Array.isArray(db.birthdays)?db.birthdays:[];
      const discordId=String(req.user?.id||item.discordUserId||"");
      const existing=db.birthdays.find(x=>discordId&&String(x.discordUserId||"")===discordId) || db.birthdays.find(x=>String(x.staticId||"")===String(item.staticId||""));
      const birthday={
        id:existing?.id||id("birthday"), nickname:item.nickname, staticId:item.staticId, discordUserId:discordId,
        discordName:item.discordName||item.discord, day, month, enabled:true,
        createdAt:existing?.createdAt||now(), updatedAt:now()
      };
      if(existing) Object.assign(existing,birthday); else db.birthdays.unshift(birthday);
      writeDb(db);
      let discordSent=false,discordError="";
      try{
        const ch=await channel(CONFIG.channels.birthdays);
        if(ch){
          await ch.send({embeds:[embed("🎂 Додано день народження",`**Нік:** ${birthday.nickname}\n**Static ID:** ${birthday.staticId}\n**Discord:** ${birthday.discordUserId?`<@${birthday.discordUserId}>`:birthday.discordName||"-"}\n**Дата:** ${String(day).padStart(2,"0")}.${String(month).padStart(2,"0")}`)],allowedMentions:{users:birthday.discordUserId?[birthday.discordUserId]:[]}});
          discordSent=true;
        } else discordError="Канал днів народження не знайдено";
      }catch(e){discordError=e.message||String(e);}
      return res.json({ok:true,birthday,application:birthday,discordSent,discordError});
    }

    db.applications.unshift(item);
    writeDb(db);

    
    const chId = typeLower.includes("увал") || typeLower.includes("звіль") || typeLower === "dismissal"
      ? CONFIG.channels.dismissals
      : typeLower.includes("відпуст") || typeLower === "vacation"
        ? CONFIG.channels.vacations
        : typeLower.includes("фарм") || typeLower === "farm"
          ? CONFIG.channels.applicationsFarm
          : typeLower.includes("капт") || typeLower === "capt"
            ? CONFIG.channels.applicationsCapt
            : CONFIG.channels.applicationsFamily;

    let discordSent = false;
    let discordError = "";
    try{
      const ch = await channel(chId);
      if(!ch){
        discordError = `Канал заявок не знайдено: ${chId}`;
      }else{
        await ch.send({
          embeds:[embed("📝 Нова заявка",
            `**Тип:** ${item.type}
`+
            `**Нік:** ${item.nickname}
`+
            `**ID:** ${item.staticId}
`+
            `**Discord:** ${item.discord}
`+
            `**Discord user:** ${item.discordUserId ? `<@${item.discordUserId}>` : "не авторизований"}
`+
            `**Вік:** ${item.age||"-"}
`+
            `**Рівень на сервері:** ${item.level||"-"}
`+
            `**Грає на сервері:** ${item.serverExperience||"-"}
`+
            `**Грає на день:** ${item.dailyHours||"-"}
`+
            `**Досвід:** ${item.experience||"-"}
`+
            `**Мотивація:** ${item.motivation||"-"}
`+
            `**Мікрофон:** ${item.microphone||"-"}
`+
            `**Додатковий коментар:** ${item.additionalComment||"-"}
`+
            `**Період:** ${item.startDate||"-"} — ${item.endDate||"-"}
`+
            `**Причина:** ${item.reason||"-"}`
          )],
          components:[row([
            {id:`app_approve:${item.id}`,label:"✅ Одобрити",style:ButtonStyle.Success},
            {id:`app_reject:${item.id}`,label:"❌ Відхилити",style:ButtonStyle.Danger}
          ])]
        });
        discordSent = true;
      }
    }catch(e){
      discordError = e.message || String(e);
      console.error("Application Discord send failed:", e);
    }

    res.json({ok:true,application:item,discordSent,discordError,channelId:chId});
  }catch(e){
    console.error("POST /api/applications failed:", e);
    res.status(500).json({ok:false,error:"application_create_failed",message:e.message});
  }
});



function pragueDateParts(){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Prague',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const get=t=>parts.find(x=>x.type===t)?.value||'';
  return {year:get('year'),month:Number(get('month')),day:Number(get('day')),key:`${get('year')}-${get('month')}-${get('day')}`};
}
async function processBirthdayAnnouncements(){
  if(!client.isReady()) return {sent:0,ready:false};
  const d=pragueDateParts();
  const db=readDb();
  db.birthdays=Array.isArray(db.birthdays)?db.birthdays:[];
  db.birthdayAnnouncements=Array.isArray(db.birthdayAnnouncements)?db.birthdayAnnouncements:[];
  const today=db.birthdays.filter(x=>x.enabled!==false&&Number(x.day)===d.day&&Number(x.month)===d.month);
  let sent=0;
  const ch=await channel(CONFIG.channels.generalChat).catch(()=>null);
  if(ch){
    for(const b of today){
      const announceKey=`${d.key}:${b.id||b.discordUserId||b.staticId}`;
      if(db.birthdayAnnouncements.some(x=>x.key===announceKey)) continue;
      const mention=b.discordUserId?`<@${b.discordUserId}>`:`**${b.nickname} [${b.staticId}]**`;
      await ch.send({content:`@everyone 🎉 Сьогодні у ${mention} день народження! Давайте привітаємо його! 🎂`,allowedMentions:{parse:['everyone'],users:b.discordUserId?[String(b.discordUserId)]:[]}});
      db.birthdayAnnouncements.push({key:announceKey,birthdayId:b.id,date:d.key,sentAt:now()});
      sent++;
    }
    if(sent) writeDb(db);
  }
  return {sent,ready:true,today};
}
app.get('/api/birthdays/today', async(req,res)=>{
  try{
    const result=await processBirthdayAnnouncements();
    const d=pragueDateParts();
    const db=readDb();
    const viewer=String(req.query.viewerDiscordId||'');
    const birthdays=(Array.isArray(db.birthdays)?db.birthdays:[]).filter(x=>x.enabled!==false&&Number(x.day)===d.day&&Number(x.month)===d.month).map(x=>({nickname:x.nickname,staticId:x.staticId,isViewer:Boolean(viewer&&String(x.discordUserId||'')===viewer)}));
    res.json({ok:true,date:d.key,birthdays,announcementsSent:result.sent,botReady:result.ready});
  }catch(e){console.error('birthday today failed',e);res.status(500).json({ok:false,error:'birthday_today_failed',message:e.message});}
});

function safeRemoteMediaUrl(value){
  const v=String(value||"").trim();
  return /^https?:\/\//i.test(v) ? v : "";
}
function stripTransientMediaFields(obj){
  if(!obj || typeof obj!=="object") return obj;
  const copy={...obj};
  for(const key of ["screenshotData","imageData","photoData","fileData","attachmentData","proofData","proofImageData"]){
    delete copy[key];
  }
  return copy;
}

app.get("/api/farm-reports", protect, async (req,res)=>{
  const member = await requireFamilyRole(req, res); if(!member) return;
  res.set("Cache-Control","no-store, no-cache, must-revalidate, private");
  const db = readDb();
  const reports = (db.farmReports || [])
    .filter(r=>!r.salaryClosed && r.status !== "paid_week_closed")
    .map(r => {
      const amount = Number(r.amount || r.contractAmount || 0);
      const players = Array.isArray(r.players) ? r.players : [];
      const each = Number(r.each || (players.length ? Math.floor(amount * 0.8 / players.length) : 0));
      return {
        ...r,
        amount,
        contractAmount:Number(r.contractAmount || amount || 0),
        each,
        familyShare:Number(r.familyShare || Math.floor(amount * 0.2)),
        status:r.status || (r.reviewedAt ? "approved" : "pending")
      };
    });
  res.json({ok:true,reports,count:reports.length,serverTime:new Date().toISOString()});
});


app.post("/api/farm-reports", protect, async (req,res)=>{
  try{
    const member = await apiMemberOr403(req, res);
    if(!member) return;
    // farm-звіт доступний всім авторизованим учасникам
if(!memberHasRealServerRole(member)){
      return publicError(res,403,"no_server_role","Потрібна хоча б одна роль на Discord сервері.");
    }

    const screenshotData = req.body.screenshotData || "";
    const screenshotFile = screenshotAttachment(req.body, "farm-proof.jpg");
    if(!screenshotData || !screenshotFile){
      return publicError(res,400,"screenshot_required","Додай скріншот виконання контракту. Без доказу фарм-звіт не приймається.");
    }
    if(screenshotFile.tooLarge){
      return publicError(res,400,"screenshot_too_large",`Скріншот завеликий (${screenshotFile.sizeMb}MB). Максимум ${screenshotFile.maxMb}MB.`);
    }
    const players = Array.isArray(req.body.players) ? req.body.players : [];
    const amount = Number(req.body.amount || req.body.contractAmount || 0);
    const each = Number(req.body.each || (players.length ? Math.floor(amount * 0.8 / players.length) : 0));
    const familyShare = Number(req.body.familyShare || Math.floor(amount * 0.2));

    const item = {
      id:id("farm"),
      discordUserId:req.user?.id || req.body.discordUserId || req.headers["x-discord-user-id"] || "",
      player:req.body.player || req.body.nickname || member.displayName || req.user?.username || "",
      staticId:req.body.staticId || req.body.id || "",
      contract:req.body.contract || req.body.contractName || "",
      contractAmount:amount,
      amount,
      each,
      familyShare,
      players,
      comment:req.body.comment || "",
      screenshotUrl:safeRemoteMediaUrl(req.body.screenshotUrl),
      status:"pending",
      discordStatus:"pending",
      createdAt:now()
    };

    debugLog("farm_report_submit", {by:member.id, reportId:item.id, amount, players:players.length});

    const db = readDb();
    db.farmReports = Array.isArray(db.farmReports) ? db.farmReports : [];
    db.farmReports.unshift(item);
    trimSystemLogs(db);
    writeDb(db);

    const components = [row([
      {id:`farm_approve:${item.id}`,label:"✅ Одобрити",style:ButtonStyle.Success},
      {id:`farm_reject:${item.id}`,label:"❌ Відхилити",style:ButtonStyle.Danger}
    ])];

    const farmPlayersLabel = await formatFarmPlayersForDiscord(players);
    const content = {
      content:item.discordUserId?`<@${item.discordUserId}>`:undefined,
      allowedMentions:{users:item.discordUserId?[item.discordUserId]:[]},
      embeds:[embed("🚜 Фарм-звіт на перевірку",
        `**№ звіту:** ${item.id}\n`+
        `**Гравець:** ${item.discordUserId ? `<@${item.discordUserId}>` : item.player || "-"}\n`+
        `**Контракт:** ${item.contract || "-"}\n`+
        `**Сума контракту:** ${money(amount)}\n`+
        `**У банк сімʼї 20%:** ${money(familyShare)}\n`+
        `**Гравцям 80%:** ${money(Math.floor(amount*0.8))}\n`+
        `**Кожному:** ${money(each)}\n`+
        `**Гравці:** ${farmPlayersLabel}\n`+
        `**Коментар:** ${item.comment || "-"}`
      )],
      components
    };

    try{
      const ch = await channel(CONFIG.channels.farmReports);
      if(!ch) throw new Error("Канал farm-звітів не знайдено.");
      if(typeof sendWithOptionalScreenshot !== "function") throw new Error("Модуль прикріплення скріншота недоступний.");
      const sent = await sendWithOptionalScreenshot(ch, content, req.body, `farm-${item.id}.jpg`);
      if(!sent.ok || !sent.screenshot) throw new Error(sent.error || "Discord не отримав скріншот доказу.");
      const db2=readDb();
      const saved=(db2.farmReports||[]).find(x=>x.id===item.id);
      if(saved){ saved.discordStatus="sent"; saved.discordError=""; }
      writeDb(db2);
      item.discordStatus="sent";
      debugLog("farm_report_sent", {reportId:item.id});
      return res.json({ok:true,queued:false,report:item});
    }catch(discordErr){
      console.error("farm discord send failed, saved to DB:", discordErr);
      const db2=readDb();
      const saved=(db2.farmReports||[]).find(x=>x.id===item.id);
      if(saved){
        saved.discordStatus="queued";
        saved.discordError=discordErr.message || String(discordErr);
      }
      if(typeof queueDiscordSend === "function"){
        const q=queueDiscordSend("farm_report", CONFIG.channels.farmReports, content, item.id, discordErr.message || String(discordErr));
        if(saved) saved.discordQueueId=q?.id||"";
      }
      writeDb(db2);
      item.discordStatus="queued";
      item.discordError=discordErr.message || String(discordErr);
      debugLog("farm_report_queued", {reportId:item.id, error:item.discordError});
      return res.json({ok:true,queued:true,warning:"discord_send_queued",message:"Звіт збережено, Discord тимчасово не прийняв повідомлення. Він у черзі.",report:item});
    }
  }catch(e){
    console.error("farm report error:", e);
    return publicError(res,500,"farm_report_failed","Farm-звіт не відправлено.",e.message);
  }
});



app.post("/api/farm-reports/:id/status", protect, async (req,res)=>{
  try{
    const member = await apiMemberOr403(req, res);
    if(!member) return;
    if(!canModerateFarmReports(member)){
      return publicError(res,403,"no_permission","Недостатньо прав для зміни статусу farm-звіту.");
    }

    const status = String(req.body.status || "").trim();
    if(!["pending","approved","rejected"].includes(status)){
      return publicError(res,400,"bad_status","Статус має бути pending / approved / rejected.");
    }

    const db = readDb();
    const report = (db.farmReports || []).find(x => String(x.id) === String(req.params.id));
    if(!report) return publicError(res,404,"report_not_found","Farm-звіт не знайдено.");

    const oldStatus = report.status || "pending";
    report.status = status;
    report.manualStatusChangedAt = now();
    report.manualStatusChangedBy = member.id;
    report.statusHistory = Array.isArray(report.statusHistory) ? report.statusHistory : [];
    report.statusHistory.unshift({oldStatus,newStatus:status,by:member.id,at:now(),reason:req.body.reason || "manual_change"});
    report.amount = Number(report.amount || report.contractAmount || 0);
    report.contractAmount = Number(report.contractAmount || report.amount || 0);
    report.each = Number(report.each || ((report.players||[]).length ? Math.floor(report.amount*0.8/(report.players||[]).length) : 0));
    writeDb(db);

    debugLog("farm_status_manual_change", {id:report.id, oldStatus, newStatus:status, by:member.id});
    if(typeof addLog === "function") addLog("Farm статус змінено вручну", {id:report.id, oldStatus, newStatus:status, by:member.id});
    return res.json({ok:true,report});
  }catch(e){
    console.error("manual farm status error:", e);
    return publicError(res,500,"farm_status_change_failed","Не вдалося змінити статус farm-звіту.",e.message);
  }
});
app.get("/api/capts", protect, async (req,res)=>{
  const member = await requireFamilyRole(req, res); if(!member) return;
  const db=readDb();
  res.json({ok:true,capts:db.capts||[]});
});



async function requireCaptManagerFromRequest(req, res){
  const member = await apiMemberFromRequest(req);
  if(!member){
    res.status(401).json({ok:false,error:"discord_member_not_found",message:"Не бачу користувача на Discord сервері."});
    return null;
  }
  if(!canManageCaptLists(member,req)){
    console.warn("CAPT ACTION DENIED", {
      userId: member.id,
      roles: getMemberRoleIds(member),
      allowed: [CONFIG.roles.leader,CONFIG.roles.owner,CONFIG.roles.deputy,CONFIG.roles.rightHand,CONFIG.roles.seniorCapt].filter(Boolean)
    });
    res.status(403).json({ok:false,error:"no_permission",message:"Недостатньо прав. Потрібна роль Старший каптер / Права рука / Зам / Лідер."});
    return null;
  }
  return member;
}

app.post("/api/capts", protect, async (req,res)=>{
  try{
    const member = await apiMemberOr403(req, res);
    if(!member) return;

  /* FORBES_CAPT_ALL_PATCH */
  if(member && !canCaptAll(member, req)) return denyPerm(res,"Недостатньо прав для каптів/листів.");

    if(!canManageCaptLists(member,req)){
      console.warn("CAPT CREATE DENIED", {
        userId: member.id,
        roles: member.roles?.cache ? Array.from(member.roles.cache.keys()) : [],
        allowed: [CONFIG.roles.leader, CONFIG.roles.owner, CONFIG.roles.deputy, CONFIG.roles.rightHand, CONFIG.roles.seniorCapt].filter(Boolean)
      });
      return res.status(403).json({ok:false,error:"no_permission",message:"Запит на капт можуть робити тільки Старший каптер / Права рука / Зам.лідера / Лідер."});
    }

    const item={
      id:id("capt"),
      date:req.body.date||"",
      time:req.body.time||"",
      enemy:req.body.enemy||"",
      neededPlayers:Number(req.body.neededPlayers||req.body.need||0),
      comment:req.body.comment||"",
      yes:[],
      no:[],
      maybe:[],
      absent:[],
      status:"open",
      discordStatus:"pending",
      messageId:"",
      createdAt:now(),
      createdBy:req.user?.id || req.body.discordUserId || member.id || ""
    };

    const db=readDb();
    db.capts = Array.isArray(db.capts) ? db.capts : [];
    db.capts.unshift(item);
    writeDb(db);

    const ch=await channel(CONFIG.channels.captSignup);
    if(!ch) return res.status(404).json({ok:false,error:"capt_signup_channel_not_found"});

    const msg=await ch.send({
      embeds:[embed("⚔️ Запис на капт",
        `**Дата:** ${item.date||"-"}
`+
        `**Час:** ${item.time||"-"} по Києву
`+
        `**Проти:** ${item.enemy||"-"}
`+
        `**Потрібно людей:** ${item.neededPlayers||"-"}
`+
        `**Створив:** <@${item.createdBy}>
`+
        `**Коментар:** ${item.comment||"-"}`
      )],
      components:[row([
        {id:`capt_yes:${item.id}`,label:"✅ Буду",style:ButtonStyle.Success},
        {id:`capt_no:${item.id}`,label:"❌ Не буду",style:ButtonStyle.Danger},
        {id:`capt_maybe:${item.id}`,label:"❓ Не знаю",style:ButtonStyle.Secondary}
      ])]
    });

    item.messageId=msg.id;
    item.discordStatus="sent";
    const db2=readDb();
    const saved=db2.capts.find(x=>x.id===item.id);
    if(saved){ saved.messageId=msg.id; saved.discordStatus="sent"; }
    writeDb(db2);

    if(typeof scheduleCaptReminder === "function") scheduleCaptReminder(item.id);
    if(typeof addLog === "function") addLog(`Створено капт: ${item.date} ${item.time}`, {id:item.id});
    return res.json({ok:true,capt:item});
  }catch(e){
    console.error("capt create error:", e);
    return res.status(500).json({ok:false,error:"capt_create_failed",details:e.message});
  }
});



async function apiMemberFromRequest(req){
  const userId = req.user?.id || req.headers["x-discord-user-id"] || "";
  if(!userId) return null;
  const guild = await client.guilds.fetch(CONFIG.guildId);
  return await guild.members.fetch(userId).catch(()=>null);
}

app.post("/api/capts/:id/list-now", protect, async (req,res)=>{
  try {
    const member = await requireCaptManagerFromRequest(req, res);
    if(!member) return;

  /* FORBES_CAPT_ALL_PATCH */
  if(member && !canCaptAll(member, req)) return denyPerm(res,"Недостатньо прав для каптів/листів.");
    const ok = await postCaptList(req.params.id);
    if(!ok) return res.status(404).json({ok:false,error:"capt_or_channel_not_found"});
    if(typeof addLog === "function") addLog("Капт-лист відправлено", {id:req.params.id, by:member.id});
    return res.json({ok:true,message:"capt_list_sent"});
  } catch(e) {
    console.error("capt list now error:", e);
    return res.status(500).json({ok:false,error:"capt_list_failed",details:e.message});
  }
});


app.post("/api/capts/:id/absent", protect, async (req,res)=>{
  try {
    const member = await requireCaptManagerFromRequest(req, res);
    if(!member) return;

  /* Attendance fine is allowed for capt managers. */
  /* FORBES_CAPT_ALL_PATCH */
  if(member && !canCaptAll(member, req)) return denyPerm(res,"Недостатньо прав для каптів/листів.");
    const db = readDb();
    const capt = (db.capts || []).find(x => String(x.id) === String(req.params.id));
    if(!capt) return res.status(404).json({ok:false,error:"capt_not_found"});

    const userId = String(req.body.userId || "").replace(/[<@!>]/g,"").trim();
    if(!userId) return res.status(400).json({ok:false,error:"user_required"});
    const yes = (capt.yes || []).map(String);
    if(!yes.includes(userId)) return res.status(400).json({ok:false,error:"user_not_in_yes_list"});

    capt.absent = Array.isArray(capt.absent) ? capt.absent : [];
    if(!capt.absent.map(String).includes(userId)) capt.absent.push(userId);

    db.fines = Array.isArray(db.fines) ? db.fines : [];
    const fine = {
      id:id("fine"),
      nickname:req.body.nickname || "",
      staticId:req.body.staticId || "",
      discordUserId:userId,
      amount:50000,
      reason:`Неявка на капт ${capt.date || ""} ${capt.time || ""}`,
      status:"unpaid",
      createdAt:now(),
      createdBy:member.id
    };
    db.fines.unshift(fine);
    writeDb(db);

    const ch = await channel(CONFIG.channels.fines);
    if(ch){
      await ch.send({embeds:[embed("💸 Штраф за неявку на капт",
        `**Гравець:** <@${userId}>\n**Сума:** ${money(50000)}\n**Причина:** ${fine.reason}`
      )]});
    }
    if(typeof addLog === "function") addLog("Видано штраф за неявку на капт", {captId:capt.id,userId,by:member.id});
    return res.json({ok:true,fine,capt});
  } catch(e) {
    console.error("capt absent error:", e);
    return res.status(500).json({ok:false,error:"capt_absent_failed",details:e.message});
  }
});

app.post("/api/capts/:id/close", protect, async (req,res)=>{
  try {
    const member = await requireCaptManagerFromRequest(req, res);
    if(!member) return;

    if(member && typeof canCaptAll === "function" && !canCaptAll(member, req)) return denyPerm(res,"Недостатньо прав для каптів/листів.");

    const db = readDb();
    db.capts = Array.isArray(db.capts) ? db.capts : [];
    const capt = db.capts.find(x => String(x.id) === String(req.params.id));
    if(!capt) return res.status(404).json({ok:false,error:"capt_not_found",message:"Капт не знайдено."});

    const result = String(req.body.result || "").toLowerCase();
    const normalized = result === "loss" || result === "lose" || result === "програш" ? "loss" : "win";
    const resultText = normalized === "win" ? "✅ Перемога" : "❌ Програш";

    capt.status = "closed";
    capt.result = normalized;
    capt.resultText = resultText;
    capt.closedAt = now();
    capt.closedBy = member.id;

    writeDb(db);

    if(capt.messageId && CONFIG.channels.captSignup){
      const ch = await channel(CONFIG.channels.captSignup);
      if(ch){
        const msg = await ch.messages.fetch(capt.messageId).catch(()=>null);
        if(msg) await msg.edit({components:[]}).catch(()=>{});
      }
    }

    let discordSent = false;
    let discordError = "";
    try{
      const statsCh = await channel(CONFIG.channels.captReports || CONFIG.channels.captStats);
      if(!statsCh){
        discordError = `Канал капт-звітів не знайдено: ${CONFIG.channels.captReports || CONFIG.channels.captStats}`;
      }else{
        await statsCh.send({embeds:[embed("⚔️ Статистика капту",
          `**Капт №:** ${capt.id}\n`+
          `**Проти:** ${capt.enemy || "-"}\n`+
          `**Дата:** ${capt.date || "-"}\n`+
          `**Година:** ${capt.time || "-"}\n`+
          `**Результат:** ${resultText}\n`+
          `**Потрібно людей:** ${capt.neededPlayers || capt.need || "-"}\n`+
          `**Закрив:** <@${member.id}>`
        )]});
        discordSent = true;
      }
    }catch(e){
      discordError = e.message || String(e);
      console.error("capt stats send failed:", e);
    }

    if(typeof addLog === "function") addLog("Капт закрито", {id:capt.id, by:member.id, result:normalized, discordSent});
    return res.json({ok:true,capt,discordSent,discordError,channelId:(CONFIG.channels.captReports || CONFIG.channels.captStats)});
  } catch(e) {
    console.error("capt close error:", e);
    return res.status(500).json({ok:false,error:"capt_close_failed",message:e.message});
  }
});





/* === FORBES DISCORD PUBLISH HELPERS FIX === */
async function forbesSendToChannel(channelId, payload, fallbackText){
  try{
    let ch = null;
    if(channelId) ch = await channel(channelId).catch?.(()=>null) || await channel(channelId);
    if(!ch && CONFIG?.channels?.botLogs) ch = await channel(CONFIG.channels.botLogs).catch?.(()=>null) || await channel(CONFIG.channels.botLogs);
    if(!ch) {
      console.error("FORBES Discord channel not found:", channelId, fallbackText || "");
      return false;
    }
    await ch.send(payload);
    return true;
  }catch(e){
    console.error("FORBES Discord send failed:", e);
    return false;
  }
}
function reqDiscordId(req){
  return String(req?.user?.id || req?.headers?.["x-discord-user-id"] || req?.headers?.["x-user-id"] || req?.body?.discordUserId || "");
}
function canManagePublicPosts(req){
  const idv = reqDiscordId(req);
  const main = String(process.env.MAIN_DISCORD_ID || process.env.OWNER_DISCORD_ID || process.env.OWNER_ID || CONFIG.ownerId || "");
  if(idv && main && idv === main) return true;
  return false;
}

app.get("/api/fines", protect, async (req,res)=>{
  const member = await requireFamilyRole(req, res); if(!member) return;
  const db = readDb();
  res.json({ok:true,fines:db.fines || []});
});

app.get("/api/warnings", protect, async (req,res)=>{
  const member = await requireFamilyRole(req, res); if(!member) return;
  const db = readDb();
  res.json({ok:true,warnings:db.warnings || []});
});

app.post("/api/fines", protect, async (req,res)=>{
  try{
    const member = await requireFamilyRole(req, res);
    if(!member) return;
    if(member && typeof canDisciplineAll === "function" && !canDisciplineAll(member, req)) return denyPerm(res,"Недостатньо прав для штрафів/доган.");

    const db=readDb();
    db.fines = Array.isArray(db.fines) ? db.fines : [];
    const targetMember = await findDiscordMemberForRecord(req.body || {});
    const item={
      id:id("fine"),
      nickname:req.body.nickname||req.body.nick||"",
      staticId:req.body.staticId||req.body.playerId||"",
      amount:Number(req.body.amount||0),
      reason:req.body.reason||"",
      screenshotUrl:safeRemoteMediaUrl(req.body.screenshotUrl||req.body.screen),
      discordUserId:targetMember?.id || req.body.discordUserId || "",
      status:"unpaid",
      createdAt:now(),
      createdBy:member.displayName||member.user?.username||req.user?.name||"",
      createdByDiscordId:member.id
    };
    db.fines.unshift(item);
    writeDb(db);

    const playerLabel = await discordPlayerLabel(item);
    const issuerLabel = `${member.displayName||member.user?.username||item.createdBy} (<@${member.id}>)`;
    const payload = {content:item.discordUserId?`<@${item.discordUserId}>`:undefined,allowedMentions:{users:item.discordUserId?[item.discordUserId]:[]},embeds:[embed("🚨 Новий штраф", `**№:** ${item.id}
**Гравець:** ${playerLabel}
**Сума:** ${money(item.amount)}
**Причина:** ${item.reason}
**Видав:** ${issuerLabel}`)]};

    let targetChannel = null;
    if(CONFIG.channels.fines) targetChannel = await channel(CONFIG.channels.fines);
    if(!targetChannel && CONFIG?.channels?.botLogs) targetChannel = await channel(CONFIG.channels.botLogs);

    let sent = false;
    let screenshotSent = false;
    let screenshotTooLarge = false;
    if(targetChannel){
      const result = await sendWithOptionalScreenshot(targetChannel, payload, req.body, `fine-${item.id}.jpg`);
      sent = Boolean(result && result.ok);
      screenshotSent = Boolean(result && result.screenshot);
      screenshotTooLarge = Boolean(result && result.tooLarge);
    }

    item.screenshotAttached = screenshotSent;
    item.screenshotTooLarge = screenshotTooLarge;
    writeDb(db);

    res.json({ok:true,fine:item,discordSent:sent,screenshotSent,screenshotTooLarge});
  }catch(e){
    console.error("POST /api/fines failed:", e);
    res.status(500).json({ok:false,error:"fine_create_failed",message:e.message});
  }
});
app.post("/api/fine-payments", protect, async (req,res)=>{
  const member = await requireFamilyRole(req, res); if(!member) return;

  /* FORBES_DISC_ALL_PATCH */
  if(member && !canDisciplineAll(member, req)) return denyPerm(res,"Недостатньо прав для штрафів/доган.");
  const db=readDb();
  const targetMember=await findDiscordMemberForRecord(req.body||{});
  const item={
    id:nextSimpleId(db,"finepay",["fines","finePayments"]),
    fineId:req.body.fineId||"",
    nickname:req.body.nickname||req.body.nick||"",
    staticId:req.body.staticId||req.body.playerId||"",
    screenshotUrl:safeRemoteMediaUrl(req.body.screenshotUrl),
    discordUserId:targetMember?.id||req.body.discordUserId||"",
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
  const paymentPlayerLabel=await discordPlayerLabel(item);
  if(ch) await sendWithOptionalScreenshot(ch, {
    content:item.discordUserId?`<@${item.discordUserId}>`:undefined,
    allowedMentions:{users:item.discordUserId?[item.discordUserId]:[]},
    embeds:[embed("💳 Оплата штрафу на перевірку",
      `**Оплата №:** ${item.id}
` +
      `**Штраф №:** ${item.fineId}
` +
      `**Гравець:** ${paymentPlayerLabel}`
    )],
    components:[row([
      {id:`finepay_approve:${item.id}`,label:"✅ Одобрити оплату",style:ButtonStyle.Success},
      {id:`finepay_reject:${item.id}`,label:"❌ Відхилити",style:ButtonStyle.Danger}
    ])]
  }, req.body, "fine-payment.png");

  res.json({ok:true,payment:item});
});
app.post("/api/warnings", protect, async (req,res)=>{
  try{
    const member=await requireFamilyRole(req,res); if(!member)return;
    if(member&&typeof canDisciplineAll==="function"&&!canDisciplineAll(member,req)) return denyPerm(res,"Недостатньо прав для штрафів/доган.");
    const db=readDb(); db.warnings=Array.isArray(db.warnings)?db.warnings:[];
    const expires=new Date(Date.now()+CONFIG.warnings.days*86400000);
    const targetMember=await findDiscordMemberForRecord(req.body||{});
    const item={id:nextSimpleId(db,"warn",["warnings"]),nickname:req.body.nickname||req.body.nick||"",staticId:req.body.staticId||req.body.playerId||"",discordUserId:targetMember?.id||req.body.discordUserId||"",reason:req.body.reason||"",screenshotUrl:safeRemoteMediaUrl(req.body.screenshotUrl),status:"active",expiresAt:expires.toISOString(),createdAt:now(),createdBy:member.displayName||member.user?.username||"",createdByDiscordId:member.id};
    db.warnings.unshift(item); writeDb(db);
    const count=db.warnings.filter(w=>w.staticId===item.staticId&&w.status==="active").length;
    const ch=await channel(CONFIG.channels.warnings);
    if(ch){
      const playerLabel=await discordPlayerLabel(item);
      const issuerLabel=`${member.displayName||member.user?.username||"-"} (<@${member.id}>)`;
      await sendWithOptionalScreenshot(ch,{content:item.discordUserId?`<@${item.discordUserId}>`:undefined,allowedMentions:{users:item.discordUserId?[item.discordUserId]:[]},embeds:[embed("🚫 Нова догана",`**№:** ${item.id}\n**Гравець:** ${playerLabel}\n**Причина:** ${item.reason}\n**Видав:** ${issuerLabel}\n**Діє до:** ${expires.toLocaleDateString("uk-UA")}\n**Активних доган:** ${count}${count>=CONFIG.warnings.kickAt?"\n\n⚠️ **3 догани — кікнути / на розгляд**":""}`)]},req.body,"warning.png");
    }
    res.json({ok:true,warning:item});
  }catch(e){console.error("POST /api/warnings failed:",e);res.status(500).json({ok:false,error:"warning_create_failed",message:e.message});}
});
app.post("/api/warning-payments", protect, async (req,res)=>{
  try{
    const member = await requireFamilyRole(req, res); if(!member) return;
    const db=readDb();
    db.warningPayments = Array.isArray(db.warningPayments) ? db.warningPayments : [];
    const targetMember=await findDiscordMemberForRecord(req.body||{});
    const item={
      id:id("warnpay"),
      warningId:req.body.warningId||"",
      nickname:req.body.nickname||req.body.nick||"",
      staticId:req.body.staticId||req.body.playerId||"",
      screenshotUrl:safeRemoteMediaUrl(req.body.screenshotUrl),
      discordUserId:targetMember?.id||req.body.discordUserId||"",
      status:"pending",
      createdAt:now()
    };
    db.warningPayments.unshift(item);
    writeDb(db);
    const ch=await channel(CONFIG.channels.warningRemoval);
    const warningPaymentPlayerLabel=await discordPlayerLabel(item);
    if(ch) await sendWithOptionalScreenshot(ch, {
      content:item.discordUserId?`<@${item.discordUserId}>`:undefined,
      allowedMentions:{users:item.discordUserId?[item.discordUserId]:[]},
      embeds:[embed("🧾 Зняття догани на перевірку",
        `**Запит №:** ${item.id}\n**Догана №:** ${item.warningId}\n**Гравець:** ${item.nickname} | ${item.staticId}`
      )],
      components:[row([
        {id:`warnpay_approve:${item.id}`,label:"✅ Одобрити",style:ButtonStyle.Success},
        {id:`warnpay_reject:${item.id}`,label:"❌ Відхилити",style:ButtonStyle.Danger}
      ])]
    }, req.body, "warning-removal.png");
    res.json({ok:true,payment:item});
  }catch(e){
    console.error("POST /api/warning-payments failed:",e);
    res.status(500).json({ok:false,error:"warning_payment_failed",message:e.message});
  }
});
app.get("/api/warnings", protect, (req,res)=>{
  const db = readDb();
  res.json({ok:true,warnings:db.warnings || []});
});

app.post("/api/fines/:id/status", protect, async (req,res)=>{
  try{
    const member=await requireFamilyRole(req,res); if(!member)return;
    if(typeof canDisciplineAll==="function"&&!canDisciplineAll(member,req)) return denyPerm(res,"Недостатньо прав для штрафів/доган.");
    const allowed=["unpaid","payment_pending","paid","rejected","closed"];
    const status=String(req.body.status||"");
    if(!allowed.includes(status)) return res.status(400).json({ok:false,error:"bad_status"});
    const db=readDb(); db.fines=Array.isArray(db.fines)?db.fines:[];
    const item=db.fines.find(x=>String(x.id)===String(req.params.id));
    if(!item)return res.status(404).json({ok:false,error:"fine_not_found"});
    item.status=status; item.updatedAt=now(); if(status==="paid")item.paidAt=item.paidAt||now(); if(status==="closed")item.closedAt=now();
    await writeDbAsync(db); return res.json({ok:true,fine:item,fines:db.fines});
  }catch(e){console.error("fine status error",e);return res.status(500).json({ok:false,error:"fine_status_failed",message:e.message});}
});
app.delete("/api/fines/:id", protect, async (req,res)=>{
  try{
    const member=await requireFamilyRole(req,res); if(!member)return;
    if(typeof canDisciplineAll==="function"&&!canDisciplineAll(member,req)) return denyPerm(res,"Недостатньо прав для штрафів/доган.");
    const db=readDb(); db.fines=Array.isArray(db.fines)?db.fines:[];
    const before=db.fines.length; db.fines=db.fines.filter(x=>String(x.id)!==String(req.params.id));
    if(db.fines.length===before)return res.status(404).json({ok:false,error:"fine_not_found"});
    await writeDbAsync(db); return res.json({ok:true,fines:db.fines});
  }catch(e){return res.status(500).json({ok:false,error:"fine_delete_failed",message:e.message});}
});
app.post("/api/warnings/:id/status", protect, async (req,res)=>{
  try{
    const member=await requireFamilyRole(req,res); if(!member)return;
    if(typeof canDisciplineAll==="function"&&!canDisciplineAll(member,req)) return denyPerm(res,"Недостатньо прав для штрафів/доган.");
    const allowed=["active","remove_pending","removed","rejected","closed"];
    const status=String(req.body.status||"");
    if(!allowed.includes(status)) return res.status(400).json({ok:false,error:"bad_status"});
    const db=readDb(); db.warnings=Array.isArray(db.warnings)?db.warnings:[];
    const item=db.warnings.find(x=>String(x.id)===String(req.params.id));
    if(!item)return res.status(404).json({ok:false,error:"warning_not_found"});
    item.status=status; item.updatedAt=now(); if(["removed","closed"].includes(status))item.closedAt=now();
    await writeDbAsync(db); return res.json({ok:true,warning:item,warnings:db.warnings});
  }catch(e){console.error("warning status error",e);return res.status(500).json({ok:false,error:"warning_status_failed",message:e.message});}
});
app.delete("/api/warnings/:id", protect, async (req,res)=>{
  try{
    const member=await requireFamilyRole(req,res); if(!member)return;
    if(typeof canDisciplineAll==="function"&&!canDisciplineAll(member,req)) return denyPerm(res,"Недостатньо прав для штрафів/доган.");
    const db=readDb(); db.warnings=Array.isArray(db.warnings)?db.warnings:[];
    const before=db.warnings.length; db.warnings=db.warnings.filter(x=>String(x.id)!==String(req.params.id));
    if(db.warnings.length===before)return res.status(404).json({ok:false,error:"warning_not_found"});
    await writeDbAsync(db); return res.json({ok:true,warnings:db.warnings});
  }catch(e){return res.status(500).json({ok:false,error:"warning_delete_failed",message:e.message});}
});

app.post("/api/fines/:id/remind", protect, async (req,res)=>{
  try{
    const db = readDb();
    const f = (db.fines || []).find(x => x.id === req.params.id);
    if(!f) return res.status(404).json({ok:false,error:"fine_not_found"});
    const ch = await channel(CONFIG.channels.fines);
    if(ch){
      const playerLabel=await discordPlayerLabel(f); const target=await findDiscordMemberForRecord(f);
      await ch.send({content:target?`<@${target.id}>`:undefined,allowedMentions:{users:target?[target.id]:[]},embeds:[embed("🔔 Нагадування про штраф",
        `**Гравець:** ${playerLabel}\n` +
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
      const playerLabel=await discordPlayerLabel(w); const target=await findDiscordMemberForRecord(w);
      await ch.send({content:target?`<@${target.id}>`:undefined,allowedMentions:{users:target?[target.id]:[]},embeds:[embed("🔔 Нагадування про догану",
        `**Гравець:** ${playerLabel}\n` +
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



function firstArrayField(db, keys){
  for(const k of keys){
    if(Array.isArray(db[k])) return db[k];
  }
  return [];
}
function publicGalleryArray(db){
  return firstArrayField(db, ["gallery","photos","galleryPhotos","images","media"]);
}
function publicCarsArray(db){
  return firstArrayField(db, ["cars","vehicles","carList"]);
}
function publicMembersArray(db){
  return firstArrayField(db, ["members","familyMembers","users","players","participants"]);
}


/* === FORBES STATS PROFILES HALL OF FAME === */
function parseMemberForbes(raw){
  raw = String(raw || "").trim();
  const parts = raw.split("|").map(x=>x.trim()).filter(Boolean);
  let staticId = "";
  let nick = raw;
  for(const p of parts){ if(/^\d{1,10}$/.test(p)) staticId = p; }
  const m = raw.match(/(.+?)\s*[|#]\s*(\d{1,10})\s*$/);
  if(m){ nick = m[1].replace(/^(cpt|farm)\s*[|:-]\s*/i,"").trim(); staticId = m[2]; }
  else if(parts.length >= 2){ nick = parts.find(p=>!/^\d{1,10}$/.test(p) && !/^(cpt|farm)$/i.test(p)) || parts[0]; }
  nick = nick.replace(/^(cpt|farm)\s*[|:-]\s*/i,"").trim();
  return {nick, staticId};
}
function statKeyFor(nick, id){
  return (String(id||"").trim() || String(nick||"").trim()).toLowerCase();
}
function ensureStatsDb(db){
  db.familyStatsManual = db.familyStatsManual || {};
  db.memberJoinDates = db.memberJoinDates || {};
  db.hallOfFameManual = db.hallOfFameManual || {};
  return db;
}
function buildForbesStats(db){
  ensureStatsDb(db);
  const capts = Array.isArray(db.capts) ? db.capts : [];
  const farmReports = Array.isArray(db.farmReports) ? db.farmReports : [];
  const contracts = Array.isArray(db.contracts) ? db.contracts : [];
  const fines = Array.isArray(db.fines) ? db.fines : [];
  const warnings = Array.isArray(db.warnings) ? db.warnings : [];
  const giveaways = Array.isArray(db.giveaways) ? db.giveaways : [];

  // ВАЖЛИВО: статистика каптів рахує тільки ті капти, де реально вибрали результат win/loss.
  const resultCapts = capts.filter(c=>{
    const r = String(c.result || c.outcome || "").toLowerCase();
    return r === "win" || r === "loss";
  });
  const wins = resultCapts.filter(c=>String(c.result || c.outcome || "").toLowerCase()==="win").length;
  const losses = resultCapts.filter(c=>String(c.result || c.outcome || "").toLowerCase()==="loss").length;
  const totalCapts = wins + losses;

  const base = {
    membersCount: Number(db.membersCount || 0),
    captsTotal: totalCapts,
    captWins: wins,
    captLosses: losses,
    winRate: totalCapts ? Math.round((wins / totalCapts) * 100) : 0,
    farmReports: farmReports.filter(r=>!r.salaryClosed && r.status !== "paid_week_closed").length,
    contracts: contracts.length,
    fines: fines.length,
    warnings: warnings.length,
    giveaways: giveaways.length
  };

  // Не даємо старим ручним captsTotal/captWins/captLosses перебити реальну статистику, якщо капти ще не грались.
  const manual = {...(db.familyStatsManual || {})};
  delete manual.captsTotal;
  delete manual.captWins;
  delete manual.captLosses;
  delete manual.winRate;

  return {...base, ...manual};
}

function buildMemberProfileFromDb(db, member){
  ensureStatsDb(db);
  const parsed = parseMemberForbes(member.nick || member.nickname || member.username || "");
  const nick = parsed.nick || member.nickname || member.username || "-";
  const staticId = parsed.staticId || member.staticId || "";
  const key = statKeyFor(nick, staticId);

  const farmReports = Array.isArray(db.farmReports) ? db.farmReports : [];
  const capts = Array.isArray(db.capts) ? db.capts : [];
  const contracts = Array.isArray(db.contracts) ? db.contracts : [];
  const fines = Array.isArray(db.fines) ? db.fines : [];
  const warnings = Array.isArray(db.warnings) ? db.warnings : [];
  const giveaways = Array.isArray(db.giveaways) ? db.giveaways : [];

  let farmCount = 0;
  for(const r of farmReports){
    const players = Array.isArray(r.players) ? r.players : [];
    if(players.some(p=>statKeyFor(p.nick||p.name, p.id||p.staticId) === key)) farmCount++;
    else if(statKeyFor(r.player||r.nickname, r.staticId||r.id) === key) farmCount++;
  }

  let contractCount = 0;
  for(const c of contracts){
    const ownerKey = statKeyFor(c.nickname||c.nick||c.player, c.staticId||c.playerId||c.id);
    if(ownerKey === key) contractCount++;
  }

  const memberCapts = capts.filter(c => {
    const all = [...(c.yes||[]), ...(c.no||[]), ...(c.maybe||[]), ...(c.absent||[])].map(String);
    return all.some(x => x.includes(member.discordId || member.id || "") || x.toLowerCase().includes(nick.toLowerCase()));
  });
  const wins = memberCapts.filter(c=>String(c.result||"").toLowerCase()==="win").length;
  const losses = memberCapts.filter(c=>String(c.result||"").toLowerCase()==="loss").length;

  const fineCount = fines.filter(f=>statKeyFor(f.nickname||f.nick, f.staticId||f.playerId) === key).length;
  const warnCount = warnings.filter(w=>statKeyFor(w.nickname||w.nick, w.staticId||w.playerId) === key).length;
  const giveawayWins = giveaways.filter(g => (g.winners||[]).some(w=>String(w.userId||"")===String(member.discordId||member.id||"") || String(w.username||"").toLowerCase()===String(member.username||"").toLowerCase())).length;

  const achievements = [];
  if(farmCount >= 50) achievements.push("🌾 50 фарм-звітів");
  if(farmCount >= 100) achievements.push("🌾 100 фарм-звітів");
  if(contractCount >= 25) achievements.push("📦 25 контрактів");
  if(contractCount >= 100) achievements.push("🏆 100 контрактів");
  if(memberCapts.length >= 25) achievements.push("⚔️ 25 каптів");
  if(wins >= 10) achievements.push("🥇 10 перемог");
  if(wins >= 25) achievements.push("🏆 25 перемог");
  if(giveawayWins >= 1) achievements.push("🎁 Переможець розіграшу");
  if(fineCount === 0 && warnCount === 0) achievements.push("💎 Чиста історія");

  return {
    nick, staticId,
    discordId: member.discordId || member.id || "",
    username: member.username || "",
    avatar: member.avatar || "",
    roles: member.roles || [],
    joinedAt: db.memberJoinDates[key] || member.joinedAt || "",
    stats: {farmCount, contractCount, capts: memberCapts.length, wins, losses, fineCount, warnCount, giveawayWins},
    achievements
  };
}

/* === FORBES HOF ADMIN + TEST CLEANUP FIX === */
function emptyHallOfFame(){
  return {
    topFarmer:null,
    topCapter:null,
    topWinner:null,
    topContracts:null,
    topGiveaway:null,
    cleanest:null
  };
}
function getHallMode(db){
  db.hallOfFameSettings = db.hallOfFameSettings || {};
  return db.hallOfFameSettings.mode || "manual";
}

function buildHallOfFame(db, members){
  db.hallOfFameManual = db.hallOfFameManual || {};
  db.hallOfFameSettings = db.hallOfFameSettings || {mode:"manual"};

  // По замовчуванню ручний режим, щоб тестові капти/фарм не лізли в Зал слави.
  if((db.hallOfFameSettings.mode || "manual") === "manual"){
    return {
      topFarmer: db.hallOfFameManual.topFarmer || null,
      topCapter: db.hallOfFameManual.topCapter || null,
      topWinner: db.hallOfFameManual.topWinner || null,
      topContracts: db.hallOfFameManual.topContracts || null,
      topGiveaway: db.hallOfFameManual.topGiveaway || null,
      cleanest: db.hallOfFameManual.cleanest || null,
      mode:"manual"
    };
  }

  const profiles = members.map(m=>buildMemberProfileFromDb(db,m));
  const top = (field) => profiles.slice().filter(p=>Number(p.stats[field]||0)>0).sort((a,b)=>(b.stats[field]||0)-(a.stats[field]||0))[0] || null;
  return {
    topFarmer: top("farmCount"),
    topCapter: top("capts"),
    topWinner: top("wins"),
    topContracts: top("contractCount"),
    topGiveaway: top("giveawayWins"),
    cleanest: profiles.find(p=>p.stats.fineCount===0 && p.stats.warnCount===0 && (p.stats.farmCount||p.stats.contractCount||p.stats.capts||p.stats.wins||p.stats.giveawayWins)) || null,
    mode:"auto"
  };
}

app.get("/api/public-dashboard", async (req,res)=>{
  try{
    res.set("Cache-Control","no-store, no-cache, must-revalidate, private");
    const db=readDb();
    const members=await getPublicMembersFromDiscord();
    const cars=publicCleanCars(db);
    const gallery=publicCleanGallery(db);
    const familyInfo=db.familyInfo||{};
    const media=mediaDb(db);
    const onlineCount = members.filter(m=>m.online || m.isOnline || /^(online|idle|dnd)$/i.test(String(m.status||m.presence||""))).length;
    res.json({ok:true,membersCount:members.length,onlineCount,membersOnline:onlineCount,discordOnline:onlineCount,carsCount:cars.length,galleryCount:gallery.length,members,cars,gallery,photos:gallery,familyInfo,galleryAlbums:media.galleryAlbums,musicTracks:media.musicTracks,estate:media.estate,serverTime:new Date().toISOString()});
  }catch(e){
    console.error("public dashboard error",e);
    res.status(500).json({ok:false,error:"public_dashboard_failed",message:e.message});
  }
});



/* removed duplicate getPublicMembersFromDiscord */


app.get("/api/members-public", async (req,res)=>{
  try{ const members=await getPublicMembersFromDiscord(); const onlineCount=members.filter(m=>m.online||m.isOnline||/^(online|idle|dnd)$/i.test(String(m.status||m.presence||""))).length; res.json({ok:true,count:members.length,onlineCount,members}); }
  catch(e){ console.error("members public error",e); res.status(500).json({ok:false,error:"members_public_failed",message:e.message}); }
});
app.get("/api/members", protect, async (req,res)=>{
  try{
    const members = await getGuildMembersSimple();
    // Public registry: no Discord IDs are returned, only nickname and roles.
    res.json({ok:true,members});
  }catch(e){
    console.error("members list error:", e);
    res.status(500).json({ok:false,error:"members_failed",details:e.message});
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


























function memberHasRealServerRole(member){
  try{
    if(!member || !member.roles || !member.roles.cache) return false;
    return member.roles.cache.some(role => {
      if(!role) return false;
      if(role.id === CONFIG.guildId) return false; // @everyone
      if(role.managed && role.id === CONFIG.roles?.bot) return false;
      return true;
    });
  }catch(e){
    return false;
  }
}


async function requireFamilyRole(req, res){
  const member = await apiMemberFromRequest(req);
  if(!member) {
    res.status(401).json({ok:false,error:"discord_login_required"});
    return null;
  }
  if(!memberHasRealServerRole(member)){
    res.status(403).json({ok:false,error:"no_server_role",message:"Доступ тільки для учасників FORBES з роллю."});
    return null;
  }
  return member;
}

async function apiMemberOr403(req, res){
  const member = await apiMemberFromRequest(req);
  if(!member){
    res.status(401).json({ok:false,error:"discord_login_required"});
    return null;
  }
  return member;
}

















function getMemberRoleIds(member){
  try{
    if(!member || !member.roles) return [];
    if(member.roles.cache) return Array.from(member.roles.cache.keys()).map(String);
    if(Array.isArray(member.roles)) return member.roles.map(String);
    return [];
  }catch(e){ return []; }
}
function userHasAnyRole(member, roleIds = []){
  if(!member) return false;
  if(CONFIG.ownerId && String(member.id) === String(CONFIG.ownerId)) return true;
  const current = getMemberRoleIds(member);
  const allowed = roleIds.filter(Boolean).map(String);
  return allowed.some(roleId => current.includes(roleId));
}












function canManage(member){
  return userHasAnyRole(member, [
    CONFIG.roles.leader,
    CONFIG.roles.owner,
    CONFIG.roles.deputy,
    CONFIG.roles.rightHand
  ]);
}








function canUseCaptSignup(member){
  return userHasAnyRole(member, [
    CONFIG.roles.leader,
    CONFIG.roles.owner,
    CONFIG.roles.deputy,
    CONFIG.roles.rightHand,
    CONFIG.roles.seniorCapt,
    CONFIG.roles.capt
  ]);
}
function canManageCaptLists(member,req=null){return canCaptAll(member,req)||forbes2026Capt(member,req);}
function canModerateFarmReports(member){ return forbes2026Farm(member,null); }

function canModerateWarningsAndFines(member){ return forbes2026Discipline(member,null); }

function canModerateApplications(member,req){
  return forbes2026Full(member,req)||forbes2026HasId(member,[FORBES_ACCESS_ROLE_IDS_2026.farmManager,FORBES_ACCESS_ROLE_IDS_2026.seniorCapt,CONFIG.roles.farmManager,CONFIG.roles.seniorCapt])||forbes2026HasName(member,["фарм менеджер","старший каптер"]);
}
function canManageBlacklist(member){
  return userHasAnyRole(member, [
    CONFIG.roles.leader,
    CONFIG.roles.owner,
    CONFIG.roles.deputy,
    CONFIG.roles.rightHand,
    CONFIG.roles.seniorCapt
  ]);
}

async function interactionMember(interaction){
  if(interaction.member && interaction.member.roles && interaction.member.roles.cache) return interaction.member;
  const guild = await client.guilds.fetch(CONFIG.guildId);
  return await guild.members.fetch(interaction.user.id).catch(()=>null);
}

async function denyNoPerm(interaction, text="❌ У вас немає прав для цієї дії."){
  if(interaction.deferred || interaction.replied){
    return interaction.followUp({content:text, ephemeral:true}).catch(()=>{});
  }
  return interaction.reply({content:text, ephemeral:true});
}

async function deferReviewButton(interaction){
  if(interaction.deferred || interaction.replied) return true;
  try{
    await interaction.deferUpdate();
    return true;
  }catch(e){
    console.error("button deferUpdate failed", interaction.customId, e);
    return false;
  }
}

async function reviewButtonError(interaction, text="❌ Помилка обробки кнопки."){
  if(interaction.deferred || interaction.replied){
    return interaction.followUp({content:text, ephemeral:true}).catch(()=>{});
  }
  return interaction.reply({content:text, ephemeral:true}).catch(()=>{});
}

async function finishReviewButton(interaction, payload){
  if(interaction.deferred || interaction.replied){
    return interaction.editReply(payload);
  }
  return interaction.update(payload);
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
    const reviewActions = new Set(["app_approve","app_reject","farm_approve","farm_reject","warnpay_approve","warnpay_reject","finepay_approve","finepay_reject"]);
    if(reviewActions.has(action)) await deferReviewButton(interaction);
    const db=readDb();
    const member = await interactionMember(interaction);

    // РОЗІГРАШІ: кнопка участі для всіх учасників Discord
    if(action==="giveaway_join"){
      const giveaway=(Array.isArray(db.giveaways)?db.giveaways:[]).find(x=>String(x.id)===String(itemId));
      if(!giveaway) return interaction.reply({content:"❌ Розіграш не знайдено.",ephemeral:true});
      if(String(giveaway.status||"active").toLowerCase()!=="active") return interaction.reply({content:"🏁 Цей розіграш уже завершено.",ephemeral:true});

      giveaway.participants=Array.isArray(giveaway.participants)?giveaway.participants:[];
      const userId=String(interaction.user.id);
      const exists=giveaway.participants.some(x=>String(x.userId||x.id||"")===userId);
      if(exists) return interaction.reply({content:"✅ Ти вже береш участь у цьому розіграші.",ephemeral:true});

      giveaway.participants.push({
        userId,
        username:interaction.user.globalName||interaction.user.username||"Учасник",
        tag:interaction.user.tag||interaction.user.username||"",
        joinedAt:now()
      });
      giveaway.participantsCount=giveaway.participants.length;
      await writeDbAsync(db);

      try{
        await interaction.message.edit({
          embeds:[embed("🎁 "+(giveaway.title||"Розіграш"),
            `**Приз:** ${giveaway.prize||"-"}\n`+
            `**Умови:** ${giveaway.rules||"-"}\n\n`+
            `Натисни кнопку **✅ Беру участь**, щоб взяти участь.\n`+
            `**Учасників:** ${giveaway.participants.length}`
          )],
          components:[row([{id:`giveaway_join:${giveaway.id}`,label:"✅ Беру участь",style:ButtonStyle.Success}])]
        });
      }catch(e){ console.error("Giveaway participant count edit failed:",e); }

      return interaction.reply({content:"✅ Тебе додано до розіграшу!",ephemeral:true});
    }

    // ЗАЯВКИ: права залежать від типу заявки
    if(action==="app_approve"||action==="app_reject"){
      const app=db.applications.find(x=>x.id===itemId);
      if(!app) return reviewButtonError(interaction,"❌ Заявку не знайдено.");
      const type=String(app.type||"").toLowerCase();
      const isDismiss=type.includes("увал")||type.includes("звіль")||type==="dismissal";
      const allowed=isDismiss
        ? userHasAnyRole(member,[CONFIG.roles.leader,CONFIG.roles.owner,CONFIG.roles.deputy,CONFIG.roles.rightHand])
        : canModerateApplications(member,interaction);
      if(!allowed){
        return denyNoPerm(interaction,isDismiss
          ? "❌ Увал можуть одобряти тільки Лідер, Зам.лідера або Права рука."
          : "❌ Заявку можуть одобряти Лідер, Зам, Права рука, Старший каптер або Фарм менеджер.");
      }
      if(app.status!=="pending") return reviewButtonError(interaction,`ℹ️ Заявка вже оброблена: ${app.status}`);
      app.status = action==="app_approve" ? "approved" : "rejected";
      app.reviewedBy=interaction.user.id; app.reviewedAt=now();
      let resultText="";
      const roleApplication=!(type.includes("відпуст")||type.includes("увал")||type.includes("звіль"));
      if(action==="app_approve" && roleApplication){
        try{const result=await applyApplicationApprove(app);resultText=result.ok?`\n✅ Роль видана, нік встановлено: **${result.nickname}**`:`\n⚠️ Роль/нік не видано: ${result.reason}`;}catch(e){resultText="\n⚠️ Бот не зміг видати роль або змінити нік.";}
      }
      await writeDbAsync(db);
      return finishReviewButton(interaction,{content:`Заявку ${app.status==="approved"?"✅ одобрено":"❌ відхилено"} модератором ${interaction.user}.${resultText}`,components:[],embeds:interaction.message.embeds});
    }

    // ФАРМ-ЗВІТИ: тільки Лідер / Зам / Права рука / Фарм менеджер
    if(action==="farm_approve"||action==="farm_reject"){
      if(!canModerateFarmReports(member)){
        return denyNoPerm(interaction, "❌ Фарм-звіти можуть одобряти тільки Лідер, Зам.лідера, Права рука або Фарм менеджер.");
      }

      const r=db.farmReports.find(x=>x.id===itemId);
      if(!r) return reviewButtonError(interaction,"❌ Не знайдено звіт.");
      r.status=action==="farm_approve"?"approved":"rejected";
      r.reviewedBy=interaction.user.id;
      r.reviewedAt=now();
      r.discordStatus="sent";
      r.amount=Number(r.amount || r.contractAmount || 0);
      r.contractAmount=Number(r.contractAmount || r.amount || 0);
      await writeDbAsync(db);
      if(typeof addLog === "function") addLog("Farm-звіт перевірено", {id:r.id,status:r.status,by:interaction.user.id});
      return finishReviewButton(interaction,{
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
      if(!p) return reviewButtonError(interaction,"❌ Не знайдено запит на зняття догани.");
      if(["approved","rejected"].includes(String(p.status))) return reviewButtonError(interaction,"ℹ️ Цей запит уже оброблено.");

      p.status=action==="warnpay_approve"?"approved":"rejected";
      p.reviewedBy=interaction.user.id;
      p.reviewedAt=now();

      const original = db.warnings.find(x => String(x.id) === String(p.warningId));
      if(original && action==="warnpay_approve"){
        original.status = "closed";
        original.closedAt = now();
      }

      await writeDbAsync(db);

      return finishReviewButton(interaction,{
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
      if(!p) return reviewButtonError(interaction,"❌ Не знайдено оплату штрафу.");
      if(["paid","rejected"].includes(String(p.status))) return reviewButtonError(interaction,"ℹ️ Цю оплату вже оброблено.");

      p.status=action==="finepay_approve"?"paid":"rejected";
      p.reviewedBy=interaction.user.id;
      p.reviewedAt=now();

      const original = db.fines.find(x => x.id === p.fineId);
      if(original){
        original.status = action==="finepay_approve" ? "paid" : "unpaid";
        if(action==="finepay_approve") original.paidAt = now();
      }

      await writeDbAsync(db);

      const fineCh = await channel(CONFIG.channels.fines);
      if(fineCh && original && action==="finepay_approve"){
        fineCh.send({embeds:[embed("✅ Штраф оплачено",
          `**Штраф №:** ${original.id}\n` +
          `**Гравець:** ${original.nickname || p.nickname} | ${original.staticId || p.staticId}\n` +
          `**Сума:** ${money(original.amount || 0)}`
        )]}).catch(()=>{});
      }

      return finishReviewButton(interaction,{
        content:`Оплату штрафу ${p.status==="paid"?"✅ одобрено":"❌ відхилено"} модератором ${interaction.user}`,
        components:[],
        embeds:interaction.message.embeds
      });
    }

  }catch(err){
    console.error("interaction button failed", interaction.customId, err);
    await reviewButtonError(interaction,"❌ Помилка бота під час обробки кнопки. Спробуйте ще раз.");
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


async function findDiscordMemberForRecord(record={}){
  try{
    const guild = await client.guilds.fetch(CONFIG.guildId);
    const directId = String(record.discordUserId || record.userId || record.memberId || record.discordId || "").replace(/\D/g,"");
    if(directId){
      const direct = await guild.members.fetch(directId).catch(()=>null);
      if(direct) return direct;
    }
    const wantedNick = String(record.nickname || record.nick || record.player || record.name || "").trim().toLowerCase();
    const wantedStatic = String(record.staticId || record.playerId || record.id || "").trim();
    const members = await guild.members.fetch().catch(()=>guild.members.cache);
    let nickMatch = null;
    for(const m of members.values()){
      if(m.user?.bot) continue;
      const display = String(m.displayName || m.nickname || m.user?.username || "");
      const parsed = parseForbesStaticNickFinal(display);
      if(wantedStatic && parsed.staticId && String(parsed.staticId) === wantedStatic) return m;
      if(wantedNick){
        const cleanDisplay = String(parsed.nick || display).trim().toLowerCase();
        if(cleanDisplay === wantedNick || display.trim().toLowerCase() === wantedNick) nickMatch = nickMatch || m;
      }
    }
    return nickMatch;
  }catch(e){
    console.warn("Discord member resolve failed:", e?.message || e);
    return null;
  }
}

async function discordPlayerLabel(record={}, fallback="-"){
  const member = await findDiscordMemberForRecord(record);
  if(member) return `${member.displayName} (<@${member.id}>)`;
  const nick = record.nickname || record.nick || record.player || record.name || fallback;
  const sid = record.staticId || record.playerId || "";
  return sid ? `${nick} | ${sid}` : String(nick || fallback);
}

async function formatFarmPlayersForDiscord(players=[]){
  if(!Array.isArray(players) || !players.length) return "-";
  const labels=[];
  for(const p of players) labels.push(await discordPlayerLabel(p));
  return labels.join(", ");
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


cron.schedule("0 12 * * *", async()=>{
  const db=readDb();const unpaid=(db.fines||[]).filter(f=>f.status==="unpaid");if(!unpaid.length)return;
  const ch=await channel(CONFIG.channels.fines);if(!ch)return;const labels=[];const ids=[];
  for(const f of unpaid){const m=await findDiscordMemberForRecord(f);if(m)ids.push(m.id);labels.push(`• **${f.id}** — ${await discordPlayerLabel(f)} — ${money(f.amount)}`);}
  const unique=[...new Set(ids)];ch.send({content:unique.length?unique.map(id=>`<@${id}>`).join(" "):undefined,allowedMentions:{users:unique},embeds:[embed("⏰ Нагадування про неоплачені штрафи",labels.join("\n"))]}).catch(()=>{});
});
async function registerCommands(){ if(!client.user) return; const commands=[new SlashCommandBuilder().setName("ping").setDescription("Перевірити чи бот онлайн"),new SlashCommandBuilder().setName("stats").setDescription("Статистика FORBES")].map(c=>c.toJSON()); const rest=new REST({version:"10"}).setToken(process.env.DISCORD_BOT_TOKEN); await rest.put(Routes.applicationGuildCommands(client.user.id, CONFIG.guildId), {body:commands}); }


app.get("/api/salary/archive/latest", protect, async (req,res)=>{
  const member = await requireFamilyRole(req, res); if(!member) return;
  const db = readDb();
  cleanupOldSalaryArchive(db);
  writeDb(db);
  const archive = Array.isArray(db.farmReportsArchive) ? db.farmReportsArchive : [];
  res.json({ok:true,latest:archive[0] || null,archiveCount:archive.length});
});





function setDeliveryStatus(db, collection, sourceId, status, queueId = "", error = ""){
  try{
    const list = db[collection];
    if(!Array.isArray(list)) return;
    const item = list.find(x => String(x.id) === String(sourceId));
    if(!item) return;
    item.discordStatus = status; // sent | queued | failed
    item.discordQueueId = queueId || item.discordQueueId || "";
    item.discordError = error || "";
    item.discordUpdatedAt = now();
  }catch(e){ console.error("setDeliveryStatus failed:", e); }
}
function deliveryStatusText(status){
  if(status === "sent") return "🟢 Відправлено";
  if(status === "queued") return "🟡 В черзі";
  if(status === "failed") return "🔴 Помилка";
  return "⚪ Невідомо";
}

function trimSystemLogs(db){
  db.logs = Array.isArray(db.logs) ? db.logs.slice(0,500) : [];
  db.securityLogs = Array.isArray(db.securityLogs) ? db.securityLogs.slice(0,500) : [];
  db.discordQueue = Array.isArray(db.discordQueue) ? db.discordQueue.slice(0,300) : [];
}
function securityLog(action, actor="", extra={}){
  try{
    const db=readDb();
    db.securityLogs=Array.isArray(db.securityLogs)?db.securityLogs:[];
    db.securityLogs.unshift({id:id("sec"),action,actor,extra,createdAt:now()});
    trimSystemLogs(db); writeDb(db);
  }catch(e){ console.error("securityLog failed:",e); }
}

function safePayloadForQueue(payload){
  try{
    return JSON.parse(JSON.stringify(payload, (k,v)=>{
      if(typeof v === "string" && v.length > 5000) return "[removed-large-data]";
      return v;
    }));
  }catch(e){ return payload; }
}

function queueDiscordSend(type, channelId, payload, sourceId="", error=""){
  payload = safePayloadForQueue(payload);

  const db=readDb();
  db.discordQueue=Array.isArray(db.discordQueue)?db.discordQueue:[];
  const item={id:id("dq"),type,channelId,payload,sourceId,status:"failed",attempts:0,lastError:error,createdAt:now(),updatedAt:now()};
  db.discordQueue.unshift(item); trimSystemLogs(db); writeDb(db); return item;
}
async function sendQueueItem(item){
  const ch=await channel(item.channelId);
  if(!ch) throw new Error("channel_not_found");
  await ch.send(item.payload);
}
async function processDiscordQueue(limit=20){
  const db=readDb();
  db.discordQueue=Array.isArray(db.discordQueue)?db.discordQueue:[];
  const items=db.discordQueue.filter(x=>x.status!=="sent").slice(0,limit);
  let sent=0;
  for(const item of items){
    try{
      item.attempts=Number(item.attempts||0)+1;
      item.updatedAt=now();
      await sendQueueItem(item);
      item.status="sent"; item.sentAt=now(); item.lastError="";
      if(item.type === "farm_report") setDeliveryStatus(db, "farmReports", item.sourceId, "sent", item.id, "");
      if(item.type === "capt_signup") setDeliveryStatus(db, "capts", item.sourceId, "sent", item.id, "");
      sent++;
    }catch(e){
      item.status="failed"; item.lastError=e?.message||String(e); item.updatedAt=now();
      if(item.type === "farm_report") setDeliveryStatus(db, "farmReports", item.sourceId, "failed", item.id, item.lastError);
      if(item.type === "capt_signup") setDeliveryStatus(db, "capts", item.sourceId, "failed", item.id, item.lastError);
    }
  }
  trimSystemLogs(db); writeDb(db); return {processed:items.length,sent};
}
async function sendOrQueueDiscord(type, channelId, payload, sourceId=""){
  try{
    const ch=await channel(channelId);
    if(!ch) throw new Error("channel_not_found");
    await ch.send(payload);
    return {ok:true,queued:false};
  }catch(e){
    const item=queueDiscordSend(type,channelId,payload,sourceId,e?.message||String(e));
    return {ok:false,queued:true,queueId:item.id,error:item.lastError};
  }
}


function debugLog(action, data={}){
  try{
    console.log(`[FORBES DEBUG] ${action}`, JSON.stringify(data));
  }catch(e){
    console.log(`[FORBES DEBUG] ${action}`, data);
  }
}
function publicError(res, status, error, message, details=""){
  return res.status(status).json({ok:false,error,message:message || error,details});
}

function addLog(text, extra = {}){
  try{
    const db = readDb();
    db.logs = Array.isArray(db.logs) ? db.logs : [];
    db.logs.unshift({id:id("log"), text, extra, createdAt:now()});
    trimSystemLogs(db);
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



async function getGuildMembersSimple(){
  const guild = await client.guilds.fetch(CONFIG.guildId);
  await guild.members.fetch();
  const members = [];
  guild.members.cache.forEach(member=>{
    if(member.user?.bot) return;
    const display = member.displayName || member.user.username;
    const parsed = parseForbesPlayerNameId(display);
    const roles = member.roles.cache
      .filter(r => r.id !== CONFIG.guildId && r.name !== "@everyone")
      .map(r => ({id:r.id,name:r.name}))
      .sort((a,b)=>String(a.name).localeCompare(String(b.name)));
    members.push({
      nickname: parsed.nick,
      nick: parsed.nick,
      username: member.user.username,
      staticId: parsed.staticId,
      playerId: parsed.staticId,
      avatar: member.user.displayAvatarURL?.() || "",
      roles
    });
  });
  return members.sort((a,b)=>String(a.nickname).localeCompare(String(b.nickname)));
}



/* === FORBES PLAYER SEARCH STATIC ID FINAL === */
function parseForbesPlayerNameId(raw){
  raw = String(raw || "").trim();
  let nick = raw;
  let staticId = "";
  const parts = raw.split("|").map(x=>x.trim()).filter(Boolean);
  const num = parts.find(x=>/^\d{1,10}$/.test(x));
  if(num) staticId = num;
  const possibleNick = parts.find(x=>!/^\d{1,10}$/.test(x) && !/^(cpt|farm|фарм|учасник)$/i.test(x));
  if(possibleNick) nick = possibleNick;
  const m = raw.match(/^(.+?)\s*(?:#|\||\[|\()\s*(\d{1,10})\s*(?:\]|\))?$/);
  if(m){ nick = m[1].trim(); staticId = m[2].trim(); }
  return {nick, staticId};
}
function playerFieldMatchesText(v,q){
  return String(v || "").toLowerCase().includes(String(q||"").toLowerCase());
}

function playerMatches(item, q){
  q = String(q || "").toLowerCase().trim();
  if(!q) return false;
  const baseFields = [item.nickname,item.nick,item.player,item.name,item.staticId,item.playerId,item.id,item.username,item.discordUserId];
  if(baseFields.some(v => playerFieldMatchesText(v,q))) return true;
  const players = Array.isArray(item.players) ? item.players : [];
  if(players.some(p => [p.nick,p.nickname,p.name,p.id,p.staticId,p.playerId].some(v=>playerFieldMatchesText(v,q)))) return true;
  return false;
}


app.get("/api/members", protect, async (req,res)=>{
  try{
    const member = await requireFamilyRole(req,res); if(!member) return;
    if(!canModerateFarmReports(member) && !canModerateWarningsAndFines(member) && !canManageCaptLists(member)){
      return res.status(403).json({ok:false,error:"no_permission"});
    }
    const members = await getGuildMembersSimple();
    res.json({ok:true,members});
  }catch(e){
    console.error("members list error:", e);
    res.status(500).json({ok:false,error:"members_failed",details:e.message});
  }
});

app.get("/api/player-search", protect, async (req,res)=>{
  try{
    const member = await requireFamilyRole(req,res); if(!member) return;
    if(!canModerateFarmReports(member) && !canModerateWarningsAndFines(member) && !canManageCaptLists(member)){
      return res.status(403).json({ok:false,error:"no_permission"});
    }
    const q = String(req.query.q || "").toLowerCase().trim();
    if(!q) return res.json({ok:true,query:q,result:null});

    const db = readDb();
    const members = await getGuildMembersSimple();
    const foundMembers = members.filter(m =>
      String(m.staticId||"").includes(q) ||
      String(m.playerId||"").includes(q) ||
      String(m.nickname||"").toLowerCase().includes(q) ||
      String(m.nick||"").toLowerCase().includes(q) ||
      String(m.username||"").toLowerCase().includes(q) ||
      (m.roles||[]).some(r=>String(r.name||"").toLowerCase().includes(q))
    );

    const fines = (db.fines||[]).filter(x=>playerMatches(x,q));
    const warnings = (db.warnings||[]).filter(x=>playerMatches(x,q));
    const farmReports = (db.farmReports||[]).filter(x=>playerMatches(x,q));
    const blacklist = (db.blacklist||[]).filter(x=>playerMatches(x,q));
    const applications = (db.applications||[]).filter(x=>playerMatches(x,q));
    const capts = (db.capts||[]).filter(c=>{
      const all = [...(c.yes||[]),...(c.no||[]),...(c.maybe||[]),...(c.absent||[])].map(String);
      return all.some(id=>id.toLowerCase().includes(q)) || String(c.enemy||"").toLowerCase().includes(q);
    });

    res.set("Cache-Control","no-store, no-cache, must-revalidate, private");
    res.json({
      ok:true, query:q,
      result:{
        members:foundMembers.slice(0,20),
        fines:fines.slice(0,50),
        warnings:warnings.slice(0,50),
        farmReports:farmReports.slice(0,50),
        blacklist:blacklist.slice(0,20),
        applications:applications.slice(0,20),
        capts:capts.slice(0,30),
        summary:{
          finesUnpaid:fines.filter(f=>f.status!=="paid"&&f.status!=="closed").length,
          warningsActive:warnings.filter(w=>w.status==="active").length,
          farmApproved:farmReports.filter(r=>r.status==="approved").length,
          blacklist:blacklist.length,
          capts:capts.length
        }
      }
    });
  }catch(e){
    console.error("player search error:", e);
    res.status(500).json({ok:false,error:"player_search_failed",details:e.message});
  }
});

app.get("/api/reminders/summary", protect, async (req,res)=>{
  try{
    const member = await requireFamilyRole(req,res); if(!member) return;
    if(!canModerateWarningsAndFines(member) && !canModerateFarmReports(member)){
      return res.status(403).json({ok:false,error:"no_permission"});
    }
    const db=readDb();
    const unpaid=(db.fines||[]).filter(f=>f.status!=="paid"&&f.status!=="closed");
    const active=(db.warnings||[]).filter(w=>w.status==="active");
    res.json({ok:true,unpaidFines:unpaid.length,activeWarnings:active.length,totalFineAmount:unpaid.reduce((s,f)=>s+Number(f.amount||0),0)});
  }catch(e){ res.status(500).json({ok:false,error:"reminder_summary_failed"}); }
});

app.post("/api/reminders/fines", protect, async (req,res)=>{
  try{
    const member = await requireFamilyRole(req,res); if(!member) return;

  /* FORBES_DISC_ALL_PATCH */
  if(member && !canDisciplineAll(member, req)) return denyPerm(res,"Недостатньо прав для штрафів/доган.");
    if(!canModerateWarningsAndFines(member) && !canModerateFarmReports(member)){
      return res.status(403).json({ok:false,error:"no_permission"});
    }
    const db=readDb();
    const unpaid=(db.fines||[]).filter(f=>f.status!=="paid"&&f.status!=="closed");
    const ch=await channel(CONFIG.channels.fines);
    if(!ch) return res.status(404).json({ok:false,error:"fines_channel_not_found"});
    const labels=[];const mentionIds=[];
    for(const f of unpaid){const m=await findDiscordMemberForRecord(f);if(m)mentionIds.push(m.id);labels.push(`• **${f.id}** — ${await discordPlayerLabel(f)} — **${money(Number(f.amount||0))}**`);}
    const text=labels.length?labels.join("\n"):"Немає неоплачених штрафів.";
    const ids=[...new Set(mentionIds)];
    await ch.send({content:ids.length?ids.map(id=>`<@${id}>`).join(" "):undefined,allowedMentions:{users:ids},embeds:[embed("🔔 Нагадування про неоплачені штрафи",text)]});
    securityLog("Нагадування про штрафи", req.user?.id || member.id, {count:unpaid.length});
    res.json({ok:true,count:unpaid.length});
  }catch(e){
    console.error("manual fine reminder error:", e);
    res.status(500).json({ok:false,error:"fine_reminder_failed",details:e.message});
  }
});

app.post("/api/reminders/warnings", protect, async (req,res)=>{
  try{
    const member = await requireFamilyRole(req,res); if(!member) return;

  /* FORBES_DISC_ALL_PATCH */
  if(member && !canDisciplineAll(member, req)) return denyPerm(res,"Недостатньо прав для штрафів/доган.");
    if(!canModerateWarningsAndFines(member) && !canModerateFarmReports(member)){
      return res.status(403).json({ok:false,error:"no_permission"});
    }
    const db=readDb();
    const active=(db.warnings||[]).filter(w=>w.status==="active");
    const ch=await channel(CONFIG.channels.warnings);
    if(!ch) return res.status(404).json({ok:false,error:"warnings_channel_not_found"});
    const labels=[];const mentionIds=[];
    for(const w of active){const m=await findDiscordMemberForRecord(w);if(m)mentionIds.push(m.id);labels.push(`• **${w.id}** — ${await discordPlayerLabel(w)} — ${w.reason||"-"}`);}
    const text=labels.length?labels.join("\n"):"Немає активних доган.";
    const ids=[...new Set(mentionIds)];
    await ch.send({content:ids.length?ids.map(id=>`<@${id}>`).join(" "):undefined,allowedMentions:{users:ids},embeds:[embed("🔔 Нагадування про активні догани",text)]});
    securityLog("Нагадування про догани", req.user?.id || member.id, {count:active.length});
    res.json({ok:true,count:active.length});
  }catch(e){
    console.error("manual warning reminder error:", e);
    res.status(500).json({ok:false,error:"warning_reminder_failed",details:e.message});
  }
});

app.get("/api/discord-queue", protect, async (req,res)=>{
  try{
    const member=await requireFamilyRole(req,res); if(!member) return;
    if(!canModerateFarmReports(member)&&!canModerateWarningsAndFines(member)&&!canManageCaptLists(member)) return res.status(403).json({ok:false,error:"no_permission"});
    const db=readDb(); res.json({ok:true,queue:(db.discordQueue||[]).slice(0,100)});
  }catch(e){ res.status(500).json({ok:false,error:"queue_get_failed"}); }
});
app.post("/api/discord-queue/:id/retry", protect, async (req,res)=>{
  try{
    const member=await requireFamilyRole(req,res); if(!member) return;

  /* Attendance fine is allowed for capt managers. */
  /* FORBES_CAPT_ALL_PATCH */
  if(member && !canCaptAll(member, req)) return denyPerm(res,"Недостатньо прав для каптів/листів.");
    if(!canModerateFarmReports(member)&&!canModerateWarningsAndFines(member)&&!canManageCaptLists(member)) return res.status(403).json({ok:false,error:"no_permission"});
    const db=readDb(); const item=(db.discordQueue||[]).find(x=>x.id===req.params.id);
    if(!item) return res.status(404).json({ok:false,error:"queue_not_found"});
    item.status="failed"; writeDb(db);
    const result=await processDiscordQueue(20);
    securityLog("Повтор Discord-відправки", req.user?.id||member.id, {queueId:item.id,result});
    res.json({ok:true,result});
  }catch(e){ res.status(500).json({ok:false,error:"queue_retry_failed",details:e.message}); }
});
app.post("/api/discord-queue/retry-all", protect, async (req,res)=>{
  try{
    const member=await requireFamilyRole(req,res); if(!member) return;

  /* Attendance fine is allowed for capt managers. */
  /* FORBES_CAPT_ALL_PATCH */
  if(member && !canCaptAll(member, req)) return denyPerm(res,"Недостатньо прав для каптів/листів.");
    if(!canModerateFarmReports(member)&&!canModerateWarningsAndFines(member)&&!canManageCaptLists(member)) return res.status(403).json({ok:false,error:"no_permission"});
    const result=await processDiscordQueue(50);
    securityLog("Повтор всієї Discord-черги", req.user?.id||member.id, result);
    res.json({ok:true,result});
  }catch(e){ res.status(500).json({ok:false,error:"queue_retry_all_failed"}); }
});
app.get("/api/security-logs", protect, async (req,res)=>{
  try{
    const member=await requireFamilyRole(req,res); if(!member) return;
    if(!canModerateWarningsAndFines(member)&&!canManageCaptLists(member)) return res.status(403).json({ok:false,error:"no_permission"});
    const db=readDb(); res.json({ok:true,logs:(db.securityLogs||[]).slice(0,200)});
  }catch(e){ res.status(500).json({ok:false,error:"security_logs_failed"}); }
});

app.post("/api/gallery", protect, async (req,res)=>{
  try{
    if(!forbesMainIdFromReq(req)) return res.status(403).json({ok:false,error:"no_permission",message:"Додавати фото може тільки головний Discord ID."});

    const title = String(req.body.title || req.body.name || "Фото FORBES").trim();
    const url = cleanForbesMediaUrl(req.body.url || req.body.photoUrl || req.body.imageUrl || "");
    if(!/^https?:\/\//i.test(url)) return res.status(400).json({ok:false,error:"bad_url",message:"Встав правильний URL фото."});

    const db = readDb();
    db.gallery = Array.isArray(db.gallery) ? db.gallery : [];

    const existing = db.gallery.find(x => String(x.url || x.photoUrl || x.imageUrl) === url);
    const item = existing || {id:id("photo"),title,url,photoUrl:url,createdAt:now()};
    if(existing){
      existing.title = title || existing.title;
      existing.url = url;
      existing.photoUrl = url;
    }else{
      db.gallery.unshift(item);
    }

    const writeResult = await writeDbAsync(db);
    if(!writeResult.ok){
      return res.status(500).json({ok:false,error:"gallery_db_write_failed",message:"Supabase не прийняв запис галереї: "+writeResult.error,writeResult});
    }

    const verifyDb = readDb();
    const gallery = publicCleanGallery(verifyDb);
    const saved = gallery.some(x => String(x.url || x.photoUrl) === url);

    if(!saved){
      return res.status(500).json({
        ok:false,
        error:"gallery_not_persisted",
        message:"Фото не знайшлось у db.gallery після запису.",
        item,
        gallery,
        count:gallery.length,
        writeResult
      });
    }

    res.json({ok:true,item,gallery,photos:gallery,count:gallery.length,saved:true,source:"db.gallery",writeResult});
  }catch(e){
    console.error("gallery add error", e);
    res.status(500).json({ok:false,error:"gallery_add_failed",message:e.message});
  }
});
app.get("/api/logs", protect, async (req,res)=>{
  const member = await requireFamilyRole(req, res); if(!member) return;
  const db=readDb();
  res.json({ok:true,logs:(db.logs||[]).slice(0,100)});
});


app.get("/api/salary/archive", protect, async (req,res)=>{
  const member = await requireFamilyRole(req, res); if(!member) return;
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


function stripBackupHeavyData(value){
  try{
    return JSON.parse(JSON.stringify(value, (k,v)=>{
      const badKeys = ["screenshotData","imageData","photoData","fileData","attachmentData","housePhotoData","officePhotoData"];
      if(badKeys.includes(k)) return undefined;
      if(typeof v === "string" && v.length > 5000) return "[removed-large-data]";
      return v;
    }));
  }catch(e){ return value; }
}
async function sendSystemBackup(){
  try{
    const db = stripBackupHeavyData(readDb());
    const backupData = {
      createdAt: now(),
      type: "FORBES_SYSTEM_BACKUP",
      data: {
        contracts: db.contracts || [],
        cars: db.cars || [],
        familyInfo: db.familyInfo || {},
        gallery: db.gallery || [],
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
    const maxBytes = 7 * 1024 * 1024;
    if(payload.length > maxBytes){
      console.warn(`Backup too large, skipped: ${payload.length} bytes`);
      if(typeof addLog === "function") addLog("Backup занадто великий, пропущено", {bytes:payload.length});
      return;
    }

    await ch.send({
      content: `🗂️ Backup системи FORBES\n📅 ${now()}\n⏳ Автоматичний backup кожні 3 дні`,
      files: [{attachment: payload,name: `forbes-backup-${Date.now()}.json`}]
    });

    if(typeof addLog === "function") addLog("Автоматичний backup відправлено");
    console.log("Backup uploaded.");
  }catch(e){
    console.error("Backup send failed:", e);
  }
}


app.get("/api/system/status", protect, async (req,res)=>{
  const member = await requireFamilyRole(req, res); if(!member) return;
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
  setInterval(()=>processDiscordQueue(10).catch(console.error), 60 * 1000);
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

    if(typeof addLog === "function") addLog("ЗП відправлено в Discord", {count:rows.length}); securityLog("ЗП відправлено", req.user?.id || "", {count:rows.length});
    return res.json({ok:true,sent:true,count:rows.length});
  }catch(e){
    console.error("salary send error:", e);
    return res.status(500).json({ok:false,error:"salary_send_failed",details:e.message});
  }
});



app.post("/api/salary/close-week", protect, async (req,res)=>{
  try{
    const member = await apiMemberFromRequest(req);
    if(!member){
      return res.status(401).json({ok:false,error:"discord_member_not_found",message:"Не бачу користувача на Discord сервері."});
    }
    const allowed = (typeof canDisciplineAll === "function" && canDisciplineAll(member, req)) ||
      (typeof canModerateFarmReports === "function" && canModerateFarmReports(member)) ||
      (typeof canModerateWarningsAndFines === "function" && canModerateWarningsAndFines(member));
    if(!allowed){
      return res.status(403).json({ok:false,error:"no_permission",message:"Недостатньо прав для закриття тижня ЗП."});
    }
    if(req.body?.confirmSent !== true){
      return res.status(400).json({ok:false,error:"salary_not_confirmed",message:"Спочатку відправ ЗП в Discord, потім закривай тиждень."});
    }

    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    const closedAt = req.body.closedAt || now();
    const text = String(req.body.text || "").trim();

    const db = readDb();
    const archived = Array.isArray(db.farmReports) ? db.farmReports : [];
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

    const writeResult = typeof writeDbAsync === "function" ? await writeDbAsync(db) : (writeDb(db), {ok:true,mode:"sync"});
    if(!writeResult.ok){
      return res.status(500).json({ok:false,error:"salary_db_write_failed",message:"Supabase не прийняв очищення ЗП: "+writeResult.error,writeResult});
    }

    const verify = readDb();
    const remaining = Array.isArray(verify.farmReports) ? verify.farmReports.length : 0;
    if(remaining !== 0){
      return res.status(500).json({ok:false,error:"salary_not_cleared",message:"Після закриття тижня farmReports не очистились у базі.",remaining});
    }

    const salaryChannelId = CONFIG.channels?.salary || CONFIG.salaryChannelId;
    const ch = salaryChannelId ? await client.channels.fetch(salaryChannelId).catch(()=>null) : null;
    if(ch){
      await ch.send("🔒 **Тиждень закрито. Старі farm-звіти очищено. Новий тиждень відкрито.**");
    }

    if(typeof addLog === "function") addLog("Тиждень ЗП закрито", {count:rows.length});
    if(typeof securityLog === "function") securityLog("Тиждень ЗП закрито", req.user?.id || "", {count:rows.length});
    return res.json({ok:true,closed:true,count:rows.length,remaining,writeResult});
  }catch(e){
    console.error("salary close week error:", e);
    return res.status(500).json({ok:false,error:"salary_close_week_failed",message:"Помилка закриття тижня ЗП.",details:e.message});
  }
});





app.get("/api/blacklist", protect, async (req,res)=>{
  const member = await requireFamilyRole(req, res); if(!member) return;
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


/* === FORBES MUSIC URL + FILE DISCORD FIX === */

/* === FORBES URL NORMALIZE FIX === */
function cleanForbesMediaUrl(raw){
  let url = String(raw || "").trim();
  url = url.replace(/^["'`]+|["'`]+$/g, "").trim();
  // If user pasted markdown or text, extract first URL.
  const m = url.match(/https?:\/\/[^\s<>"'`]+/i);
  if(m) url = m[0].trim();
  try{
    const u = new URL(url);
    // IMPORTANT: do NOT strip Discord query params. New Discord/CDN links need ex/is/hm query to work.
    return u.toString();
  }catch(e){
    return url;
  }
}

function normalizeTrackUrl(url){
  return cleanForbesMediaUrl(url);
}

app.get("/api/music", async (req,res)=>{
  const db=readDb();
  db.musicTracks=Array.isArray(db.musicTracks)?db.musicTracks:[];
  const tracks = db.musicTracks.map(t=>({...t,url:normalizeTrackUrl(t.url)})).filter(t=>t.url);
  res.json({ok:true,tracks,count:tracks.length});
});
app.post("/api/music", protect, async (req,res)=>{
  try{
    if(!_mainId(req)) return denyPerm(res,"Додавати треки може тільки головний Discord ID.");
    const url = normalizeTrackUrl(req.body.url || req.body.musicUrl || req.body.src || "");
    const title = String(req.body.title || req.body.name || "FORBES Track").trim();

    if(!/^https?:\/\//i.test(url)) return res.status(400).json({ok:false,error:"url_required",message:"Встав правильний URL mp3 / Discord CDN."});

    const db=readDb();
    db.musicTracks=Array.isArray(db.musicTracks)?db.musicTracks:[];
    const track={id:id("track"),title,url,createdAt:now()};
    db.musicTracks.unshift(track);

    const writeResult = await writeDbAsync(db);
    if(!writeResult.ok){
      return res.status(500).json({ok:false,error:"music_db_write_failed",message:"Supabase не прийняв запис музики: "+writeResult.error,writeResult});
    }

    const verify = readDb();
    const tracks = (Array.isArray(verify.musicTracks)?verify.musicTracks:[]).map(t=>({...t,url:normalizeTrackUrl(t.url)})).filter(t=>t.url);
    const saved = tracks.some(t=>String(t.url)===String(url));
    if(!saved){
      return res.status(500).json({ok:false,error:"music_not_persisted",message:"Трек не знайшовся у db.musicTracks після запису.",track,tracks,writeResult});
    }

    console.log("[FORBES DEBUG] music_track_added", JSON.stringify({by:req.user?.id,title,url}));
    res.json({ok:true,track,tracks,saved:true,writeResult});
  }catch(e){
    console.error("[MUSIC] add failed",e);
    res.status(500).json({ok:false,error:"music_add_failed",message:e.message});
  }
});
app.delete("/api/music/:id", protect, async (req,res)=>{
  try{
    if(!_mainId(req)) { console.warn("[MUSIC] delete denied", {user:req.user?.id, h:req.headers?.["x-discord-user-id"], main:process.env.MAIN_DISCORD_ID||process.env.OWNER_ID||"502825427761365026"}); return denyPerm(res,"Видаляти треки може тільки головний Discord ID."); }
    const db=readDb(); db.musicTracks=Array.isArray(db.musicTracks)?db.musicTracks:[];
    db.musicTracks=db.musicTracks.filter(t=>String(t.id)!==String(req.params.id)); writeDb(db);
    console.log("[FORBES DEBUG] music_track_deleted", JSON.stringify({by:req.user?.id,id:req.params.id}));
    res.json({ok:true,tracks:db.musicTracks});
  }catch(e){console.error("[MUSIC] delete failed",e);res.status(500).json({ok:false,error:"music_delete_failed",message:e.message});}
});


app.get("/api/gallery", async (req,res)=>{
  try{
    res.set("Cache-Control","no-store, no-cache, must-revalidate, private");
    const db = readDb();
    db.gallery = Array.isArray(db.gallery) ? db.gallery : [];
    const gallery = publicCleanGallery(db);
    res.json({ok:true,gallery,photos:gallery,count:gallery.length,source:"db.gallery",serverTime:new Date().toISOString()});
  }catch(e){
    console.error("gallery get error", e);
    res.status(500).json({ok:false,error:"gallery_get_failed",message:e.message});
  }
});
app.post("/api/gallery", protect, async (req,res)=>{
  try{
    if(!forbesMainIdFromReq(req)) return res.status(403).json({ok:false,error:"no_permission",message:"Додавати фото може тільки головний Discord ID."});
    const title=String(req.body.title||"").trim(); const url=String(req.body.url||req.body.photoUrl||"").trim();
    if(!/^https?:\/\//i.test(url)) return res.status(400).json({ok:false,error:"bad_url",message:"Встав URL фото."});
    const db=readDb(); db.gallery=Array.isArray(db.gallery)?db.gallery:[];
    const item={id:id("photo"),title:title||"Фото FORBES",url,photoUrl:url,createdAt:now()};
    db.gallery.unshift(item); writeDb(db); res.json({ok:true,item,gallery:db.gallery});
  }catch(e){console.error("gallery add error",e);res.status(500).json({ok:false,error:"gallery_add_failed",message:e.message});}
});
app.delete("/api/gallery/:id", protect, async (req,res)=>{
  try{
    if(!forbesMainIdFromReq(req)) return res.status(403).json({ok:false,error:"no_permission",message:"Видаляти фото може тільки головний Discord ID."});
    const db=readDb(); db.gallery=Array.isArray(db.gallery)?db.gallery:[]; db.gallery=db.gallery.filter(x=>String(x.id)!==String(req.params.id)); writeDb(db);
    const gallery=publicCleanGallery(db); res.json({ok:true,gallery,photos:gallery,count:gallery.length});
  }catch(e){ console.error("gallery delete error",e); res.status(500).json({ok:false,error:"gallery_delete_failed",message:e.message}); }
});


/* === FORBES CALENDAR DUPLICATE FIX === */
async function sendForbesCalendarCopy(title, description){
  try{
    const ch = await channel(CONFIG.channels.calendar);
    if(!ch){
      console.error("FORBES calendar channel not found:", CONFIG.channels.calendar);
      return false;
    }
    await ch.send({embeds:[embed(title, description)]});
    return true;
  }catch(e){
    console.error("FORBES calendar copy failed:", e);
    return false;
  }
}

app.post("/api/announcements", protect, async (req,res)=>{
  try{
    const annMember=await apiMemberFromRequest(req);
    const annType=String(req.body.type||"all").toLowerCase();
    const canGeneral=_mainId(req)||userHasAnyRole(annMember,[CONFIG.roles.deputy,CONFIG.roles.rightHand]);
    const canFarm=canGeneral||forbes2026Farm(annMember,req)||userHasAnyRole(annMember,[CONFIG.roles.farmManager]);
    if(annType==="farm" ? !canFarm : !canGeneral) return res.status(403).json({ok:false,error:"no_permission",message:"Немає прав."});
    const db=readDb();
    db.announcements = Array.isArray(db.announcements) ? db.announcements : [];
    const item={
      id:id("ann"),
      type:String(req.body.type||"all"),
      title:String(req.body.title||"Оголошення").trim(),
      text:String(req.body.text||req.body.message||"").trim(),
      createdAt:now(),
      createdBy:req.user?.username||req.user?.name||req.body.createdBy||""
    };
    if(!item.text) return res.status(400).json({ok:false,error:"empty_text",message:"Текст оголошення порожній."});
    db.announcements.unshift(item);
    writeDb(db);

    const desc = `${item.text}\n\n**Опублікував:** ${item.createdBy || "-"}`;
    let discordSent = false;
    let discordError = "";
    try{
      const ch = await channel(item.type === "farm" ? CONFIG.channels.farmAnnouncements : CONFIG.channels.announcements);
      if(!ch){
        discordError = `Канал оголошень не знайдено: ${CONFIG.channels.announcements}`;
      }else{
        await ch.send({embeds:[embed("📢 "+item.title, desc)]});
        discordSent = true;
      }
    }catch(e){
      discordError = e.message || String(e);
      console.error("Announcement Discord send failed:", e);
    }

    const calendarSent = await sendForbesCalendarCopy("📅 Оголошення: "+item.title, desc);
    res.json({ok:true,announcement:item,item,discordSent,discordError,calendarSent,calendarChannelId:CONFIG.channels.calendar});
  }catch(e){
    console.error("POST /api/announcements failed:", e);
    res.status(500).json({ok:false,error:"announcement_create_failed",message:e.message});
  }
});

app.get("/api/announcements", protect, async (req,res)=>{
  try{
    const db=readDb();
    const announcements = Array.isArray(db.announcements) ? db.announcements : [];
    res.json({ok:true,announcements,count:announcements.length});
  }catch(e){res.status(500).json({ok:false,error:"announcements_get_failed",message:e.message});}
});

async function finalizeGiveawayDiscord(g, winners=[], {closedWithoutWinner=false}={}){
  const participants=Array.isArray(g.participants)?g.participants:[];
  const winnerLine = w => {
    const mention=w.userId?`<@${w.userId}>`:"";
    const nick=w.nickname||w.nick||w.displayName||w.username||w.name||"Учасник";
    const sid=w.staticId||w.playerId||"";
    return `${mention||`**${nick}**`}${mention?` — **${nick}**`:""}${sid?` | ID: **${sid}**`:""}`;
  };
  const winnersText=winners.map((w,i)=>`**${i+1}.** ${winnerLine(w)}`).join("\n");
  const statusText=closedWithoutWinner?"🔒 **Розіграш закрито без вибору переможця**":`🏁 **Розіграш завершено**\n\n${winnersText}`;
  let discordSent=false,discordError="";
  try{
    const ch=await channel(CONFIG.channels.giveawayWinners||"1505075996100137110");
    if(!ch) discordError=`Канал переможців не знайдено: ${CONFIG.channels.giveawayWinners}`;
    else if(!closedWithoutWinner){
      const mentionIds=winners.map(w=>String(w.userId||"")).filter(Boolean);
      await ch.send({
        content:mentionIds.map(id=>`<@${id}>`).join(" ")||undefined,
        allowedMentions:{users:mentionIds},
        embeds:[embed("🏆 Переможець розіграшу: "+(g.title||"-"),`**Приз:** ${g.prize||"-"}\n\n${winnersText}`)]
      });
      discordSent=true;
    }
  }catch(e){discordError=e.message||String(e);console.error("Giveaway winners send failed:",e);}
  try{
    if(g.messageId&&CONFIG.channels.giveawayActive){
      const activeCh=await channel(CONFIG.channels.giveawayActive);
      const msg=activeCh?await activeCh.messages.fetch(g.messageId).catch(()=>null):null;
      if(msg){
        await msg.edit({embeds:[embed("🎁 "+(g.title||"Розіграш")+(closedWithoutWinner?" — закрито":" — завершено"),`**Приз:** ${g.prize||"-"}\n**Учасників:** ${participants.length}\n${winners.length?`**Переможців:** ${winners.length}\n\n`:"\n"}${statusText}`)],components:[]}).catch(()=>{});
      }
    }
  }catch(e){console.error("Giveaway finish message edit failed:",e);}
  return {discordSent,discordError,winnersText};
}

app.post("/api/giveaways", protect, async (req,res)=>{
  try{
    const db=readDb();
    db.giveaways = Array.isArray(db.giveaways) ? db.giveaways : [];

    const item={
      id:id("give"),
      title:String(req.body.title||"Розіграш").trim(),
      prize:String(req.body.prize||"").trim(),
      rules:String(req.body.rules||req.body.text||"").trim(),
      status:"active",
      participants:[],
      winners:[],
      createdAt:now(),
      createdBy:req.user?.username||req.user?.name||req.body.createdBy||""
    };
    if(!item.title || !item.prize) return res.status(400).json({ok:false,error:"bad_giveaway",message:"Вкажи назву і приз."});

    db.giveaways.unshift(item);
    writeDb(db);

    let discordSent = false;
    let discordError = "";
    try{
      const ch = await channel(CONFIG.channels.giveawayActive);
      if(!ch){
        discordError = `Канал розіграшів не знайдено: ${CONFIG.channels.giveawayActive}`;
      }else{
        const msg = await ch.send({
          embeds:[embed("🎁 "+item.title,
            `**Приз:** ${item.prize}\n`+
            `**Умови:** ${item.rules || "-"}\n\n`+
            `Натисни кнопку **✅ Беру участь**, щоб взяти участь.\n`+
            `**Учасників:** 0`
          )],
          components:[row([
            {id:`giveaway_join:${item.id}`,label:"✅ Беру участь",style:ButtonStyle.Success}
          ])]
        });
        item.messageId = msg?.id || "";
        discordSent = true;
        writeDb(db);
      }
    }catch(e){
      discordError = e.message || String(e);
      console.error("Giveaway Discord send failed:", e);
    }

    res.json({ok:true,giveaway:item,item,discordSent,discordError});
  }catch(e){
    console.error("POST /api/giveaways failed:", e);
    res.status(500).json({ok:false,error:"giveaway_create_failed",message:e.message});
  }
});

app.get("/api/giveaways", async (req,res)=>{
  try{
    const db=readDb();
    const giveaways = (Array.isArray(db.giveaways) ? db.giveaways : []).map(g=>({
      id:g.id,
      title:g.title||"",
      prize:g.prize||"",
      rules:g.rules||"",
      status:g.status||"active",
      created:g.created||g.createdAt||"",
      createdAt:g.createdAt||g.created||"",
      finishedAt:g.finishedAt||"",
      closedAt:g.closedAt||"",
      messageId:g.messageId||"",
      participantsCount:Array.isArray(g.participants)?g.participants.length:Number(g.participantsCount||0),
      winners:Array.isArray(g.winners)?g.winners.map(w=>({
        userId:w.userId||"",
        nickname:w.nickname||w.nick||w.displayName||w.username||"Учасник",
        username:w.username||"",
        staticId:w.staticId||w.playerId||""
      })):[]
    }));
    res.set("Cache-Control","no-store");
    res.json({ok:true,giveaways,count:giveaways.length});
  }catch(e){res.status(500).json({ok:false,error:"giveaways_get_failed",message:e.message});}
});

app.post("/api/giveaways/:id/pick-winners", protect, async (req,res)=>{
  try{
    const db=readDb();
    db.giveaways = Array.isArray(db.giveaways) ? db.giveaways : [];
    const g = db.giveaways.find(x=>String(x.id)===String(req.params.id));
    if(!g) return res.status(404).json({ok:false,error:"giveaway_not_found",message:"Розіграш не знайдено."});

    if(String(g.status||"").toLowerCase()==="finished" && Array.isArray(g.winners) && g.winners.length){
      return res.status(400).json({ok:false,error:"already_finished",message:"Розіграш уже завершено."});
    }

    const participants = Array.isArray(g.participants) ? g.participants : [];
    const count = Math.max(1, Math.min(Number(req.body.count||1), participants.length));
    if(!participants.length) return res.status(400).json({ok:false,error:"no_participants",message:"У розіграші немає учасників."});

    const shuffled = [...participants].sort(()=>Math.random()-0.5);
    const winners = shuffled.slice(0,count);
    g.winners = winners;
    g.winnersCount = winners.length;
    g.status = "finished";
    g.finishedAt = now();
    writeDb(db);

    const {discordSent,discordError,winnersText}=await finalizeGiveawayDiscord(g,winners);

    let calendarSent = false;
    if(typeof sendForbesCalendarCopy === "function"){
      const desc=`**Приз:** ${g.prize||"-"}
**Кількість переможців:** ${winners.length}

${winnersText}`;
      calendarSent = await sendForbesCalendarCopy("📅 Переможці розіграшу: "+(g.title||"-"), desc);
    }

    res.json({ok:true,giveaway:g,winners,discordSent,discordError,calendarSent,calendarChannelId:CONFIG.channels.calendar});
  }catch(e){
    console.error("POST /api/giveaways/:id/pick-winners failed:", e);
    res.status(500).json({ok:false,error:"pick_winners_failed",message:e.message});
  }
});

app.post("/api/giveaways/:id/manual-winner", protect, async (req,res)=>{
  try{
    const db=readDb(); db.giveaways=Array.isArray(db.giveaways)?db.giveaways:[];
    const g=db.giveaways.find(x=>String(x.id)===String(req.params.id));
    if(!g)return res.status(404).json({ok:false,error:"giveaway_not_found",message:"Розіграш не знайдено."});
    const nickname=String(req.body.nickname||req.body.nick||"").trim();
    const staticId=String(req.body.staticId||req.body.playerId||"").trim();
    if(!nickname&&!staticId)return res.status(400).json({ok:false,error:"winner_required",message:"Вкажи нік або Static ID переможця."});
    const member=await findDiscordMemberForRecord({nickname,staticId,discordUserId:req.body.discordUserId||""}).catch(()=>null);
    const winner={userId:member?.id||req.body.discordUserId||"",nickname:member?.displayName||nickname||member?.user?.username||"Учасник",username:member?.user?.username||"",staticId,selectedManually:true,selectedAt:now()};
    g.winners=[winner]; g.winnersCount=1; g.status="finished"; g.finishedAt=now(); g.manualWinner=true;
    writeDb(db);
    const {discordSent,discordError}=await finalizeGiveawayDiscord(g,[winner]);
    res.json({ok:true,giveaway:g,winners:[winner],discordSent,discordError});
  }catch(e){console.error("manual giveaway winner failed:",e);res.status(500).json({ok:false,error:"manual_winner_failed",message:e.message});}
});

app.post("/api/giveaways/:id/close", protect, async (req,res)=>{
  try{
    const db=readDb(); db.giveaways=Array.isArray(db.giveaways)?db.giveaways:[];
    const g=db.giveaways.find(x=>String(x.id)===String(req.params.id));
    if(!g)return res.status(404).json({ok:false,error:"giveaway_not_found",message:"Розіграш не знайдено."});
    g.status="closed"; g.closedAt=now(); g.closedBy=req.user?.username||req.user?.name||"";
    writeDb(db);
    await finalizeGiveawayDiscord(g,[],{closedWithoutWinner:true});
    res.json({ok:true,giveaway:g});
  }catch(e){console.error("close giveaway failed:",e);res.status(500).json({ok:false,error:"giveaway_close_failed",message:e.message});}
});

app.delete("/api/giveaways/:id", protect, async (req,res)=>{
  try{
    const db=readDb(); db.giveaways=Array.isArray(db.giveaways)?db.giveaways:[];
    const idx=db.giveaways.findIndex(x=>String(x.id)===String(req.params.id));
    if(idx<0)return res.status(404).json({ok:false,error:"giveaway_not_found",message:"Розіграш не знайдено."});
    const [g]=db.giveaways.splice(idx,1); writeDb(db);
    let discordDeleted=false;
    try{
      if(g.messageId&&CONFIG.channels.giveawayActive){
        const ch=await channel(CONFIG.channels.giveawayActive);
        const msg=ch?await ch.messages.fetch(g.messageId).catch(()=>null):null;
        if(msg){await msg.delete().catch(()=>{});discordDeleted=true;}
      }
    }catch(e){console.error("giveaway discord delete failed:",e);}
    res.json({ok:true,id:req.params.id,discordDeleted});
  }catch(e){console.error("delete giveaway failed:",e);res.status(500).json({ok:false,error:"giveaway_delete_failed",message:e.message});}
});

app.get("/api/family-stats", protect, async (req,res)=>{
  try{
    const db = ensureStatsDb(readDb());
    db.hallOfFameSettings = db.hallOfFameSettings || {mode:"manual"};
    const members = await getPublicMembersFromDiscord().catch(()=>[]);
    const stats = buildForbesStats({...db, membersCount: members.length});
    const hallOfFame = buildHallOfFame(db, members);
    res.json({ok:true,stats,hallOfFame,settings:db.hallOfFameSettings});
  }catch(e){
    console.error("GET /api/family-stats failed:", e);
    res.status(500).json({ok:false,error:"family_stats_failed",message:e.message});
  }
});

app.put("/api/family-stats", protect, async (req,res)=>{
  try{
    const db = ensureStatsDb(readDb());
    db.familyStatsManual = {...(db.familyStatsManual||{}), ...(req.body||{})};
    writeDb(db);
    res.json({ok:true,stats:buildForbesStats(db)});
  }catch(e){
    console.error("PUT /api/family-stats failed:", e);
    res.status(500).json({ok:false,error:"family_stats_update_failed",message:e.message});
  }
});

app.post("/api/family-stats/reset", protect, async (req,res)=>{
  try{
    const db = ensureStatsDb(readDb());
    db.familyStatsManual = {};
    writeDb(db);
    res.json({ok:true,stats:buildForbesStats(db)});
  }catch(e){
    res.status(500).json({ok:false,error:"family_stats_reset_failed",message:e.message});
  }
});

app.get("/api/member-profiles", protect, async (req,res)=>{
  try{
    const db = ensureStatsDb(readDb());
    const members = await getPublicMembersFromDiscord().catch(()=>[]);
    const profiles = members.map(m=>buildMemberProfileFromDb(db,m));
    res.json({ok:true,profiles,count:profiles.length});
  }catch(e){
    console.error("GET /api/member-profiles failed:", e);
    res.status(500).json({ok:false,error:"member_profiles_failed",message:e.message});
  }
});

app.put("/api/member-join-date", protect, async (req,res)=>{
  try{
    const db = ensureStatsDb(readDb());
    const key = statKeyFor(req.body.nick, req.body.staticId);
    if(!key) return res.status(400).json({ok:false,error:"bad_member",message:"Нема ніку/ID."});
    db.memberJoinDates[key] = req.body.joinedAt || "";
    writeDb(db);
    res.json({ok:true,key,joinedAt:db.memberJoinDates[key]});
  }catch(e){
    res.status(500).json({ok:false,error:"join_date_update_failed",message:e.message});
  }
});

app.get("/api/hall-of-fame", protect, async (req,res)=>{
  try{
    const db = ensureStatsDb(readDb());
    db.hallOfFameSettings = db.hallOfFameSettings || {mode:"manual"};
    const members = await getPublicMembersFromDiscord().catch(()=>[]);
    res.json({ok:true,hallOfFame:buildHallOfFame(db,members),settings:db.hallOfFameSettings});
  }catch(e){
    res.status(500).json({ok:false,error:"hall_of_fame_failed",message:e.message});
  }
});

app.put("/api/hall-of-fame", protect, async (req,res)=>{
  try{
    const db = ensureStatsDb(readDb());
    db.hallOfFameManual = db.hallOfFameManual || {};
    db.hallOfFameSettings = db.hallOfFameSettings || {mode:"manual"};

    if(req.body.mode) db.hallOfFameSettings.mode = req.body.mode === "auto" ? "auto" : "manual";

    const fields = ["topFarmer","topCapter","topWinner","topContracts","topGiveaway","cleanest"];
    for(const f of fields){
      if(Object.prototype.hasOwnProperty.call(req.body, f)){
        const v = req.body[f];
        if(!v || (!v.nick && !v.staticId)){
          db.hallOfFameManual[f] = null;
        }else{
          db.hallOfFameManual[f] = {
            nick:String(v.nick||"").trim(),
            staticId:String(v.staticId||"").trim(),
            note:String(v.note||"").trim(),
            stats:v.stats || {}
          };
        }
      }
    }

    writeDb(db);
    const members = await getPublicMembersFromDiscord().catch(()=>[]);
    res.json({ok:true,hallOfFame:buildHallOfFame(db,members),settings:db.hallOfFameSettings});
  }catch(e){
    console.error("PUT /api/hall-of-fame failed:", e);
    res.status(500).json({ok:false,error:"hall_of_fame_update_failed",message:e.message});
  }
});

app.post("/api/hall-of-fame/clear", protect, async (req,res)=>{
  try{
    const db = ensureStatsDb(readDb());
    db.hallOfFameManual = {};
    db.hallOfFameSettings = {mode:"manual"};
    writeDb(db);
    res.json({ok:true,hallOfFame:emptyHallOfFame(),settings:db.hallOfFameSettings});
  }catch(e){
    res.status(500).json({ok:false,error:"hall_of_fame_clear_failed",message:e.message});
  }
});

app.post("/api/admin/cleanup-test-data", protect, async (req,res)=>{
  try{
    const db = readDb();
    const target = String(req.body.target || "all");
    const before = {
      applications: Array.isArray(db.applications) ? db.applications.length : 0,
      farmReports: Array.isArray(db.farmReports) ? db.farmReports.length : 0,
      capts: Array.isArray(db.capts) ? db.capts.length : 0,
      fines: Array.isArray(db.fines) ? db.fines.length : 0,
      warnings: Array.isArray(db.warnings) ? db.warnings.length : 0
    };

    if(target === "all" || target === "applications") db.applications = [];
    if(target === "all" || target === "farmReports") db.farmReports = [];
    if(target === "all" || target === "capts") db.capts = [];
    if(target === "all" || target === "fines") db.fines = [];
    if(target === "all" || target === "warnings") db.warnings = [];

    // Після тестової очистки Зал слави теж стає ручним і пустим.
    if(target === "all" || target === "capts" || target === "farmReports"){
      db.hallOfFameManual = {};
      db.hallOfFameSettings = {mode:"manual"};
    }

    writeDb(db);
    const after = {
      applications: Array.isArray(db.applications) ? db.applications.length : 0,
      farmReports: Array.isArray(db.farmReports) ? db.farmReports.length : 0,
      capts: Array.isArray(db.capts) ? db.capts.length : 0,
      fines: Array.isArray(db.fines) ? db.fines.length : 0,
      warnings: Array.isArray(db.warnings) ? db.warnings.length : 0
    };
    res.json({ok:true,target,before,after});
  }catch(e){
    console.error("cleanup test data failed:", e);
    res.status(500).json({ok:false,error:"cleanup_failed",message:e.message});
  }
});

app.get("/api/media-proxy", async (req,res)=>{
  try{
    const raw = String(req.query.url || "").trim();
    if(!/^https?:\/\//i.test(raw)) return res.status(400).send("Bad media url");

    const target = new URL(raw);
    const host = target.hostname.toLowerCase();
    const allowed = (
      host.endsWith("discordapp.com") || host.endsWith("discordapp.net") ||
      host.endsWith("discord.com") || host.endsWith("media.discordapp.net") ||
      host.endsWith("cdn.discordapp.com") || host.endsWith("githubusercontent.com") ||
      host.endsWith("supabase.co")
    );
    if(!allowed) return res.status(403).send("Host not allowed");

    const range = req.headers.range;
    const headers = {
      "User-Agent":"Mozilla/5.0 FORBES-MediaProxy",
      "Accept":"image/*,audio/*,*/*"
    };
    if(range) headers.Range = range;

    const upstream = await fetch(target.toString(), { headers });
    if(!upstream.ok && upstream.status !== 206){
      return res.status(upstream.status).send("Upstream media failed: " + upstream.status);
    }

    res.status(upstream.status);
    for(const name of ["content-type","content-length","content-range","accept-ranges","etag","last-modified"]){
      const value=upstream.headers.get(name);
      if(value) res.set(name,value);
    }
    if(!res.get("Accept-Ranges")) res.set("Accept-Ranges","bytes");
    res.set("Access-Control-Allow-Origin","*");
    res.set("Cross-Origin-Resource-Policy","cross-origin");
    res.set("Cache-Control","public, max-age=300");

    if(!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  }catch(e){
    console.error("media proxy failed:", e);
    if(!res.headersSent) res.status(500).send("Media proxy failed: " + (e.message || e));
    else res.end();
  }
});

app.post("/api/contracts", protect, ownerOnly, async (req,res)=>{
  try{
    const db=readDb();
    db.contracts=Array.isArray(db.contracts)?db.contracts:[];
    const item={id:id("contract"),name:String(req.body.name||"").trim(),amount:Number(req.body.amount||0),contractAmount:Number(req.body.amount||0),active:Boolean(req.body.active ?? true),createdAt:now()};
    if(!item.name || !item.amount) return res.status(400).json({ok:false,error:"name and amount required"});
    db.contracts.unshift(item);
    const wr = typeof writeDbAsync==="function" ? await writeDbAsync(db) : (writeDb(db), {ok:true});
    if(!wr.ok) return res.status(500).json({ok:false,error:"contracts_db_write_failed",message:wr.error||"write failed"});
    const fresh=readDb();
    res.json({ok:true,contract:item,contracts:Array.isArray(fresh.contracts)?fresh.contracts:db.contracts,writeResult:wr});
  }catch(e){
    console.error("contracts post failed",e);
    res.status(500).json({ok:false,error:"contracts_post_failed",message:e.message});
  }
});

app.get("/api/members-autofill", async (req,res)=>{
  try{
    res.set("Cache-Control","no-store, no-cache, must-revalidate, private");
    const map = new Map();

    // 1) Discord members
    try{
      const discordMembers = await getPublicMembersFromDiscord();
      for(const m of discordMembers || []){
        _autoAddMember(map, m.nick || m.nickname || m.username, m.staticId || m.playerId, m.roles || [], "discord");
      }
    }catch(e){
      console.warn("members-autofill discord source failed", e?.message || e);
    }

    // 2) DB sources where static IDs often exist
    const db = readDb();
    const sources = [
      ["applications", db.applications],
      ["farmReports", db.farmReports],
      ["farmReportsArchive", db.farmReportsArchive],
      ["fines", db.fines],
      ["warnings", db.warnings],
      ["blacklist", db.blacklist],
      ["members", db.members],
      ["memberProfiles", db.memberProfiles]
    ];
    for(const [name, arr] of sources){
      if(Array.isArray(arr)){
        for(const item of arr) _autoCollectPlayersFromAny(map, item, name);
      }else if(arr && typeof arr === "object"){
        for(const item of Object.values(arr)) _autoCollectPlayersFromAny(map, item, name);
      }
    }

    const members = Array.from(new Set(Array.from(map.values())))
      .filter(x=>x.nick && x.nick !== "-")
      .sort((a,b)=>String(a.nick).localeCompare(String(b.nick),"uk"));

    res.json({ok:true,members,count:members.length,serverTime:new Date().toISOString()});
  }catch(e){
    console.error("members-autofill failed", e);
    res.status(500).json({ok:false,error:"members_autofill_failed",message:e.message});
  }
});

/* === FORBES FINAL MEDIA + CONTENT API V2 === */
function finalRoles(member){try{return member?.roles?.cache?Array.from(member.roles.cache.values()).map(r=>({id:r.id,name:String(r.name||"").toLowerCase()})):[]}catch(e){return []}}
function finalHas(member,ids,names){const rs=finalRoles(member);return rs.some(r=>(ids||[]).filter(Boolean).map(String).includes(String(r.id))||(names||[]).some(n=>r.name.includes(n)));}
function finalOwner(req){return _mainId(req);}
async function finalMember(req){return apiMemberFromRequest(req);}
async function finalCanContent(req){return finalOwner(req);}
async function finalCanFarmAnn(req){if(finalOwner(req))return true;const m=await finalMember(req);return finalHas(m,[CONFIG.roles.deputy,CONFIG.roles.rightHand,CONFIG.roles.farmManager],["зам","права рука","фарм менеджер"]);}
function backupMedia(db,type,payload,action="update"){db.mediaBackups=Array.isArray(db.mediaBackups)?db.mediaBackups:[];db.mediaBackups.unshift({id:id("backup"),type,action,payload:JSON.parse(JSON.stringify(payload||null)),createdAt:new Date().toISOString()});db.mediaBackups=db.mediaBackups.slice(0,200);}
function mediaDb(db){db.galleryAlbums=Array.isArray(db.galleryAlbums)?db.galleryAlbums:[];db.musicTracks=Array.isArray(db.musicTracks)?db.musicTracks:[];db.cars=Array.isArray(db.cars)?db.cars:[];db.estate=db.estate||{title:"Фото маєтку",description:"",photos:[]};db.office=db.office||{title:"Офіс",description:"",photos:[]};db.familyHistory=db.familyHistory||{title:"Історія сім’ї",text:"",photos:[]};db.leadership=Array.isArray(db.leadership)?db.leadership:[];db.mediaBackups=Array.isArray(db.mediaBackups)?db.mediaBackups:[];return db;}
app.get("/api/v2/content", async (req,res)=>{
  const db=mediaDb(readDb());
  const familyInfo=db.familyInfo||{};
  const leadership=(Array.isArray(familyInfo.leadership)&&familyInfo.leadership.length)?familyInfo.leadership:db.leadership;
  const legacyGallery=(db.gallery||[]).map(x=>({id:x.id,title:x.title||x.name||"Стара галерея",description:x.description||"",photos:[{publicUrl:x.url||x.photoUrl||x.imageUrl||"",legacy:true}].filter(p=>p.publicUrl),legacy:true,createdAt:x.createdAt||""}));
  const galleryAlbums=db.galleryAlbums.length?db.galleryAlbums:legacyGallery;
  const estate={...db.estate,photoUrl:db.estate?.photoUrl||familyInfo.housePhotoUrl||"",description:db.estate?.description||familyInfo.houseDescription||"",location:db.estate?.location||familyInfo.houseLocation||""};
  res.set("Cache-Control","no-store");
  res.json({ok:true,cars:db.cars,estate,office:db.office,familyHistory:db.familyHistory,leadership,galleryAlbums,musicTracks:db.musicTracks,mediaConfigured:mediaConfigured(),paths:MEDIA_PATHS,serverTime:new Date().toISOString()});
});
app.get("/api/v2/media/status", async (req,res)=>{try{const s=await ensureMediaSystem();res.json({...s,paths:MEDIA_PATHS});}catch(e){res.status(500).json({ok:false,error:"media_init_failed",message:e.message});}});
app.post("/api/v2/content/:section",protect,async(req,res)=>{if(!(await finalCanContent(req)))return denyPerm(res);const allowed=["estate","office","familyHistory","leadership"];if(!allowed.includes(req.params.section))return res.status(400).json({ok:false,error:"bad_section"});const db=mediaDb(readDb());backupMedia(db,req.params.section,db[req.params.section]);db[req.params.section]=req.body.value;const wr=await writeDbAsync(db);if(!wr.ok)return res.status(500).json({ok:false,error:"db_write_failed",message:wr.error});res.json({ok:true,value:db[req.params.section]});});
app.post("/api/v2/media/upload",protect,async(req,res)=>{if(!(await finalCanContent(req)))return denyPerm(res);try{const media=await uploadBase64Media(req.body.kind,req.body.file);res.json({ok:true,media});}catch(e){res.status(400).json({ok:false,error:"upload_failed",message:e.message});}});
app.post("/api/v2/cars",protect,async(req,res)=>{if(!(await finalCanContent(req)))return denyPerm(res);try{const db=mediaDb(readDb());let media=null;if(req.body.file)media=await uploadBase64Media("car",req.body.file);const car={id:id("car"),name:req.body.name||"",category:req.body.category||"premium",categoryName:req.body.categoryName||"",number:req.body.number||"",place:req.body.place||"",rank:req.body.rank||"",description:req.body.description||"",specPower:req.body.specPower||req.body.power||"",specEngine:req.body.specEngine||req.body.engine||"",specDrive:req.body.specDrive||req.body.drive||"",specSpeed:req.body.specSpeed||req.body.maxSpeed||"",specAccel:req.body.specAccel||req.body.accel||req.body.acceleration||"",specSeats:req.body.specSeats||req.body.seats||"",status:req.body.status||req.body.availability||"",photoUrl:media?.publicUrl||req.body.photoUrl||"",media,createdAt:new Date().toISOString()};db.cars.unshift(car);const wr=await writeDbAsync(db);if(!wr.ok)throw new Error(wr.error);res.json({ok:true,car,cars:db.cars});}catch(e){res.status(400).json({ok:false,error:"car_save_failed",message:e.message});}});
app.delete("/api/v2/cars/:id",protect,async(req,res)=>{if(!(await finalCanContent(req)))return denyPerm(res);const db=mediaDb(readDb());const item=db.cars.find(x=>String(x.id)===String(req.params.id));if(!item)return res.status(404).json({ok:false,error:"not_found"});backupMedia(db,"car",item,"delete");db.cars=db.cars.filter(x=>x!==item);if(item.media?.bucket&&item.media?.path)await deleteMedia(item.media.bucket,item.media.path).catch(()=>{});await writeDbAsync(db);res.json({ok:true,cars:db.cars});});
app.post("/api/v2/gallery/albums",protect,async(req,res)=>{if(!(await finalCanContent(req)))return denyPerm(res);try{const db=mediaDb(readDb());const photos=[];for(const f of req.body.files||[])photos.push(await uploadBase64Media("gallery",f));const album={id:id("album"),category:["estate","cars","office","other"].includes(String(req.body.category||""))?String(req.body.category):"other",title:req.body.title||"Альбом",description:req.body.description||"",photos,author:req.user?.username||req.body.author||"",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};db.galleryAlbums.unshift(album);await writeDbAsync(db);res.json({ok:true,album,albums:db.galleryAlbums});}catch(e){res.status(400).json({ok:false,error:"album_save_failed",message:e.message});}});
app.delete("/api/v2/gallery/albums/:albumId/photos/:index",protect,async(req,res)=>{if(!(await finalCanContent(req)))return denyPerm(res);const db=mediaDb(readDb());const album=db.galleryAlbums.find(x=>String(x.id)===String(req.params.albumId));if(!album)return res.status(404).json({ok:false,error:"not_found"});const index=Number(req.params.index);if(!Number.isInteger(index)||index<0||index>=album.photos.length)return res.status(404).json({ok:false,error:"photo_not_found"});const [photo]=album.photos.splice(index,1);if(photo?.bucket&&photo?.path)await deleteMedia(photo.bucket,photo.path).catch(()=>{});if(!album.photos.length)db.galleryAlbums=db.galleryAlbums.filter(x=>x!==album);else album.updatedAt=new Date().toISOString();await writeDbAsync(db);res.json({ok:true,albums:db.galleryAlbums});});
app.delete("/api/v2/gallery/albums/:id",protect,async(req,res)=>{if(!(await finalCanContent(req)))return denyPerm(res);const db=mediaDb(readDb());const album=db.galleryAlbums.find(x=>String(x.id)===String(req.params.id));if(!album)return res.status(404).json({ok:false,error:"not_found"});backupMedia(db,"galleryAlbum",album,"delete");for(const p of album.photos||[])if(p.bucket&&p.path)await deleteMedia(p.bucket,p.path).catch(()=>{});db.galleryAlbums=db.galleryAlbums.filter(x=>x!==album);await writeDbAsync(db);res.json({ok:true,albums:db.galleryAlbums});});
app.post("/api/v2/music/tracks",protect,async(req,res)=>{if(!(await finalCanContent(req)))return denyPerm(res);try{const db=mediaDb(readDb());const media=await uploadBase64Media("track",req.body.file);let cover=null;if(req.body.cover)cover=await uploadBase64Media("cover",req.body.cover);const track={id:id("track"),title:req.body.title||media.name,author:req.body.author||"",url:media.publicUrl,media,coverUrl:cover?.publicUrl||"",cover,createdAt:new Date().toISOString()};db.musicTracks.unshift(track);await writeDbAsync(db);res.json({ok:true,track,tracks:db.musicTracks});}catch(e){res.status(400).json({ok:false,error:"track_save_failed",message:e.message});}});
app.delete("/api/v2/music/tracks/:id",protect,async(req,res)=>{if(!(await finalCanContent(req)))return denyPerm(res);const db=mediaDb(readDb());const t=db.musicTracks.find(x=>String(x.id)===String(req.params.id));if(!t)return res.status(404).json({ok:false,error:"not_found"});backupMedia(db,"musicTrack",t,"delete");if(t.media?.bucket&&t.media?.path)await deleteMedia(t.media.bucket,t.media.path).catch(()=>{});if(t.cover?.bucket&&t.cover?.path)await deleteMedia(t.cover.bucket,t.cover.path).catch(()=>{});db.musicTracks=db.musicTracks.filter(x=>x!==t);await writeDbAsync(db);res.json({ok:true,tracks:db.musicTracks});});
app.get("/api/v2/backups",protect,async(req,res)=>{if(!(await finalCanContent(req)))return denyPerm(res);const db=mediaDb(readDb());res.json({ok:true,backups:db.mediaBackups.slice(0,100)});});
app.post("/api/v2/announcements/farm",protect,async(req,res)=>{if(!(await finalCanFarmAnn(req)))return denyPerm(res);const db=readDb();db.announcements=Array.isArray(db.announcements)?db.announcements:[];const item={id:id("ann"),type:"farm",title:req.body.title||"Оголошення для фарму",text:req.body.text||"",createdAt:now()};db.announcements.unshift(item);await writeDbAsync(db);const ch=await channel(CONFIG.channels.farmAnnouncements);if(ch)await ch.send({embeds:[embed(item.title,item.text)]});res.json({ok:true,item});});


/* === FORBES COMPLAINTS SYSTEM === */
const COMPLAINTS_REVIEWED_CHANNEL_ID = "1527177727919001722";
function complaintIsoNow(){ return new Date().toISOString(); }
function parseComplaintDate(value){
  if(value===null||value===undefined||value==="") return null;
  if(value instanceof Date) return Number.isNaN(value.getTime())?null:value;
  if(typeof value==="number"){ const d=new Date(value); return Number.isNaN(d.getTime())?null:d; }
  const raw=String(value).trim();
  let d=new Date(raw);
  if(!Number.isNaN(d.getTime())) return d;
  // Legacy format produced by now(): dd.mm.yyyy, hh:mm:ss (Kyiv local time).
  const m=raw.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})(?:[,\s]+)(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if(m){
    const [,dd,mm,yyyy,hh,mi,ss="0"]=m;
    d=new Date(Number(yyyy),Number(mm)-1,Number(dd),Number(hh),Number(mi),Number(ss));
    if(!Number.isNaN(d.getTime())) return d;
  }
  return null;
}
function formatComplaintDate(value){
  const d=parseComplaintDate(value);
  return d ? d.toLocaleString("uk-UA",{timeZone:"Europe/Prague",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit"}) : "Невідомо";
}
function complaintRoleId(){ return String("1527167132696313866").trim(); }
function canReviewComplaints(member,req){ return forbes2026Complaints(member,req); }
function ensureComplaintsDb(db){
  db.complaints=Array.isArray(db.complaints)?db.complaints:[];
  db.complaintBackups=Array.isArray(db.complaintBackups)?db.complaintBackups:[];
  return db;
}
function nextComplaintNumber(db){
  const max=(db.complaints||[]).reduce((m,c)=>Math.max(m,Number(String(c.number||"").replace(/\D/g,""))||0),0);
  return `SC-${String(max+1).padStart(4,"0")}`;
}
function complaintDeleteAllowed(c){
  return Boolean(c && c.status === "reviewed");
}

app.get("/api/complaints", protect, async(req,res)=>{
  try{
    const member=await requireFamilyRole(req,res); if(!member)return;
    const db=ensureComplaintsDb(readDb());
    const scope=String(req.query.scope||"reviewed");
    if(scope==="pending" && !canReviewComplaints(member)) return res.status(403).json({ok:false,error:"no_permission",message:"Потрібна роль Адміністратор скарг."});
    let list=db.complaints.filter(c=>scope==="pending"?c.status==="pending":c.status==="reviewed");
    list=list.sort((a,b)=>Date.parse(b.reviewedAt||b.createdAt||0)-Date.parse(a.reviewedAt||a.createdAt||0)).map(c=>({...c,canDelete:complaintDeleteAllowed(c)}));
    res.set("Cache-Control","no-store"); res.json({ok:true,complaints:list});
  }catch(e){res.status(500).json({ok:false,error:"complaints_get_failed",message:e.message});}
});

app.post("/api/complaints", protect, async(req,res)=>{
  try{
    const member=await requireFamilyRole(req,res); if(!member)return;
    const db=ensureComplaintsDb(readDb());
    const item={
      id:id("complaint"),number:nextComplaintNumber(db),status:"pending",
      authorNick:String(req.body.authorNick||member.displayName||req.user?.username||"").trim(),
      authorId:String(req.body.authorId||"").trim(),
      authorDiscordId:String(req.user?.id||req.headers["x-discord-user-id"]||member.id||""),
      targetNick:String(req.body.targetNick||"").trim(),targetId:String(req.body.targetId||"").trim(),
      text:String(req.body.text||"").trim(),evidenceUrl:String(req.body.evidenceUrl||"").trim(),timecode:String(req.body.timecode||"").trim(),createdAt:complaintIsoNow()
    };
    if(!item.authorNick||!item.authorId||!item.targetNick||!item.targetId||!item.text||!item.evidenceUrl)return res.status(400).json({ok:false,error:"required_fields",message:"Заповни всі обов’язкові поля."});
    db.complaints.unshift(item); const wr=typeof writeDbAsync==="function"?await writeDbAsync(db):(writeDb(db),{ok:true});
    if(!wr.ok)return res.status(500).json({ok:false,error:"db_write_failed",message:wr.error});
    res.json({ok:true,complaint:item});
  }catch(e){res.status(500).json({ok:false,error:"complaint_submit_failed",message:e.message});}
});

app.post("/api/complaints/:id/review", protect, async(req,res)=>{
  try{
    const member=await requireFamilyRole(req,res); if(!member)return;
    if(!canReviewComplaints(member))return res.status(403).json({ok:false,error:"no_permission",message:"Потрібна роль Адміністратор скарг."});
    const db=ensureComplaintsDb(readDb()); const c=db.complaints.find(x=>String(x.id)===String(req.params.id));
    if(!c)return res.status(404).json({ok:false,error:"not_found"}); if(c.status!=="pending")return res.status(409).json({ok:false,error:"already_reviewed"});
    const punishment=String(req.body.punishment||"innocent"); const decision=String(req.body.decision||"rejected"); const reason=String(req.body.reason||"").trim(); const amount=Number(req.body.amount||0);
    if(!["innocent","fine","warning"].includes(punishment)||!["approved","rejected"].includes(decision)||!reason)return res.status(400).json({ok:false,error:"bad_review"});
    if(punishment==="fine"&&decision==="approved"&&!amount)return res.status(400).json({ok:false,error:"amount_required"});
    c.status="reviewed";c.punishment=punishment;c.decision=decision;c.reason=reason;c.amount=amount||0;c.reviewedAt=complaintIsoNow();c.reviewedById=member.id;c.reviewedByName=member.displayName||req.user?.username||"Адміністратор";
    let createdPunishment=null;
    if(decision==="approved"&&punishment==="fine"){
      db.fines=Array.isArray(db.fines)?db.fines:[];
      createdPunishment={id:id("fine"),nickname:c.targetNick,staticId:c.targetId,amount,reason,complaintId:c.id,status:"unpaid",createdAt:now(),createdBy:c.reviewedByName}; db.fines.unshift(createdPunishment);
      const ch=await channel(CONFIG.channels.fines); if(ch)await ch.send({embeds:[embed("🚨 Штраф за скаргою",`**Скарга:** ${c.number}\n**Гравець:** ${c.targetNick} | ${c.targetId}\n**Сума:** ${money(amount)}\n**Причина:** ${reason}\n**Видав:** ${c.reviewedByName}`)]});
    }
    if(decision==="approved"&&punishment==="warning"){
      db.warnings=Array.isArray(db.warnings)?db.warnings:[]; const expires=new Date(Date.now()+CONFIG.warnings.days*86400000).toISOString();
      createdPunishment={id:id("warn"),nickname:c.targetNick,staticId:c.targetId,reason,complaintId:c.id,status:"active",expiresAt:expires,createdAt:now(),createdBy:c.reviewedByName}; db.warnings.unshift(createdPunishment);
      const ch=await channel(CONFIG.channels.warnings); if(ch)await ch.send({embeds:[embed("🚫 Догана за скаргою",`**Скарга:** ${c.number}\n**Гравець:** ${c.targetNick} | ${c.targetId}\n**Причина:** ${reason}\n**Видав:** ${c.reviewedByName}`)]});
    }
    const wr=typeof writeDbAsync==="function"?await writeDbAsync(db):(writeDb(db),{ok:true}); if(!wr.ok)return res.status(500).json({ok:false,error:"db_write_failed",message:wr.error});
    const reviewed=await channel(COMPLAINTS_REVIEWED_CHANNEL_ID);
    if(reviewed){
      const outcome=punishment==="fine"?"Гравець отримує штраф.":punishment==="warning"?"Гравець отримує догану.":"Гравець не отримує покарання.";
      const submittedAt = formatComplaintDate(c.createdAt || c.created_at || c.submittedAt || c.submitted_at);
      const closedAt = formatComplaintDate(c.reviewedAt || c.reviewed_at || c.closedAt || c.closed_at);
      await reviewed.send({embeds:[embed(`🔒 Закрита скарга ${c.number}`,`**Статус:** ${decision==="approved"?"Схвалено":"Відмовлено"}\n**Результат:** ${outcome}\n\n**Хто подав:** ${c.authorNick} | ID ${c.authorId}\n**На кого подано:** ${c.targetNick} | ID ${c.targetId}\n**Опис скарги:** ${c.text}\n**Докази:** ${c.evidenceUrl}${c.timecode?`\n**Тайм-код:** ${c.timecode}`:""}\n\n**Висновок адміністратора:** ${reason}${amount?`\n**Сума штрафу:** ${money(amount)}`:""}\n**Скаргу закрив:** ${c.reviewedByName} (<@${c.reviewedById}>)\n**Дата подання:** ${submittedAt}\n**Дата закриття:** ${closedAt}`)]});
    }
    res.json({ok:true,complaint:c,punishment:createdPunishment});
  }catch(e){console.error("complaint review failed",e);res.status(500).json({ok:false,error:"complaint_review_failed",message:e.message});}
});

app.delete("/api/complaints/:id", protect, async(req,res)=>{
  try{
    const member=await requireFamilyRole(req,res);if(!member)return;
    if(!canReviewComplaints(member))return res.status(403).json({ok:false,error:"no_permission"});
    const db=ensureComplaintsDb(readDb());const c=db.complaints.find(x=>String(x.id)===String(req.params.id));
    if(!c)return res.status(404).json({ok:false,error:"not_found"});
    if(c.status!=="reviewed")return res.status(400).json({ok:false,error:"not_reviewed",message:"Видаляти можна лише розглянуті скарги."});
    db.complaints=db.complaints.filter(x=>x!==c);
    const wr=typeof writeDbAsync==="function"?await writeDbAsync(db):(writeDb(db),{ok:true});if(!wr.ok)return res.status(500).json({ok:false,error:"db_write_failed",message:wr.error});
    res.json({ok:true});
  }catch(e){res.status(500).json({ok:false,error:"complaint_delete_failed",message:e.message});}
});


/* === FORBES CENTRAL ROLE MATRIX 2026 === */
const FORBES_ACCESS_ROLE_IDS_2026 = Object.freeze({
  leader2: "1504871859261538425",
  deputy: "1504871693397790871",
  farmManager: "1504871085223706664",
  complaintAdmin: "1527167132696313866",
  seniorCapt: "1504871617543536782"
});
function forbes2026RoleIds(member){
  try{ if(member?.roles?.cache) return Array.from(member.roles.cache.keys()).map(String); if(Array.isArray(member?.roles)) return member.roles.map(r=>String(r?.id||r||"")); }catch(e){} return [];
}
function forbes2026RoleNames(member){
  try{ if(member?.roles?.cache) return Array.from(member.roles.cache.values()).map(r=>String(r?.name||"").toLowerCase()); if(Array.isArray(member?.roles)) return member.roles.map(r=>String(r?.name||r||"").toLowerCase()); }catch(e){} return [];
}
function forbes2026HasId(member, ids){ const have=forbes2026RoleIds(member); return (ids||[]).map(String).some(id=>have.includes(id)); }
function forbes2026HasName(member,names){ const have=forbes2026RoleNames(member); return have.some(r=>names.some(n=>r===String(n).toLowerCase())); }
function forbes2026Main(req){ try{ if(typeof _mainId==='function'&&_mainId(req))return true; if(typeof forbesMainIdFromReq==='function'&&forbesMainIdFromReq(req))return true; }catch(e){} return false; }
function forbes2026Full(member,req){ return forbes2026Main(req)||forbes2026HasId(member,[FORBES_ACCESS_ROLE_IDS_2026.leader2,FORBES_ACCESS_ROLE_IDS_2026.deputy])||forbes2026HasName(member,['лідер','лідер 2','зам лідера']); }
function forbes2026Farm(member,req){ return forbes2026Full(member,req)||forbes2026HasId(member,[FORBES_ACCESS_ROLE_IDS_2026.farmManager])||forbes2026HasName(member,['фарм менеджер','старший каптер']); }
function forbes2026Capt(member,req){ return forbes2026Full(member,req)||forbes2026HasId(member,[FORBES_ACCESS_ROLE_IDS_2026.seniorCapt,CONFIG.roles.seniorCapt])||forbes2026HasName(member,['старший каптер']); }
function forbes2026Discipline(member,req){ return forbes2026Farm(member,req)||forbes2026Capt(member,req); }
function forbes2026Complaints(member,req){ return forbes2026Full(member,req)||forbes2026HasId(member,[FORBES_ACCESS_ROLE_IDS_2026.complaintAdmin])||forbes2026HasName(member,['адміністратор скарг']); }



/* === V26 CHARGE REPORTS / OWNER ITEM CONSTRUCTOR === */
function chargeEnsureDb(db){
  db.chargeItems=Array.isArray(db.chargeItems)?db.chargeItems:[];
  db.chargeReports=Array.isArray(db.chargeReports)?db.chargeReports:[];
  return db;
}
function chargeIsStaff(member,req){
  // Модерація звітів заряду: власник, лідер, лідер 2, зам лідера, старший каптер.
  // Звичайні учасники можуть бачити предмети й подавати звіти, але не модерувати.
  return chargeIsOwnerReq(req)||forbes2026Main(req)||
    forbes2026HasId(member,[CONFIG.roles.leader,FORBES_ACCESS_ROLE_IDS_2026.leader2,FORBES_ACCESS_ROLE_IDS_2026.deputy,FORBES_ACCESS_ROLE_IDS_2026.seniorCapt,CONFIG.roles.seniorCapt])||
    forbes2026HasName(member,['лідер','лідер 2','зам лідера','старший каптер']);
}
function chargeIsOwnerReq(req){ return String(req.user?.id||'')===String(CONFIG.ownerId); }
function chargeCleanItems(items){
  return (Array.isArray(items)?items:[]).map(x=>({
    itemId:String(x.itemId||x.id||''), name:String(x.name||'').trim().slice(0,80), quantity:Math.max(1,Math.min(1000000,Number(x.quantity||0)))
  })).filter(x=>x.itemId&&x.name&&x.quantity>0).slice(0,50);
}
function chargeStatusLabel(s){return ({pending:'🟡 Очікує перевірки',approved:'✅ Одобрено',rejected:'❌ Відхилено',fraud:'⚠️ Обман'})[s]||'🟡 Очікує перевірки';}
async function chargeReportPayload(report){
  // Для звітів заряду спочатку шукаємо по точному серверному ніку, а вже потім по Static ID.
  // Це не дає боту тегнути іншу людину, якщо в старих/тестових даних ID випадково дублювався.
  const giverMember=(await findDiscordMemberForRecord({nickname:report.giverNick}).catch(()=>null))||
    (await findDiscordMemberForRecord({nickname:report.giverNick,staticId:report.giverStaticId}).catch(()=>null));
  const receiverMember=(await findDiscordMemberForRecord({nickname:report.receiverNick}).catch(()=>null))||
    (await findDiscordMemberForRecord({nickname:report.receiverNick,staticId:report.receiverStaticId}).catch(()=>null));
  const giver=giverMember?`<@${giverMember.id}> — ${report.giverNick} | ID ${report.giverStaticId}`:`${report.giverNick} | ID ${report.giverStaticId}`;
  const receiver=receiverMember?`<@${receiverMember.id}> — ${report.receiverNick} | ID ${report.receiverStaticId}`:`${report.receiverNick} | ID ${report.receiverStaticId}`;
  const itemText=(report.items||[]).map(x=>`• **${x.name}:** ${x.quantity}`).join('\n')||'—';
  const e=embed('📦 Звіт заряду FORBES',`**Хто видав:** ${giver}\n**Хто отримав:** ${receiver}\n**Хто подав звіт:** <@${report.submittedByDiscordId}>\n\n**Предмети:**\n${itemText}\n\n**Статус:** ${chargeStatusLabel(report.status)}${report.reviewComment?`\n**Коментар:** ${report.reviewComment}`:''}`);
  const components=report.status==='pending'?[row([
    {id:`charge_approve:${report.id}`,label:'✅ Одобрити',style:ButtonStyle.Success},
    {id:`charge_reject:${report.id}`,label:'❌ Відхилити',style:ButtonStyle.Danger},
    {id:`charge_fraud:${report.id}`,label:'⚠️ Обман',style:ButtonStyle.Secondary}
  ])]:[];
  return {embeds:[e],components};
}

app.get('/api/charge/items/:id/image', async(req,res)=>{
  try{
    const db=chargeEnsureDb(readDb());
    const item=db.chargeItems.find(x=>String(x.id)===String(req.params.id)&&x.active!==false);
    if(!item||!item.imageBucket||!item.imagePath)return res.status(404).end();
    const blob=await downloadMedia(item.imageBucket,item.imagePath);
    const buf=Buffer.from(await blob.arrayBuffer());
    res.set('Content-Type',blob.type||'image/png');
    res.set('Cache-Control','public, max-age=86400, stale-while-revalidate=604800');
    res.set('Cross-Origin-Resource-Policy','cross-origin');
    return res.send(buf);
  }catch(e){
    console.error('charge image load failed',e?.message||e);
    return res.status(404).end();
  }
});

app.get('/api/charge/items', protect, async(req,res)=>{
  // V32: charge items are available to every authenticated guild account.
  // Do not require a separate visible Discord role here: some regular members
  // have access to the panel but were rejected by requireFamilyRole(), so they
  // received an empty items grid.
  const member=await apiMemberOr403(req,res); if(!member)return;
  const db=chargeEnsureDb(readDb());
  const source=db.chargeItems.filter(x=>x.active!==false).sort((a,b)=>(a.order||0)-(b.order||0));
  const forwardedProto=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim();
  const proto=forwardedProto||req.protocol||'https';
  const apiOrigin=`${proto}://${req.get('host')}`;
  const items=source.map(item=>{
    const out={...item};
    // Постійний URL через наш API тільки для фото предметів заряду.
    // Він однаковий для всіх користувачів і не залежить від приватності bucket, кешу чи Supabase-сесії.
    if(item.imageBucket&&item.imagePath){
      const stamp=encodeURIComponent(String(item.updatedAt||item.createdAt||item.id||''));
      out.imageUrl=`${apiOrigin}/api/charge/items/${encodeURIComponent(item.id)}/image?v=${stamp}`;
    }
    return out;
  });
  res.set('Cache-Control','no-store');
  res.json({ok:true,items,canEditItems:chargeIsOwnerReq(req)});
});
app.post('/api/charge/items', protect, ownerOnly, async(req,res)=>{
  try{
    const db=chargeEnsureDb(readDb()); const name=String(req.body.name||'').trim();
    if(!name)return res.status(400).json({ok:false,error:'name_required'});
    const item={id:id('charge_item'),name:name.slice(0,80),imageUrl:String(req.body.imageUrl||''),imageBucket:String(req.body.imageBucket||''),imagePath:String(req.body.imagePath||''),order:Number(req.body.order??db.chargeItems.length),active:true,createdAt:now(),createdBy:String(req.user?.id||'')};
    db.chargeItems.push(item); await writeDbAsync(db); res.json({ok:true,item});
  }catch(e){res.status(500).json({ok:false,error:'charge_item_create_failed',message:e.message});}
});
app.put('/api/charge/items/:id', protect, ownerOnly, async(req,res)=>{
  try{const db=chargeEnsureDb(readDb());const item=db.chargeItems.find(x=>String(x.id)===String(req.params.id));if(!item)return res.status(404).json({ok:false,error:'not_found'});
    if(req.body.name!==undefined)item.name=String(req.body.name||'').trim().slice(0,80);
    ['imageUrl','imageBucket','imagePath'].forEach(k=>{if(req.body[k]!==undefined)item[k]=String(req.body[k]||'');});
    if(req.body.order!==undefined)item.order=Number(req.body.order||0); if(req.body.active!==undefined)item.active=Boolean(req.body.active); item.updatedAt=now();
    await writeDbAsync(db);res.json({ok:true,item});}catch(e){res.status(500).json({ok:false,error:'charge_item_update_failed',message:e.message});}
});
app.delete('/api/charge/items/:id', protect, ownerOnly, async(req,res)=>{
  try{const db=chargeEnsureDb(readDb());const i=db.chargeItems.findIndex(x=>String(x.id)===String(req.params.id));if(i<0)return res.status(404).json({ok:false,error:'not_found'});const [item]=db.chargeItems.splice(i,1);await writeDbAsync(db);if(item.imageBucket&&item.imagePath)deleteMedia(item.imageBucket,item.imagePath).catch(()=>{});res.json({ok:true});}catch(e){res.status(500).json({ok:false,error:'charge_item_delete_failed',message:e.message});}
});
app.post('/api/charge/reports', protect, async(req,res)=>{
  try{const member=await apiMemberOr403(req,res);if(!member)return;const db=chargeEnsureDb(readDb());
    const giverNick=String(req.body.giverNick||'').trim(),giverStaticId=String(req.body.giverStaticId||'').trim(),receiverNick=String(req.body.receiverNick||'').trim(),receiverStaticId=String(req.body.receiverStaticId||'').trim();const items=chargeCleanItems(req.body.items);
    if(!giverNick||!giverStaticId||!receiverNick||!receiverStaticId||!items.length)return res.status(400).json({ok:false,error:'required_fields',message:'Заповни хто видав, хто отримав і вибери хоча б один предмет.'});
    const report={id:id('charge_report'),giverNick,giverStaticId,receiverNick,receiverStaticId,items,status:'pending',submittedByDiscordId:String(req.user?.id||''),submittedByName:member.displayName||member.user?.username||'Учасник',createdAt:now(),createdAtIso:new Date().toISOString()};
    db.chargeReports.unshift(report);await writeDbAsync(db);
    const ch=await channel(CONFIG.channels.chargeReports||'1533952822775779419');if(ch){const msg=await ch.send(await chargeReportPayload(report));report.discordMessageId=msg.id;report.discordChannelId=ch.id;await writeDbAsync(db);}
    res.json({ok:true,report});
  }catch(e){console.error('charge report create failed',e);res.status(500).json({ok:false,error:'charge_report_create_failed',message:e.message});}
});
app.get('/api/charge/reports', protect, async(req,res)=>{
  // V32: shared charge history is visible to every authenticated guild account.
  const member=await apiMemberOr403(req,res);
  if(!member)return;
  const db=chargeEnsureDb(readDb());
  const staff=chargeIsStaff(member,req);
  // Усі учасники сім'ї бачать спільну історію звітів заряду.
  // Раніше звичайним учасникам повертались тільки власні звіти,
  // тому старий звіт іншої людини виглядав як зниклий/порожній.
  res.json({
    ok:true,
    reports:db.chargeReports.slice(0,300),
    canModerate:staff,
    canEditItems:chargeIsOwnerReq(req)
  });
});
app.put('/api/charge/reports/:id', protect, async(req,res)=>{
  try{const member=await requireFamilyRole(req,res);if(!member)return;if(!chargeIsStaff(member,req))return res.status(403).json({ok:false,error:'no_permission'});const db=chargeEnsureDb(readDb());const r=db.chargeReports.find(x=>String(x.id)===String(req.params.id));if(!r)return res.status(404).json({ok:false,error:'not_found'});
    ['giverNick','giverStaticId','receiverNick','receiverStaticId'].forEach(k=>{if(req.body[k]!==undefined)r[k]=String(req.body[k]||'').trim();});if(req.body.items!==undefined)r.items=chargeCleanItems(req.body.items);if(req.body.status!==undefined&&['pending','approved','rejected','fraud'].includes(req.body.status))r.status=req.body.status;if(req.body.reviewComment!==undefined)r.reviewComment=String(req.body.reviewComment||'').slice(0,500);r.reviewedByDiscordId=String(req.user?.id||'');r.reviewedByName=member.displayName||member.user?.username||'';r.reviewedAt=now();await writeDbAsync(db);
    if(r.discordMessageId&&r.discordChannelId){const ch=await channel(r.discordChannelId);const msg=ch?await ch.messages.fetch(r.discordMessageId).catch(()=>null):null;if(msg)await msg.edit(await chargeReportPayload(r)).catch(()=>{});}res.json({ok:true,report:r});
  }catch(e){res.status(500).json({ok:false,error:'charge_report_update_failed',message:e.message});}
});
app.delete('/api/charge/reports/:id', protect, async(req,res)=>{
  try{const member=await requireFamilyRole(req,res);if(!member)return;if(!chargeIsStaff(member,req))return res.status(403).json({ok:false,error:'no_permission'});const db=chargeEnsureDb(readDb());const i=db.chargeReports.findIndex(x=>String(x.id)===String(req.params.id));if(i<0)return res.status(404).json({ok:false,error:'not_found'});const [r]=db.chargeReports.splice(i,1);await writeDbAsync(db);if(r.discordMessageId&&r.discordChannelId){const ch=await channel(r.discordChannelId);const msg=ch?await ch.messages.fetch(r.discordMessageId).catch(()=>null):null;if(msg)await msg.delete().catch(()=>{});}res.json({ok:true});
  }catch(e){res.status(500).json({ok:false,error:'charge_report_delete_failed',message:e.message});}
});
client.on('interactionCreate',async interaction=>{
  if(!interaction.isButton()||!String(interaction.customId).startsWith('charge_'))return;
  try{
    await deferReviewButton(interaction);
    const [action,reportId]=interaction.customId.split(':');
    const member=await interactionMember(interaction);
    if(!(String(interaction.user.id)===String(CONFIG.ownerId)||chargeIsStaff(member,null)))return denyNoPerm(interaction,'❌ Цю дію можуть виконувати тільки старший каптер, зам лідера, лідер 2, лідер або власник.');
    const map={charge_approve:'approved',charge_reject:'rejected',charge_fraud:'fraud'};
    const status=map[action];if(!status)return;
    const db=chargeEnsureDb(readDb());
    const r=db.chargeReports.find(x=>String(x.id)===String(reportId));
    if(!r)return reviewButtonError(interaction,'❌ Звіт не знайдено.');
    if(r.status && r.status!=='pending')return reviewButtonError(interaction,`ℹ️ Звіт уже оброблено: ${chargeStatusLabel(r.status)}`);
    r.status=status;r.reviewedByDiscordId=interaction.user.id;r.reviewedByName=member.displayName||interaction.user.username;r.reviewedAt=now();
    await writeDbAsync(db);
    await finishReviewButton(interaction,await chargeReportPayload(r));
  }catch(e){
    console.error('charge button failed',interaction.customId,e);
    await reviewButtonError(interaction,'❌ Помилка обробки кнопки звіту. Спробуйте ще раз.');
  }
});

app.listen(PORT, ()=>{
  console.log(`✅ API running on port ${PORT}`);
});

initDb()
  .then(async()=>{console.log("✅ DB initialized"); try{const m=await ensureMediaSystem(); (m.logs||[]).forEach(x=>console.log("✅ "+x)); console.log("✅ FORBES media system ready");}catch(e){console.error("⚠️ Media init failed:",e.message);}})
  .catch(e=>console.error("⚠️ DB init failed, continuing:", e?.message || e))
  .finally(()=>{
    if(!process.env.DISCORD_BOT_TOKEN){
      console.error("❌ DISCORD_BOT_TOKEN is missing");
    }else{
      client.login(process.env.DISCORD_BOT_TOKEN).catch(e=>console.error("❌ Discord login failed:", e));
    }
  });


function canManageComplaints(member,req){ return forbes2026Complaints(member,req); }

function isComplaintAdmin(member,req){ return forbes2026Complaints(member,req); }

/* V16 auth diagnostic: signed tokens have no expiry */
app.get('/api/auth/status', protect, (req,res)=>res.json({ok:true,authenticated:true,userId:String(req.user?.id||''),tokenExpiry:null,serverTime:new Date().toISOString()}));
