import { CONFIG } from "./config.js";

export const PERMISSIONS = Object.freeze({
  FULL_ADMIN: [CONFIG.roles.boss, CONFIG.roles.leader2, CONFIG.roles.deputy],
  CAPT_MANAGE: [CONFIG.roles.boss, CONFIG.roles.leader2, CONFIG.roles.deputy, CONFIG.roles.headCapt, CONFIG.roles.depHeadCapt],
  ISSUE_FINE: [CONFIG.roles.boss, CONFIG.roles.leader2, CONFIG.roles.deputy, CONFIG.roles.headCapt, CONFIG.roles.depHeadCapt, CONFIG.roles.farmManager],
  ISSUE_WARNING: [CONFIG.roles.boss, CONFIG.roles.leader2, CONFIG.roles.deputy, CONFIG.roles.headCapt, CONFIG.roles.farmManager],
  FARM_MANAGE: [CONFIG.roles.boss, CONFIG.roles.leader2, CONFIG.roles.deputy, CONFIG.roles.farmManager]
});

export function roleIdsOf(member){
  if(member?.roles?.cache) return [...member.roles.cache.keys()].map(String);
  if(Array.isArray(member?.roles)) return member.roles.map(role=>String(role?.id||role||""));
  return [];
}

export function hasPermission(member, permission){
  const held=new Set(roleIdsOf(member));
  return (PERMISSIONS[permission]||[]).some(id=>held.has(String(id)));
}
