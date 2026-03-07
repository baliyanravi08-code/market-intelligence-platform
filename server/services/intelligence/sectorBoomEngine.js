function sectorBoomEngine(queue){

  if(!queue) return null;

  if(queue.orders < 5) return null;

  return {
    sector: queue.sector,
    companies: queue.companies,
    totalValue: queue.totalValue,
    signal:"SECTOR_BOOM"
  };

}

module.exports = sectorBoomEngine;