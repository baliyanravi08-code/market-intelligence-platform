const axios = require("axios");

let ioRef = null;

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
        "Referer": "https://www.bseindia.com/",
        "Origin": "https://www.bseindia.com"
      }
    });

    const list = res.data.Table || [];

    console.log("📢 BSE Announcements fetched:", list.length);

    const announcements = list.slice(0,10).map(item => ({
      company: item.SLONGNAME,
      code: item.SCRIP_CD,
      title: item.HEADLINE,
      date: item.NEWS_DT
    }));

    if (ioRef) {

      ioRef.emit("bse_announcements", {
        count: announcements.length,
        announcements
      });

    }

  } catch (err) {

    console.log("❌ Market Feed Failed:", err.message);

  }

}

module.exports = startBSEListener;