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

  setInterval(fetchAnnouncements, 15000);

}

async function fetchAnnouncements() {

  try {

    const url =
      "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w";

    const res = await axios.get(url, {
      params: {
        pageno: 1,
        strCat: -1,
        strPrevDate: "",
        strScrip: "",
        strSearch: "P",
        strToDate: "",
        strType: "C"
      },
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
        "Referer": "https://www.bseindia.com/corporates/ann.html"
      }
    });

    const list = res.data?.Table || [];

    console.log("📢 BSE Announcements fetched:", list.length);

    const alerts = [];

    for (const item of list) {

      const company = item.SLONGNAME;
      const code = item.SCRIP_CD;
      const title = item.HEADLINE;
      const date = item.NEWS_DT;

      const id = code + title + date;

      if (seen.has(id)) continue;

      seen.add(id);

      const announcement = {
        company,
        code,
        title,
        date
      };

      const signal = await analyzeAnnouncement(announcement);

      if (!signal) continue;

      alerts.push(signal);

      updateRadar(signal.code || signal.company, signal);

      if (signal.type === "ORDER_ALERT") {

        const sectorData = updateSectorRadar(signal);

        if (sectorData.orders >= 3) {

          ioRef.emit("sector_alerts", [{
            sector: sectorData.sector,
            orders: sectorData.orders,
            value: sectorData.value
          }]);

        }

      }

    }

    if (alerts.length > 0 && ioRef) {

      ioRef.emit("market_events", alerts);

    }

  } catch (err) {

    console.log("❌ BSE Feed Failed:", err.message);

  }

}

module.exports = startBSEListener;