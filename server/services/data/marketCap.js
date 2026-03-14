/*
  COMPANY DATA — MCap + Order Book + Revenue
  Values in crore (INR).
  confirmedOrderBook = from last quarterly result filing
  confirmedQuarter   = which quarter it was confirmed
  ttmRevenue         = trailing 12 month revenue
*/

const companyData = {

  // ── WATER / EPC ──
  "533269": { mcap: 8091,   confirmedOrderBook: 16300, confirmedQuarter: "Q3FY26", ttmRevenue: 4200,  name: "VA Tech Wabag" },
  "500510": { mcap: 280000, confirmedOrderBook: 450000,confirmedQuarter: "Q3FY26", ttmRevenue: 220000,name: "L&T" },
  "532898": { mcap: 22000,  confirmedOrderBook: 180000,confirmedQuarter: "Q3FY26", ttmRevenue: 6500,  name: "IRFC" },
  "542649": { mcap: 12000,  confirmedOrderBook: 85000, confirmedQuarter: "Q3FY26", ttmRevenue: 4200,  name: "RVNL" },

  // ── DEFENSE ──
  "540678": { mcap: 48000,  confirmedOrderBook: 94000, confirmedQuarter: "Q3FY26", ttmRevenue: 28000, name: "HAL" },
  "541143": { mcap: 32000,  confirmedOrderBook: 68000, confirmedQuarter: "Q3FY26", ttmRevenue: 18000, name: "BEL" },
  "500024": { mcap: 15000,  confirmedOrderBook: 19000, confirmedQuarter: "Q3FY26", ttmRevenue: 3200,  name: "Bharat Dynamics" },

  // ── POWER ──
  "500400": { mcap: 320000, confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 180000,name: "NTPC" },
  "532155": { mcap: 18000,  confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 12000, name: "CESC" },
  "533122": { mcap: 35000,  confirmedOrderBook: 12000, confirmedQuarter: "Q3FY26", ttmRevenue: 3800,  name: "Inox Wind" },

  // ── IT ──
  "532174": { mcap: 1400000,confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 153000,name: "Infosys" },
  "507685": { mcap: 12000,  confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 14000, name: "Mphasis" },

  // ── PHARMA ──
  "500124": { mcap: 210000, confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 28000, name: "Dr Reddy" },
  "500087": { mcap: 190000, confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 25000, name: "Cipla" },

  // ── BANKING ──
  "500180": { mcap: 1200000,confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 250000,name: "HDFC Bank" },
  "500247": { mcap: 380000, confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 52000, name: "Kotak Mahindra" },

  // ── STEEL ──
  "500470": { mcap: 230000, confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 220000,name: "Tata Steel" },
  "500295": { mcap: 95000,  confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 220000,name: "Hindalco" },

  // ── CEMENT ──
  "500387": { mcap: 480000, confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 68000, name: "UltraTech" },
  "532538": { mcap: 95000,  confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 18000, name: "Shree Cement" },

  // ── AUTO ──
  "500520": { mcap: 320000, confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 125000,name: "M&M" },
  "532500": { mcap: 270000, confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 140000,name: "Maruti" },

  // ── SMALL CAPS ──
  "500238": { mcap: 2100,   confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: null,  name: null },
  "532370": { mcap: 640,    confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: null,  name: null },
  "540750": { mcap: 1200,   confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: null,  name: null },
  "532895": { mcap: 850,    confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: null,  name: null },
  "533152": { mcap: 4500,   confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: null,  name: null },
  "532343": { mcap: 920,    confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: null,  name: null },
  "532706": { mcap: 1500,   confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: null,  name: null },
  "539300": { mcap: 780,    confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: null,  name: null },
  "543326": { mcap: 900,    confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: null,  name: null },
  "531780": { mcap: 1100,   confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: null,  name: null },
};

// ── Runtime updates from result filings ──
// When quarterly result is parsed, this gets updated automatically
const runtimeUpdates = {};

function getMarketCap(code) {
  const c = String(code);
  return (runtimeUpdates[c]?.mcap) || companyData[c]?.mcap || null;
}

function getCompanyData(code) {
  const c = String(code);
  const base = companyData[c] || {};
  const runtime = runtimeUpdates[c] || {};
  return { ...base, ...runtime };
}

// Called by resultAnalyzer when quarterly result is parsed
function updateFromResult(code, fields) {
  const c = String(code);
  if (!runtimeUpdates[c]) runtimeUpdates[c] = {};
  Object.assign(runtimeUpdates[c], fields, { lastResultUpdate: Date.now() });
  console.log(`📊 Company data updated for ${c}:`, fields);
}

// Called by orderBookEngine for each new order
function getEstimatedOrderBook(code) {
  const c = String(code);
  const data = getCompanyData(c);
  const runtime = runtimeUpdates[c] || {};

  const confirmed = data.confirmedOrderBook || 0;
  const newOrders = runtime.newOrdersSinceConfirm || 0;
  const executedEst = data.ttmRevenue ? Math.round(data.ttmRevenue / 4) : 0;

  if (!confirmed) return null; // no baseline — don't guess

  return {
    estimated: confirmed + newOrders - executedEst,
    confirmed,
    confirmedQuarter: data.confirmedQuarter,
    newOrders,
    executedEst,
    obToRevRatio: data.ttmRevenue ? ((confirmed + newOrders) / data.ttmRevenue).toFixed(1) : null,
    bookToBill: data.ttmRevenue && newOrders
      ? (newOrders / (data.ttmRevenue / 4)).toFixed(2)
      : null
  };
}

// Add new order to runtime counter
function addNewOrder(code, crores) {
  const c = String(code);
  if (!runtimeUpdates[c]) runtimeUpdates[c] = {};
  runtimeUpdates[c].newOrdersSinceConfirm =
    (runtimeUpdates[c].newOrdersSinceConfirm || 0) + crores;
}

module.exports = {
  getMarketCap,
  getCompanyData,
  updateFromResult,
  getEstimatedOrderBook,
  addNewOrder
};