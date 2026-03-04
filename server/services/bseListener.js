const axios = require("axios");
const cheerio = require("cheerio");

const BSE_URL = "https://www.bseindia.com/corporates/ann.html";

async function fetchAnnouncements() {

  try {

    const res = await axios.get(BSE_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
      },
      timeout: 10000
    });

    const $ = cheerio.load(res.data);

    const announcements = [];

    $("table tr").each((i, row) => {

      const text = $(row).text().trim();

      if (text.length > 20) {
        announcements.push(text);
      }

    });

    console.log("📢 BSE Announcements fetched:", announcements.length);

  } catch (err) {

    console.log("❌ Market Feed Failed");
    console.log(err.message);

  }

}

function startBSEListener() {

  console.log("🚀 BSE Listener running...");

  fetchAnnouncements();

  setInterval(fetchAnnouncements, 5000);

}

module.exports = startBSEListener;