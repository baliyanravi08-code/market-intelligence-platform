const axios = require("axios");
const pdf = require("pdf-parse");

/*
====================================
READ PDF
====================================
*/

async function readPDF(url){

 try{

  const response = await axios({
   method:"GET",
   url:url,
   responseType:"arraybuffer",
   headers:{
    "User-Agent":
    "Mozilla/5.0"
   },
   timeout:30000
  });

  const data = await pdf(response.data);

  return data.text
   .replace(/\n/g," ")
   .toLowerCase();

 }catch(err){

  console.log("❌ PDF Read Failed");
  return "";
 }
}

/*
====================================
NUMBER FINDER
====================================
*/

function findNumber(text){

 const match =
 text.match(/\d{1,3}(,\d{3})*(\.\d+)?/);

 if(!match) return null;

 return parseFloat(
   match[0].replace(/,/g,"")
 );
}

/*
====================================
EXPENSE DETECTION
====================================
*/

function detectExpenseImpact(text){

 let reasons=[];

 if(text.includes("employee benefit"))
   reasons.push("Employee Cost Increased");

 if(text.includes("finance cost"))
   reasons.push("Interest Cost Increased");

 if(text.includes("other expenses"))
   reasons.push("Operational Expense Increased");

 if(text.includes("raw material"))
   reasons.push("Input Cost Pressure");

 if(text.includes("provision"))
   reasons.push("Higher Provisioning");

 if(reasons.length===0)
   reasons.push("No Major Cost Spike");

 return reasons;
}

/*
====================================
FINANCIAL EXTRACTION
====================================
*/

function extractFinancials(text){

 const revenueMatch =
  text.match(/revenue[^]{0,80}/);

 const profitMatch =
  text.match(/profit[^]{0,80}/);

 return{
  revenue: revenueMatch
   ? findNumber(revenueMatch[0])
   : null,

  profit: profitMatch
   ? findNumber(profitMatch[0])
   : null
 };
}

/*
====================================
FINAL ANALYSIS
====================================
*/

function analyzeResult(text){

 const fin =
  extractFinancials(text);

 const expenses =
  detectExpenseImpact(text);

 let conclusion="Stable Result";

 if(
   expenses.includes("Higher Provisioning") ||
   expenses.includes("Employee Cost Increased")
 ){
   conclusion="Profit impacted by Cost Increase";
 }

 if(!fin.revenue && !fin.profit){
   conclusion="Structured Data Not Found";
 }

 return{
  revenue:fin.revenue,
  profit:fin.profit,
  expenseReasons:expenses,
  conclusion
 };
}

module.exports={
 readPDF,
 analyzeResult
};