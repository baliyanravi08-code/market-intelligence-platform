const axios = require("axios");
const cheerio = require("cheerio");

const analyzeAnnouncement = require("./orderAnalyzer");
const updateSectorRadar = require("./intelligence/sectorRadar");
const { updateRadar } = require("./intelligence/radarEngine");

let ioRef = null;
let seen = new Set();

function startBSEListener(io) {

  ioRef = io;

  console.log("🚀 BSE Listener running...");

  fetchAnnouncements();

  setInterval(fetchAnnouncements, 10000);

}

async function fetchAnnouncements() {

  try {

    const url = "https://www.bseindia.com/corporates/ann.html";

    const res = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const $ = cheerio.load(res.data);

    const rows = $("#ctl00_ContentPlaceHolder1_gvData tr");

    console.log("📢 BSE Announcements fetched:", rows.length);

    const alerts = [];

    rows.each(async (index, row) => {

      const cols = $(row).find("td");

      if (cols.length < 5) return;

      const company = $(cols[1]).text().trim();
      const code = $(cols[0]).text().trim();
      const title = $(cols[3]).text().trim();
      const date = $(cols[4]).text().trim();

      const id = code + title + date;

      if (seen.has(id)) return;

      seen.add(id);

      const announcement = {
        company,
        code,
        title,
        date
      };

      const signal = await analyzeAnnouncement(announcement);

      if (!signal) return;

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

    });

    if (alerts.length > 0 && ioRef) {

      ioRef.emit("market_events", alerts);

    }

  } catch (err) {

    console.log("❌ BSE Feed Failed:", err.message);

  }

}

module.exports = startBSEListener;