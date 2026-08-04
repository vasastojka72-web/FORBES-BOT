const COMPLAINT_ADMIN_ROLE_ID='1527167132696313866';
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL || "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
export const mediaSupabase = URL && KEY ? createClient(URL, KEY, {auth:{persistSession:false}}) : null;
export const IMAGE_BUCKET = process.env.SUPABASE_IMAGES_BUCKET || "forbes-images";
export const MUSIC_BUCKET = process.env.SUPABASE_MUSIC_BUCKET || "forbes-music";

const IMAGE_MIMES = ["image/jpeg","image/png","image/webp","image/gif","image/avif"];
const MUSIC_MIMES = ["audio/mpeg","audio/mp3","audio/ogg","audio/wav","audio/x-wav","audio/mp4","audio/m4a","audio/x-m4a"];
const KIND_MAP = {
  car:{bucket:IMAGE_BUCKET,folder:"cars",mimes:IMAGE_MIMES,max:15*1024*1024},
  estate:{bucket:IMAGE_BUCKET,folder:"estate",mimes:IMAGE_MIMES,max:10*1024*1024},
  office:{bucket:IMAGE_BUCKET,folder:"office",mimes:IMAGE_MIMES,max:10*1024*1024},
  gallery:{bucket:IMAGE_BUCKET,folder:"gallery",mimes:IMAGE_MIMES,max:10*1024*1024},
  family:{bucket:IMAGE_BUCKET,folder:"family",mimes:IMAGE_MIMES,max:10*1024*1024},
  leadership:{bucket:IMAGE_BUCKET,folder:"leadership",mimes:IMAGE_MIMES,max:10*1024*1024},
  history:{bucket:IMAGE_BUCKET,folder:"history",mimes:IMAGE_MIMES,max:10*1024*1024},
  charge:{bucket:IMAGE_BUCKET,folder:"charge-items",mimes:IMAGE_MIMES,max:10*1024*1024},
  cover:{bucket:MUSIC_BUCKET,folder:"covers",mimes:IMAGE_MIMES,max:10*1024*1024},
  track:{bucket:MUSIC_BUCKET,folder:"tracks",mimes:MUSIC_MIMES,max:25*1024*1024}
};
function safeName(v){return String(v||"file").normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g,"_").replace(/^_+|_+$/g,"").slice(-120)||"file";}
function extFor(mime,name){const ext=String(name||"").split(".").pop(); if(ext && ext!==name) return ext.toLowerCase(); return ({"image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif","audio/mpeg":"mp3","audio/ogg":"ogg","audio/wav":"wav","audio/x-wav":"wav","audio/mp4":"m4a","audio/m4a":"m4a","audio/x-m4a":"m4a"})[mime]||"bin";}
export function mediaConfigured(){return Boolean(mediaSupabase);}
export async function ensureMediaSystem(){
  if(!mediaSupabase) return {ok:false,error:"SUPABASE_URL або SUPABASE_SERVICE_ROLE_KEY відсутні"};
  const logs=[];
  for(const [name,opts] of [[IMAGE_BUCKET,{public:true,fileSizeLimit:15*1024*1024,allowedMimeTypes:IMAGE_MIMES}],[MUSIC_BUCKET,{public:true,fileSizeLimit:25*1024*1024,allowedMimeTypes:[...MUSIC_MIMES,...IMAGE_MIMES]}]]){
    const {data,error}=await mediaSupabase.storage.listBuckets();
    if(error) throw error;
    const exists=(data||[]).some(b=>b.name===name);
    if(!exists){const {error:e}=await mediaSupabase.storage.createBucket(name,opts); if(e) throw e; logs.push(`Bucket ${name} created`);} else {const {error:e}=await mediaSupabase.storage.updateBucket(name,opts); if(e) logs.push(`Bucket ${name} exists (settings unchanged: ${e.message})`); else logs.push(`Bucket ${name} updated`);}
  }
  logs.push("Storage folders ready");
  return {ok:true,logs,buckets:[IMAGE_BUCKET,MUSIC_BUCKET]};
}
export async function uploadBase64Media(kind,file){
  if(!mediaSupabase) throw new Error("Supabase Storage не налаштований");
  const rule=KIND_MAP[kind]; if(!rule) throw new Error("Невідомий тип файлу");
  const mime=String(file?.type||"").toLowerCase(); if(!rule.mimes.includes(mime)) throw new Error(`Формат ${mime||"невідомий"} заборонений`);
  const buf=Buffer.from(String(file?.data||""),"base64"); if(!buf.length) throw new Error("Файл порожній"); if(buf.length>rule.max) throw new Error(`Файл завеликий: максимум ${Math.round(rule.max/1024/1024)} MB`);
  const ext=extFor(mime,file?.name); const base=safeName(String(file?.name||"file").replace(/\.[^.]+$/, ""));
  const path=`${rule.folder}/${Date.now()}_${Math.random().toString(36).slice(2,8)}_${base}.${ext}`;
  const {error}=await mediaSupabase.storage.from(rule.bucket).upload(path,buf,{contentType:mime,upsert:false,cacheControl:"3600"}); if(error) throw error;
  const {data}=mediaSupabase.storage.from(rule.bucket).getPublicUrl(path);
  return {bucket:rule.bucket,path,publicUrl:data.publicUrl,name:file.name||`${base}.${ext}`,mimeType:mime,size:buf.length,kind};
}

export function getMediaPublicUrl(bucket,path){
  if(!mediaSupabase||!bucket||!path) return "";
  const {data}=mediaSupabase.storage.from(bucket).getPublicUrl(path);
  return data?.publicUrl||"";
}

export async function createMediaSignedUrl(bucket,path,expiresIn=3600){
  if(!mediaSupabase||!bucket||!path) return "";
  const {data,error}=await mediaSupabase.storage.from(bucket).createSignedUrl(path,expiresIn);
  if(error) throw error;
  return data?.signedUrl||"";
}


export async function downloadMedia(bucket,path){
  if(!mediaSupabase||!bucket||!path) throw new Error("Supabase Storage не налаштований");
  const {data,error}=await mediaSupabase.storage.from(bucket).download(path);
  if(error) throw error;
  return data;
}

export async function deleteMedia(bucket,path){if(!mediaSupabase||!bucket||!path)return; const {error}=await mediaSupabase.storage.from(bucket).remove([path]); if(error) throw error;}
export const MEDIA_PATHS={car:`${IMAGE_BUCKET}/cars`,estate:`${IMAGE_BUCKET}/estate`,office:`${IMAGE_BUCKET}/office`,gallery:`${IMAGE_BUCKET}/gallery`,family:`${IMAGE_BUCKET}/family`,leadership:`${IMAGE_BUCKET}/leadership`,history:`${IMAGE_BUCKET}/history`,charge:`${IMAGE_BUCKET}/charge-items`,track:`${MUSIC_BUCKET}/tracks`,cover:`${MUSIC_BUCKET}/covers`};
