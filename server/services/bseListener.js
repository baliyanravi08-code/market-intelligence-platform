const axios = require("axios");
const cheerio = require("cheerio");

const BSE_URL = "https://www.bseindia.com/corporates/ann.html";

let ioRef = null;

function attachSocket(io) {
  ioRef = io;
}

async function fetchAnnouncements() {

  try {

    const res = await axios.get(BSE_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
      }
    });

    const $ = cheerio.load(res.data);

    const announcements = [];

    $("table tr").each((i, row) => {

      const text = $(row).text().trim();

      if (text.length > 30) {
        announcements.push(text);
      }

    });

    console.log("📢 BSE Announcements fetched:", announcements.length);

    if (ioRef) {

      ioRef.emit("bse_announcements", {
        count: announcements.length,
        announcements: announcements.slice(0, 10),
        time: new Date()
      });

    }

  } catch (err) {

    console.log("❌ Market Feed Failed", err.message);

  }

}

function startBSEListener(io) {

  ioRef = io;

  console.log("🚀 BSE Listener running...");

  fetchAnnouncements();

  setInterval(fetchAnnouncements, 5000);

}

module.exports = startBSEListener;