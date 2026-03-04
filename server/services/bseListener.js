const axios = require("axios");
const analyzeAnnouncement = require("./orderAnalyzer");
const updateSectorRadar = require("./intelligence/sectorRadar");
const { updateRadar } = require("./intelligence/radarEngine");

let ioRef = null;
let seen = new Set();

function startBSEListener(io) {

  ioRef = io;

  console.log("🚀 BSE Listener running...");

  fetchAnnouncements();

  setInterval(fetchAnnouncements, 5000);

}

async function fetchAnnouncements() {

  try {

    const url =
      "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?pageno=1&strCat=-1&strPrevDate=&strScrip=&strSearch=P&strToDate=&strType=C";

    const res = await axios.get(url, {
      headers:{
        "User-Agent":"Mozilla/5.0",
        "Referer":"https://www.bseindia.com/"
      }
    });

    const list = res.data.Table || [];

    const alerts = [];

    for (const item of list.slice(0,50)) {

      const id = item.SCRIP_CD + item.HEADLINE;

      if (seen.has(id)) continue;

      seen.add(id);

      const announcement = {
        company: item.SLONGNAME,
        code: item.SCRIP_CD,
        title: item.HEADLINE,
        date: item.NEWS_DT
      };

      const signal = await analyzeAnnouncement(announcement);

      if (!signal) continue;

      alerts.push(signal);

      updateRadar(signal.code || signal.company, signal);

      if (signal.type === "ORDER_ALERT") {

        const sectorData = updateSectorRadar(signal);

        if (sectorData.orders >= 3) {

          ioRef.emit("sector_alerts",[{
            sector: sectorData.sector,
            orders: sectorData.orders,
            value: sectorData.value
          }]);

        }

      }

    }

    console.log("📢 BSE Announcements fetched:", list.length);

    if (alerts.length > 0 && ioRef) {

      ioRef.emit("market_events", alerts);

    }

  } catch (err) {

    console.log("❌ Market Feed Failed:", err.message);

  }

}

module.exports = startBSEListener;