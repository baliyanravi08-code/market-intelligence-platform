"use strict";

/**
 * gannIntegration.js
 * server/services/intelligence/gannIntegration.js
 *
 * CHANGES vs previous version:
 *   - MongoDB persistence: every computed analysis is saved to GannCache
 *     collection immediately after computation.
 *   - On startup: loadCacheFromDB() restores all previously saved analyses
 *     into in-memory gannCache so the frontend gets data instantly, even
 *     after a Render spin-down / server restart.
 *   - Outside market hours: serves MongoDB-backed cache with
 *     _usingCachedLTP: true — panel always shows last session's data.
 *   - No behaviour change during market hours.
 */

const gann = require("./gannEngine");
const { isMarketOpen, marketStatus } = require("./marketHours");

// ─── Lazy-load MongoDB model (safe if mongoose not connected yet) ─────────────
let GannCacheModel = null;
function getModel() {
  if (!GannCacheModel) {
    try {
      GannCacheModel = require("../../models/GannCache");
    } catch (e) {
      console.warn("📐 GannCache model not available:", e.message);
    }
  }
  return GannCacheModel;
}

// ─── In-memory cache ──────────────────────────────────────────────────────────
const gannCache    = new Map();   // symbol → { analysis, computedAt }
const CACHE_TTL_MS = 5 * 60 * 1000;

// ─── Swing pivot store ────────────────────────────────────────────────────────
const swingStore = new Map();

// ─── Index LTP store ──────────────────────────────────────────────────────────
const indexLTPs = new Map();

// ─── Symbol normaliser ────────────────────────────────────────────────────────
function normaliseSymbol(raw) {
  if (!raw) return "";
  return raw
    .toUpperCase()
    .trim()
    .replace(/^NIFTY\s+50$/, "NIFTY")
    .replace(/^NIFTY50$/, "NIFTY")
    .replace(/^BANK\s+NIFTY$/, "BANKNIFTY")
    .replace(/^NIFTY\s+BANK$/, "BANKNIFTY")
    .replace(/\s+/g, "");
}

// ─── MongoDB helpers ──────────────────────────────────────────────────────────

/**
 * Persist one analysis entry to MongoDB (fire-and-forget, never throws).
 */
async function saveToDb(sym, analysis, computedAt) {
  const Model = getModel();
  if (!Model) return;
  try {
    await Model.findOneAndUpdate(
      { symbol: sym },
      {
        symbol:     sym,
        analysis,
        computedAt: new Date(computedAt),
        ltp:        analysis.ltp   ?? null,
        bias:       analysis.signal?.bias  ?? null,
        score:      analysis.signal?.score ?? null,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    console.warn(`📐 GannCache DB write failed [${sym}]:`, err.message);
  }
}

/**
 * Load all persisted analyses from MongoDB into the in-memory gannCache.
 * Called once on startup — restores data that survived a server restart.
 */
async function loadCacheFromDB() {
  const Model = getModel();
  if (!Model) {
    console.warn("📐 GannCache: model unavailable — skipping DB restore");
    return;
  }
  try {
    const docs = await Model.find({}).lean();
    if (!docs.length) {
      console.log("📐 GannCache: no saved analyses in DB yet");
      return;
    }
    for (const doc of docs) {
      if (!doc.symbol || !doc.analysis) continue;
      gannCache.set(doc.symbol, {
        analysis:   doc.analysis,
        computedAt: new Date(doc.computedAt).getTime(),
      });
      // Also restore LTP so market-open computation has a starting price
      if (doc.ltp) indexLTPs.set(doc.symbol, doc.ltp);
    }
    console.log(`📐 GannCache: restored ${docs.length} analyses from MongoDB`);
  } catch (err) {
    console.warn("📐 GannCache: DB restore failed —", err.message);
  }
}

// ─── Core ─────────────────────────────────────────────────────────────────────

function ingestSwingData(data) {
  if (!data?.symbol) return;
  swingStore.set(normaliseSymbol(data.symbol), data);
}

/**
 * Run or serve Gann analysis for a symbol.
 *
 * Outside market hours → serve last cached result (in-memory or MongoDB-restored)
 *                        tagged with _usingCachedLTP: true.
 * During market hours  → recompute if stale, save to MongoDB, broadcast.
 */
function getGannAnalysis(symbol, ltp) {
  const sym    = normaliseSymbol(symbol);
  const closed = !isMarketOpen();
  const cached = gannCache.get(sym);

  // ── OUTSIDE MARKET HOURS ──────────────────────────────────────────────────
  if (closed) {
    if (cached?.analysis) {
      return {
        ...cached.analysis,
        _usingCachedLTP: true,
        _marketStatus:   marketStatus(),
        _lastUpdatedAt:  new Date(cached.computedAt).toISOString(),
      };
    }
    console.warn(`⚠️  Gann [${sym}]: market closed and no cached data available`);
    return null;
  }

  // ── DURING MARKET HOURS ───────────────────────────────────────────────────
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) {
    return cached.analysis;
  }

  const swingData = swingStore.get(sym) || {};
  const price =
    (ltp && ltp > 0 ? ltp : null) ||
    indexLTPs.get(sym)            ||
    swingData.ltp                 ||
    null;

  if (!price || price <= 0) {
    console.warn(`⚠️  Gann [${sym}]: no LTP from any source — cannot analyse`);
    return null;
  }

  indexLTPs.set(sym, price);

  const today     = new Date().toISOString().slice(0, 10);
  const high52w   = swingData.high52w   ?? price * 1.15;
  const low52w    = swingData.low52w    ?? price * 0.85;
  const swingHigh = swingData.swingHigh ?? { price: price * 1.05, date: today };
  const swingLow  = swingData.swingLow  ?? { price: price * 0.95, date: today };

  let analysis;
  try {
    analysis = gann.analyzeGann({
      symbol,
      ltp:         price,
      high52w,
      low52w,
      swingHigh,
      swingLow,
      ipoDate:     swingData.ipoDate     ?? null,
      allTimeHigh: swingData.allTimeHigh ?? null,
      allTimeLow:  swingData.allTimeLow  ?? null,
      priceUnit:   swingData.priceUnit   ?? null,
    });
  } catch (err) {
    console.error(`❌ Gann engine error [${sym}]:`, err.message);
    return null;
  }

  if (!analysis) {
    console.warn(`⚠️  Gann [${sym}]: analyzeGann returned null for ltp=${price}`);
    return null;
  }

  const computedAt = Date.now();
  gannCache.set(sym, { analysis, computedAt });

  // ── Persist to MongoDB (non-blocking) ────────────────────────────────────
  saveToDb(sym, analysis, computedAt);

  console.log(`📐 Gann [${sym}]: bias=${analysis.signal?.bias} score=${analysis.signal?.score} price=${price}`);
  return analysis;
}

// ─── Composite signal ─────────────────────────────────────────────────────────

function gannToCompositeSignal(analysis) {
  if (!analysis?.signal) return null;
  const { signal, alerts, timeCycles: cycles } = analysis;
  let score = signal.score;

  const highPriorityAlerts = (alerts || []).filter(a => a.priority === "HIGH");
  if (highPriorityAlerts.length >= 2) score = Math.min(100, score + 10);
  if (highPriorityAlerts.length >= 1) score = Math.min(100, score + 5);

  const imminentMajor = (cycles || []).filter(
    c => c.daysFromToday <= 3 &&
         (c.cycleStrength === "MAJOR" || c.cycleStrength === "EXTREME")
  );
  if (imminentMajor.length > 0) score = Math.min(100, score + 8);

  const topReason =
    highPriorityAlerts[0]?.message ||
    signal.factors?.[0]            ||
    "Gann analysis";

  return {
    key:    "gann",
    score:  Math.round(score),
    weight: 0.15,
    label:  "Gann Analysis",
    detail: topReason.replace(/^[⏰📅⚡🔢🎯]\s/, ""),
    color:  signal.bias === "BULLISH" ? "green"
          : signal.bias === "BEARISH" ? "red"
          : "amber",
    icon:   "📐",
    raw: {
      bias:         signal.bias,
      masterAngle:  analysis.keyLevels?.masterAngle,
      aboveMaster:  analysis.priceOnUpFan?.aboveMasterAngle,
      activeAlerts: highPriorityAlerts.length,
      headline:     analysis.headline,
    },
  };
}

// ─── Alerts ───────────────────────────────────────────────────────────────────

function broadcastGannAlerts(io, symbol, analysis) {
  if (!io || !analysis?.alerts?.length) return;
  if (!isMarketOpen()) return;
  const highAlerts = analysis.alerts.filter(a => a.priority === "HIGH");
  if (highAlerts.length > 0) {
    io.emit("gann-alert", {
      symbol,
      ltp:      analysis.ltp,
      alerts:   highAlerts,
      headline: analysis.headline,
    });
  }
}

// ─── Socket handlers ──────────────────────────────────────────────────────────

function registerSocketHandlers(io, socket) {
  socket.on("get-gann-analysis", ({ symbol, ltp } = {}) => {
    if (!symbol) return;
    const sym      = normaliseSymbol(symbol);
    const closed   = !isMarketOpen();
    const analysis = getGannAnalysis(sym, ltp);

    if (analysis) {
      socket.emit("gann-analysis", analysis);
      console.log(`📤 gann-analysis (${closed ? "cached/closed" : "live"}) → ${socket.id} [${sym}]`);
      return;
    }

    socket.emit("gann-analysis", {
      symbol:        sym,
      marketClosed:  closed,
      _marketStatus: marketStatus(),
      signal:        null,
      error:         closed
        ? "Market closed — Gann data will load at next market open (Mon–Fri 09:00 IST)"
        : `No data available for ${sym}`,
    });
    console.warn(`⚠️  gann-analysis: no result for ${sym} — sent marketClosed=${closed}`);
  });
}

// ─── Pre-warm ─────────────────────────────────────────────────────────────────

function preWarmIndexes(io) {
  if (!isMarketOpen()) {
    console.log(`📐 Gann pre-warm: market is ${marketStatus()} — skipping`);
    return;
  }
  const INDEX_SYMBOLS = ["NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY"];
  for (const sym of INDEX_SYMBOLS) {
    const ltp = indexLTPs.get(sym);
    if (!ltp) continue;
    const analysis = getGannAnalysis(sym, ltp);
    if (analysis && io) {
      io.emit("gann-analysis", analysis);
      console.log(`📐 Pre-warmed Gann for ${sym} @ ${ltp}`);
    }
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

/**
 * startGannIntegration — call this from coordinator.js.
 *
 * NEW: loadCacheFromDB() is called first so MongoDB-persisted analyses
 * are available immediately, even before the first LTP tick arrives.
 * The frontend will show last session's data with "Last known price" banner
 * instead of a blank panel after a server restart.
 */
async function startGannIntegration(io, deps = {}) {
  // ── Restore persisted cache from MongoDB ─────────────────────────────────
  await loadCacheFromDB();

  const { onNewLTP, setGannSignal } = deps;

  if (typeof onNewLTP === "function") {
    onNewLTP((symbol, ltp) => {
      const sym = normaliseSymbol(symbol);
      indexLTPs.set(sym, ltp);
      if (!isMarketOpen()) return;

      const analysis = getGannAnalysis(sym, ltp);
      if (!analysis) return;

      if (io) io.emit("gann-analysis", analysis);
      broadcastGannAlerts(io, sym, analysis);

      if (typeof setGannSignal === "function") {
        const signal = gannToCompositeSignal(analysis);
        if (signal) setGannSignal(sym, signal);
      }
    });
  }

  if (io) {
    io.on("connection", socket => {
      registerSocketHandlers(io, socket);

      // Replay all cached analyses to new/reconnecting clients
      for (const [sym, cached] of gannCache) {
        if (!cached?.analysis) continue;
        const closed  = !isMarketOpen();
        const payload = closed
          ? {
              ...cached.analysis,
              _usingCachedLTP: true,
              _marketStatus:   marketStatus(),
              _lastUpdatedAt:  new Date(cached.computedAt).toISOString(),
            }
          : cached.analysis;
        socket.emit("gann-analysis", payload);
      }
    });

    setTimeout(() => preWarmIndexes(io), 3000);
  }

  console.log("📐 GannIntegration started");
}

// ─── Batch ────────────────────────────────────────────────────────────────────

function runBatchGannAnalysis(symbols = []) {
  if (!isMarketOpen()) {
    console.log("📐 Gann batch: market closed — returning cached data");
    return symbols
      .map(sym => gannCache.get(normaliseSymbol(sym))?.analysis)
      .filter(Boolean);
  }
  const results = [];
  for (const sym of symbols) {
    const key  = normaliseSymbol(sym);
    const data = swingStore.get(key);
    if (!data?.ltp) continue;
    const analysis = getGannAnalysis(key, data.ltp);
    if (analysis) results.push(analysis);
  }
  return results;
}

module.exports = {
  startGannIntegration,
  ingestSwingData,
  getGannAnalysis,
  gannToCompositeSignal,
  runBatchGannAnalysis,
  normaliseSymbol,
};