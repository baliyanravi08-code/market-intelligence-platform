function sectorRadar(queue) {
  if (!queue) return null;
  if (queue.orders < 1) return null;

  return {
    sector: queue.sector,
    orders: queue.orders,
    companies: queue.companies,
    totalValue: queue.totalValue,
    isBoom: queue.orders >= 3,
    lastUpdate: new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })
  };
}

module.exports = sectorRadar;