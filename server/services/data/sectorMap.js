const sectorMap = {

  "500510": "Infrastructure", // Larsen & Toubro
  "532540": "Infrastructure", // KNR Constructions
  "500400": "Power",
  "532898": "Railway",
  "540678": "Defense",
  "500325": "Energy",
  "532174": "IT",
  "532215": "Pharma"

};

function getSector(code) {

  return sectorMap[code] || "Unknown";

}

module.exports = getSector;