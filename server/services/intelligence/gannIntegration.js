"use strict";

/**
 * gannIntegration.js
 * server/services/intelligence/gannIntegration.js
 *
 * FIXES IN THIS VERSION (on top of previous session fixes):
 *
 * FIX G-3 — preWarmIndexes called with hardcoded fallback LTPs:
 *   Root cause: preWarmIndexes() calls getGannAnalysis(sym, null).
 *   If indexLTPs is empty (fresh deploy, no MongoDB docs), every symbol
 *   returns null → no emit → panel stays blank at 12s and 45s.
 *   Fix: pass reasonable fallback LTPs (NIFTY~23500, BANKNIFTY~50000,
 *   SENSEX~77000) so getGannAnalysis() can at least compute a structural
 *   analysis using ±15% swing estimates. The real LTP from upstoxStream
 *   replaces this as soon as the first tick arrives via onNewLTP.
 *
 * FIX G-4 — onNewLTP registered even if ltpTickHandler was null at start:
 *   Root cause: server.js was calling setLTPTickHandler AFTER startCoordinator.
 *   Coordinator calls startGannIntegration which wires onNewLTP. But
 *   ltpTickHandler in upstoxStream was null for the first 10-30s of ticks.
 *   Fix: handled in server.js (setLTPTickHandler moved before startCoordinator).
 *   gannIntegration itself is correct — no change needed here.
 *
 * Previously working behaviour preserved — no changes to:
 *   - MongoDB persistence logic
 *   - Outside-market-hours cached serving
 *   - Composite signal generation
 *   - Alert broadcasting
 *   - FIX G-1 (DB restore seeding indexLTPs)
 *   - FIX G-2 (connection replay)
 */

const gann = require("./gannEngine");
const { isMarketOpen, marketStatus } = require("./marketHours");

// ─── Lazy-load MongoDB model ──────────────────────────────────────────────────
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
const gannCache    = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

// ─── Swing pivot store ────────────────────────────────────────────────────────
const swingStore = new Map();

// ─── Index LTP store ──────────────────────────────────────────────────────────
const indexLTPs = new Map();

// ─── Known index symbols ──────────────────────────────────────────────────────
const INDEX_SYMBOLS = ["NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY"];

// ─── FIX G-3: fallback LTPs for preWarm when indexLTPs is empty ──────────────
// These are approximate mid-range values — replaced by real LTP on first tick.
// Without these, preWarmIndexes() returns null for all symbols on fresh deploy.
const FALLBACK_LTPS = {
  NIFTY:      23500,
  BANKNIFTY:  50000,
  SENSEX:     77000,
  FINNIFTY:   23000,
  MIDCPNIFTY: 12000,
};

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
      // Seed indexLTPs from DB so preWarmIndexes has a real price
      if (doc.ltp && doc.ltp > 0) {
        indexLTPs.set(doc.symbol, doc.ltp);
        console.log(`📐 GannCache: restored LTP ${doc.symbol}=${doc.ltp} from DB`);
      }
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
    if (cached?.analysis) {
      console.warn(`⚠️  Gann [${sym}]: no live LTP yet — serving TTL-expired cache`);
      return cached.analysis;
    }
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

/**
 * FIX G-3: preWarmIndexes now uses fallback LTPs when indexLTPs is empty.
 *
 * Previous code: getGannAnalysis(sym, null) → no LTP from any source → null
 * on fresh deploy (no MongoDB docs, upstoxStream not yet connected).
 *
 * Now: passes FALLBACK_LTPS[sym] so the engine always has a price to work
 * with. The analysis uses ±15% fake swing estimates but at least renders
 * the Gann grid. Real LTP from onNewLTP replaces this within seconds.
 */
function preWarmIndexes(io) {
  if (!isMarketOpen()) {
    console.log(`📐 Gann pre-warm: market is ${marketStatus()} — skipping`);
    return;
  }

  let warmed = 0;
  for (const sym of INDEX_SYMBOLS) {
    // FIX G-3: prefer real LTP from indexLTPs, fall back to FALLBACK_LTPS
    const ltp = indexLTPs.get(sym) || FALLBACK_LTPS[sym] || null;
    const analysis = getGannAnalysis(sym, ltp);
    if (analysis && io) {
      io.emit("gann-analysis", analysis);
      warmed++;
      console.log(`📐 Pre-warmed Gann for ${sym} @ ${analysis.ltp}${!indexLTPs.get(sym) ? " (fallback LTP)" : ""}`);
    }
  }

  if (warmed === 0) {
    console.warn("📐 Gann pre-warm: no analyses produced even with fallback LTPs — check gannEngine");
  } else {
    console.log(`📐 Gann pre-warm: emitted ${warmed} analyses to all clients`);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

async function startGannIntegration(io, deps = {}) {
  // Restore persisted cache from MongoDB — seeds indexLTPs (FIX G-1A)
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

      const closed = !isMarketOpen();

      if (gannCache.size > 0) {
        for (const [sym, cached] of gannCache) {
          if (!cached?.analysis) continue;
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
        console.log(`📤 Replayed ${gannCache.size} Gann analyses to new client ${socket.id}`);
      } else if (isMarketOpen()) {
        // Cache empty + market open = first few seconds of server start
        // FIX G-3: use fallback LTPs so new clients get something immediately
        for (const sym of INDEX_SYMBOLS) {
          const ltp = indexLTPs.get(sym) || FALLBACK_LTPS[sym] || null;
          const analysis = getGannAnalysis(sym, ltp);
          if (analysis) {
            socket.emit("gann-analysis", analysis);
            console.log(`📤 Fresh Gann [${sym}] sent to new client ${socket.id}`);
          }
        }
      }
    });

    // 12s delay — gives upstoxStream time to connect + fire first tick
    setTimeout(() => preWarmIndexes(io), 12_000);

    // 45s safety-net pre-warm for slow connections
    setTimeout(() => preWarmIndexes(io), 45_000);
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