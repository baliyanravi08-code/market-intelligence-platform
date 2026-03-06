function sectorBoomEngine(sectorData){

  if(!sectorData) return null;

  if(sectorData.orders >= 3){

    return {
      signal:"SECTOR_BOOM",
      sector:sectorData.sector,
      orders:sectorData.orders,
      companies:sectorData.companies,
      totalValue:sectorData.value
    };

  }

  return null;

}

module.exports = sectorBoomEngine;