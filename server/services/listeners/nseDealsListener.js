const axios = require("axios");

const { updateRadar } = require("../intelligence/radarEngine");

let ioRef = null;

function startNSEDealsListener(io){

  ioRef = io;

  console.log("🏦 NSE Deals Listener running...");

  fetchDeals();

  setInterval(fetchDeals,60000);

}

async function fetchDeals(){

  try{

    const url = "https://www.nseindia.com/api/block-deal";

    const res = await axios.get(url,{
      headers:{
        "User-Agent":"Mozilla/5.0"
      }
    });

    const deals = res.data?.data || [];

    for(const deal of deals){

      const activity = {
        company: deal.symbol,
        signal: "INSTITUTIONAL_DEAL",
        quantity: deal.quantity,
        price: deal.price,
        value: deal.quantity * deal.price
      };

      // update radar scoring
      updateRadar(activity.company, activity);

      if(ioRef){

        ioRef.emit("institutional_activity", activity);

      }

    }

  }
  catch(err){

    console.log("❌ NSE Deals fetch failed:", err.message);

  }

}

module.exports = startNSEDealsListener;