/**
 * marketCap.js
 * Company data store with persistent quarter-by-quarter order book tracking.
 * Saves to disk so order book history survives server restarts.
 */

const fs   = require("fs");
const path = require("path");

const OB_FILE = path.join(__dirname, "../../data/orderBookHistory.json");

// ── Static baseline data ──
const companyData = {
  // WATER / EPC
  "533269": { mcap: 8091,   confirmedOrderBook: 16300, confirmedQuarter: "Q3FY26", ttmRevenue: 4200,  name: "VA Tech Wabag" },
  "500510": { mcap: 280000, confirmedOrderBook: 450000,confirmedQuarter: "Q3FY26", ttmRevenue: 220000,name: "L&T" },
  "532898": { mcap: 22000,  confirmedOrderBook: 180000,confirmedQuarter: "Q3FY26", ttmRevenue: 6500,  name: "IRFC" },
  "542649": { mcap: 12000,  confirmedOrderBook: 85000, confirmedQuarter: "Q3FY26", ttmRevenue: 4200,  name: "RVNL" },
  // DEFENSE
  "540678": { mcap: 48000,  confirmedOrderBook: 94000, confirmedQuarter: "Q3FY26", ttmRevenue: 28000, name: "HAL" },
  "541143": { mcap: 32000,  confirmedOrderBook: 68000, confirmedQuarter: "Q3FY26", ttmRevenue: 18000, name: "BEL" },
  "500024": { mcap: 15000,  confirmedOrderBook: 19000, confirmedQuarter: "Q3FY26", ttmRevenue: 3200,  name: "Bharat Dynamics" },
  // POWER
  "500400": { mcap: 320000, confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 180000,name: "NTPC" },
  "533122": { mcap: 35000,  confirmedOrderBook: 12000, confirmedQuarter: "Q3FY26", ttmRevenue: 3800,  name: "Inox Wind" },
  // IT
  "532174": { mcap: 1400000,confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 153000,name: "Infosys" },
  // PHARMA
  "500124": { mcap: 210000, confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 28000, name: "Dr Reddy" },
  "500087": { mcap: 190000, confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 25000, name: "Cipla" },
  // BANKING
  "500180": { mcap: 1200000,confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 250000,name: "HDFC Bank" },
  "500247": { mcap: 380000, confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 52000, name: "Kotak Mahindra" },
  // STEEL
  "500470": { mcap: 230000, confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 220000,name: "Tata Steel" },
  "500295": { mcap: 95000,  confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 220000,name: "Hindalco" },
  // CEMENT
  "500387": { mcap: 480000, confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 68000, name: "UltraTech" },
  // AUTO
  "500520": { mcap: 320000, confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 125000,name: "M&M" },
  "532500": { mcap: 270000, confirmedOrderBook: null,  confirmedQuarter: null,     ttmRevenue: 140000,name: "Maruti" },
};

// ── Runtime updates (in-memory, loaded from disk on startup) ──
// Structure per code:
// {
//   mcap, ttmRevenue,
//   confirmedOrderBook, confirmedQuarter,  ← from latest result filing
//   newOrdersSinceConfirm,                 ← sum of orders detected since last result
//   quarterHistory: [                      ← full quarter-by-quarter history
//     { quarter, confirmedOrderBook, addedOrders, totalOrderBook, timestamp }
//   ]
// }
let runtimeUpdates = {};

// ── Load from disk ──
function loadFromDisk() {
  try {
    if (fs.existsSync(OB_FILE)) {
      const raw  = fs.readFileSync(OB_FILE, "utf8");
      runtimeUpdates = JSON.parse(raw);
      const count = Object.keys(runtimeUpdates).length;
      console.log(`📦 OrderBook history loaded: ${count} companies`);
    }
  } catch(e) {
    console.log("⚠️ OrderBook history load failed:", e.message);
    runtimeUpdates = {};
  }
}

function saveToDisk() {
  try {
    const dir = path.dirname(OB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(OB_FILE, JSON.stringify(runtimeUpdates), "utf8");
  } catch(e) {
    console.log("⚠️ OrderBook history save failed:", e.message);
  }
}

loadFromDisk();
setInterval(saveToDisk, 5 * 60 * 1000); // auto-save every 5 min

// ── Get MCap ──
function getMarketCap(code) {
  const c = String(code);
  return runtimeUpdates[c]?.mcap || companyData[c]?.mcap || null;
}

// ── Get full company data ──
function getCompanyData(code) {
  const c       = String(code);
  const base    = companyData[c]    || {};
  const runtime = runtimeUpdates[c] || {};
  return { ...base, ...runtime };
}

// ── Called by resultAnalyzer when quarterly result is filed ──
// This is the KEY function — sets confirmed order book from result filing
function updateFromResult(code, fields) {
  const c = String(code);
  if (!runtimeUpdates[c]) runtimeUpdates[c] = {};

  const prev = runtimeUpdates[c];

  // If we have a new confirmed order book from result filing
  if (fields.confirmedOrderBook) {
    const quarter   = fields.confirmedQuarter || getCurrentFYQuarter();
    const prevTotal = (prev.confirmedOrderBook || 0) + (prev.newOrdersSinceConfirm || 0);

    // Save this quarter to history
    if (!prev.quarterHistory) prev.quarterHistory = [];

    // Don't duplicate same quarter
    const alreadyExists = prev.quarterHistory.some(q => q.quarter === quarter);
    if (!alreadyExists) {
      prev.quarterHistory.push({
        quarter,
        confirmedOrderBook: fields.confirmedOrderBook,
        addedOrders:        prev.newOrdersSinceConfirm || 0,
        totalOrderBook:     fields.confirmedOrderBook,
        timestamp:          Date.now()
      });

      // Keep last 8 quarters
      prev.quarterHistory = prev.quarterHistory
        .sort((a, b) => a.quarter.localeCompare(b.quarter))
        .slice(-8);
    }

    // Reset accumulator — new baseline from result
    prev.confirmedOrderBook    = fields.confirmedOrderBook;
    prev.confirmedQuarter      = quarter;
    prev.newOrdersSinceConfirm = 0;

    console.log(`📊 Order book confirmed: code=${c} ₹${fields.confirmedOrderBook}Cr (${quarter})`);
  }

  // Update other fields
  Object.assign(prev, {
    ...fields,
    lastResultUpdate: Date.now()
  });

  runtimeUpdates[c] = prev;
  saveToDisk();
}

// ── Get current FY quarter string e.g. "Q4FY26" ──
function getCurrentFYQuarter() {
  const now   = new Date();
  const month = now.getMonth() + 1; // 1-12
  const year  = now.getFullYear();

  // Indian FY: Apr-Jun=Q1, Jul-Sep=Q2, Oct-Dec=Q3, Jan-Mar=Q4
  let q, fy;
  if      (month >= 4 && month <= 6)  { q = 1; fy = year; }
  else if (month >= 7 && month <= 9)  { q = 2; fy = year; }
  else if (month >= 10 && month <= 12) { q = 3; fy = year; }
  else                                 { q = 4; fy = year; } // Jan-Mar

  // FY year: Apr 2025 - Mar 2026 = FY26
  const fyYear = month >= 4 ? (fy + 1) % 100 : fy % 100;
  return `Q${q}FY${fyYear}`;
}

// ── Called by orderBookEngine for each new order detected ──
function addNewOrder(code, crores, orderId) {
  const c = String(code);
  if (!runtimeUpdates[c]) runtimeUpdates[c] = {};

  const r = runtimeUpdates[c];

  // Dedup by orderId
  if (orderId) {
    if (!r.seenOrderIds) r.seenOrderIds = [];
    if (r.seenOrderIds.includes(orderId)) return;
    r.seenOrderIds.push(orderId);
    r.seenOrderIds = r.seenOrderIds.slice(-200); // keep last 200
  }

  r.newOrdersSinceConfirm = (r.newOrdersSinceConfirm || 0) + crores;
  saveToDisk();
}

// ── Get estimated current order book ──
function getEstimatedOrderBook(code) {
  const c    = String(code);
  const data = getCompanyData(c);
  const r    = runtimeUpdates[c] || {};

  const confirmed  = r.confirmedOrderBook  || data.confirmedOrderBook  || 0;
  const newOrders  = r.newOrdersSinceConfirm || 0;
  const ttmRevenue = r.ttmRevenue || data.ttmRevenue || 0;

  // Execution estimate: roughly 1 quarter of revenue executed per quarter
  const executedEst = ttmRevenue ? Math.round(ttmRevenue / 4) : 0;

  if (!confirmed) return null;

  const estimated = Math.max(0, confirmed + newOrders - executedEst);

  return {
    estimated,
    confirmed,
    confirmedQuarter: r.confirmedQuarter || data.confirmedQuarter,
    newOrders,
    addedSinceResult: newOrders,
    currentOrderBook: confirmed + newOrders,
    quarterHistory:   r.quarterHistory || [],
    executedEst,
    obToRevRatio: ttmRevenue
      ? ((confirmed + newOrders) / ttmRevenue).toFixed(1)
      : null,
    bookToBill: ttmRevenue && newOrders
      ? (newOrders / (ttmRevenue / 4)).toFixed(2)
      : null
  };
}

module.exports = {
  getMarketCap,
  getCompanyData,
  updateFromResult,
  getEstimatedOrderBook,
  addNewOrder,
  getCurrentFYQuarter
};