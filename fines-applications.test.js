import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {applicationNeedsKick, applicationKind, isJoinApplication, kickApplicationAuthor} from './application-policy.js';
import {isOriginalFine, fineBelongsToMember, myPayableFines, validateFinePayment} from './fine-payments.js';
import {compactResolvedDiscipline} from './discipline-stats.js';

const actor={id:'111111111111111111',displayName:'farm | Alex Forbes | 123'};
const other='222222222222222222';
const fine=()=>({id:'fine_1',displayNumber:'FINE-0001',discordUserId:actor.id,nickname:'Alex Forbes',staticId:'123',amount:50000,reason:'Пропуск збору',status:'unpaid'});
const source=fs.readFileSync(new URL('./index.js',import.meta.url),'utf8');

test('kick allowlist: only rejected join applications and approved dismissal',()=>{
  for(const type of ['В сім’ю',"В сім'ю",'У фарм','У капт','family','farm','capt']){
    assert.equal(applicationNeedsKick({type},'app_reject'),true,type);
    assert.equal(applicationNeedsKick({type},'app_approve'),false,type);
  }
  for(const type of ['Увал','Звільнення','dismissal']){
    assert.equal(applicationNeedsKick({type},'app_approve'),true,type);
    assert.equal(applicationNeedsKick({type},'app_reject'),false,type);
  }
  for(const type of ['Відпустка','vacation','День народження','birthday','Фарм-звіт','Капт-звіт','Звіт заряду','Оплата штрафу','unknown','',null]){
    for(const action of ['app_approve','app_reject'])assert.equal(applicationNeedsKick({type},action),false,`${type}/${action}`);
  }
  for(const type of ['У фарм','У капт','Увал','В сім’ю']){
    for(const action of ['farm_approve','farm_reject','finepay_approve','finepay_reject','warnpay_approve','warnpay_reject','charge_reject','capt_reject'])assert.equal(applicationNeedsKick({type},action),false);
  }
});

test('kick uses author ID, handles absence, permission errors and duplicate calls',async()=>{
  let kicks=0,fetches=0;
  const app={id:'app_1',type:'У фарм',discordUserId:actor.id};
  const guild={members:{fetch:async request=>{fetches++;assert.equal(request.user,actor.id);return {kickable:true,kick:async()=>{kicks++;}};}}};
  assert.equal((await kickApplicationAuthor({...app,type:'Відпустка'},'app_reject',guild,other)).status,'not_required');
  assert.equal(fetches,0);
  app.kickResult=await kickApplicationAuthor(app,'app_reject',guild,other);
  await kickApplicationAuthor(app,'app_reject',guild,other);
  assert.equal(kicks,1);
  delete app.kickResult;
  guild.members.fetch=async()=>({kickable:false});
  assert.equal((await kickApplicationAuthor(app,'app_reject',guild,other)).status,'failed');
  guild.members.fetch=async()=>{throw Object.assign(new Error('Unknown Member'),{code:10007});};
  assert.equal((await kickApplicationAuthor(app,'app_reject',guild,other)).status,'already_absent');
  guild.members.fetch=async()=>{throw new Error('network');};
  assert.equal((await kickApplicationAuthor(app,'app_reject',guild,other)).status,'failed');
});

test('own fine resolution prioritizes Discord/central ID, never nickname alone',()=>{
  assert.equal(fineBelongsToMember(fine(),actor),true);
  assert.equal(fineBelongsToMember({...fine(),discordUserId:other},actor),false);
  const legacy={...fine(),discordUserId:''};
  assert.equal(fineBelongsToMember(legacy,actor),true);
  assert.equal(fineBelongsToMember({...legacy,staticId:'456'},actor),false);
  assert.equal(fineBelongsToMember({...legacy,staticId:''},actor),false);
  const linked={...legacy,targetMemberId:'member_1'};
  assert.equal(fineBelongsToMember(linked,actor,[{memberId:'member_1',discordUserId:actor.id}]),true);
  assert.equal(fineBelongsToMember(linked,actor,[{memberId:'member_1',discordUserId:other}]),false);
  assert.equal(fineBelongsToMember({...fine(),fineId:'fine_0'},actor),false);
});

test('my list separates review state and hides paid, foreign and payment records',()=>{
  const db={fines:[fine(),{...fine(),id:'b',status:'paid'},{...fine(),id:'c',discordUserId:other},{...fine(),id:'d',status:'payment_pending'},{id:'p',fineId:'fine_1',status:'pending'}]};
  const mine=myPayableFines(db,actor);
  assert.deepEqual(mine.map(f=>f.id),['fine_1','d']);
  assert.ok(mine.every(f=>f.status==='payment_pending'));
  assert.equal(validateFinePayment(db,db.fines[0],actor).status,409);
});

function routeHarness({sendFailure=false,saveFailure=false}={}){
  const db={fines:[fine()],members:[]}, routes={}, sent=[];
  const context={console:{error(){}},app:{post:(path,...handlers)=>routes[path]=handlers.at(-1)},protect(){},requireLauncherSession(){},requireFamilyRole:async()=>actor,
    screenshotAttachment:body=>body.screenshotData?{attachment:Buffer.from('proof'),name:'proof.png'}:null,
    channel:async()=>({send:async payload=>{if(sendFailure)throw Error('Discord down');sent.push(payload);return {id:'message_1'};}}),
    CONFIG:{channels:{finePayments:'channel'}},readDb:()=>db,findByPublicOrInternalId:(list,id)=>list.find(x=>x.id===id||x.displayNumber===id),
    isOriginalFine,validateFinePayment,nextSimpleId:()=>`payment_${db.fines.length}`,findCentralMember:()=>null,
    now:()=>new Date().toISOString(),writeDbAsync:async()=>({ok:!saveFailure}),embed:(title,description)=>({title,description}),row:x=>x,ButtonStyle:{Success:1,Danger:2},money:x=>`${x}$`};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('app.post("/api/fine-payments",'),source.indexOf('app.post("/api/warnings",')),context);
  return {db,sent,async submit(body={}){const res={statusCode:200,status(code){this.statusCode=code;return this;},json(data){this.data=data;return this;}};await routes['/api/fine-payments']({body:{fineId:'fine_1',screenshotData:'proof',...body}},res);return res;}};
}

test('payment endpoint derives identity/amount, blocks forged ownership and duplicate submissions',async()=>{
  const h=routeHarness();
  const response=await h.submit({nickname:'Wrong',staticId:'999',discordUserId:other,amount:1});
  assert.equal(response.statusCode,200);
  assert.equal(response.data.payment.nickname,'Alex Forbes');
  assert.equal(response.data.payment.discordUserId,actor.id);
  assert.equal(response.data.payment.amount,50000);
  assert.equal(h.db.fines.find(isOriginalFine).status,'payment_pending');
  assert.equal((await h.submit()).statusCode,409);
  assert.equal(h.sent.length,1);
  const foreign=routeHarness();foreign.db.fines[0].discordUserId=other;
  assert.equal((await foreign.submit({discordUserId:actor.id})).statusCode,403);
  assert.equal(foreign.sent.length,0);
});

test('payment endpoint requires proof and allows retry after delivery failure',async()=>{
  const h=routeHarness();assert.equal((await h.submit({screenshotData:''})).statusCode,400);
  assert.equal(h.db.fines.length,1);
  const failed=routeHarness({sendFailure:true});assert.equal((await failed.submit()).statusCode,502);
  assert.equal(failed.db.fines.find(isOriginalFine).status,'unpaid');
  assert.equal(validateFinePayment(failed.db,failed.db.fines.find(isOriginalFine),actor),null);
  const unsaved=routeHarness({saveFailure:true});assert.equal((await unsaved.submit()).statusCode,503);assert.equal(unsaved.sent.length,0);
});

test('simultaneous payment submissions reserve the fine only once',async()=>{
  const h=routeHarness();const results=await Promise.all([h.submit(),h.submit()]);
  assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);assert.equal(h.sent.length,1);
});

function reviewHarness({type='У фарм',permission=true,saveOk=true}={}){
  const db={applications:[{id:'app_1',type,status:'pending',discordUserId:actor.id}]};
  const events=[];
  const ctx={readDb:()=>db,applicationKind,isJoinApplication,applicationNeedsKick,kickApplicationAuthor,
    hasPermission:()=>permission,canModerateApplications:()=>permission,now:()=>new Date().toISOString(),
    writeDbAsync:async()=>{events.push('save');return {ok:saveOk};},applyApplicationApprove:async()=>{events.push('role');return {ok:true,nickname:'Alex'};},
    client:{guilds:{fetch:async()=>({members:{fetch:async()=>({kickable:true,kick:async()=>events.push('kick')})}})}},CONFIG:{guildId:'guild'},
    addUserNotification(){},finishReviewButton:async(_,payload)=>payload,reviewButtonError:async(_,content)=>({content}),denyNoPerm:async(_,content)=>({content})};
  vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('const applicationReviewsInFlight'),source.indexOf('client.on("interactionCreate", async interaction=>{')),ctx);
  const interaction={user:{id:other},message:{embeds:[]}};
  return {db,events,review:action=>ctx.reviewApplicationDecision(interaction,{},action,'app_1')};
}

test('application handler saves before kick, rejects repeat clicks, respects permission/storage failures',async()=>{
  const h=reviewHarness();await Promise.all([h.review('app_reject'),h.review('app_reject')]);
  assert.equal(h.events.filter(x=>x==='kick').length,1);assert.ok(h.events.indexOf('save')<h.events.indexOf('kick'));
  await h.review('app_reject');assert.equal(h.events.filter(x=>x==='kick').length,1);
  for(const options of [{permission:false},{saveOk:false}]){const blocked=reviewHarness(options);await blocked.review('app_reject');assert.equal(blocked.events.includes('kick'),false);assert.equal(blocked.db.applications[0].status,'pending');}
});

test('vacation does not grant roles or kick; dismissal only kicks on approval',async()=>{
  for(const type of ['Відпустка','vacation','Капт-звіт','Звіт заряду'])for(const action of ['app_approve','app_reject']){
    const h=reviewHarness({type});await h.review(action);assert.equal(h.events.includes('kick'),false);assert.equal(h.events.includes('role'),false);
  }
  const approved=reviewHarness({type:'Увал'});await approved.review('app_approve');assert.equal(approved.events.includes('kick'),true);assert.equal(approved.events.includes('role'),false);
  const rejected=reviewHarness({type:'Увал'});await rejected.review('app_reject');assert.equal(rejected.events.includes('kick'),false);
});

test('kick execution is referenced only in the application helper',()=>{
  assert.equal((source.match(/await kickApplicationAuthor\(/g)||[]).length,1);
  assert.ok(source.includes('return await reviewApplicationDecision(interaction,member,action,itemId)'));
});

test('payment rejection reopens the original; approval removes it from payable fines',async()=>{
  const start=source.indexOf('    // ОПЛАТА ШТРАФУ: тільки');
  const end=source.indexOf('\n  }catch(err){',start);
  for(const action of ['finepay_reject','finepay_approve']){
    const h=routeHarness();const submitted=await h.submit();
    const ctx={db:h.db,action,itemId:submitted.data.payment.id,member:{},interaction:{user:{id:other},message:{embeds:[]}},
      canModerateWarningsAndFines:()=>true,reviewButtonError:async(_,text)=>{throw Error(text);},isOriginalFine,
      now:()=>new Date().toISOString(),addUserNotification(){},compactResolvedDiscipline,writeDbAsync:async()=>({ok:true}),
      channel:async()=>null,CONFIG:{channels:{fines:'fines'}},finishReviewButton:async()=>{},money:x=>x};
    vm.createContext(ctx);vm.runInContext('async function reviewPayment(){'+source.slice(start,end)+'}',ctx);
    await ctx.reviewPayment();
    if(action==='finepay_reject'){
      assert.equal(myPayableFines(h.db,actor)[0].status,'unpaid');
      assert.equal((await h.submit()).statusCode,200);
    }else{
      assert.equal(myPayableFines(h.db,actor).length,0);
      assert.equal((await h.submit()).statusCode,404);
    }
  }
});
