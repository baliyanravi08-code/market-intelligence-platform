"use strict";

/**
 * gannIntegration.js
 * server/services/intelligence/gannIntegration.js
 *
 * FIXES APPLIED:
 *  1. getGannAnalysis — no longer returns null when swingStore is empty.
 *     Falls back to ±5% / ±15% of LTP so Gann runs with just a price.
 *  2. registerSocketHandlers — normalises symbol name before lookup:
 *     "NIFTY 50" → "NIFTY", "BANK NIFTY" → "BANKNIFTY", etc.
 *  3. Added console.warn so silent failures are visible in server logs.
 *  4. All original exports preserved — no breaking changes.
 */

const gann = require("./gannEngine");

// ── Cache ─────────────────────────────────────────────────────────────────────
const gannCache  = new Map();   // symbol → { analysis, computedAt }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Swing pivot store ─────────────────────────────────────────────────────────
const swingStore = new Map();   // symbol → { swingHigh, swingLow, high52w, low52w, … }

// ── Symbol normaliser ─────────────────────────────────────────────────────────
// Converts any display name the frontend might send into the canonical
// short form that gannEngine and swingStore use.
//   "NIFTY 50"   → "NIFTY"
//   "BANK NIFTY" → "BANKNIFTY"
//   "SENSEX"     → "SENSEX"  (unchanged)
//   "FINNIFTY"   → "FINNIFTY" (unchanged)
function normaliseSymbol(raw) {
  if (!raw) return "";
  return raw
    .toUpperCase()
    .trim()
    .replace(/^NIFTY\s+50$/, "NIFTY")
    .replace(/^BANK\s+NIFTY$/, "BANKNIFTY")
    .replace(/^NIFTY\s+BANK$/, "BANKNIFTY")
    .replace(/\s+/g, "");
}

/**
 * Feed swing pivot data from your OHLCV / market data source.
 * Call whenever fresh OHLCV data arrives.
 */
function ingestSwingData(data) {
  if (!data?.symbol) return;
  swingStore.set(normaliseSymbol(data.symbol), data);
}

/**
 * Run full Gann analysis for a symbol.
 *
 * FIX: Previously returned null when swingStore was empty (nothing had
 * called ingestSwingData yet), so the "gann-analysis" event was never
 * emitted and the dashboard showed "Awaiting Gann data…" forever.
 *
 * Now: falls back to estimated swing levels derived from LTP so Gann
 * always runs.  Levels become more accurate once real OHLCV data is
 * ingested via ingestSwingData().
 */
function getGannAnalysis(symbol, ltp) {
  const sym = normaliseSymbol(symbol);

  // Return cache if still fresh
  const cached = gannCache.get(sym);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) {
    return cached.analysis;
  }

  const swingData = swingStore.get(sym) || {};
  const price     = ltp || swingData.ltp;

  // Need at least a price to run any Gann calculation
  if (!price || price <= 0) {
    console.warn(`⚠️  Gann [${sym}]: no LTP available — skipping`);
    return null;
  }

  // ── Fallback levels when OHLCV store is empty ─────────────────────────
  // ±5%  of spot → short-term swing high/low proxy
  // ±15% of spot → 52-week high/low proxy
  // These are rough but allow the Square of Nine, cardinal cross, and
  // Gann fan calculations to produce meaningful output immediately.
  const today = new Date().toISOString().slice(0, 10);

  const high52w   = swingData.high52w   ?? price * 1.15;
  const low52w    = swingData.low52w    ?? price * 0.85;
  const swingHigh = swingData.swingHigh ?? { price: price * 1.05, date: today };
  const swingLow  = swingData.swingLow  ?? { price: price * 0.95, date: today };

  let analysis;
  try {
    analysis = gann.analyzeGann({
      symbol:      sym,
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

  gannCache.set(sym, { analysis, computedAt: Date.now() });
  console.log(`📐 Gann [${sym}]: computed — bias=${analysis.signal?.bias} score=${analysis.signal?.score}`);
  return analysis;
}

/**
 * Convert Gann analysis into a composite score contribution (0–100).
 */
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

/**
 * Socket handler — client requests full Gann drill-down for a symbol.
 *
 * FIX: normalises the symbol before lookup so "NIFTY 50" (sent by the
 * frontend) resolves to the same key as "NIFTY" (used internally).
 */
function registerSocketHandlers(io, socket) {
  socket.on("get-gann-analysis", ({ symbol, ltp } = {}) => {
    if (!symbol) return;

    const sym      = normaliseSymbol(symbol);
    const analysis = getGannAnalysis(sym, ltp);

    if (analysis) {
      socket.emit("gann-analysis", analysis);
      console.log(`📤 gann-analysis sent to ${socket.id} for ${sym}`);
    } else {
      console.warn(`⚠️  gann-analysis: no result for ${sym} ltp=${ltp}`);
    }
  });
}

/**
 * Broadcast high-priority Gann alerts to all clients.
 */
function broadcastGannAlerts(io, symbol, analysis) {
  if (!io || !analysis?.alerts?.length) return;
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

/**
 * Start the Gann integration service.
 */
function startGannIntegration(io, deps = {}) {
  const { onNewLTP, setGannSignal } = deps;

  if (typeof onNewLTP === "function") {
    onNewLTP((symbol, ltp) => {
      const sym      = normaliseSymbol(symbol);
      const analysis = getGannAnalysis(sym, ltp);
      if (!analysis) return;

      broadcastGannAlerts(io, sym, analysis);

      if (typeof setGannSignal === "function") {
        const signal = gannToCompositeSignal(analysis);
        if (signal) setGannSignal(sym, signal);
      }
    });
  }

  if (io) {
    io.on("connection", socket => registerSocketHandlers(io, socket));
  }

  console.log("📐 GannIntegration started");
}

// ── Batch analysis (for cron / startup) ──────────────────────────────────────
function runBatchGannAnalysis(symbols = []) {
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
};