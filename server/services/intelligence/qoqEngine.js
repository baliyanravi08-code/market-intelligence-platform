function analyzeQoQ(data){

 let qoq = {
  qoqSignal:"Stable",
  yoySignal:"Stable",
  insight:"Normal Performance"
 };

/*
====================
QoQ ANALYSIS
====================
*/

 if(data.currentProfit >
    data.lastQuarterProfit){

  qoq.qoqSignal="QoQ Growth";
 }

 if(data.currentProfit <
    data.lastQuarterProfit){

  qoq.qoqSignal="QoQ Decline";
 }

/*
====================
YoY ANALYSIS
====================
*/

 if(data.currentProfit >
    data.lastYearProfit){

  qoq.yoySignal="YoY Growth";
 }

 if(data.currentProfit <
    data.lastYearProfit){

  qoq.yoySignal="YoY Decline";
 }

/*
====================
INTELLIGENCE LOGIC
====================
*/

 if(
  qoq.qoqSignal==="QoQ Decline"
  &&
  qoq.yoySignal==="YoY Growth"
 ){
  qoq.insight=
   "Temporary Weak Quarter";
 }

 if(
  qoq.qoqSignal==="QoQ Decline"
  &&
  qoq.yoySignal==="YoY Decline"
 ){
  qoq.insight=
   "Structural Weakness";
 }

 if(
  qoq.qoqSignal==="QoQ Growth"
  &&
  qoq.yoySignal==="YoY Growth"
 ){
  qoq.insight=
   "Strong Expansion";
 }

 return qoq;
}

module.exports = analyzeQoQ;