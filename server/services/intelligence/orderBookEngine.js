const { addOrder } = require("../data/orderBookStore");

function orderBookEngine(signal) {

  if (signal.type !== "ORDER_ALERT") return null;

  const orderData = addOrder(signal.code, signal.value);

  return {
    company: signal.company,
    code: signal.code,
    totalOrderValue: orderData.totalValue,
    orderCount: orderData.orderCount,
    lastOrder: signal.value
  };

}

module.exports = orderBookEngine;