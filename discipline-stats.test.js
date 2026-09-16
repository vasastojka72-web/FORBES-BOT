import assert from "node:assert/strict";
import { compactResolvedDiscipline, disciplineCounters } from "./discipline-stats.js";

const db={fines:[{id:"f1",nickname:"Aura",staticId:"28184",status:"unpaid",reason:"keep"},{id:"f2",nickname:"Aura",staticId:"28184",status:"paid",reason:"remove"}],warnings:[{id:"w1",nickname:"Aura",staticId:"28184",status:"active"},{id:"w2",nickname:"Aura",staticId:"28184",status:"removed"}]};
compactResolvedDiscipline(db);
assert.deepEqual(db.fines.map(x=>x.id),["f1"]);
assert.deepEqual(db.warnings.map(x=>x.id),["w1"]);
assert.deepEqual(disciplineCounters(db,"Aura","28184"),{paidFines:1,removedWarnings:1});
compactResolvedDiscipline(db);
assert.deepEqual(disciplineCounters(db,"Aura","28184"),{paidFines:1,removedWarnings:1});
console.log("discipline compaction: OK");
