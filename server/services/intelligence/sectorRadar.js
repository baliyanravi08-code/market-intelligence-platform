const sectorMap = require("../data/sectorMap");

const sectorState = {};

/*
TRACK SECTOR ACTIVITY
*/

function sectorRadar(signal){

  if(signal.type !== "ORDER_ALERT") return null;

  const sector = sectorMap[signal.code];

  if(!sector) return null;

  if(!sectorState[sector]){

    sectorState[sector] = {
      sector,
      orders:0,
      value:0,
      companies:new Set()
    };

  }

  const data = sectorState[sector];

  data.orders += 1;
  data.value += signal.newOrder || 0;
  data.companies.add(signal.company);

  return {
    sector,
    orders:data.orders,
    value:data.value,
    companies:Array.from(data.companies)
  };

}

module.exports = sectorRadar;