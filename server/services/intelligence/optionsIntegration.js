"use strict";

/**
 * optionsIntegration.js
 * Location: server/services/intelligence/optionsIntegration.js
 *
 * Bridges nseOIListener → optionsIntelligenceEngine → socket.io
 *
 * What it does:
 *   1. Subscribes to OI chain updates from nseOIListener (via its event emitter)
 *   2. Calls analyzeOptionsChain() from optionsIntelligenceEngine
 *   3. Emits "options-intelligence" socket events to all connected clients
 *   4. Optionally feeds strong signals into the composite score engine
 *      via the ingestOptionsSignal callback
 *
 * Usage (coordinator.js):
 *   const { startOptionsIntegration } = require('./services/intelligence/optionsIntegration');
 *   startOptionsIntegration(io, { ingestOptionsSignal: ingestOpportunity });
 */

const { analyzeOptionsChain } = require("./optionsIntelligenceEngine");

// nseOIListener may export an event emitter or a subscription function.
// Support both patterns gracefully.
let nseOIListener = null;
try {
  nseOIListener = require("./nseOIListener");
} catch (e) {
  console.warn("⚠️ optionsIntegration: could not load nseOIListener:", e.message);
}

// ── IV history store (in-memory, keyed by symbol) ─────────────────────────────
// Keeps last 252 daily ATM IV snapshots per symbol for IV rank calculation.
const ivHistory = {};          // symbol → number[]
const MAX_IV_HISTORY = 252;

function appendIVHistory(symbol, iv) {
  if (!symbol || !iv || iv <= 0) return;
  if (!ivHistory[symbol]) ivHistory[symbol] = [];
  ivHistory[symbol].push(iv);
  if (ivHistory[symbol].length > MAX_IV_HISTORY) {
    ivHistory[symbol] = ivHistory[symbol].slice(-MAX_IV_HISTORY);
  }
}

// ── Throttle: don't re-analyse the same symbol more than once per 10 seconds ──
const lastAnalysisTs = {};

function shouldAnalyse(symbol, minIntervalMs = 10_000) {
  const now = Date.now();
  if (lastAnalysisTs[symbol] && now - lastAnalysisTs[symbol] < minIntervalMs) return false;
  lastAnalysisTs[symbol] = now;
  return true;
}

// ── Core: run analysis on one symbol/expiry payload ──────────────────────────

function runAnalysis({ symbol, spotPrice, chain, expiryDate, lotSize }, io, ingestOptionsSignal) {
  if (!chain || chain.length === 0 || !spotPrice || !expiryDate) return;
  if (!shouldAnalyse(symbol)) return;

  let result;
  try {
    result = analyzeOptionsChain({
      symbol,
      spotPrice,
      chain,
      expiryDate,
      historicalIVs: ivHistory[symbol] || [],
      closes:        [],          // would need OHLC history for HV — skip for now
      lotSize:       lotSize || 1,
      riskFreeRate:  0.065,
    });
  } catch (e) {
    console.warn(`⚠️ optionsIntegration: analyzeOptionsChain failed for ${symbol}:`, e.message);
    return;
  }

  if (!result || result.error) return;

  // Append ATM IV to rolling history for future IV rank calculations
  if (result.volatility?.atmIV) {
    appendIVHistory(symbol, result.volatility.atmIV / 100);  // store as fraction
  }

  // Emit to all connected socket clients
  if (io) {
    io.emit("options-intelligence", {
      symbol,
      data: result,
      ltp:  spotPrice,
      ts:   Date.now(),
    });
  }

  // Feed strong signals into composite score engine
  if (typeof ingestOptionsSignal === "function") {
    const score  = result.score;
    const bias   = result.bias;
    const topStrat = result.strategy?.[0];

    // Only ingest when signal is meaningful (not neutral)
    if (score != null && (score >= 65 || score <= 35)) {
      try {
        ingestOptionsSignal({
          scrip:     symbol,
          source:    "OPTIONS",
          score,
          bias,
          detail:    topStrat
            ? `${topStrat.strategy}: ${topStrat.note?.slice(0, 80) || ""}`
            : `Options score ${score} — ${bias}`,
          timestamp: Date.now(),
        });
      } catch (e) { /* never crash on ingest */ }
    }
  }
}

// ── Adapter: nseOIListener payloads → runAnalysis ────────────────────────────

/**
 * nseOIListener emits one of these shapes (depending on version):
 *   A) EventEmitter: emitter.on("oi-update", payload => …)
 *   B) Callback:     setOITickHandler(cb)  — cb(payload)
 *   C) Direct:       handleOITick(payload) is called from upstoxStream
 *
 * The payload shape from nseOIListener (after parsing):
 * {
 *   symbol:    "NIFTY",
 *   spotPrice: 24050,
 *   expiries:  ["2025-04-24", ...],
 *   chains: {
 *     "2025-04-24": {
 *       rows: [ { strike, callOI, putOI, callVol, putVol, callLTP, putLTP, callIV, putIV }, … ],
 *       pcr, maxPainStrike, support, resistance, totalCEOI, totalPEOI
 *     }
 *   },
 *   lotSize: 25,
 * }
 */
function handleOIPayload(payload, io, ingestOptionsSignal) {
  if (!payload) return;

  const symbol    = payload.symbol || payload.underlying;
  const spotPrice = payload.spotPrice || payload.spot;
  const lotSize   = payload.lotSize || 1;

  if (!symbol || !spotPrice) return;

  // Pick the nearest expiry with data
  const chains   = payload.chains || {};
  const expiries = payload.expiries || Object.keys(chains);
  if (!expiries.length) return;

  // Sort expiries ascending; pick nearest
  const sortedExpiries = [...expiries].sort();
  const nearestExpiry  = sortedExpiries[0];
  const chainData      = chains[nearestExpiry];
  if (!chainData) return;

  // normalise rows — engine expects { strike, callOI, putOI, callVol, putVol, callLTP, putLTP, callIV, putIV }
  const rows = (chainData.rows || chainData.data || chainData || []);
  if (!Array.isArray(rows) || rows.length === 0) return;

  const chain = rows.map(r => ({
    strike:  r.strike   || r.strikePrice || r.SP,
    callOI:  r.callOI   || r.CE_OI       || r.ceOI  || 0,
    putOI:   r.putOI    || r.PE_OI       || r.peOI  || 0,
    callVol: r.callVol  || r.CE_Vol      || r.ceVol || 0,
    putVol:  r.putVol   || r.PE_Vol      || r.peVol || 0,
    callLTP: r.callLTP  || r.CE_LTP      || r.ceLTP || 0,
    putLTP:  r.putLTP   || r.PE_LTP      || r.peLTP || 0,
    callIV:  r.callIV   || r.CE_IV       || r.ceIV  || null,
    putIV:   r.putIV    || r.PE_IV       || r.peIV  || null,
  })).filter(r => r.strike > 0);

  runAnalysis({ symbol, spotPrice, chain, expiryDate: nearestExpiry, lotSize }, io, ingestOptionsSignal);
}

// ── Start function ────────────────────────────────────────────────────────────

function startOptionsIntegration(io, { ingestOptionsSignal } = {}) {
  console.log("📊 Options Integration: starting…");

  if (!nseOIListener) {
    console.warn("⚠️ optionsIntegration: nseOIListener not available — options analysis disabled");
    return;
  }

  // Pattern A: EventEmitter
  if (typeof nseOIListener.on === "function") {
    nseOIListener.on("oi-update", (payload) => {
      handleOIPayload(payload, io, ingestOptionsSignal);
    });
    console.log("📊 Options Integration: subscribed via EventEmitter (oi-update)");
    return;
  }

  // Pattern B: setOITickHandler callback registration
  if (typeof nseOIListener.setOITickHandler === "function") {
    const existingHandler = nseOIListener.getOITickHandler?.() || null;
    nseOIListener.setOITickHandler((payload) => {
      // chain to existing handler so nseOIListener still works normally
      if (typeof existingHandler === "function") existingHandler(payload);
      handleOIPayload(payload, io, ingestOptionsSignal);
    });
    console.log("📊 Options Integration: subscribed via setOITickHandler");
    return;
  }

  // Pattern C: polling — fall back to polling getAllCached() every 30 seconds
  if (typeof nseOIListener.getAllCached === "function") {
    console.log("📊 Options Integration: no event hook found — using 30s poll on getAllCached");
    setInterval(() => {
      try {
        const all = nseOIListener.getAllCached();
        for (const [symbol, payload] of Object.entries(all || {})) {
          handleOIPayload({ ...payload, symbol }, io, ingestOptionsSignal);
        }
      } catch (e) {
        console.warn("⚠️ optionsIntegration poll error:", e.message);
      }
    }, 30_000);
    return;
  }

  console.warn("⚠️ optionsIntegration: no compatible hook found in nseOIListener — options analysis passive");
}

module.exports = { startOptionsIntegration };