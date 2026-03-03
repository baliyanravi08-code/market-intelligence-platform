const axios = require("axios");

let lastTime = null;

async function getBSEData() {

 try {

  const res = await axios.get(
   "https://query1.finance.yahoo.com/v7/finance/quote?symbols=RELIANCE.NS,TCS.NS,HDFCBANK.NS,SBIN.NS,INFY.NS",
   { timeout:15000 }
  );

  const quotes =
   res.data.quoteResponse.result;

  if(!quotes.length) return null;

  const random =
   quotes[Math.floor(
    Math.random()*quotes.length
   )];

  const now =
   new Date().toLocaleTimeString();

  if(now === lastTime)
   return null;

  lastTime = now;

  return {
   company:random.symbol,
   sector:"Market",
   strengthScore:
    Math.floor(Math.random()*100),
   marketStatus:
    random.regularMarketChangePercent>0
     ?"Bullish":"Bearish",
   time:now
  };

 } catch(err){

  console.log("❌ Market Feed Failed");
  return null;
 }
}

module.exports = getBSEData;