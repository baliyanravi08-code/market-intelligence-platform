"use strict";

/**
 * optionsIntegration.js
 * server/services/intelligence/optionsIntegration.js
 *
 * Wires optionsIntelligenceEngine + gannEngine together and emits
 * structured socket events consumed by the Options Intel v2 dashboard.
 *
 * Socket events emitted:
 *   "options-intel"   → full intelligence payload per symbol (on every OI refresh)
 *   "gann-update"     → Gann analysis per symbol (on every LTP tick, throttled 30s)
 *   "options-alert"   → individual alert objects (high-priority, real-time)
 *
 * Called from coordinator.js after it receives option chain data.
 *
 * Usage (in coordinator.js or nseOIListener.js):
 *   const { emitOptionsIntel, emitGannUpdate, setIO } = require('./optionsIntegration');
 *   setIO(io);
 *   // After each option chain refresh:
 *   emitOptionsIntel(io, symbol, chainData, spotPrice, expiryDate, gannParams);
 *   // After each LTP tick:
 *   emitGannUpdate(io, symbol, ltp, gannParams);
 */

const optionsEngine = require("./optionsIntelligenceEngine");
const gannEngine    = require("./gannEngine");

// ── Config ────────────────────────────────────────────────────────────────────

const INDIA_RF = 0.065;

// NSE lot sizes (update quarterly)
const LOT_SIZES = {
  NIFTY:     75,
  BANKNIFTY: 35,
  SENSEX:    10,
  FINNIFTY:  65,
  MIDCPNIFTY:120,
};

// Gann throttle: re-run gann analysis at most every N ms per symbol
const GANN_THROTTLE_MS = 30_000;
const _gannLastRun = {};

// Historical IV cache (symbol → last 252 daily ATM IVs, updated rolling)
const _ivHistory = {};    // symbol → number[]
const _closeHistory = {}; // symbol → number[] (closing spot prices)

// IO ref
let _io = null;

// ── Public API ────────────────────────────────────────────────────────────────

function setIO(io) {
  _io = io;
}

/**
 * Run full options intelligence and emit to all connected clients.
 *
 * @param {object} io         - socket.io server instance
 * @param {string} symbol     - "NIFTY" | "BANKNIFTY" | "SENSEX"
 * @param {string} displaySym - "NIFTY 50" | "BANK NIFTY" | "SENSEX" (UI label)
 * @param {Array}  rawChain   - array from processOptionChain().strikes
 * @param {number} spotPrice
 * @param {string} expiryDate - "YYYY-MM-DD"
 * @param {Array}  [historicalIVs]  - past year daily ATM IV values (0–1 range)
 * @param {Array}  [closes]         - past 60+ daily closing prices
 */
function emitOptionsIntel(io, symbol, displaySym, rawChain, spotPrice, expiryDate, historicalIVs, closes) {
  if (!rawChain || !spotPrice || !expiryDate) return;

  // Build chain format expected by optionsIntelligenceEngine
  const chain = rawChain.map(s => ({
    strike:   s.strike,
    callOI:   s.ce?.oi   || 0,
    putOI:    s.pe?.oi   || 0,
    callVol:  s.ce?.volume || 0,
    putVol:   s.pe?.volume || 0,
    callLTP:  s.ce?.ltp  || 0,
    putLTP:   s.pe?.ltp  || 0,
    callIV:   s.ce?.iv   || null,   // Upstox provides these
    putIV:    s.pe?.iv   || null,
    oiChange: (s.ce?.oiChange || 0) + (s.pe?.oiChange || 0),
  }));

  // Update rolling IV history from current ATM IV
  const atmRow = chain.reduce((b, r) =>
    Math.abs(r.strike - spotPrice) < Math.abs(b.strike - spotPrice) ? r : b
  );
  const atmIV = atmRow?.callIV || atmRow?.putIV;
  if (atmIV && atmIV > 0.01) {
    if (!_ivHistory[symbol]) _ivHistory[symbol] = [];
    _ivHistory[symbol].push(atmIV);
    if (_ivHistory[symbol].length > 252) _ivHistory[symbol].shift();
  }

  // Update rolling close history
  if (spotPrice) {
    if (!_closeHistory[symbol]) _closeHistory[symbol] = [];
    _closeHistory[symbol].push(spotPrice);
    if (_closeHistory[symbol].length > 65) _closeHistory[symbol].shift();
  }

  const ivs    = historicalIVs   || _ivHistory[symbol]    || [];
  const clses  = closes           || _closeHistory[symbol] || [];
  const lotSize = LOT_SIZES[symbol] || 1;

  let result;
  try {
    result = optionsEngine.analyzeOptionsChain({
      symbol,
      spotPrice,
      chain,
      expiryDate,
      historicalIVs: ivs,
      closes:        clses,
      lotSize,
      riskFreeRate:  INDIA_RF,
    });
  } catch (e) {
    console.error(`[optionsIntegration] analyzeOptionsChain failed for ${symbol}:`, e.message);
    return;
  }

  if (!result || result.error) return;

  // ── Map engine output → dashboard payload ──────────────────────────────────
  // Dashboard expects: { symbol, score, bias, strategy, spot, ltp,
  //   volatility, atmGreeks, gex, dealerExposures, oi, structure }
  //
  // strategy is array of strategy strings for the tag chips
  // oi.unusualOI and oi.unusualOITailRisk need to be arrays of
  //   { strike, type, oi, vol, oiChange }

  const unusualOI = buildUnusualOI(rawChain, spotPrice, "near");
  const unusualOITailRisk = buildUnusualOI(rawChain, spotPrice, "tail");

  const payload = {
    symbol:      displaySym,
    score:       result.score,
    bias:        result.bias,
    confidence:  result.confidence,
    factors:     result.factors || [],

    spot:  spotPrice,
    ltp:   spotPrice,

    // Strategy tags (array of strategy name strings)
    strategy: (result.strategy || []).map(s => s.strategy),

    volatility: {
      atmIV:        result.volatility?.atmIV  || 0,
      hv20:         result.volatility?.hv20   || 0,
      hv60:         result.volatility?.hv60   || 0,
      vrp:          result.volatility?.vrp    || 0,
      ivRank:       result.volatility?.ivRank || 0,
      ivPercentile: result.volatility?.ivPercentile || 0,
      skew25:       result.volatility?.skew25 || 0,
      skewSentiment:result.volatility?.skewSentiment || "NEUTRAL",
    },

    atmGreeks: {
      delta: result.atmGreeks?.delta || 0.5,
      gamma: result.atmGreeks?.gamma || 0,
      theta: result.atmGreeks?.theta || 0,
      vega:  result.atmGreeks?.vega  || 0,
      rho:   result.atmGreeks?.rho   || 0,
    },

    gex: {
      netGEX:    result.gex?.netGEX  || 0,
      callGEX:   result.gex?.callGEX || 0,
      putGEX:    result.gex?.putGEX  || 0,
      callWall:  result.gex?.callWall   || null,
      putWall:   result.gex?.putWall    || null,
      gammaFlip: result.gex?.gammaFlip  || null,
      regime:    result.gex?.regime     || "MEAN_REVERTING",
      topStrikes: result.gex?.topStrikes || [],
    },

    dealerExposures: {
      dex:  result.dealerExposures?.dex  || 0,
      vex:  result.dealerExposures?.vex  || 0,
      chex: result.dealerExposures?.chex || 0,
    },

    oi: {
      pcr:             result.oi?.pcr            || 0,
      maxPain:         result.oi?.maxPain         || null,
      totalCallOI:     result.oi?.totalCallOI     || 0,
      totalPutOI:      result.oi?.totalPutOI      || 0,
      netPremiumFlow:  result.oi?.netPremiumFlow  || 0,
      premiumBias:     result.oi?.premiumBias     || "NEUTRAL",
      unusualOI,
      unusualOITailRisk,
    },

    structure: {
      straddlePrice:    result.structure?.straddlePrice    || 0,
      expectedMoveAbs:  result.structure?.expectedMoveAbs  || 0,
      expectedMovePct:  result.structure?.expectedMovePct  || 0,
      vrp:              result.structure?.vrp              || 0,
      ivEnvironment:    result.structure?.ivEnvironment    || "NORMAL",
      eventRiskScore:   result.structure?.eventRiskScore   || 0,
      supportFromOI:    result.structure?.supportFromOI    || result.gex?.putWall || null,
      resistanceFromOI: result.structure?.resistanceFromOI || result.gex?.callWall || null,
    },

    updatedAt: Date.now(),
  };

  (io || _io)?.emit("options-intel", payload);

  // Emit individual HIGH alerts
  emitHighAlerts(io || _io, symbol, result);
}

/**
 * Run Gann analysis and emit update (throttled per symbol).
 *
 * @param {object} io
 * @param {string} symbol     - "NIFTY" | "BANKNIFTY" | "SENSEX"
 * @param {string} displaySym - "NIFTY 50" | "BANK NIFTY" | "SENSEX"
 * @param {number} ltp
 * @param {object} gannParams - { high52w, low52w, swingHigh, swingLow, ipoDate, allTimeHigh, allTimeLow }
 */
function emitGannUpdate(io, symbol, displaySym, ltp, gannParams = {}) {
  const now = Date.now();
  if (_gannLastRun[symbol] && now - _gannLastRun[symbol] < GANN_THROTTLE_MS) return;
  _gannLastRun[symbol] = now;

  let result;
  try {
    result = gannEngine.analyzeGann({
      symbol,
      ltp,
      high52w:    gannParams.high52w    || ltp * 1.1,
      low52w:     gannParams.low52w     || ltp * 0.9,
      swingHigh:  gannParams.swingHigh  || null,
      swingLow:   gannParams.swingLow   || null,
      ipoDate:    gannParams.ipoDate    || null,
      allTimeHigh:gannParams.allTimeHigh|| null,
      allTimeLow: gannParams.allTimeLow || null,
      priceUnit:  gannParams.priceUnit  || null,
    });
  } catch (e) {
    console.error(`[optionsIntegration] analyzeGann failed for ${symbol}:`, e.message);
    return;
  }

  if (!result || result.error) return;

  // Map gannEngine output → dashboard GANN_MAP format
  const payload = {
    symbol: displaySym,

    // signal block (dashboard reads signal.bias, signal.score, signal.summary)
    signal: {
      bias:    result.signal?.bias    || "NEUTRAL",
      score:   result.signal?.score   || 50,
      summary: result.signal?.summary || "",
    },

    // squareOfNine block
    squareOfNine: result.squareOfNine ? {
      angleOnSquare:    result.squareOfNine.angleOnSquare,
      positionOnSquare: result.squareOfNine.positionOnSquare,
    } : null,

    // keyLevels block
    keyLevels: result.keyLevels ? {
      supports:    (result.keyLevels.supports    || []).slice(0, 3),
      resistances: (result.keyLevels.resistances || []).slice(0, 3),
      masterAngle: result.keyLevels.masterAngle || null,
    } : null,

    // timeCycles array
    timeCycles: (result.timeCycles || []).slice(0, 4).map(c => ({
      label:         c.label,
      daysFromToday: c.daysFromToday,
      proximity:     c.proximity,
      cycleStrength: c.cycleStrength,
    })),

    // alerts array
    alerts: (result.alerts || []).slice(0, 4).map(a => ({
      priority: a.priority,
      message:  a.message,
    })),

    headline: result.headline || "",

    // gannFan position (for structure panel)
    priceOnUpFan:   result.priceOnUpFan   || null,
    priceOnDownFan: result.priceOnDownFan || null,

    updatedAt: Date.now(),
  };

  (io || _io)?.emit("gann-update", payload);

  // Emit HIGH priority Gann alerts individually
  (result.alerts || [])
    .filter(a => a.priority === "HIGH")
    .forEach(a => {
      (io || _io)?.emit("options-alert", {
        type:     a.type || "GANN",
        priority: "HIGH",
        symbol:   displaySym,
        message:  a.message,
        ts:       Date.now(),
      });
    });
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Build unusualOI / tailRisk arrays from raw strike data.
 * "near" = within 8% of spot, high OI/vol
 * "tail" = beyond 8% of spot (institutional hedges)
 */
function buildUnusualOI(rawChain, spotPrice, mode) {
  if (!rawChain || !spotPrice) return [];

  const results = [];
  const pctThreshold = 0.08;

  for (const row of rawChain) {
    const dist = Math.abs(row.strike - spotPrice) / spotPrice;
    const isNear = dist <= pctThreshold;
    if (mode === "near"  && !isNear) continue;
    if (mode === "tail"  &&  isNear) continue;

    // CE
    if ((row.ce?.oi || 0) > 50000 || (row.ce?.volume || 0) > 5000) {
      results.push({
        strike:   row.strike,
        type:     "CALL",
        oi:       row.ce?.oi       || 0,
        vol:      row.ce?.volume   || 0,
        oiChange: row.ce?.oiChange || 0,
      });
    }
    // PE
    if ((row.pe?.oi || 0) > 50000 || (row.pe?.volume || 0) > 5000) {
      results.push({
        strike:   row.strike,
        type:     "PUT",
        oi:       row.pe?.oi       || 0,
        vol:      row.pe?.volume   || 0,
        oiChange: row.pe?.oiChange || 0,
      });
    }
  }

  return results
    .sort((a, b) => b.oi - a.oi)
    .slice(0, 10);
}

/**
 * Emit individual high-priority alerts from options result.
 */
function emitHighAlerts(io, symbol, result) {
  if (!io) return;

  // PCR extreme
  const pcr = result.oi?.pcr;
  if (pcr && pcr > 1.5) {
    io.emit("options-alert", {
      type:     "PCR_SPIKE",
      priority: "HIGH",
      symbol,
      message:  `${symbol}: PCR ${pcr.toFixed(2)} — extreme put loading`,
      ts:       Date.now(),
    });
  }

  // GEX flip
  if (result.gex?.regime === "TREND_AMPLIFYING" && Math.abs(result.gex.netGEX) > 30) {
    io.emit("options-alert", {
      type:     "GAMMA_FLIP",
      priority: "HIGH",
      symbol,
      message:  `${symbol}: Negative GEX ₹${result.gex.netGEX}Cr — dealers short gamma`,
      ts:       Date.now(),
    });
  }

  // IV spike
  if (result.volatility?.ivRank > 85) {
    io.emit("options-alert", {
      type:     "IV_SPIKE",
      priority: "MEDIUM",
      symbol,
      message:  `${symbol}: IV rank ${result.volatility.ivRank}% — premium sellers' market`,
      ts:       Date.now(),
    });
  }
}

/**
 * REST endpoint helper — returns latest cached result for a symbol.
 * Call from coordinator if you want HTTP polling support too.
 */
const _cache = {};
function cacheResult(symbol, payload) {
  _cache[symbol] = { ...payload, cachedAt: Date.now() };
}
function getCached(symbol) {
  return _cache[symbol] || null;
}

module.exports = {
  setIO,
  emitOptionsIntel,
  emitGannUpdate,
  getCached,
};