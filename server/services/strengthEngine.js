/*
====================================
COMPANY STRENGTH CALCULATOR
====================================
*/

function calculateStrength(type,analysis){

 let score=50; // base score

 /*
 ======================
 RESULT IMPACT
 ======================
 */

 if(type==="RESULT" && analysis){

  if(
   analysis.conclusion &&
   analysis.conclusion.includes("Strong")
  )
   score+=25;

  if(
   analysis.conclusion &&
   analysis.conclusion.includes("Pressure")
  )
   score-=10;
 }

 /*
 ======================
 ORDER IMPACT
 ======================
 */

 if(type==="ORDER" && analysis){

  const value =
   parseFloat(analysis.orderValue);

  if(value>500) score+=30;
  else if(value>100) score+=20;
  else if(value>20) score+=10;
 }

 /*
 LIMIT SCORE
 */

 if(score>100) score=100;
 if(score<0) score=0;

 return score;
}

module.exports={
 calculateStrength
};