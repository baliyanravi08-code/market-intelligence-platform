const { getMarketCap } = require("../data/marketCap");

function orderQualityEngine(signal){

  if(signal.type !== "ORDER_ALERT") return null;

  const marketCap = getMarketCap(signal.code);

  if(!marketCap) return null;

  const percentage = (signal.newOrder / marketCap) * 100;

  if(percentage >= 20){

    return {
      company: signal.company,
      code: signal.code,
      orderValue: signal.newOrder,
      marketCap,
      percentage: percentage.toFixed(2),
      signal: "ORDER_QUALITY"
    };

  }

  return null;

}

module.exports = orderQualityEngine;