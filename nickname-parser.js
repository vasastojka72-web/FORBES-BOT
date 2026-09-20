const PREFIX_PATTERN=/^(?:(?:head|dep)\s+cpt|farm\s+manager|adm|rev|rec|farm|cpt)\s+/i;

export function parseForbesNickname(value){
  const raw=String(value||"").trim();
  const parts=raw.split("|").map(x=>x.trim()).filter(Boolean);
  let numeric=parts.find(x=>/^\d{1,10}$/.test(x))||"";
  let candidate=raw;
  if(parts.length>1){
    const text=parts.filter(x=>!/^\d{1,10}$/.test(x));
    candidate=text[text.length-1]||raw;
  }else{
    const match=raw.match(/^(.+?)\s*(?:#|\[|\()\s*(\d{1,10})\s*(?:\]|\))?$/);
    if(match){candidate=match[1].trim();numeric=match[2];}
  }
  // Forbes is the in-game surname, not a disposable Discord suffix. Keep the
  // complete "FirstName Forbes" value and remove only the service/rank prefix.
  const words=candidate.replace(/\s+/g," ").trim().split(" ").filter(Boolean);
  let nick=words.join(" ").trim().replace(PREFIX_PATTERN,"").trim();
  return {nick:nick||candidate,staticId:numeric};
}
