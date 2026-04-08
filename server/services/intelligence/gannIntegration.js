/**
 * gannIntegration.js
 * server/services/intelligence/gannIntegration.js
 *
 * Bridges gannEngine.js with your existing compositeScoreEngine.js.
 *
 * What this file does:
 *   1. Runs Gann analysis for each symbol
 *   2. Converts Gann output into a compositeScoreEngine-compatible signal
 *   3. Caches results (Gann is CPU-intensive; recalc every 5 min is enough)
 *   4. Exposes socket events: "gann-analysis", "gann-alert"
 *
 * Add to coordinator.js:
 *   const gannIntegration = require("./gannIntegration");
 *   gannIntegration.startGannIntegration(io, { getCompositeForScrip, setGannSignal });
 */

"use strict";

const gann = require("./gannEngine");

// ── Cache ─────────────────────────────────────────────────────────────────────
// symbol → { analysis, computedAt }
const gannCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── NSE swing pivot store ─────────────────────────────────────────────────────
// In production: populate this from your OHLCV store / zigzag indicator
// For now: ingest from outside via ingestSwingData()
const swingStore = new Map();  // symbol → { swingHigh, swingLow, high52w, low52w, ipoDate }

/**
 * Feed swing pivot data in from your OHLCV / market data source.
 * Call this whenever you get fresh OHLCV data.
 *
 * @example
 * ingestSwingData({
 *   symbol: "RELIANCE",
 *   ltp: 2941.50,
 *   high52w: 3217.90,
 *   low52w: 2220.30,
 *   swingHigh: { price: 3050, date: "2024-09-27" },
 *   swingLow:  { price: 2680, date: "2024-11-14" },
 *   ipoDate:   "1977-11-12",
 *   allTimeHigh: { price: 3217.90, date: "2024-07-08" },
 * });
 */
function ingestSwingData(data) {
  if (!data?.symbol) return;
  swingStore.set(data.symbol.toUpperCase(), data);
}

/**
 * Run full Gann analysis for a symbol.
 * Returns cached result if fresh enough.
 */
function getGannAnalysis(symbol, ltp) {
  const sym = symbol.toUpperCase();

  // Return cache if fresh
  const cached = gannCache.get(sym);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) {
    return cached.analysis;
  }

  const swingData = swingStore.get(sym);
  if (!swingData && !ltp) return null;

  const analysis = gann.analyzeGann({
    symbol:      sym,
    ltp:         ltp || swingData?.ltp,
    high52w:     swingData?.high52w,
    low52w:      swingData?.low52w,
    swingHigh:   swingData?.swingHigh,
    swingLow:    swingData?.swingLow,
    ipoDate:     swingData?.ipoDate,
    allTimeHigh: swingData?.allTimeHigh,
    allTimeLow:  swingData?.allTimeLow,
    priceUnit:   swingData?.priceUnit || null,
  });

  gannCache.set(sym, { analysis, computedAt: Date.now() });
  return analysis;
}

/**
 * Convert Gann analysis into a composite score contribution (0–100).
 *
 * Add this weight to compositeScoreEngine.js WEIGHTS:
 *   gann: 0.15   (shift 15% weight from circuit or credibility)
 *
 * The Gann signal is directional (bull/bear) + proximity to key levels.
 */
function gannToCompositeSignal(analysis) {
  if (!analysis?.signal) return null;

  const { signal, alerts, keyLevels, timeCycles: cycles } = analysis;

  // Base score from Gann bias
  let score = signal.score; // 0–100

  // Boost if price is very close to a key level (imminent move)
  const highPriorityAlerts = (alerts || []).filter(a => a.priority === "HIGH");
  if (highPriorityAlerts.length >= 2) score = Math.min(100, score + 10);
  if (highPriorityAlerts.length >= 1) score = Math.min(100, score + 5);

  // Boost if major time cycle is imminent
  const imminentMajor = (cycles || []).filter(
    c => c.daysFromToday <= 3 && (c.cycleStrength === "MAJOR" || c.cycleStrength === "EXTREME")
  );
  if (imminentMajor.length > 0) score = Math.min(100, score + 8);

  const topReason = highPriorityAlerts[0]?.message || signal.factors[0] || "Gann analysis";

  return {
    key:    "gann",
    score:  Math.round(score),
    weight: 0.15,
    label:  "Gann Analysis",
    detail: topReason.replace(/^[⏰📅⚡🔢🎯]\s/, ""),
    color:  signal.bias === "BULLISH" ? "green" : signal.bias === "BEARISH" ? "red" : "amber",
    icon:   "📐",
    raw: {
      bias:         signal.bias,
      masterAngle:  keyLevels?.masterAngle,
      aboveMaster:  analysis.priceOnUpFan?.aboveMasterAngle,
      activeAlerts: highPriorityAlerts.length,
      headline:     analysis.headline,
    },
  };
}

/**
 * Socket handler — client requests full Gann drill-down for a symbol.
 */
function registerSocketHandlers(io, socket) {
  socket.on("get-gann-analysis", ({ symbol, ltp }) => {
    const analysis = getGannAnalysis(symbol, ltp);
    if (analysis) {
      socket.emit("gann-analysis", analysis);
    }
  });
}

/**
 * Broadcast Gann alerts to all clients for a symbol.
 */
function broadcastGannAlerts(io, symbol, analysis) {
  if (!io || !analysis?.alerts?.length) return;
  const highAlerts = analysis.alerts.filter(a => a.priority === "HIGH");
  if (highAlerts.length > 0) {
    io.emit("gann-alert", {
      symbol,
      ltp:    analysis.ltp,
      alerts: highAlerts,
      headline: analysis.headline,
    });
  }
}

/**
 * Start the Gann integration service.
 * Call from coordinator.js after startCompositeEngine().
 */
function startGannIntegration(io, deps = {}) {
  const { onNewLTP, setGannSignal } = deps;

  // Re-run analysis whenever LTP updates (throttled by cache)
  if (typeof onNewLTP === "function") {
    onNewLTP((symbol, ltp) => {
      const analysis = getGannAnalysis(symbol, ltp);
      if (!analysis) return;

      broadcastGannAlerts(io, symbol, analysis);

      // Feed back into composite score
      if (typeof setGannSignal === "function") {
        const signal = gannToCompositeSignal(analysis);
        if (signal) setGannSignal(symbol, signal);
      }
    });
  }

  // Register socket handlers for drill-down requests
  if (io) {
    io.on("connection", socket => registerSocketHandlers(io, socket));
  }

  console.log("📐 GannIntegration started");
}

// ── Batch analysis (for cron / startup) ──────────────────────────────────────
function runBatchGannAnalysis(symbols = []) {
  const results = [];
  for (const sym of symbols) {
    const data = swingStore.get(sym.toUpperCase());
    if (!data?.ltp) continue;
    const analysis = getGannAnalysis(sym, data.ltp);
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
};