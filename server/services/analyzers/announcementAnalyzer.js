const detectOrder = require("../intelligence/orderDetector");
const classifyAnnouncement = require("../intelligence/aiClassifier");

async function analyzeAnnouncement(announcement) {

  const orderValue = detectOrder(announcement.title);

  if (orderValue) {

    return {
      type: "ORDER_ALERT",
      company: announcement.company,
      code: announcement.code,
      value: orderValue,
      title: announcement.title,
      time: new Date()
    };

  }

  const aiEvent = classifyAnnouncement(announcement.title);

  if (aiEvent) {

    return {
      type: "AI_EVENT",
      company: announcement.company,
      code: announcement.code,
      event: aiEvent,
      title: announcement.title,
      time: new Date()
    };

  }

  return null;

}

module.exports = analyzeAnnouncement;