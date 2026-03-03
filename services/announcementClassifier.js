function classifyAnnouncement(title){

 const text = title.toLowerCase();

 /*
 ================================
 RESULT DETECTION
 ================================
 */

 if(
   text.includes("financial result") ||
   text.includes("results") ||
   text.includes("quarter ended")
 ){
   return "RESULT";
 }

 /*
 ================================
 ORDER DETECTION
 ================================
 */

 if(
   text.includes("order") ||
   text.includes("contract") ||
   text.includes("work order") ||
   text.includes("loi")
 ){
   return "ORDER";
 }

 /*
 ================================
 IGNORE OTHERS
 ================================
 */

 return "IGNORE";
}

module.exports={
 classifyAnnouncement
};