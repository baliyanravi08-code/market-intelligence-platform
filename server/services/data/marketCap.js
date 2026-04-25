/**
 * marketCap.js
 * Company data store with persistent quarter-by-quarter order book tracking.
 * Loads MCap from marketCapDB.json (built by fetchAllMcap.js script).
 *
 * MEMORY FIXES:
 *  1. mcapDB capped at MAX_MCAP_ENTRIES (1000) — sorted by mcap desc, top 1000 only
 *     Old: all 4587 companies loaded into RAM flat → ~45MB permanent allocation
 *  2. getCompaniesByMcap — no longer builds a third merged object on every call
 *     Old: O(n) alloc per call, caller held reference keeping both copies alive
 *  3. runtimeUpdates.seenOrderIds capped at 100 (was 200) — small savings per company
 */

const fs   = require("fs");
const path = require("path");

const OB_FILE   = path.join(__dirname, "../../data/orderBookHistory.json");
const MCAP_FILE = path.join(__dirname, "../../data/marketCapDB.json");

// FIX: only keep top 1000 companies by mcap — covers all large/mid/small cap stocks
const MAX_MCAP_ENTRIES = 1000;

// ── Static baseline for key companies ──
const staticData = {
  "533269": { mcap: 8091,    confirmedOrderBook: 16300,  confirmedQuarter: "Q3FY26", ttmRevenue: 4200,   name: "VA Tech Wabag" },
  "500510": { mcap: 280000,  confirmedOrderBook: 450000, confirmedQuarter: "Q3FY26", ttmRevenue: 220000, name: "L&T" },
  "532898": { mcap: 22000,   confirmedOrderBook: 180000, confirmedQuarter: "Q3FY26", ttmRevenue: 6500,   name: "IRFC" },
  "542649": { mcap: 12000,   confirmedOrderBook: 85000,  confirmedQuarter: "Q3FY26", ttmRevenue: 4200,   name: "RVNL" },
  "540678": { mcap: 48000,   confirmedOrderBook: 94000,  confirmedQuarter: "Q3FY26", ttmRevenue: 28000,  name: "HAL" },
  "541143": { mcap: 32000,   confirmedOrderBook: 68000,  confirmedQuarter: "Q3FY26", ttmRevenue: 18000,  name: "BEL" },
  "500024": { mcap: 15000,   confirmedOrderBook: 19000,  confirmedQuarter: "Q3FY26", ttmRevenue: 3200,   name: "Bharat Dynamics" },
  "500400": { mcap: 320000,  confirmedOrderBook: null,   confirmedQuarter: null,     ttmRevenue: 180000, name: "NTPC" },
  "533122": { mcap: 35000,   confirmedOrderBook: 12000,  confirmedQuarter: "Q3FY26", ttmRevenue: 3800,   name: "Inox Wind" },
  "532174": { mcap: 1400000, confirmedOrderBook: null,   confirmedQuarter: null,     ttmRevenue: 153000, name: "Infosys" },
  "500180": { mcap: 1200000, confirmedOrderBook: null,   confirmedQuarter: null,     ttmRevenue: 250000, name: "HDFC Bank" },
  "500470": { mcap: 230000,  confirmedOrderBook: null,   confirmedQuarter: null,     ttmRevenue: 220000, name: "Tata Steel" },
  "500387": { mcap: 480000,  confirmedOrderBook: null,   confirmedQuarter: null,     ttmRevenue: 68000,  name: "UltraTech" },
  "500520": { mcap: 320000,  confirmedOrderBook: null,   confirmedQuarter: null,     ttmRevenue: 125000, name: "M&M" },
  "532500": { mcap: 270000,  confirmedOrderBook: null,   confirmedQuarter: null,     ttmRevenue: 140000, name: "Maruti" },
};

// ── MCap database (loaded from marketCapDB.json, capped at MAX_MCAP_ENTRIES) ──
let mcapDB = {};

function loadMcapDB() {
  try {
    if (fs.existsSync(MCAP_FILE)) {
      const raw = fs.readFileSync(MCAP_FILE, "utf8").trim();
      if (!raw) return;
      const full = JSON.parse(raw);
      const totalEntries = Object.keys(full).length;

      // FIX: sort by mcap descending, keep only top MAX_MCAP_ENTRIES
      // This covers all large/mid/small caps while dropping obscure microcaps
      const entries = Object.entries(full);
      entries.sort((a, b) => (b[1].mcap || 0) - (a[1].mcap || 0));
      mcapDB = Object.fromEntries(entries.slice(0, MAX_MCAP_ENTRIES));

      console.log(`📊 MCap DB loaded: ${Object.keys(mcapDB).length} companies (capped from ${totalEntries})`);
    }
  } catch (e) {
    console.log("⚠️ MCap DB load failed:", e.message);
    mcapDB = {};
  }
}

// ── Order book history (persisted) ──
let runtimeUpdates = {};

function loadFromDisk() {
  try {
    if (fs.existsSync(OB_FILE)) {
      const raw = fs.readFileSync(OB_FILE, "utf8").trim();
      if (!raw) return;
      runtimeUpdates = JSON.parse(raw);
      console.log(`📦 OrderBook history loaded: ${Object.keys(runtimeUpdates).length} companies`);
    }
  } catch (e) {
    console.log("⚠️ OrderBook history load failed:", e.message);
    runtimeUpdates = {};
  }
}

function saveToDisk() {
  try {
    const dir = path.dirname(OB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(OB_FILE, JSON.stringify(runtimeUpdates), "utf8");
  } catch (e) {}
}

loadMcapDB();
loadFromDisk();
setInterval(saveToDisk, 5 * 60 * 1000);

// ── Get MCap — checks runtime → mcapDB → static ──
function getMarketCap(code) {
  const c = String(code);
  return runtimeUpdates[c]?.mcap
      || mcapDB[c]?.mcap
      || staticData[c]?.mcap
      || null;
}

// ── Get company name ──
function getCompanyName(code) {
  const c = String(code);
  return runtimeUpdates[c]?.name
      || mcapDB[c]?.name
      || staticData[c]?.name
      || null;
}

// ── Get full company data ──
function getCompanyData(code) {
  const c       = String(code);
  const base    = staticData[c]     || {};
  const dbEntry = mcapDB[c]         || {};
  const runtime = runtimeUpdates[c] || {};
  return { ...base, ...dbEntry, ...runtime };
}

// ── Get current FY quarter string e.g. "Q4FY26" ──
function getCurrentFYQuarter() {
  const now   = new Date();
  const month = now.getMonth() + 1;
  const year  = now.getFullYear();
  let q, fyYear;
  if      (month >= 4 && month <= 6)   { q = 1; fyYear = (year + 1) % 100; }
  else if (month >= 7 && month <= 9)   { q = 2; fyYear = (year + 1) % 100; }
  else if (month >= 10 && month <= 12) { q = 3; fyYear = (year + 1) % 100; }
  else                                  { q = 4; fyYear = year % 100; }
  return `Q${q}FY${fyYear}`;
}

// ── Called by resultAnalyzer when quarterly result is filed ──
function updateFromResult(code, fields) {
  const c = String(code);
  if (!runtimeUpdates[c]) runtimeUpdates[c] = {};
  const prev = runtimeUpdates[c];

  if (fields.confirmedOrderBook) {
    const quarter = fields.confirmedQuarter || getCurrentFYQuarter();
    if (!prev.quarterHistory) prev.quarterHistory = [];
    const alreadyExists = prev.quarterHistory.some(q => q.quarter === quarter);
    if (!alreadyExists) {
      prev.quarterHistory.push({
        quarter,
        confirmedOrderBook:  fields.confirmedOrderBook,
        addedOrders:         prev.newOrdersSinceConfirm || 0,
        totalOrderBook:      fields.confirmedOrderBook,
        timestamp:           Date.now(),
      });
      prev.quarterHistory = prev.quarterHistory
        .sort((a, b) => a.quarter.localeCompare(b.quarter))
        .slice(-8);
    }
    prev.confirmedOrderBook    = fields.confirmedOrderBook;
    prev.confirmedQuarter      = quarter;
    prev.newOrdersSinceConfirm = 0;
    console.log(`📊 Order book confirmed: ${c} ₹${fields.confirmedOrderBook}Cr (${quarter})`);
  }

  if (fields.mcap && fields.mcap > 0) {
    prev.mcap = fields.mcap;
    if (!mcapDB[c]) mcapDB[c] = {};
    mcapDB[c].mcap = fields.mcap;
  }

  Object.assign(prev, { ...fields, lastResultUpdate: Date.now() });
  runtimeUpdates[c] = prev;
  saveToDisk();
}

// ── Add new order to runtime counter ──
function addNewOrder(code, crores, orderId) {
  const c = String(code);
  if (!runtimeUpdates[c]) runtimeUpdates[c] = {};
  const r = runtimeUpdates[c];
  if (orderId) {
    if (!r.seenOrderIds) r.seenOrderIds = [];
    if (r.seenOrderIds.includes(orderId)) return;
    r.seenOrderIds.push(orderId);
    // FIX: cap at 100 (was 200) — small per-company saving across many companies
    r.seenOrderIds = r.seenOrderIds.slice(-100);
  }
  r.newOrdersSinceConfirm = (r.newOrdersSinceConfirm || 0) + crores;
  saveToDisk();
}

// ── Get estimated current order book ──
function getEstimatedOrderBook(code) {
  const c    = String(code);
  const data = getCompanyData(c);
  const r    = runtimeUpdates[c] || {};
  const confirmed  = r.confirmedOrderBook   || data.confirmedOrderBook  || 0;
  const newOrders  = r.newOrdersSinceConfirm || 0;
  const ttmRevenue = r.ttmRevenue            || data.ttmRevenue         || 0;
  const executedEst = ttmRevenue ? Math.round(ttmRevenue / 4) : 0;
  if (!confirmed) return null;
  return {
    estimated:        Math.max(0, confirmed + newOrders - executedEst),
    confirmed,
    confirmedQuarter: r.confirmedQuarter || data.confirmedQuarter,
    newOrders,
    addedSinceResult: newOrders,
    currentOrderBook: confirmed + newOrders,
    quarterHistory:   r.quarterHistory || [],
    executedEst,
    obToRevRatio:     ttmRevenue ? ((confirmed + newOrders) / ttmRevenue).toFixed(1) : null,
    bookToBill:       ttmRevenue && newOrders ? (newOrders / (ttmRevenue / 4)).toFixed(2) : null,
  };
}

// ── Get all companies from mcapDB above a threshold ──
// FIX: no longer builds a third merged object on every call
// Returns references directly — caller must treat result as read-only
function getCompaniesByMcap(minMcap = 100) {
  const result = {};
  for (const [code, data] of Object.entries(staticData)) {
    if ((data.mcap || 0) >= minMcap) result[code] = data;
  }
  for (const [code, data] of Object.entries(mcapDB)) {
    if ((data.mcap || 0) >= minMcap) {
      // Only spread if we need to merge with static (avoids unnecessary alloc)
      result[code] = result[code] ? { ...result[code], ...data } : data;
    }
  }
  return result;
}

module.exports = {
  getMarketCap,
  getCompanyName,
  getCompanyData,
  updateFromResult,
  getEstimatedOrderBook,
  addNewOrder,
  getCurrentFYQuarter,
  getCompaniesByMcap,
};