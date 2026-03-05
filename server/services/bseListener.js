const axios = require("axios");
const xml2js = require("xml2js");

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
      "https://www.bseindia.com/xml-data/corpfiling/ann.xml";

    const res = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const parser = new xml2js.Parser();

    const data = await parser.parseStringPromise(res.data);

    const items = data.Announcements.Announcement || [];

    console.log("📢 BSE Announcements fetched:", items.length);

    const alerts = [];

    for (const item of items) {

      const title = item.HEADLINE?.[0] || "";
      const company = item.SLONGNAME?.[0] || "";
      const code = item.SCRIP_CD?.[0] || "";
      const date = item.NEWS_DT?.[0] || "";

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