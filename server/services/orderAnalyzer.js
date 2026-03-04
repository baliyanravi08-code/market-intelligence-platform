const detectOrder = require("./intelligence/orderDetector");

function analyzeAnnouncement(announcement) {

  const order = detectOrder(announcement.title);

  if (!order) return null;

  const impact = classifyImpact(order.orderValueCrore);

  return {

    type: "ORDER_ALERT",

    company: announcement.company,
    code: announcement.code,

    orderValueCrore: order.orderValueCrore,

    impact: impact,

    title: announcement.title,
    date: announcement.date

  };

}

function classifyImpact(value) {

  if (value >= 500) return "VERY_HIGH";
  if (value >= 100) return "HIGH";
  if (value >= 20) return "MEDIUM";
  return "LOW";

}

module.exports = analyzeAnnouncement;