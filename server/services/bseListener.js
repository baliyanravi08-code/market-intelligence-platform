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
      "https://www.bseindia.com/markets/MarketInfo/BseRSS.xml";

    const res = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const parser = new xml2js.Parser();

    const data = await parser.parseStringPromise(res.data);

    const items = data.rss.channel[0].item || [];

    console.log("📢 BSE Announcements fetched:", items.length);

    const alerts = [];

    for (const item of items) {

      const title = item.title?.[0] || "";
      const date = item.pubDate?.[0] || "";
      const company = title.split(" - ")[0] || "Unknown";

      const id = title + date;

      if (seen.has(id)) continue;

      seen.add(id);

      const announcement = {
        company,
        code: company,
        title,
        date
      };

      const signal = await analyzeAnnouncement(announcement);

      if (!signal) continue;

      alerts.push(signal);

      updateRadar(signal.company || signal.code, signal);

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

    console.log("❌ BSE RSS Feed Failed:", err.message);

  }

}

module.exports = startBSEListener;