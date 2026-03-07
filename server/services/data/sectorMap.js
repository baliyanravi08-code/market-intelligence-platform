const sectorMap = {

  "500510": "Infrastructure",
  "532540": "Infrastructure",
  "500400": "Power",
  "532898": "Railway",
  "540678": "Defense",
  "500325": "Energy",
  "532174": "IT",
  "532215": "Pharma"

};

module.exports = function(code){
  return sectorMap[code] || null;
};