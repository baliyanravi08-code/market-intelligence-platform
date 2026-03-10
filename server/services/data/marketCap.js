/*
  MARKET CAP DATABASE
  Values in crore (INR).
  Replace/expand with a live API call when available.
  Source: Approximate values as of early 2025.
*/

const marketCaps = {

  // Infrastructure
  "500510": 280000,  // L&T
  "532540": 95000,   // Siemens
  "500209": 62000,   // Hindustan Construction

  // Power
  "500400": 320000,  // NTPC
  "532155": 18000,   // CESC
  "533122": 35000,   // Inox Wind

  // Railway
  "532898": 22000,   // IRFC
  "542649": 12000,   // RVNL
  "543543": 8500,    // Rail Vikas Nigam

  // Defense
  "540678": 48000,   // HAL
  "541143": 32000,   // BEL
  "500024": 15000,   // Bharat Dynamics

  // Energy
  "500325": 420000,  // Reliance
  "500312": 180000,  // ONGC
  "532337": 75000,   // Petronet LNG

  // IT
  "532174": 1400000, // Infosys
  "500696": 830000,  // Wipro (also mapped to FMCG — use carefully)
  "507685": 12000,   // Mphasis

  // Pharma
  "500124": 210000,  // Dr Reddy
  "500087": 190000,  // Cipla
  "524804": 45000,   // Alkem

  // Banking
  "500180": 1200000, // HDFC Bank
  "500247": 380000,  // Kotak Mahindra

  // Steel
  "500470": 230000,  // Tata Steel
  "500295": 95000,   // Hindalco
  "500790": 420000,  // JSW Steel

  // Cement
  "500387": 480000,  // UltraTech
  "532538": 95000,   // Shree Cement
  "500425": 76000,   // Ambuja

  // Auto
  "500520": 320000,  // M&M
  "532500": 270000,  // Maruti
  "500182": 58000,   // Hero MotoCorp

  // Small caps from original
  "500238": 2100,
  "532370": 640,
  "540750": 1200,
  "532895": 850,
  "533152": 4500,
  "532343": 920,
  "532706": 1500,
  "539300": 780,
  "543326": 900,
  "531780": 1100

};

function getMarketCap(code) {
  return marketCaps[String(code)] || null;
}

module.exports = { getMarketCap };