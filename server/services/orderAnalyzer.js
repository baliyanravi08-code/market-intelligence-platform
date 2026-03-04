const detectOrder = require("./intelligence/orderDetector");
const { addOrder } = require("./data/orderBookStore");
const getMarketCap = require("./data/marketCap");

async function analyzeAnnouncement(announcement) {

  const order = detectOrder(announcement.title);

  if (!order) return null;

  const orderValue = order.orderValueCrore;

  const book = addOrder(announcement.code, orderValue);

  const marketCap = await getMarketCap(announcement.code);

  let impactPercent = null;

  if (marketCap && marketCap > 0) {

    impactPercent = ((book.totalOrderValue / marketCap) * 100).toFixed(2);

  }

  return {

    type: "ORDER_UPDATE",

    company: announcement.company,
    code: announcement.code,

    newOrder: orderValue,

    totalOrderBook: book.totalOrderValue,

    impactPercent: impactPercent,

    title: announcement.title,
    date: announcement.date

  };

}

module.exports = analyzeAnnouncement;