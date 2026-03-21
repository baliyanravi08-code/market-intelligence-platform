/*
 * database.js
 * Dual storage: MongoDB (persistent) + in-memory (fast access).
 * Falls back to in-memory only if MongoDB is unavailable.
 */

const mongoose = require("mongoose");
const MONGO_URI = process.env.MONGO_URI;

// ── MongoDB Schema ──
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
}, {
  timestamps: true,
  strict: false  // allow extra fields
});

// TTL index — auto-delete documents older than 4 days (96h)
SignalSchema.index({ createdAt: 1 }, { expireAfterSeconds: 96 * 60 * 60 });

let Signal = null;
let mongoConnected = false;

// ── In-memory store (always available as fallback) ──
const memoryStore = {
  bse: [],
  nse: []
};

// ── Retention window ──
const RETENTION_MS = 96 * 60 * 60 * 1000; // 96 hours

function getRetentionHours() {
  return 96;
}

function getWindowLabel() {
  const now  = new Date();
  const day  = now.getDay();
  const hour = now.getHours();
  // Weekend — show extended window label
  if (day === 0 || day === 6 || (day === 5 && hour >= 15) || (day === 1 && hour < 9)) {
    return "96h (weekend)";
  }
  return "24h";
}

// ── Connect to MongoDB ──
async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 10000,
    });
    Signal = mongoose.model("Signal", SignalSchema);
    mongoConnected = true;
    console.log("✅ MongoDB Connected");

    // Load recent events from MongoDB into memory on startup
    await loadFromMongo();

  } catch (err) {
    console.log("⚠️ MongoDB unavailable, using in-memory only:", err.message);
    mongoConnected = false;
  }
}

// ── Load recent events from MongoDB into memory ──
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

    // Sort by savedAt desc
    memoryStore.bse.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    memoryStore.nse.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));

    console.log(`📦 MongoDB loaded: ${bseCount} BSE + ${nseCount} NSE events`);
  } catch (err) {
    console.log("⚠️ MongoDB load failed:", err.message);
  }
}

// ── Save a signal ──
function saveResult(data) {
  if (!data) return;

  const exchange = (data.exchange || "bse").toLowerCase();
  const store    = memoryStore[exchange] || memoryStore.bse;

  // Dedup by company+time+title
  const key = (data.company || "") + (data.time || "") + (data.title || "");
  const exists = store.some(e =>
    ((e.company || "") + (e.time || "") + (e.title || "")) === key
  );
  if (exists) return;

  // Add to memory
  store.unshift(data);

  // Trim memory to last 96h + max 500 per exchange
  const cutoff = Date.now() - RETENTION_MS;
  memoryStore.bse = memoryStore.bse.filter(e => (e.savedAt || 0) > cutoff).slice(0, 500);
  memoryStore.nse = memoryStore.nse.filter(e => (e.savedAt || 0) > cutoff).slice(0, 500);

  // Persist to MongoDB async (don't block)
  if (mongoConnected && Signal) {
    Signal.create(data).catch(err => {
      if (!err.message.includes("duplicate")) {
        console.log("⚠️ MongoDB save error:", err.message);
      }
    });
  }
}

// ── Get events by exchange ──
function getEvents(exchange) {
  const ex      = (exchange || "bse").toLowerCase();
  const cutoff  = Date.now() - RETENTION_MS;
  const store   = memoryStore[ex] || [];
  return store
    .filter(e => (e.savedAt || 0) > cutoff)
    .slice(0, 500);
}

// ── Legacy: get all results ──
function getResults() {
  return [...memoryStore.bse, ...memoryStore.nse]
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

// ── Connect on module load ──
connectDB();

module.exports = {
  connectDB,
  saveResult,
  getResults,
  getEvents,
  getRetentionHours,
  getWindowLabel
};