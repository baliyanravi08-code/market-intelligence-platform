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

  // ── Use actual crore value, not signal score ──
  // If no crore in headline, don't add 0 — just count the order
  const crores = signal._orderInfo?.crores;
  if (crores && crores > 0) {
    q.totalValue += crores;
  }

  q.lastUpdated = Date.now();

  return { sector, ...q };
}

module.exports = sectorQueue;