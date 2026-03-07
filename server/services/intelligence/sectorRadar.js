function sectorRadar(queue){

  if(!queue) return null;

  if(queue.orders < 3) return null;

  return {
    sector: queue.sector,
    orders: queue.orders,
    companies: queue.companies,
    totalValue: queue.totalValue
  };

}

module.exports = sectorRadar;