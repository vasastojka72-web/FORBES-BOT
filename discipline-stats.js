const keyFor=item=>(String(item?.staticId||item?.playerId||"").trim()||String(item?.nickname||item?.nick||item?.player||"").trim()).toLowerCase();

export function compactResolvedDiscipline(db){
  db.memberLifetimeStats=db.memberLifetimeStats||{};
  db.disciplineArchiveLedger=Array.isArray(db.disciplineArchiveLedger)?db.disciplineArchiveLedger:[];
  const seen=new Set(db.disciplineArchiveLedger.map(String));
  const keepFine=[];
  for(const fine of (Array.isArray(db.fines)?db.fines:[])){
    if(!["paid","closed"].includes(String(fine.status||"").toLowerCase())){keepFine.push(fine);continue;}
    if(fine.fineId)continue;
    const ledger=`fine:${fine.id}`;
    if(!seen.has(ledger)){
      const key=keyFor(fine); if(key){const stat=db.memberLifetimeStats[key]||{};stat.paidFines=Number(stat.paidFines||0)+1;db.memberLifetimeStats[key]=stat;}
      seen.add(ledger);
    }
  }
  const keepWarning=[];
  for(const warning of (Array.isArray(db.warnings)?db.warnings:[])){
    if(!["removed","closed"].includes(String(warning.status||"").toLowerCase())){keepWarning.push(warning);continue;}
    if(warning.warningId)continue;
    const ledger=`warning:${warning.id}`;
    if(!seen.has(ledger)){
      const key=keyFor(warning); if(key){const stat=db.memberLifetimeStats[key]||{};stat.removedWarnings=Number(stat.removedWarnings||0)+1;db.memberLifetimeStats[key]=stat;}
      seen.add(ledger);
    }
  }
  db.fines=keepFine;db.warnings=keepWarning;db.disciplineArchiveLedger=[...seen].slice(-5000);
  return db;
}

export function disciplineCounters(db,nick,id){
  const key=(String(id||"").trim()||String(nick||"").trim()).toLowerCase();
  const stat=db?.memberLifetimeStats?.[key]||{};
  return {paidFines:Number(stat.paidFines||0),removedWarnings:Number(stat.removedWarnings||0)};
}
