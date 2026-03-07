const { addOrder } = require("../data/orderBookStore");

function orderBookEngine(signal){

  if(signal.type !== "ORDER_ALERT") return null;

  const value =
    signal.value ||
    signal.orderValueCrore ||
    signal.newOrder;

  if(!value) return null;

  const data = addOrder(String(signal.code), value);

  return {
    company: signal.company,
    value,
    totalOrderValue: data.totalOrderValue,
    orders: data.orders.length
  };

}

module.exports = orderBookEngine;