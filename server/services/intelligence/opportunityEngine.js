const { getMarketCap } = require("../data/marketCap");

function opportunityEngine(signal) {
  if (signal.type !== "ORDER_ALERT") return null;

  const cap = getMarketCap(signal.code);
  if (!cap) return null;

  const ratio = (signal.value / cap) * 100;

  if (ratio > 20) {
    return {
      company: signal.company,
      code: signal.code,
      score: ratio.toFixed(2),
      signal: "MULTIBAGGER_SIGNAL",
      orderValue: signal.value,
      marketCap: cap,
      time: signal.time
    };
  }

  return null;
}

module.exports = opportunityEngine;