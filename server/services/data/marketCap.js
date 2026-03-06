/*
MARKET CAP DATABASE
(values in crore)
This can later be replaced with a live API
*/

const marketCaps = {

  500238: 2100,
  532370: 640,
  540750: 1200,
  532895: 850,
  533152: 4500,
  532343: 920,
  532706: 1500,
  539300: 780,
  543326: 900,
  531780: 1100

};

function getMarketCap(code){

  const cap = marketCaps[code];

  if(!cap) return null;

  return cap;

}

module.exports = {
  getMarketCap
};