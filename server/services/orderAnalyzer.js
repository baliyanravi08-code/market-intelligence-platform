const detectOrder = require("./intelligence/orderDetector");
const classifyAnnouncement = require("./intelligence/aiClassifier");

async function analyzeAnnouncement(announcement) {

  const order = detectOrder(announcement.title);

  if (order) {

    return {
      type: "ORDER_ALERT",
      company: announcement.company,
      code: announcement.code,
      newOrder: order,
      title: announcement.title
    };

  }

  const aiEvent = classifyAnnouncement(announcement.title);

  if (aiEvent) {

    return {
      type: "AI_EVENT",
      company: announcement.company,
      code: announcement.code,
      event: aiEvent,
      title: announcement.title
    };

  }

  return null;

}

module.exports = analyzeAnnouncement;