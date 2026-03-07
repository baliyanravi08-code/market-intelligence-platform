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
      title: announcement.title,
      pdfUrl: announcement.pdfUrl
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
        title: announcement.title,
        pdfUrl: announcement.pdfUrl
      };

    }

  }

  const aiEvent = classifyAnnouncement(announcement.title);

  if (aiEvent) {

    return {
      type: "AI_EVENT",
      company: announcement.company,
      code: announcement.code,
      signal: aiEvent,
      title: announcement.title,
      pdfUrl: announcement.pdfUrl
    };

  }

  return null;

}

module.exports = analyzeAnnouncement;