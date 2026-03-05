/*
====================================
MARKET DIRECTION ENGINE
====================================
*/

let marketScore = 50;

function updateMarketDirection(sectorStrength){

 let total = 0;
 let sectors = 0;

 for(const sector in sectorStrength){
  total += sectorStrength[sector];
  sectors++;
 }

 const avg = total / sectors;

 if(avg > 60)
  marketScore += 5;

 else if(avg < 40)
  marketScore -= 5;

 if(marketScore > 100)
  marketScore = 100;

 if(marketScore < 0)
  marketScore = 0;

 return getMarketStatus();
}

function getMarketStatus(){

 if(marketScore > 70)
  return "BULLISH BUILDUP 🚀";

 if(marketScore < 35)
  return "RISK INCREASING ⚠️";

 return "SIDEWAYS / TRANSITION";
}

module.exports={
 updateMarketDirection,
 getMarketStatus
};