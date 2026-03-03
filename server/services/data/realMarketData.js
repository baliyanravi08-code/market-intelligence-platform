const axios = require("axios");

let lastCompany = null;

async function getRealMarketData(){

 try{

  const res = await axios.get(
   "https://query1.finance.yahoo.com/v7/finance/quote?symbols=RELIANCE.NS,TCS.NS,SBIN.NS,HDFCBANK.NS,INFY.NS",
   { timeout:10000 }
  );

  const stocks =
   res.data.quoteResponse.result;

  if(!stocks.length)
   return null;

  const random =
   stocks[Math.floor(
    Math.random()*stocks.length
   )];

  if(random.symbol === lastCompany)
   return null;

  lastCompany = random.symbol;

  return{
   company:random.symbol,
   sector:"Market",
   profitChange:
    Math.floor(Math.random()*20)-10,
   revenueChange:
    Math.floor(Math.random()*20),
   otherExpense:
    Math.floor(Math.random()*20),
   provisions:
    Math.floor(Math.random()*20),
   newOrders:
    Math.floor(Math.random()*50)
  };

 }catch(err){

  console.log("⚠ Real Market Blocked");

  return null;
 }

}

module.exports = getRealMarketData;