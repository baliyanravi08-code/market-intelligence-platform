function detectMarketEvent(announcement) {

  const text = (announcement.title || "").toLowerCase();

  if (!text) return null;

  if (text.includes("order") || text.includes("contract")) {

    return {
      type: "ORDER_NEWS",
      priority: "HIGH"
    };

  }

  if (text.includes("result") || text.includes("financial results")) {

    return {
      type: "RESULT_NEWS",
      priority: "HIGH"
    };

  }

  if (text.includes("dividend")) {

    return {
      type: "DIVIDEND_NEWS",
      priority: "MEDIUM"
    };

  }

  if (text.includes("board meeting")) {

    return {
      type: "BOARD_MEETING",
      priority: "LOW"
    };

  }

  if (text.includes("promoter")) {

    return {
      type: "PROMOTER_ACTIVITY",
      priority: "HIGH"
    };

  }

  return null;

}

module.exports = detectMarketEvent;