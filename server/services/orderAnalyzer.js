/*
====================================
ORDER VALUE EXTRACTION
====================================
*/

function extractOrderValue(text){

 text=text.toLowerCase();

 /*
 CRORE FORMAT
 */

 let crore =
 text.match(/rs\.?\s?(\d+(\.\d+)?)\s?crore/);

 if(crore){
  return parseFloat(crore[1]);
 }

 /*
 MILLION FORMAT
 */

 let million =
 text.match(/(\d+(\.\d+)?)\s?million/);

 if(million){
  return parseFloat(million[1]) * 0.1;
 }

 /*
 BILLION FORMAT
 */

 let billion =
 text.match(/(\d+(\.\d+)?)\s?billion/);

 if(billion){
  return parseFloat(billion[1]) * 100;
 }

 return null;
}

/*
====================================
ORDER IMPACT SCORE
====================================
*/

function orderImpact(value){

 if(!value) return "UNKNOWN";

 if(value>500)
  return "MEGA ORDER 🚀";

 if(value>100)
  return "HIGH ORDER ✅";

 if(value>20)
  return "MEDIUM ORDER";

 return "SMALL ORDER";
}

/*
====================================
ORDER ANALYSIS
====================================
*/

function analyzeOrder(text){

 const value =
  extractOrderValue(text);

 if(!value) return null;

 return{
  orderValue:value+" Cr",
  impact:orderImpact(value)
 };
}

module.exports={
 analyzeOrder
};