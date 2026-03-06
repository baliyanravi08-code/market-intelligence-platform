const sectorMap = require("../data/sectorMap");

const sectors = {};

function sectorRadar(signal){

  if(signal.type !== "ORDER_ALERT") return null;

  const sector = sectorMap[signal.code];

  if(!sector) return null;

  if(!sectors[sector]){

    sectors[sector] = {
      sector,
      orders:0,
      totalValue:0,
      companies:[]
    };

  }

  sectors[sector].orders += 1;

  sectors[sector].totalValue += signal.newOrder || 0;

  if(!sectors[sector].companies.includes(signal.company)){
    sectors[sector].companies.push(signal.company);
  }

  return sectors[sector];

}

module.exports = sectorRadar;