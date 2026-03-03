const axios = require("axios");

let lastAnnouncement = null;

async function fetchBSEAnnouncement() {

  try {

    const response = await axios.get(
      "https://api.allorigins.win/raw?url=https://www.bseindia.com/corporates/ann.html",
      { timeout: 15000 }
    );

    const html = response.data;

    const match =
      html.match(/<td class="tdtext">(.*?)<\/td>/);

    if (!match) return null;

    const text = match[1]
      .replace(/<[^>]*>/g, "")
      .trim();

    if (text === lastAnnouncement)
      return null;

    lastAnnouncement = text;

    return {
      company: text.split(" ")[0],
      sector: "Market",
      strengthScore:
        Math.floor(Math.random() * 100),
      marketStatus: "LIVE",
      time: new Date().toLocaleTimeString()
    };

  } catch (err) {

    console.log("❌ BSE Fetch Failed");
    return null;
  }
}

module.exports = {
  fetchBSEAnnouncement
};