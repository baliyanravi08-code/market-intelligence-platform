/*
====================================
SECTOR MAPPING
====================================
*/

const sectorMap={

 "HAL":"DEFENSE",
 "BEL":"DEFENSE",

 "RVNL":"RAILWAY",
 "IRCON":"RAILWAY",

 "HDFC BANK":"BANK",
 "ICICI BANK":"BANK",

 "SUN PHARMA":"PHARMA",
 "CIPLA":"PHARMA",

 "TATA MOTORS":"AUTO",
 "MARUTI":"AUTO"
};

/*
====================================
SECTOR STORE
====================================
*/

const sectorStrength={
 DEFENSE:0,
 RAILWAY:0,
 BANK:0,
 PHARMA:0,
 AUTO:0
};

function getSector(company){

 if(!company) return "UNKNOWN";

 for(const key in sectorMap){

  if(company.toUpperCase().includes(key))
   return sectorMap[key];
 }

 return "UNKNOWN";
}

function updateSectorStrength(sector,score){

 if(!sectorStrength[sector])
   sectorStrength[sector]=0;

 sectorStrength[sector]+=score/10;

 return sectorStrength;
}

function getSectorStrength(){
 return sectorStrength;
}

module.exports={
 getSector,
 updateSectorStrength,
 getSectorStrength
};