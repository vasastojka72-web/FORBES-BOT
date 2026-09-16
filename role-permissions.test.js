import assert from "node:assert/strict";
import { CONFIG } from "./config.js";
import { hasPermission } from "./role-permissions.js";
import { parseForbesNickname } from "./nickname-parser.js";

const member=role=>({roles:[role]});
assert.equal(hasPermission(member(CONFIG.roles.headCapt),"ISSUE_FINE"),true);
assert.equal(hasPermission(member(CONFIG.roles.headCapt),"ISSUE_WARNING"),true);
assert.equal(hasPermission(member(CONFIG.roles.depHeadCapt),"ISSUE_FINE"),true);
assert.equal(hasPermission(member(CONFIG.roles.depHeadCapt),"CAPT_MANAGE"),true);
assert.equal(hasPermission(member(CONFIG.roles.depHeadCapt),"ISSUE_WARNING"),false);
assert.equal(hasPermission(member(CONFIG.roles.farmManager),"ISSUE_FINE"),true);
assert.equal(hasPermission(member(CONFIG.roles.farmManager),"ISSUE_WARNING"),true);
for(const role of [CONFIG.roles.capper,CONFIG.roles.farmer,CONFIG.roles.buyout,CONFIG.roles.debtor]){
  assert.equal(hasPermission(member(role),"ISSUE_FINE"),false);
  assert.equal(hasPermission(member(role),"ISSUE_WARNING"),false);
}
assert.deepEqual(parseForbesNickname("REV Aura Forbes"),{nick:"Aura",staticId:""});
assert.deepEqual(parseForbesNickname("Rec | Aura Forbes | 28184"),{nick:"Aura",staticId:"28184"});
assert.deepEqual(parseForbesNickname("CPT | Maksim_Hunter | 19962"),{nick:"Maksim_Hunter",staticId:"19962"});
assert.deepEqual(parseForbesNickname("Head Cpt | Aura Forbes | 28184"),{nick:"Aura",staticId:"28184"});
assert.deepEqual(parseForbesNickname("Head Cpt Aura Forbes | 28184"),{nick:"Aura",staticId:"28184"});
for(const prefix of ["ADM","Rec","farm","cpt","Head Cpt","head cpt","dep cpt","farm manager"]){
  assert.deepEqual(parseForbesNickname(`${prefix} Aura Forbes`),{nick:"Aura",staticId:""});
}
console.log("role permissions and nickname parser: OK");
