"use strict";

/**
 * optionsIntegration.js
 * Location: server/services/intelligence/optionsIntegration.js
 *
 * Bridges the optionsIntelligenceEngine into your existing system:
 *   - Consumes option chain data from nseOIListener
 *   - Runs full analysis on each symbol + expiry
 *   - Emits "options-intelligence" socket event
 *   - Feeds score into compositeScoreEngine (15% weight)
 *
 * Add to coordinator.js:
 *   const { startOptionsIntegration } = require('./services/intelligence/optionsIntegration');
 *   startOptionsIntegration(io, { getCompositeForScrip, ingestOptionsSignal });
 */

const { analyzeOptionsChain } = require("./optionsIntelligenceEngine");

// ─── In-memory store ──────────────────────────────────────────────────────────

const optionsCache = new Map();   // symbol → latest analysis result

// ─── Historical IV store (rolling 252-day) ────────────────────────────────────
// In production, persist this to data/optionsIVHistory.json

const ivHistory = new Map();   // symbol → number[] (up to 252 values)

function recordIV(symbol, atmIV) {
  if (!atmIV || atmIV <= 0) return;
  const arr = ivHistory.get(symbol) || [];
  arr.push(atmIV);
  if (arr.length > 252) arr.shift();
  ivHistory.set(symbol, arr);
}

// ─── Core analysis runner ─────────────────────────────────────────────────────

/**
 * Run full options intelligence analysis for one symbol.
 * Called whenever fresh OI data arrives from nseOIListener.
 *
 * @param {Object} chainData   Normalized chain from nseOIListener
 *   chainData.symbol:        "RELIANCE"
 *   chainData.spotPrice:     2941.50
 *   chainData.expiryDate:    "2025-04-24"
 *   chainData.chain:         [{ strike, callOI, putOI, callVol, putVol, callLTP, putLTP, callIV, putIV }]
 *   chainData.closes:        [] (optional — daily closes for HV calc)
 *   chainData.lotSize:       1300
 * @param {Function} onResult  Callback receiving the full result
 */
function runOptionsAnalysis(chainData, onResult) {
  const { symbol, spotPrice, expiryDate, chain, closes, lotSize } = chainData;

  if (!symbol || !spotPrice || !chain || chain.length === 0) return;

  // Get stored IV history for this symbol
  const historicalIVs = ivHistory.get(symbol) || [];

  try {
    const result = analyzeOptionsChain({
      symbol,
      spotPrice,
      chain,
      expiryDate,
      historicalIVs,
      closes:       closes || [],
      lotSize:      lotSize || 1,
    });

    // Record ATM IV for history
    if (result.volatility?.atmIV) {
      recordIV(symbol, result.volatility.atmIV / 100);   // store as decimal
    }

    // Cache
    optionsCache.set(symbol, result);

    if (typeof onResult === 'function') onResult(result);
  } catch (err) {
    console.error(`📊 Options engine error for ${symbol}:`, err.message);
  }
}

// ─── Socket integration ───────────────────────────────────────────────────────

let _io = null;
let _ingestOptionsSignal = null;

function startOptionsIntegration(io, { ingestOptionsSignal } = {}) {
  _io = io;
  _ingestOptionsSignal = ingestOptionsSignal;

  console.log("📊 Options Intelligence Engine started");

  // Handle on-demand requests from frontend
  io.on("connection", (socket) => {
    // Client requests analysis for a specific symbol
    socket.on("get-options-analysis", ({ symbol } = {}) => {
      if (!symbol) return;
      const cached = optionsCache.get(symbol.toUpperCase());
      if (cached) {
        socket.emit("options-intelligence", cached);
      } else {
        socket.emit("options-intelligence", { symbol, error: "No data yet — OI feed pending" });
      }
    });

    // Client can request the leaderboard of options scores
    socket.on("get-options-leaderboard", () => {
      const leaderboard = Array.from(optionsCache.values())
        .filter(r => r.score !== null)
        .sort((a, b) => Math.abs(b.score - 50) - Math.abs(a.score - 50))  // most conviction first
        .slice(0, 50)
        .map(r => ({
          symbol:     r.symbol,
          score:      r.score,
          bias:       r.bias,
          confidence: r.confidence,
          ivRank:     r.volatility?.ivRank,
          pcr:        r.oi?.pcr,
          gexRegime:  r.gex?.regime,
          topFactor:  r.factors?.[0] || '',
        }));
      socket.emit("options-leaderboard", leaderboard);
    });
  });
}

/**
 * Call this from nseOIListener whenever fresh chain data arrives.
 * This is the main entry point for live data.
 *
 * Example (in nseOIListener.js):
 *   const { ingestChainData } = require('./optionsIntegration');
 *   ingestChainData({ symbol, spotPrice, expiryDate, chain, lotSize });
 */
function ingestChainData(chainData) {
  runOptionsAnalysis(chainData, (result) => {
    // Emit to all connected clients
    if (_io) {
      _io.emit("options-intelligence", result);
    }

    // Feed into compositeScoreEngine if integration function is provided
    if (typeof _ingestOptionsSignal === 'function' && result.score !== null) {
      _ingestOptionsSignal({
        symbol: result.symbol,
        score:  result.score,
        bias:   result.bias,
        data:   result,
      });
    }
  });
}

/**
 * Get cached result for a symbol (sync, for use in other engines).
 */
function getOptionsSignal(symbol) {
  return optionsCache.get(symbol?.toUpperCase()) || null;
}

/**
 * Get all cached results (for leaderboard or composite recompute).
 */
function getAllOptionsSignals() {
  return Array.from(optionsCache.values());
}

module.exports = {
  startOptionsIntegration,
  ingestChainData,
  getOptionsSignal,
  getAllOptionsSignals,
  runOptionsAnalysis,
};