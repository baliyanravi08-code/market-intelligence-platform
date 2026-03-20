function sectorRadar(queue) {
  if (!queue) return null;
  if (queue.orders < 1) return null;

  // ── Boom threshold by sector ──
  // High-activity sectors need more orders to trigger boom
  const BOOM_THRESHOLDS = {
    "Infrastructure": 3,
    "Railway":        3,
    "Defense":        2,
    "Solar":          3,
    "Energy":         3,
    "Water":          2,
    "IT":             4,
    "Pharma":         4,
    "Banking":        5,
    "Metals":         3,
  };

  const threshold = BOOM_THRESHOLDS[queue.sector] || 3;
  const isBoom    = queue.orders >= threshold;

  // ── Value label ──
  // If totalValue is 0 (orders with no headline amount), show order count only
  const hasValue = queue.totalValue > 0;

  return {
    sector:     queue.sector,
    orders:     queue.orders,
    companies:  queue.companies,
    totalValue: hasValue ? queue.totalValue : null,
    isBoom,
    lastUpdate: new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })
  };
}

module.exports = sectorRadar;