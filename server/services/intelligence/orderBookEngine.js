const orderBooks = {};

function updateOrderBook(signal, marketCap) {

  const company = signal.company || signal.code;

  if (!orderBooks[company]) {

    orderBooks[company] = {
      totalOrders: 0,
      history: []
    };

  }

  const newOrder = signal.newOrder || 0;

  orderBooks[company].totalOrders += newOrder;

  orderBooks[company].history.push({
    value: newOrder,
    date: new Date()
  });

  const orderBook = orderBooks[company].totalOrders;

  let orderToMcap = null;

  if (marketCap) {

    orderToMcap = (orderBook / marketCap) * 100;

  }

  return {
    company,
    newOrder,
    orderBook,
    orderToMcap
  };

}

function getOrderBook(company) {

  return orderBooks[company] || null;

}

module.exports = {
  updateOrderBook,
  getOrderBook
};