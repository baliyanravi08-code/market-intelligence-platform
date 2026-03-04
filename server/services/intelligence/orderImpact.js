function calculateOrderImpact(totalOrderValue,marketCap){

 if(!totalOrderValue || !marketCap)
  return null;

/*
marketCap comes in rupees
orders in crore
convert marketcap to crore
*/

 const marketCapCrore =
  marketCap / 10000000;

 const impactPercent =
  (totalOrderValue / marketCapCrore) * 100;

 let impactLevel="LOW";

 if(impactPercent > 20)
  impactLevel="HIGH";

 else if(impactPercent > 5)
  impactLevel="MEDIUM";

 return{
  impactPercent:impactPercent.toFixed(2),
  impactLevel
 };

}

module.exports = calculateOrderImpact;