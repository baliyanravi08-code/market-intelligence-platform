const axios = require("axios");

let lastTitle = null;

async function fetchBSE() {

 try {

  const res = await axios.get(
   "https://api.allorigins.win/raw?url=https://www.bseindia.com/corporates/ann.html"
  );

  const html = res.data;

  const match =
   html.match(/<td class="tdtext">(.*?)<\/td>/);

  if(!match) return null;

  const title =
   match[1].replace(/<[^>]*>/g,"").trim();

  if(title === lastTitle) return null;

  lastTitle = title;

  return {
   company:title.split(" ")[0],
   sector:"Market",
   strengthScore:
    Math.floor(Math.random()*100),
   marketStatus:"Live",
   time:new Date().toLocaleTimeString()
  };

 } catch(err){

  console.log("BSE Fetch Failed");
  return null;
 }
}

module.exports={fetchBSE};