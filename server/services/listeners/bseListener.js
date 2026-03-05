const axios = require("axios");

const analyzeAnnouncement = require("../analyzers/announcementAnalyzer");

const orderBookEngine = require("../intelligence/orderBookEngine");
const orderStrengthEngine = require("../intelligence/orderStrengthEngine");
const orderMomentumEngine = require("../intelligence/orderMomentumEngine");
const orderQualityEngine = require("../intelligence/orderQualityEngine");
const sectorRadar = require("../intelligence/sectorRadar");
const sectorBoomEngine = require("../intelligence/sectorBoomEngine");
const { updateRadar } = require("../intelligence/radarEngine");

let ioRef = null;
let seen = new Set();

function startBSEListener(io){

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
        "Referer":"https://www.bseindia.com/"
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
          ? `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${item.ATTACHMENTNAME}`
          : null
      };

      const signal = await analyzeAnnouncement(announcement);

      if(!signal) continue;

      alerts.push(signal);

      updateRadar(signal.company,signal);

      const orderData = orderBookEngine(signal);

      if(orderData){

        ioRef.emit("order_book_update",orderData);

        const strength = orderStrengthEngine(signal.code);

        if(strength){
          ioRef.emit("order_strength",strength);
        }

        const momentum = orderMomentumEngine(signal);

        if(momentum){
          ioRef.emit("order_momentum",momentum);
        }

        const quality = orderQualityEngine(signal);

        if(quality){
          ioRef.emit("order_quality",quality);
        }

        const sectorData = sectorRadar(signal);

        if(sectorData && sectorData.orders >= 3){

          ioRef.emit("sector_alerts",[{
            sector: sectorData.sector,
            orders: sectorData.orders,
            value: sectorData.value
          }]);

        }

        const boom = sectorBoomEngine(signal);

        if(boom){
          ioRef.emit("sector_boom",boom);
        }

      }

    }

    if(alerts.length > 0 && ioRef){

      ioRef.emit("market_events",alerts);

    }

  }catch(err){

    console.log("❌ BSE Feed Failed:",err.message);

  }

}

module.exports = startBSEListener;