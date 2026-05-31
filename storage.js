import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const DB_FILE = path.join(process.cwd(), "db.json");

const DEFAULT_DB = {
  contracts: [],
  applications: [],
  farmReports: [],
  farmReportsArchive: [],
  capts: [],
  captLists: [],
  fines: [],
  warnings: [],
  blacklist: [],
  blacklistRemoved: [],
  announcements: [],
  giveaways: [],
  logs: []
};

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_DB_KEY = process.env.SUPABASE_DB_KEY || "forbes_main";

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

function normalizeDb(data){
  return {...DEFAULT_DB, ...(data || {})};
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
    supabase
      .from("forbes_db")
      .upsert({ id: SUPABASE_DB_KEY, data: memoryDb, updated_at: new Date().toISOString() })
      .then(({ error }) => {
        if(error) console.error("⚠️ Supabase write failed:", error.message || error);
      })
      .catch(e => console.error("⚠️ Supabase write failed:", e?.message || e));
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
