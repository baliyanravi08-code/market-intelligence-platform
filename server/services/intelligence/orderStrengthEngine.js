const { getOrderBook } = require("../data/orderBookStore");
const { getMarketCap } = require("../data/marketCap");

function orderStrengthEngine(companyCode) {

  const orderBook = getOrderBook(companyCode);
  const marketCap = getMarketCap(companyCode);

  if (!orderBook || !marketCap) return null;

  const ratio = (orderBook.totalValue / marketCap) * 100;

  let strength = "NORMAL";

  if (ratio >= 100) strength = "EXTREME";
  else if (ratio >= 60) strength = "VERY_STRONG";
  else if (ratio >= 30) strength = "STRONG";
  else if (ratio >= 15) strength = "MODERATE";

  return {
    companyCode,
    orderBook: orderBook.totalValue,
    marketCap,
    ratio: Number(ratio.toFixed(2)),
    strength
  };

}

module.exports = orderStrengthEngine;