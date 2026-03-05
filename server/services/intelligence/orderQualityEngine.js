const marketCaps = require("../data/marketCap");

function orderQualityEngine(signal){

  if(signal.type !== "ORDER_ALERT") return null;

  const marketCap = marketCaps[signal.code];

  if(!marketCap) return null;

  const percentage = (signal.value / marketCap) * 100;

  if(percentage >= 30){

    return {
      company: signal.company,
      code: signal.code,
      orderValue: signal.value,
      marketCap,
      percentage: percentage.toFixed(2),
      signal: "ORDER_QUALITY"
    };

  }

  return null;

}

module.exports = orderQualityEngine;