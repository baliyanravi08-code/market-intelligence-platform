const getSector = require("../data/sectorMap");

const sectorStats = {};

function updateSectorRadar(orderEvent) {

  const sector = getSector(orderEvent.code);

  if (!sectorStats[sector]) {

    sectorStats[sector] = {
      totalOrders: 0,
      totalValue: 0
    };

  }

  sectorStats[sector].totalOrders += 1;
  sectorStats[sector].totalValue += orderEvent.newOrder;

  return {

    sector: sector,
    orders: sectorStats[sector].totalOrders,
    value: sectorStats[sector].totalValue

  };

}

module.exports = updateSectorRadar;