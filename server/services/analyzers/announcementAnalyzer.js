const detectOrder = require("../intelligence/orderDetector");
const classifyAnnouncement = require("../intelligence/aiClassifier");
const extractOrderFromPDF = require("../intelligence/pdfEngine");

async function analyzeAnnouncement(announcement) {

  const order = detectOrder(announcement.title);

  if (order) {

    return {
      type: "ORDER_ALERT",
      company: announcement.company,
      code: announcement.code,
      value: order.orderValueCrore,
      source: "headline",
      title: announcement.title
    };

  }

  if (announcement.pdfUrl) {

    const pdfOrder = await extractOrderFromPDF(announcement.pdfUrl);

    if (pdfOrder) {

      return {
        type: "ORDER_ALERT",
        company: announcement.company,
        code: announcement.code,
        value: pdfOrder.value,
        source: "pdf",
        title: announcement.title
      };

    }

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