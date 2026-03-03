const puppeteer=require("puppeteer-core");

let browser=null;
let lastAnnouncement="";
let launchTime=Date.now();

async function getBrowser(){

 const SIX_HOURS=6*60*60*1000;

 if(browser &&
   Date.now()-launchTime>SIX_HOURS){

   console.log("♻ Refresh Browser");

   await browser.close();
   browser=null;
 }

 if(!browser){

  console.log("🌐 Launch Browser");

  browser=await puppeteer.launch({

   executablePath:
     process.env.CHROME_PATH ||
     "/usr/bin/chromium-browser",

   headless:true,

   args:[
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage"
   ]
  });

  launchTime=Date.now();
 }

 return browser;
}

async function fetchAnnouncements(){

 try{

  const br=await getBrowser();
  const page=await br.newPage();

  await page.goto(
   "https://www.bseindia.com/corporates/ann.html",
   {
    waitUntil:"domcontentloaded",
    timeout:60000
   }
  );

  const data=await page.evaluate(()=>{

   const list=[];

   document.querySelectorAll("a")
   .forEach(a=>{

    const text=a.innerText?.trim();
    const link=a.getAttribute("href");

    if(text && link &&
       link.includes("AnnPdf")){

      list.push({
        title:text,
        link:
        "https://www.bseindia.com"+link
      });
    }
   });

   return list;
  });

  await page.close();

  return data;

 }catch(err){

  console.log("⚠ Browser restart");

  if(browser){
   await browser.close();
   browser=null;
  }

  return [];
 }
}

function getNewAnnouncement(list){

 if(!list.length) return null;

 const latest=list[0];

 if(latest.title!==lastAnnouncement){
  lastAnnouncement=latest.title;
  return latest;
 }

 return null;
}

module.exports={
 fetchAnnouncements,
 getNewAnnouncement
};