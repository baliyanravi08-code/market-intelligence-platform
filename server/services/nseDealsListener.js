const axios = require("axios");

let ioRef = null;
let seenDeals = new Set();

function startNSEDealsListener(io) {

  ioRef = io;

  console.log("🏦 NSE Deals Listener running...");

  fetchDeals();

  setInterval(fetchDeals, 30000);

}

async function fetchDeals() {

  try {

    const url =
      "https://www.nseindia.com/api/block-deals";

    const res = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://www.nseindia.com/"
      }
    });

    const deals = res.data.data || [];

    const alerts = [];

    for (const deal of deals) {

      const id = deal.symbol + deal.clientName + deal.tradeDate;

      if (seenDeals.has(id)) continue;

      seenDeals.add(id);

      alerts.push({

        type: "INSTITUTIONAL_DEAL",

        company: deal.symbol,

        investor: deal.clientName,

        action: deal.buySell,

        quantity: deal.quantity,

        price: deal.price,

        value: (deal.quantity * deal.price) / 10000000

      });

    }

    if (alerts.length > 0 && ioRef) {

      ioRef.emit("institutional_activity", alerts);

      console.log("🏦 Institutional deals detected:", alerts.length);

    }

  } catch (err) {

    console.log("❌ NSE Deals Fetch Failed:", err.message);

  }

}

module.exports = startNSEDealsListener;