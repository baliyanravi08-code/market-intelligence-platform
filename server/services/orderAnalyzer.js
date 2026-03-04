const detectOrder = require("./intelligence/orderDetector");
const classifyAnnouncement = require("./intelligence/aiClassifier");
const { addOrder } = require("./data/orderBookStore");
const getMarketCap = require("./data/marketCap");

async function analyzeAnnouncement(announcement) {

  const text = announcement.title;

  const order = detectOrder(text);

  if (order) {

    const orderValue = order.orderValueCrore;

    const book = addOrder(announcement.code, orderValue);

    const marketCap = await getMarketCap(announcement.code);

    let impactPercent = null;

    if (marketCap && marketCap > 0) {
      impactPercent = ((book.totalOrderValue / marketCap) * 100).toFixed(2);
    }

    return {
      type: "ORDER_ALERT",
      company: announcement.company,
      code: announcement.code,
      newOrder: orderValue,
      totalOrderBook: book.totalOrderValue,
      impactPercent: impactPercent,
      title: announcement.title,
      date: announcement.date
    };

  }

  const aiEvent = classifyAnnouncement(text);

  if (!aiEvent) return null;

  return {
    type: aiEvent,
    company: announcement.company,
    code: announcement.code,
    title: announcement.title,
    date: announcement.date
  };

}

module.exports = analyzeAnnouncement;