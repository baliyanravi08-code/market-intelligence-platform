/*
MARKET CAP DATABASE
values in crore
*/

const marketCaps = {

  540750: 1200,
  532895: 850,
  533152: 4500,
  532343: 920,
  532706: 1500,
  500238: 2100,
  532370: 640,
  539300: 780,
  543326: 900,
  531780: 1100

};

function getMarketCap(code){

  return marketCaps[code] || null;

}

module.exports = {
  getMarketCap
};