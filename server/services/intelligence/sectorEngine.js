const sectorStrength = {
 Bank:0,
 Pharma:0,
 Defense:0,
 Railway:0,
 Auto:0
};

function updateSectorStrength(data){

 const sector = data.sector;

 if(!sectorStrength[sector])
  sectorStrength[sector]=0;

/*
========================
STRENGTH CALCULATION
========================
*/

 if(data.verdict==="Bullish")
  sectorStrength[sector]+=2;

 if(data.verdict==="Caution")
  sectorStrength[sector]-=1;

 if(data.insight==="Strong Expansion")
  sectorStrength[sector]+=3;

 if(data.insight==="Structural Weakness")
  sectorStrength[sector]-=2;

/*
LIMIT RANGE
*/

 if(sectorStrength[sector]>100)
  sectorStrength[sector]=100;

 if(sectorStrength[sector]<-100)
  sectorStrength[sector]=-100;

 return sectorStrength;
}

module.exports = updateSectorStrength;