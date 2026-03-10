const { addOrder } = require("../data/orderBookStore");
const { getMarketCap } = require("../data/marketCap");

function orderBookEngine(signal) {
  if (signal.type !== "ORDER_ALERT") return null;

  const value = signal.value || signal.orderValue || 50;
  const code = String(signal.code);

  const data = addOrder(code, value);

  const marketCap = getMarketCap(code) || 0;
  let percentage = 0;
  if (marketCap) {
    percentage = ((value / marketCap) * 100).toFixed(2);
  }

  let strength = "NORMAL";
  if (percentage >= 25) strength = "EXTREME";
  else if (percentage >= 15) strength = "VERY STRONG";
  else if (percentage >= 7) strength = "STRONG";
  else if (percentage >= 3) strength = "MODERATE";

  return {
    company: signal.company,
    code,
    orderValue: value,
    totalOrderBook: data.totalOrderValue,
    orders: data.orders.length,
    percentage,
    strength,
    time: signal.time
  };
}

module.exports = orderBookEngine;