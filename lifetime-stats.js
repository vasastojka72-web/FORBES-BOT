import { parseForbesNickname } from "./nickname-parser.js";

const keyFor=(nick,id)=>(String(id||"").trim()||String(nick||"").trim()).toLowerCase();

export function applySalaryLifetimeStats(db,rows,salaryHash,closedAt){
  db.memberLifetimeStats=db.memberLifetimeStats||{};
  db.salaryCloseLedger=Array.isArray(db.salaryCloseLedger)?db.salaryCloseLedger:[];
  const hash=String(salaryHash||"").trim();
  if(!hash||db.salaryCloseLedger.includes(hash))return false;
  for(const row of Array.isArray(rows)?rows:[]){
    const parsed=parseForbesNickname(row.player||"");
    const key=keyFor(parsed.nick,parsed.staticId);
    if(!key)continue;
    const previous=db.memberLifetimeStats[key]||{};
    db.memberLifetimeStats[key]={contractsCompleted:Number(previous.contractsCompleted||0)+Math.max(0,Number(row.contracts||0)),updatedAt:closedAt};
  }
  db.salaryCloseLedger.push(hash);
  db.salaryCloseLedger=db.salaryCloseLedger.slice(-100);
  return true;
}

export function lifetimeContractCount(db,nick,id){
  return Number(db?.memberLifetimeStats?.[keyFor(nick,id)]?.contractsCompleted||0);
}
