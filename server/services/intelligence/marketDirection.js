let marketScore = 0;
let marketStatus = "Neutral";

function updateMarketDirection(sectorStrength){

 let total = 0;
 let count = 0;

 for(const sector in sectorStrength){
  total += sectorStrength[sector];
  count++;
 }

 const avg = total / count;

/*
=========================
MARKET LOGIC
=========================
*/

 if(avg > 10){
  marketStatus = "Bullish";
 }

 else if(avg < -10){
  marketStatus = "Bearish";
 }

 else{
  marketStatus = "Sideways";
 }

 marketScore = avg;

 return {
  marketStatus,
  marketScore
 };
}

module.exports = updateMarketDirection;