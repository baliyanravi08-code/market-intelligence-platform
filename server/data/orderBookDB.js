/**
 * orderBookDB.js
 * MongoDB-backed persistent order book tracker.
 * Stores per-company order history across quarters.
 * Place at: server/services/data/orderBookDB.js
 */

const mongoose = require("mongoose");

// ── Schema ────────────────────────────────────────────────────────────────────

const QuarterEntrySchema = new mongoose.Schema({
  quarter:            String,   // e.g. "Q3FY25"
  confirmedOrderBook: Number,   // Cr — from result filing / PDF
  addedOrders:        Number,   // Cr — new orders received this quarter
  filingDate:         String,
}, { _id: false });

const OrderBookSchema = new mongoose.Schema({
  code:              { type: String, index: true, unique: true },
  company:           { type: String, index: true },
  sector:            String,

  // Current snapshot
  confirmed:         Number,   // Cr — last confirmed from result
  confirmedQuarter:  String,   // e.g. "Q3FY25"
  newOrders:         Number,   // Cr — orders added since last result
  currentOrderBook:  Number,   // confirmed + newOrders

  // Ratios
  ttmRevenue:        Number,   // Cr — trailing 12 month revenue
  obToRevRatio:      String,   // e.g. "3.2"

  // History — last 12 quarters
  quarterHistory:    [QuarterEntrySchema],

  // Meta
  lastUpdated:       { type: Number, default: Date.now },
  lastOrderTitle:    String,
  lastOrderPdfUrl:   String,
}, {
  timestamps: true,
  strict: false
});

let OrderBook = null;
let ready = false;

function init() {
  try {
    OrderBook = mongoose.model("OrderBook");
    ready = true;
  } catch(e) {
    try {
      OrderBook = mongoose.model("OrderBook", OrderBookSchema);
      ready = true;
      console.log("✅ OrderBook model registered");
    } catch(e2) {
      console.log("⚠️ OrderBook model init failed:", e2.message);
    }
  }
}

function getCurrentQuarter() {
  const now   = new Date();
  const month = now.getMonth() + 1;
  const year  = now.getFullYear();
  const fy    = month >= 4 ? year + 1 : year;
  const shortFy = String(fy).slice(-2);
  if (month >= 4  && month <= 6)  return `Q1FY${shortFy}`;
  if (month >= 7  && month <= 9)  return `Q2FY${shortFy}`;
  if (month >= 10 && month <= 12) return `Q3FY${shortFy}`;
  return `Q4FY${shortFy}`;
}

// ── Get all order books ───────────────────────────────────────────────────────
async function getAllOrderBooks() {
  if (!ready || !OrderBook) return [];
  try {
    return await OrderBook.find({})
      .sort({ currentOrderBook: -1 })
      .limit(100)
      .lean();
  } catch(e) {
    console.log("⚠️ OrderBook getAllOrderBooks failed:", e.message);
    return [];
  }
}

// ── Get order book for one company ───────────────────────────────────────────
async function getOrderBook(code) {
  if (!ready || !OrderBook) return null;
  try {
    return await OrderBook.findOne({ code: String(code) }).lean();
  } catch(e) {
    return null;
  }
}

// ── Add a new order filing ────────────────────────────────────────────────────
async function addOrderToBook(code, company, crores, title, pdfUrl) {
  if (!ready || !OrderBook || !crores || crores <= 0) return;
  try {
    const existing = await OrderBook.findOne({ code: String(code) });

    if (existing) {
      const newOrdersTotal  = (existing.newOrders || 0) + crores;
      const currentOrderBook = (existing.confirmed || 0) + newOrdersTotal;
      const obToRevRatio = existing.ttmRevenue > 0
        ? (currentOrderBook / existing.ttmRevenue).toFixed(1)
        : existing.obToRevRatio || null;

      await OrderBook.updateOne(
        { code: String(code) },
        {
          $set: {
            company,
            newOrders:       newOrdersTotal,
            currentOrderBook,
            lastUpdated:     Date.now(),
            lastOrderTitle:  title,
            lastOrderPdfUrl: pdfUrl,
            ...(obToRevRatio ? { obToRevRatio } : {})
          }
        }
      );
      console.log(`📦 OB+ ${company} ₹${crores}Cr → total ₹${currentOrderBook}Cr`);
    } else {
      // First order for this company
      await OrderBook.create({
        code:             String(code),
        company,
        confirmed:        0,
        confirmedQuarter: getCurrentQuarter(),
        newOrders:        crores,
        currentOrderBook: crores,
        lastUpdated:      Date.now(),
        lastOrderTitle:   title,
        lastOrderPdfUrl:  pdfUrl,
        quarterHistory:   []
      });
      console.log(`📦 OB created: ${company} ₹${crores}Cr`);
    }
  } catch(e) {
    console.log("⚠️ addOrderToBook failed:", e.message);
  }
}

// ── Update from result filing (sets confirmed order book) ─────────────────────
async function updateFromResultFiling(code, company, confirmedOrderBook, quarter, ttmRevenue) {
  if (!ready || !OrderBook || !confirmedOrderBook) return;
  try {
    const existing = await OrderBook.findOne({ code: String(code) });

    const obToRevRatio = ttmRevenue > 0
      ? (confirmedOrderBook / ttmRevenue).toFixed(1)
      : (existing?.obToRevRatio || null);

    const historyEntry = {
      quarter,
      confirmedOrderBook,
      addedOrders: existing?.newOrders || 0,
      filingDate:  new Date().toISOString().split("T")[0]
    };

    if (existing) {
      const history = existing.quarterHistory || [];
      // Don't add duplicate quarter entry
      if (!history.some(h => h.quarter === quarter)) {
        history.push(historyEntry);
      }
      await OrderBook.updateOne(
        { code: String(code) },
        {
          $set: {
            company,
            confirmed:        confirmedOrderBook,
            confirmedQuarter: quarter,
            newOrders:        0,         // reset — new quarter starts
            currentOrderBook: confirmedOrderBook,
            quarterHistory:   history.slice(-12), // keep last 12 quarters
            lastUpdated:      Date.now(),
            ...(ttmRevenue   ? { ttmRevenue }   : {}),
            ...(obToRevRatio ? { obToRevRatio } : {})
          }
        }
      );
    } else {
      await OrderBook.create({
        code: String(code),
        company,
        confirmed:        confirmedOrderBook,
        confirmedQuarter: quarter,
        newOrders:        0,
        currentOrderBook: confirmedOrderBook,
        quarterHistory:   [historyEntry],
        lastUpdated:      Date.now(),
        ...(ttmRevenue   ? { ttmRevenue }   : {}),
        ...(obToRevRatio ? { obToRevRatio } : {})
      });
    }
    console.log(`📦 OB result: ${company} ₹${confirmedOrderBook}Cr (${quarter})`);
  } catch(e) {
    console.log("⚠️ updateFromResultFiling failed:", e.message);
  }
}

module.exports = {
  init,
  getAllOrderBooks,
  getOrderBook,
  addOrderToBook,
  updateFromResultFiling,
  getCurrentQuarter
};