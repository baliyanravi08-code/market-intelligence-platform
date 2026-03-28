/*
 * database.js
 * Dual storage: MongoDB (persistent) + in-memory (fast access).
 */

const mongoose = require("mongoose");
const MONGO_URI = process.env.MONGO_URI;

const SignalSchema = new mongoose.Schema({
  company:    { type: String, index: true },
  code:       { type: String, index: true },
  type:       { type: String, index: true },
  title:      String,
  value:      Number,
  exchange:   { type: String, index: true },
  time:       String,
  savedAt:    { type: Number, index: true },
  pdfUrl:     String,
  _orderInfo: mongoose.Schema.Types.Mixed,
  mcapRatio:  Number,
  ago:        String
}, { timestamps: true, strict: false });

SignalSchema.index({ createdAt: 1 }, { expireAfterSeconds: 96 * 60 * 60 });

let Signal = null;
let mongoConnected = false;

const memoryStore = { bse: [], nse: [] };
const RETENTION_MS = 96 * 60 * 60 * 1000;

function getRetentionHours() { return 96; }

function getWindowLabel() {
  const now  = new Date();
  const day  = now.getDay();
  const hour = now.getHours();
  if (day === 0 || day === 6 || (day === 5 && hour >= 15) || (day === 1 && hour < 9)) {
    return "96h (weekend)";
  }
  return "24h";
}

async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 10000,
    });

    Signal = mongoose.model("Signal", SignalSchema);
    mongoConnected = true;
    console.log("✅ MongoDB Connected");

    // FIX: was ./services/data/orderBookDB — file is at server/data/orderBookDB.js
    try {
      const orderBookDB = require("./data/orderBookDB");
      orderBookDB.init();
    } catch(e) {
      console.log("⚠️ OrderBook DB init failed:", e.message);
    }

    await loadFromMongo();

  } catch (err) {
    console.log("⚠️ MongoDB unavailable, using in-memory only:", err.message);
    mongoConnected = false;
  }
}

async function loadFromMongo() {
  if (!Signal) return;
  try {
    const cutoff = Date.now() - RETENTION_MS;
    const docs   = await Signal.find({ savedAt: { $gt: cutoff } })
      .sort({ savedAt: -1 })
      .limit(1000)
      .lean();

    let bseCount = 0, nseCount = 0;
    for (const doc of docs) {
      const exchange = (doc.exchange || "bse").toLowerCase();
      if (exchange === "bse") { memoryStore.bse.push(doc); bseCount++; }
      else                    { memoryStore.nse.push(doc); nseCount++; }
    }

    memoryStore.bse.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    memoryStore.nse.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    console.log(`📦 MongoDB loaded: ${bseCount} BSE + ${nseCount} NSE events`);
  } catch (err) {
    console.log("⚠️ MongoDB load failed:", err.message);
  }
}

function saveResult(data) {
  if (!data) return;
  const exchange = (data.exchange || "bse").toLowerCase();
  const store    = memoryStore[exchange] || memoryStore.bse;
  const key = (data.company || "") + (data.time || "") + (data.title || "");
  const exists = store.some(e =>
    ((e.company || "") + (e.time || "") + (e.title || "")) === key
  );
  if (exists) return;
  store.unshift(data);
  const cutoff = Date.now() - RETENTION_MS;
  memoryStore.bse = memoryStore.bse.filter(e => (e.savedAt || 0) > cutoff).slice(0, 500);
  memoryStore.nse = memoryStore.nse.filter(e => (e.savedAt || 0) > cutoff).slice(0, 500);
  if (mongoConnected && Signal) {
    Signal.create(data).catch(err => {
      if (!err.message.includes("duplicate")) {
        console.log("⚠️ MongoDB save error:", err.message);
      }
    });
  }
}

function getEvents(exchange) {
  const ex     = (exchange || "bse").toLowerCase();
  const cutoff = Date.now() - RETENTION_MS;
  const store  = memoryStore[ex] || [];
  return store.filter(e => (e.savedAt || 0) > cutoff).slice(0, 500);
}

function getResults() {
  return [...memoryStore.bse, ...memoryStore.nse]
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

connectDB();

module.exports = {
  connectDB,
  saveResult,
  saveEvent: saveResult,
  getResults,
  getEvents,
  getRetentionHours,
  getWindowLabel
};