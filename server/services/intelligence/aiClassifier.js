function classifyAnnouncement(text) {

  if (!text) return null;

  const t = text.toLowerCase();

  if (
    t.includes("order") ||
    t.includes("contract") ||
    t.includes("work order")
  ) {
    return "ORDER_ALERT";
  }

  if (
    t.includes("capacity expansion") ||
    t.includes("expansion") ||
    t.includes("new plant") ||
    t.includes("increase capacity")
  ) {
    return "CAPACITY_EXPANSION";
  }

  if (
    t.includes("acquisition") ||
    t.includes("merger") ||
    t.includes("takeover") ||
    t.includes("amalgamation")
  ) {
    return "MERGER_ACQUISITION";
  }

  if (
    t.includes("government") ||
    t.includes("ministry") ||
    t.includes("psu") ||
    t.includes("public sector")
  ) {
    return "GOVERNMENT_CONTRACT";
  }

  if (
    t.includes("approval") ||
    t.includes("regulatory") ||
    t.includes("clearance") ||
    t.includes("nod from")
  ) {
    return "REGULATORY_APPROVAL";
  }

  if (
    t.includes("financial results") ||
    t.includes("results") ||
    t.includes("earnings")
  ) {
    return "RESULT_NEWS";
  }

  return null;

}

module.exports = classifyAnnouncement;