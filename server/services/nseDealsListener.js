const axios = require("axios");
const csv = require("csv-parser");
const { Readable } = require("stream");
const updateSmartMoney = require("./intelligence/smartMoneyTracker");

let ioRef = null;
let seenDeals = new Set();

function startNSEDealsListener(io) {

  ioRef = io;

  console.log("🏦 NSE Deals Listener running...");

  fetchDeals();

  setInterval(fetchDeals, 60000);

}

async function fetchDeals() {

  try {

    const url =
      "https://archives.nseindia.com/content/equities/bulk.csv";

    const res = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const stream = Readable.from(res.data);

    const institutionalAlerts = [];
    const smartMoneyAlerts = [];

    stream
      .pipe(csv())
      .on("data", (row) => {

        const id = row.Symbol + row.ClientName + row.Date;

        if (seenDeals.has(id)) return;

        seenDeals.add(id);

        const quantity = Number(row.Quantity);
        const price = Number(row.Price);

        const value = (quantity * price) / 10000000;

        const activity = {

          type: "INSTITUTIONAL_DEAL",
          company: row.Symbol,
          investor: row.ClientName,
          action: row.BuySell,
          quantity: quantity,
          price: price,
          value: value

        };

        institutionalAlerts.push(activity);

        const smartSignal = updateSmartMoney(activity);

        if (smartSignal) {

          smartMoneyAlerts.push(smartSignal);

        }

      })
      .on("end", () => {

        if (institutionalAlerts.length > 0 && ioRef) {

          ioRef.emit("institutional_activity", institutionalAlerts);

        }

        if (smartMoneyAlerts.length > 0 && ioRef) {

          ioRef.emit("smart_money_alerts", smartMoneyAlerts);

          console.log("🧠 Smart money detected");

        }

      });

  } catch (err) {

    console.log("❌ NSE Deals Fetch Failed:", err.message);

  }

}

module.exports = startNSEDealsListener;