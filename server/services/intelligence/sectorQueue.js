const { getSector } = require("../data/sectorMap");

const queues = {};

function sectorQueue(signal) {
  const sector = getSector(signal.code, signal.company);
  if (!sector) return null;

  if (!queues[sector]) {
    queues[sector] = {
      orders:      0,
      totalValue:  0,
      companies:   [],
      lastUpdated: Date.now()
    };
  }

  const q = queues[sector];

  if (!q.companies.includes(signal.company)) {
    q.companies.push(signal.company);
  }

  q.orders++;

  // ── FIX: use actual crore value not signal score ──
  // signal.value = score (30, 40, 82) — NOT money
  // signal._orderInfo.crores = actual ₹ amount
  const crores = signal._orderInfo?.crores || 0;
  q.totalValue += crores;

  q.lastUpdated = Date.now();

  return { sector, ...q };
}

module.exports = sectorQueue;