const axios=require("axios");
const cheerio=require("cheerio");

let seenAnnouncements=new Set();

async function getBSEAnnouncement(){

 try{

  const url=
   "https://www.bseindia.com/corporates/ann.html";

  const res=await axios.get(url,{
   headers:{
    "User-Agent":
     "Mozilla/5.0"
   },
   timeout:15000
  });

  const html=res.data;

  const $=cheerio.load(html);

  const rows=$("table tr");

  for(let i=1;i<rows.length;i++){

   const text=
    $(rows[i]).text()
    .replace(/\s+/g," ")
    .trim();

   if(!text)
    continue;

   if(seenAnnouncements.has(text))
    continue;

   seenAnnouncements.add(text);

   const company=
    text.split(" ")[0];

   return{

    company,
    sector:"Market",
    announcement:text,
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

  }

  return null;

 }catch(err){

  console.log("BSE fetch failed");

  return null;

 }

}

module.exports=getBSEAnnouncement;