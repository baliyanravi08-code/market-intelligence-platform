const orderBooks = new Map();

function addOrder(companyCode, orderValueCrore) {

  if (!orderBooks.has(companyCode)) {

    orderBooks.set(companyCode, {
      totalOrderValue: 0,
      orders: []
    });

  }

  const data = orderBooks.get(companyCode);

  data.orders.push({
    value: orderValueCrore,
    time: new Date()
  });

  data.totalOrderValue += orderValueCrore;

  return data;

}

function getOrderBook(companyCode) {

  return orderBooks.get(companyCode);

}

module.exports = {
  addOrder,
  getOrderBook
};