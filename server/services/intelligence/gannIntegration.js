"use strict";

/**
 * gannIntegration.js
 * server/services/intelligence/gannIntegration.js
 *
 * MARKET HOURS UPDATE:
 *   - Outside market hours (Mon–Fri 09:00–15:45 IST, or weekends):
 *       • No new Gann analysis is computed on LTP ticks.
 *       • The last computed analysis is preserved in gannCache indefinitely.
 *       • Socket "get-gann-analysis" requests return cached data tagged with
 *         _usingCachedLTP: true and _lastUpdatedAt: <ISO timestamp>.
 *       • onNewLTP callbacks are still registered but do NOT trigger computation.
 *   - During market hours: full live behaviour as before.
 *   - This eliminates all redundant CPU + API usage when market is closed.
 */

const gann = require("./gannEngine");
const { isMarketOpen, marketStatus } = require("./marketHours");

// ─── Cache ─────────────────────────────────────────────────────────────────────
// TTL only applies during market hours. Outside hours, cache never expires.
const gannCache    = new Map();   // symbol → { analysis, computedAt }
const CACHE_TTL_MS = 5 * 60 * 1000;   // 5 min during market hours

// ─── Swing pivot store ─────────────────────────────────────────────────────────
const swingStore = new Map();

// ─── Index LTP store ───────────────────────────────────────────────────────────
// Stores the LAST known LTP for each symbol, persisted across market open/close.
// When market reopens, first tick updates this and triggers fresh analysis.
const indexLTPs = new Map();

// ─── Last market-close snapshot ────────────────────────────────────────────────
// When market closes, we freeze the last analysis. This is what the frontend
// shows during closed hours with a "Last known price" label.
const closingSnapshot = new Map();  // symbol → { analysis, closedAt }

// ─── Symbol normaliser ─────────────────────────────────────────────────────────
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

/**
 * Feed swing pivot data from OHLCV / market data source.
 */
function ingestSwingData(data) {
  if (!data?.symbol) return;
  swingStore.set(normaliseSymbol(data.symbol), data);
}

/**
 * Run full Gann analysis for a symbol.
 *
 * Outside market hours:
 *   - Returns the last cached analysis tagged with market-closed metadata.
 *   - Does NOT recompute — no wasted CPU.
 *   - If no cache exists at all, returns null (first ever run hasn't happened).
 *
 * During market hours:
 *   - Recomputes if cache is stale (> 5 min).
 *   - Tags result normally (no _usingCachedLTP flag).
 */
function getGannAnalysis(symbol, ltp) {
  const sym    = normaliseSymbol(symbol);
  const closed = !isMarketOpen();
  const cached = gannCache.get(sym);

  // ── OUTSIDE MARKET HOURS: serve last cached result as-is ─────────────────
  if (closed) {
    if (cached?.analysis) {
      // Tag it so frontend shows "Last known price · Market closed"
      const tagged = {
        ...cached.analysis,
        _usingCachedLTP: true,
        _marketStatus:   marketStatus(),
        _lastUpdatedAt:  new Date(cached.computedAt).toISOString(),
      };
      return tagged;
    }
    // No cache at all — market was never open since server started
    console.warn(`⚠️  Gann [${sym}]: market closed and no cached data available`);
    return null;
  }

  // ── DURING MARKET HOURS ───────────────────────────────────────────────────

  // Return fresh cache if still valid
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) {
    return cached.analysis;
  }

  const swingData = swingStore.get(sym) || {};

  // Resolve LTP: argument → indexLTPs store → swingStore
  const price =
    (ltp && ltp > 0 ? ltp : null) ||
    indexLTPs.get(sym)            ||
    swingData.ltp                 ||
    null;

  if (!price || price <= 0) {
    console.warn(`⚠️  Gann [${sym}]: no LTP from any source — cannot analyse`);
    return null;
  }

  // Persist so future closed-hour requests still have the last price
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

  // Store in cache
  gannCache.set(sym, { analysis, computedAt: Date.now() });
  console.log(`📐 Gann [${sym}]: bias=${analysis.signal?.bias} score=${analysis.signal?.score} price=${price}`);
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
 * Broadcast high-priority Gann alerts to all clients.
 * Only fires during market hours.
 */
function broadcastGannAlerts(io, symbol, analysis) {
  if (!io || !analysis?.alerts?.length) return;
  if (!isMarketOpen()) return;  // no alerts when market is closed
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
 * Socket handler — client requests Gann analysis for a symbol.
 *
 * Outside market hours: returns cached data with market-closed metadata.
 * Frontend GannPanel renders this as "Last known price · Market closed".
 */
function registerSocketHandlers(io, socket) {
  socket.on("get-gann-analysis", ({ symbol, ltp } = {}) => {
    if (!symbol) return;
    const sym      = normaliseSymbol(symbol);
    const closed   = !isMarketOpen();
    const analysis = getGannAnalysis(sym, ltp);

    if (analysis) {
      socket.emit("gann-analysis", analysis);
      if (closed) {
        console.log(`📤 gann-analysis (cached/closed) → ${socket.id} [${sym}]`);
      } else {
        console.log(`📤 gann-analysis (live) → ${socket.id} [${sym}]`);
      }
      return;
    }

    // No data at all (server never ran during market hours)
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

/**
 * Pre-warm Gann cache for index symbols using known LTPs.
 * Only runs if market is open.
 */
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

/**
 * Start the Gann integration service.
 *
 * LTP tick behaviour:
 *   - During market hours  → update indexLTPs, recompute analysis, broadcast.
 *   - Outside market hours → update indexLTPs (store last price) but do NOT
 *     recompute or broadcast. Zero wasted work.
 */
function startGannIntegration(io, deps = {}) {
  const { onNewLTP, setGannSignal } = deps;

  if (typeof onNewLTP === "function") {
    onNewLTP((symbol, ltp) => {
      const sym = normaliseSymbol(symbol);

      // Always store the latest LTP so we have it when market reopens
      indexLTPs.set(sym, ltp);

      // Outside market hours: store price but skip computation entirely
      if (!isMarketOpen()) return;

      // During market hours: full live analysis + broadcast
      const analysis = getGannAnalysis(sym, ltp);
      if (!analysis) return;

      // Broadcast live analysis to all clients
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

      // Replay all cached Gann analyses to new/refreshed clients.
      // Outside market hours these are tagged with _usingCachedLTP: true
      // so the frontend shows the "Last known price" indicator.
      for (const [sym, cached] of gannCache) {
        if (!cached?.analysis) continue;

        const closed = !isMarketOpen();
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

    // Pre-warm after 3s — only effective if market is open
    setTimeout(() => preWarmIndexes(io), 3000);
  }

  console.log("📐 GannIntegration started");
}

/**
 * Batch analysis — only useful during market hours.
 */
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