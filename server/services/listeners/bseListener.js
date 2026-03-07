const axios = require("axios");

const analyzeAnnouncement = require("../analyzers/announcementAnalyzer");

const orderBookEngine = require("../intelligence/orderBookEngine");
const sectorQueue = require("../intelligence/sectorQueue");
const sectorRadar = require("../intelligence/sectorRadar");
const sectorBoomEngine = require("../intelligence/sectorBoomEngine");

const { updateRadar } = require("../intelligence/radarEngine");

let ioRef = null;
let seen = new Set();

function startBSEListener(io) {

  ioRef = io;

  console.log("🚀 BSE Listener running...");

  fetchAnnouncements();

  setInterval(fetchAnnouncements,30000);

}

async function fetchAnnouncements(){

  try{

    const url =
      "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w";

    const res = await axios.get(url,{
      params:{
        pageno:1,
        strCat:-1,
        strPrevDate:"",
        strScrip:"",
        strSearch:"P",
        strToDate:"",
        strType:"C"
      },
      headers:{
        "User-Agent":"Mozilla/5.0",
        Referer:"https://www.bseindia.com/"
      }
    });

    const list = res.data?.Table || [];

    console.log("📢 BSE Announcements fetched:",list.length);

    const alerts = [];

    for(const item of list){

      const company = item.SLONGNAME;
      const code = item.SCRIP_CD;
      const title = item.HEADLINE;
      const date = item.NEWS_DT;

      const id = code + title + date;

      if(seen.has(id)) continue;

      seen.add(id);

      const announcement = {
        company,
        code,
        title,
        date,
        pdfUrl: item.ATTACHMENTNAME
  ? `https://www.bseindia.com/xml-data/corpfiling/AttachHis/${item.ATTACHMENTNAME}`
  : null
      };

      const signal = await analyzeAnnouncement(announcement);

      if(!signal) continue;

      signal.pdfUrl = announcement.pdfUrl;

      alerts.push(signal);

      updateRadar(signal.company,signal);

      /* ORDER BOOK */

      const orderData = orderBookEngine(signal);

      if(orderData && ioRef){
        ioRef.emit("order_book_update",orderData);
      }

      /* SECTOR QUEUE */

      const queue = sectorQueue(signal);

      const sectorData = sectorRadar(queue);

      if(sectorData && ioRef){
        ioRef.emit("sector_alerts",[sectorData]);
      }

      const boom = sectorBoomEngine(queue);

      if(boom && ioRef){
        ioRef.emit("sector_boom",boom);
      }

    }

    if(alerts.length > 0 && ioRef){
      ioRef.emit("market_events",alerts);
    }

  }
  catch(err){
    console.log("❌ BSE Feed Failed:",err.message);
  }

}

module.exports = startBSEListener;