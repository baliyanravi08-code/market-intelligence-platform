const detectOrder = require("./intelligence/orderDetector");
const detectMarketEvent = require("./intelligence/marketRadar");

function analyzeAnnouncement(announcement) {

  const order = detectOrder(announcement.title);

  if (order) {

    return {
      type: "ORDER_ALERT",
      company: announcement.company,
      code: announcement.code,
      orderValueCrore: order.orderValueCrore,
      impact: classifyImpact(order.orderValueCrore),
      title: announcement.title,
      date: announcement.date
    };

  }

  const event = detectMarketEvent(announcement);

  if (event) {

    return {
      type: event.type,
      priority: event.priority,
      company: announcement.company,
      code: announcement.code,
      title: announcement.title,
      date: announcement.date
    };

  }

  return null;

}

function classifyImpact(value) {

  if (value > 500) return "VERY_HIGH";
  if (value > 100) return "HIGH";
  if (value > 20) return "MEDIUM";
  return "LOW";

}

module.exports = analyzeAnnouncement;