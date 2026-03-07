const { addOrder } = require("../data/orderBookStore");

function orderBookEngine(signal){

  if(signal.type !== "ORDER_ALERT") return null;

  const value = signal.value;

  if(!value) return null;

  const data = addOrder(signal.code,value);

  return {
    company: signal.company,
    value,
    totalOrderValue: data.totalOrderValue,
    orders: data.orders.length
  };

}

module.exports = orderBookEngine;