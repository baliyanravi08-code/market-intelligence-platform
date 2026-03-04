const axios = require("axios");
const cheerio = require("cheerio");

let lastAnnouncement = null;

async function getBSEAnnouncement(){

 try{

  const url =
   "https://www.bseindia.com/corporates/ann.html";

  const response = await axios.get(url,{
   headers:{
    "User-Agent":
     "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
   },
   timeout:15000
  });

  const html = response.data;

  const $ = cheerio.load(html);

  const firstRow =
   $("table tr").eq(1).text();

  if(!firstRow)
   return null;

  const clean =
   firstRow.replace(/\s+/g," ").trim();

  if(clean === lastAnnouncement)
   return null;

  lastAnnouncement = clean;

  const company =
   clean.split(" ")[0];

  return{
   company,
   sector:"Market",
   announcement:clean,
   profitChange:
    Math.floor(Math.random()*40)-20,
   revenueChange:
    Math.floor(Math.random()*30),
   otherExpense:
    Math.floor(Math.random()*40),
   provisions:
    Math.floor(Math.random()*30),
   newOrders:
    Math.floor(Math.random()*100)
  };

 }catch(err){

  console.log("BSE fetch failed");

  return null;
 }

}

module.exports = getBSEAnnouncement;