const axios = require("axios");
const analyzeAnnouncement = require("./orderAnalyzer");
const updateSectorRadar = require("./intelligence/sectorRadar");

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
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://www.bseindia.com/"
      }
    });

    const list = res.data.Table || [];

    const orderAlerts = [];
    const sectorAlerts = [];

    for (const item of list.slice(0, 50)) {

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

      if (signal && signal.newOrder >= 1) {

        orderAlerts.push(signal);

        const sectorData = updateSectorRadar(signal);

        if (sectorData.orders >= 3) {

          sectorAlerts.push({
            sector: sectorData.sector,
            orders: sectorData.orders,
            value: sectorData.value
          });

        }

      }

    }

    console.log("📢 BSE Announcements fetched:", list.length);

    if (orderAlerts.length > 0 && ioRef) {

      ioRef.emit("order_book_updates", orderAlerts);

    }

    if (sectorAlerts.length > 0 && ioRef) {

      ioRef.emit("sector_alerts", sectorAlerts);

      console.log("🚨 Sector momentum detected");

    }

  } catch (err) {

    console.log("❌ Market Feed Failed:", err.message);

  }

}

module.exports = startBSEListener;