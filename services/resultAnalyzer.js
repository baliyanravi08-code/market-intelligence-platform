let pdfParse = null;

/*
====================================
SAFE PDF IMPORT
====================================
*/

try{
 pdfParse = require("pdf-parse");
}catch(err){
 console.log("⚠ PDF engine disabled (cloud safe mode)");
}

/*
====================================
READ PDF SAFELY
====================================
*/

async function readPDF(url){

 if(!pdfParse){
  return "";
 }

 try{

  const axios = require("axios");

  const res = await axios({
   url,
   method:"GET",
   responseType:"arraybuffer",
   timeout:30000
  });

  const data = await pdfParse(res.data);

  return data.text.toLowerCase();

 }catch(err){

  console.log("PDF Read Failed:",err.message);
  return "";
 }
}

/*
====================================
ANALYZE RESULT TEXT
====================================
*/

function analyzeResult(text){

 if(!text){
  return {
   summary:"Result Uploaded",
   reason:"PDF parsing unavailable"
  };
 }

 let summary="Stable Result";
 let reason="Normal Operations";

/* BANK */

 if(text.includes("provision")){
  summary="Provision Impact";
  reason="Higher provisioning";
 }

/* EMPLOYEE COST */

 if(text.includes("employee benefit")){
  summary="Margin Pressure";
  reason="Employee expense increased";
 }

/* STRONG */

 if(text.includes("record profit")){
  summary="Strong Result";
  reason="Operational growth";
 }

 return {summary,reason};
}

module.exports={
 readPDF,
 analyzeResult
};