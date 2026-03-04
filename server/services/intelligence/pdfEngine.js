const axios = require("axios");
const pdf = require("pdf-parse");

async function analyzeResultPDF(pdfUrl){

 try{

  const response = await axios.get(
   pdfUrl,
   { responseType:"arraybuffer" }
  );

  const data =
   await pdf(response.data);

  const text =
   data.text.toLowerCase();

/*
=====================
BASIC DETECTION
=====================
*/

 let insight="Stable Result";
 let reason="Normal Operations";

 if(text.includes("other expense")){
  insight="Expense Impact";
  reason="Other Expense Increased";
 }

 if(text.includes("provision")){
  insight="Provision Impact";
  reason="Higher Credit Cost";
 }

 if(text.includes("exceptional")){
  insight="One-time Event";
  reason="Exceptional Item Present";
 }

 if(text.includes("order")){
  insight="Order Growth";
  reason="Strong Order Book";
 }

 return{
  pdfInsight:insight,
  pdfReason:reason
 };

 }catch(err){

  console.log("PDF Read Failed");

  return{
   pdfInsight:"Unavailable",
   pdfReason:"PDF Parsing Failed"
  };
 }

}

module.exports = analyzeResultPDF;