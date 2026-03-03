function analyzeResult(data){

 let analysis = {
  verdict:"Neutral",
  reason:"Stable Operations",
  signals:[]
 };

 /*
 =====================
 PROFIT CHECK
 =====================
 */

 if(data.profitChange < 0){
  analysis.signals.push(
   "Profit Decline"
  );
 }

 if(data.revenueChange > 10){
  analysis.signals.push(
   "Strong Revenue Growth"
  );
 }

 /*
 =====================
 EXPENSE ANALYSIS
 =====================
 */

 if(data.otherExpense > 20){

  analysis.reason =
   "Expense Spike Detected";

  analysis.signals.push(
   "Possible Labour / One-time Cost"
  );
 }

 /*
 =====================
 BANK LOGIC
 =====================
 */

 if(data.sector === "Bank"){

  if(data.provisions > 15){

   analysis.reason =
    "Higher Provisions Impact";

   analysis.signals.push(
    "GNPA / Credit Cost Rise"
   );
  }
 }

 /*
 =====================
 ORDER BOOK
 =====================
 */

 if(data.newOrders > 50){

  analysis.signals.push(
   "Strong Order Inflow"
  );
 }

 /*
 =====================
 FINAL VERDICT
 =====================
 */

 if(
  analysis.signals.includes(
   "Strong Revenue Growth"
  )
 ){
  analysis.verdict="Bullish";
 }

 if(
  analysis.signals.includes(
   "Profit Decline"
  )
 ){
  analysis.verdict="Caution";
 }

 return analysis;
}

module.exports = analyzeResult;