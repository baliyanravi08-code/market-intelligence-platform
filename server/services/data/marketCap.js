const axios = require("axios");

async function getMarketCap(symbol) {

  try {

    const url =
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbol}.NS`;

    const res = await axios.get(url);

    const data = res.data.quoteResponse.result[0];

    if (!data) return null;

    const marketCap = data.marketCap || 0;

    return marketCap / 10000000; // convert to crore

  } catch {

    return null;

  }

}

module.exports = getMarketCap;