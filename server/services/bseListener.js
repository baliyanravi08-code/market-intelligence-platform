const axios = require("axios");
const analyzeAnnouncement = require("./orderAnalyzer");

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

    const alerts = [];

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

      const signal = analyzeAnnouncement(announcement);

      if (signal) alerts.push(signal);

    }

    console.log("📢 BSE Announcements fetched:", list.length);

    if (alerts.length > 0 && ioRef) {

      ioRef.emit("market_events", alerts);

      console.log("🚨 Market events detected:", alerts.length);

    }

  } catch (err) {

    console.log("❌ Market Feed Failed:", err.message);

  }

}

module.exports = startBSEListener;