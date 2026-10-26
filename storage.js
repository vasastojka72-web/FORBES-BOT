const COMPLAINT_ADMIN_ROLE_ID='1527167132696313866';
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const DB_FILE = path.join(process.cwd(), "db.json");

const DEFAULT_DB = {
  contracts: [],
  cars: [],
  familyInfo: {},
  siteSettings: {},
  applications: [],
  birthdays: [],
  birthdayAnnouncements: [],
  farmReports: [],
  farmReportsArchive: [],
  capts: [],
  captLists: [],
  fines: [],
  warnings: [],
  blacklist: [],
  blacklistRemoved: [],
  announcements: [],
  notifications: [],
  notificationPreferences: {},
  announcementReads: {},
  captReminderDeliveries: {},
  giveaways: [],
  logs: [],
  discordQueue: [],
  securityLogs: [],
  members: [],
  musicTracks: [],
  gallery: [],
  galleryAlbums: [],
  estate: {title:"Фото маєтку",description:"",photos:[]},
  office: {title:"Офіс",description:"",photos:[]},
  familyHistory: {title:"Історія сім\u2019ї",text:"",photos:[]},
  leadership: [],
  mediaBackups: [],
  warningPayments: [],
  mediaSchemaVersion: 1
};

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_DB_KEY = process.env.SUPABASE_DB_KEY || "forbes_main";

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

function stripHeavyData(db){
  try{
    const copy = {...db};
    const stripObj = (obj) => {
      if(!obj || typeof obj !== "object") return obj;
      const blocked = ["screenshotData","imageData","photoData","fileData","attachmentData","housePhotoData","officePhotoData","galleryPhotoData"];
      const out = {...obj};
      blocked.forEach(k=>{
        if(out[k]){
          delete out[k];
          out.heavyDataRemoved = true;
        }
      });
      return out;
    };
    copy.farmReports = Array.isArray(copy.farmReports) ? copy.farmReports.map(stripObj) : [];
    copy.applications = Array.isArray(copy.applications) ? copy.applications.map(stripObj) : [];
    copy.cars = Array.isArray(copy.cars) ? copy.cars.map(stripObj) : [];
    copy.gallery = Array.isArray(copy.gallery) ? copy.gallery.map(stripObj) : [];
    copy.familyInfo = stripObj(copy.familyInfo || {});
    copy.discordQueue = Array.isArray(copy.discordQueue) ? copy.discordQueue.map(clean) : [];
    return copy;
  }catch(e){ return db; }
}
function normalizeDb(data){
  return stripHeavyData({...DEFAULT_DB, ...(data || {})});
}

function memberRows(db){
  return (Array.isArray(db?.members)?db.members:[]).map(member=>({
    member_id:String(member.memberId||member.member_id||member.id||""),
    game_nickname:String(member.gameNickname||member.game_nickname||member.nickname||member.nick||""),
    game_id:String(member.gameId||member.game_id||member.staticId||member.playerId||"")||null,
    discord_user_id:String(member.discordUserId||member.discord_user_id||member.discordId||member.userId||"")||null,
    active:member.active!==false,
    created_at:member.createdAt||member.created_at||new Date().toISOString(),
    updated_at:new Date().toISOString()
  })).filter(row=>row.member_id);
}
function memberFromRow(row){
  return {memberId:String(row.member_id),gameNickname:String(row.game_nickname||""),gameId:String(row.game_id||""),discordUserId:String(row.discord_user_id||""),active:row.active!==false,createdAt:row.created_at||new Date().toISOString(),updatedAt:row.updated_at||new Date().toISOString()};
}
async function syncMemberRows(db){
  if(!supabase)return {ok:true,mode:"local"};
  const rows=memberRows(db);
  if(!rows.length)return {ok:true,mode:"supabase",members:0};
  const {error}=await supabase.from("forbes_members").upsert(rows,{onConflict:"member_id"});
  if(error)throw error;
  return {ok:true,mode:"supabase",members:rows.length};
}

function localRead(){
  try {
    if(!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
      return {...DEFAULT_DB};
    }
    return normalizeDb(JSON.parse(fs.readFileSync(DB_FILE, "utf8")));
  } catch(e) {
    console.error("localRead db error:", e);
    return {...DEFAULT_DB};
  }
}

function localWrite(data){
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(normalizeDb(data), null, 2));
  } catch(e) {
    console.error("localWrite db error:", e);
  }
}

// ВАЖЛИВО:
// readDb/writeDb лишаються синхронними, щоб не ламати старий код.
// Якщо Supabase увімкнений, база підтягується в локальний кеш при старті і кожен writeDb пише в Supabase у фоні.
let memoryDb = localRead();
let supabaseWriteQueue=Promise.resolve();

function queueSupabaseWrite(data){
  if(!supabase)return Promise.resolve({ok:true,mode:"local"});
  const snapshot=normalizeDb(JSON.parse(JSON.stringify(data)));
  const operation=supabaseWriteQueue.then(async()=>{
    const {error}=await supabase
      .from("forbes_db")
      .upsert({id:SUPABASE_DB_KEY,data:snapshot,updated_at:new Date().toISOString()});
    if(error)throw error;
    await syncMemberRows(snapshot);
    return {ok:true,mode:"supabase"};
  });
  supabaseWriteQueue=operation.catch(()=>{});
  return operation;
}

export async function initDb(){
  if(!supabase){
    console.log("ℹ️ Supabase disabled. Using local db.json only.");
    return memoryDb;
  }

  try {
    const { data, error } = await supabase
      .from("forbes_db")
      .select("data")
      .eq("id", SUPABASE_DB_KEY)
      .maybeSingle();

    if(error) throw error;

    if(data && data.data){
      memoryDb = normalizeDb(data.data);
      localWrite(memoryDb);
      console.log("✅ Supabase DB loaded.");
    } else {
      const { error: upsertError } = await supabase
        .from("forbes_db")
        .upsert({ id: SUPABASE_DB_KEY, data: memoryDb, updated_at: new Date().toISOString() });
      if(upsertError) throw upsertError;
      console.log("✅ Supabase DB created.");
    }
    const {data:memberData,error:memberError}=await supabase.from("forbes_members").select("member_id,game_nickname,game_id,discord_user_id,active,created_at,updated_at");
    if(memberError)console.warn("⚠️ forbes_members table unavailable; compatibility registry remains active:",memberError.message||memberError);
    else if(Array.isArray(memberData)&&memberData.length){const existing=Array.isArray(memoryDb.members)?memoryDb.members:[];memoryDb.members=memberData.map(row=>{const core=memberFromRow(row);const old=existing.find(x=>String(x.memberId||x.member_id||x.id||"")===core.memberId||String(x.discordUserId||x.discord_user_id||"")===core.discordUserId);return {...(old||{}),...core};});localWrite(memoryDb);}
  } catch(e) {
    console.error("⚠️ Supabase init failed, using local db.json:", e?.message || e);
  }

  return memoryDb;
}

export function readDb(){
  return normalizeDb(memoryDb);
}

export function writeDb(data){
  memoryDb = normalizeDb(data);
  localWrite(memoryDb);

  if(supabase){
    queueSupabaseWrite(memoryDb).catch(e=>console.error("⚠️ Supabase write failed:",e?.message||e));
  }
}


export async function writeDbAsync(data){
  memoryDb = normalizeDb(data);
  localWrite(memoryDb);

  if(!supabase) return {ok:true,mode:"local"};

  try{
    return await queueSupabaseWrite(memoryDb);
  }catch(e){
    console.error("⚠️ Supabase awaited write failed:", e?.message || e);
    return {ok:false,mode:"supabase",error:e?.message || String(e)};
  }
}

export function id(prefix="id"){
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2,8)}`;
}

export function getDbInfo(){
  return {
    supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
    supabaseDbKey: SUPABASE_DB_KEY,
    localDbFile: DB_FILE
  };
}
