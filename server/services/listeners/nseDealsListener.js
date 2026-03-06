const axios = require("axios");

const { updateRadar } = require("../intelligence/radarEngine");

const institutionalFlowEngine = require("../intelligence/institutionalFlowEngine");

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
        signal:"INSTITUTIONAL_DEAL",
        quantity: deal.quantity,
        price: deal.price,
        value: deal.quantity * deal.price

      };

      updateRadar(activity.company,activity);

      /*
      INSTITUTIONAL FLOW ENGINE
      */

      const flow = institutionalFlowEngine(activity);

      if(flow){

        updateRadar(flow.company,flow);

        ioRef.emit("smart_money",flow);

      }

      ioRef.emit("institutional_activity",activity);

    }

  }
  catch(err){

    console.log("❌ NSE Deals fetch failed:",err.message);

  }

}

module.exports = startNSEDealsListener;