const sectorMap = require("../data/sectorMap");

const sectorOrders = new Map();

function sectorBoomEngine(signal) {

  if (signal.type !== "ORDER_ALERT") return null;

  const sector = sectorMap[signal.code];

  if (!sector) return null;

  if (!sectorOrders.has(sector)) {
    sectorOrders.set(sector, []);
  }

  const list = sectorOrders.get(sector);

  list.push({
    company: signal.company,
    value: signal.value,
    time: Date.now()
  });

  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  const recent = list.filter(
    o => Date.now() - o.time < sevenDays
  );

  sectorOrders.set(sector, recent);

  if (recent.length >= 3) {

    const total = recent.reduce((sum, o) => sum + o.value, 0);

    return {
      sector,
      companies: recent.length,
      totalValue: total,
      signal: "SECTOR_ORDER_BOOM"
    };

  }

  return null;

}

module.exports = sectorBoomEngine;