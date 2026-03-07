const sectorMap = require("../data/sectorMap");

const queues = {};

function sectorQueue(signal){

  if(signal.type !== "ORDER_ALERT") return null;

  const sector = sectorMap[signal.code];

  if(!sector) return null;

  if(!queues[sector]){

    queues[sector] = {
      sector,
      orders:0,
      totalValue:0,
      companies:[],
      lastUpdate:Date.now()
    };

  }

  const q = queues[sector];

  q.orders += 1;
  q.totalValue += signal.newOrder || 0;

  if(!q.companies.includes(signal.company)){
    q.companies.push(signal.company);
  }

  q.lastUpdate = Date.now();

  return q;

}

module.exports = sectorQueue;