import assert from "node:assert/strict";
import { applySalaryLifetimeStats, lifetimeContractCount } from "./lifetime-stats.js";

const db={};
assert.equal(applySalaryLifetimeStats(db,[{player:"Rec Aura Forbes | 28184",contracts:8}],"week-1","2026-09-01"),true);
assert.equal(applySalaryLifetimeStats(db,[{player:"Aura | 28184",contracts:8}],"week-1","2026-09-01"),false);
assert.equal(applySalaryLifetimeStats(db,[{player:"Aura | 28184",contracts:5}],"week-2","2026-09-08"),true);
assert.equal(lifetimeContractCount(db,"Aura","28184"),13);
assert.equal(Object.keys(db.memberLifetimeStats).length,1);
console.log("lifetime contract totals: OK");
