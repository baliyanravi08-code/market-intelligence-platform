const axios = require("axios");

async function getMarketCap(symbol){

 try{

  const url =
   `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbol}.NS`;

  const res =
   await axios.get(url,{timeout:10000});

  const data =
   res.data.quoteResponse.result[0];

  if(!data)
   return null;

  return{
   marketCap:data.marketCap,
   price:data.regularMarketPrice
  };

 }catch(err){

  console.log("Marketcap fetch failed");

  return null;
 }

}

module.exports = getMarketCap;