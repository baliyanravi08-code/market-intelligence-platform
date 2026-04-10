"use strict";

/**
 * optionsIntegration.js
 * Location: server/services/intelligence/optionsIntegration.js
 *
 * Bridges nseOIListener → optionsIntelligenceEngine → socket.io
 *
 * FIXES in this version:
 *  1. Lazy-require nseOIListener (breaks circular dep)
 *  2. Exhaustive row extraction — handles every known shape getAllCached() returns
 *  3. Falls back to getChain() per-expiry if getAllCached() rows are missing
 *  4. Exports ingestChainData so nseOIListener can call it directly (fixes
 *     "ingestChainData is not a function" error in nseOIListener)
 */

const { analyzeOptionsChain } = require("./optionsIntelligenceEngine");

// ── Rolling IV history for IV Rank ────────────────────────────────────────────
const ivHistory = {};
function appendIV(symbol, ivPct) {
  if (!symbol || !ivPct || ivPct <= 0) return;
  if (!ivHistory[symbol]) ivHistory[symbol] = [];
  ivHistory[symbol].push(ivPct / 100);
  if (ivHistory[symbol].length > 252) ivHistory[symbol] = ivHistory[symbol].slice(-252);
}

// ── Throttle ──────────────────────────────────────────────────────────────────
const lastRun = {};
function canRun(key) {
  const now = Date.now();
  if (lastRun[key] && now - lastRun[key] < 15_000) return false;
  lastRun[key] = now;
  return true;
}

// ── Extract rows from ANY chain shape nseOIListener might store ───────────────
// Handles: { rows }, { data }, { strikes }, { chain }, plain array,
// or an object keyed by strike number (e.g. { "24000": { CE: {}, PE: {} } })
function extractRows(chainData) {
  if (!chainData) return null;

  // Already an array
  if (Array.isArray(chainData)) return chainData.length > 0 ? chainData : null;

  // Named array field
  for (const key of ["rows", "data", "strikes", "chain", "records", "options"]) {
    if (Array.isArray(chainData[key]) && chainData[key].length > 0) return chainData[key];
  }

  // Object keyed by strike price — convert to row array
  const entries = Object.entries(chainData);
  if (entries.length > 0 && !isNaN(Number(entries[0][0]))) {
    const rows = entries.map(([strike, v]) => ({
      strike:  Number(strike),
      callOI:  v?.CE?.openInterest   || v?.CE?.oi   || v?.ce?.oi   || 0,
      putOI:   v?.PE?.openInterest   || v?.PE?.oi   || v?.pe?.oi   || 0,
      callVol: v?.CE?.totalTradedVolume || v?.CE?.vol || v?.ce?.vol || 0,
      putVol:  v?.PE?.totalTradedVolume || v?.PE?.vol || v?.pe?.vol || 0,
      callLTP: v?.CE?.lastPrice      || v?.CE?.ltp  || v?.ce?.ltp  || 0,
      putLTP:  v?.PE?.lastPrice      || v?.PE?.ltp  || v?.pe?.ltp  || 0,
      callIV:  v?.CE?.impliedVolatility != null ? Number(v.CE.impliedVolatility) / 100 : null,
      putIV:   v?.PE?.impliedVolatility != null ? Number(v.PE.impliedVolatility) / 100 : null,
    })).filter(r => r.strike > 0);
    return rows.length > 0 ? rows : null;
  }

  return null;
}

// ── Normalise a chain row to engine format ────────────────────────────────────
function normaliseRow(r) {
  return {
    strike:  Number(r.strike  || r.strikePrice || r.SP || 0),
    callOI:  Number(r.callOI  || r.CE_OI  || r.ceOI  || r.cOI  || r.CE?.openInterest || 0),
    putOI:   Number(r.putOI   || r.PE_OI  || r.peOI  || r.pOI  || r.PE?.openInterest || 0),
    callVol: Number(r.callVol || r.CE_Vol || r.ceVol || r.cVol || r.CE?.totalTradedVolume || 0),
    putVol:  Number(r.putVol  || r.PE_Vol || r.peVol || r.pVol || r.PE?.totalTradedVolume || 0),
    callLTP: Number(r.callLTP || r.CE_LTP || r.ceLTP || r.cLTP || r.CE?.lastPrice || 0),
    putLTP:  Number(r.putLTP  || r.PE_LTP || r.peLTP || r.pLTP || r.PE?.lastPrice  || 0),
    callIV:  r.callIV != null ? Number(r.callIV)
           : r.CE?.impliedVolatility != null ? Number(r.CE.impliedVolatility) / 100
           : null,
    putIV:   r.putIV  != null ? Number(r.putIV)
           : r.PE?.impliedVolatility != null ? Number(r.PE.impliedVolatility) / 100
           : null,
  };
}

// ── Core analysis runner ──────────────────────────────────────────────────────
let _io = null;
let _ingestOptionsSignal = null;

function runAnalysis(symbol, spotPrice, rawRows, expiryDate, lotSize) {
  if (!symbol || !spotPrice || !rawRows || !expiryDate) return;
  if (!canRun(`${symbol}_${expiryDate}`)) return;

  const chain = (Array.isArray(rawRows) ? rawRows : [])
    .map(normaliseRow)
    .filter(r => r.strike > 0);

  if (chain.length === 0) {
    console.warn(`⚠️ optionsIntegration: ${symbol}/${expiryDate} — 0 valid rows after normalise`);
    return;
  }

  let result;
  try {
    result = analyzeOptionsChain({
      symbol,
      spotPrice,
      chain,
      expiryDate,
      historicalIVs: ivHistory[symbol] || [],
      closes:        [],
      lotSize:       lotSize || 1,
      riskFreeRate:  0.065,
    });
  } catch (e) {
    console.warn(`⚠️ optionsIntegration [${symbol}]:`, e.message);
    return;
  }

  if (!result || result.error) return;

  if (result.volatility?.atmIV) appendIV(symbol, result.volatility.atmIV);

  if (_io) {
    _io.emit("options-intelligence", {
      symbol,
      data: result,
      ltp:  spotPrice,
      ts:   Date.now(),
    });
    console.log(`📡 options-intelligence: ${symbol} score=${result.score} bias=${result.bias} strikes=${chain.length}`);
  }

  if (typeof _ingestOptionsSignal === "function") {
    const { score, bias, strategy } = result;
    if (score != null && (score >= 65 || score <= 35)) {
      try {
        _ingestOptionsSignal({
          scrip:     symbol,
          source:    "OPTIONS",
          score,
          bias,
          detail:    strategy?.[0]
            ? `${strategy[0].strategy}: ${(strategy[0].note || "").slice(0, 80)}`
            : `Options score ${score} — ${bias}`,
          timestamp: Date.now(),
        });
      } catch (_) {}
    }
  }
}

// ── ingestChainData — called directly by nseOIListener ───────────────────────
// This is the function nseOIListener already tries to call but was missing.
// nseOIListener calls: ingestChainData(symbol, spotPrice, chain, expiry, lotSize)
function ingestChainData(symbol, spotPrice, chainData, expiryDate, lotSize) {
  if (!symbol || !spotPrice || !chainData || !expiryDate) return;

  const rows = extractRows(chainData);
  if (!rows) {
    console.warn(`⚠️ ingestChainData: ${symbol}/${expiryDate} — could not extract rows`);
    return;
  }

  runAnalysis(symbol, spotPrice, rows, expiryDate, lotSize || 1);
}

// ── Poll fallback — reads getAllCached() every 15s ────────────────────────────
function poll() {
  let nseOI;
  try {
    nseOI = require("./nseOIListener");
  } catch (e) {
    return;
  }

  // Try getChain() per expiry first (more reliable than getAllCached shape)
  const hasGetChain    = typeof nseOI.getChain    === "function";
  const hasGetExpiries = typeof nseOI.getExpiries === "function";
  const hasGetAll      = typeof nseOI.getAllCached === "function";

  if (hasGetChain && hasGetExpiries) {
    // Best path: use getChain(symbol, expiry) directly
    const symbols = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];
    for (const symbol of symbols) {
      let expiries = [];
      try { expiries = nseOI.getExpiries(symbol) || []; } catch (_) {}
      if (!expiries.length) continue;

      // Get spotPrice from getAllCached if available
      let spotPrice = 0;
      if (hasGetAll) {
        try {
          const all = nseOI.getAllCached();
          spotPrice = all?.[symbol]?.spotPrice || all?.[symbol]?.spot || 0;
        } catch (_) {}
      }
      if (!spotPrice) continue;

      const sorted = [...expiries].sort();
      for (const expiry of sorted.slice(0, 3)) {
        let chainData;
        try { chainData = nseOI.getChain(symbol, expiry); } catch (_) { continue; }
        if (!chainData) continue;

        const rows = extractRows(chainData);
        if (rows) {
          runAnalysis(symbol, spotPrice, rows, expiry, 1);
        } else {
          // chainData itself might be the processed result with metadata
          // Try reading its raw sub-fields
          const sub = chainData.rows || chainData.data || chainData.strikes
                   || chainData.chain || chainData.records;
          if (sub) runAnalysis(symbol, spotPrice, sub, expiry, 1);
          else console.warn(`⚠️ optionsIntegration: ${symbol}/${expiry} — getChain shape unknown, keys: ${Object.keys(chainData || {}).join(",")}`);
        }
      }
    }
    return;
  }

  // Fallback: getAllCached()
  if (!hasGetAll) return;
  let all;
  try { all = nseOI.getAllCached(); } catch (e) { return; }
  if (!all || typeof all !== "object") return;

  const symbols = Object.keys(all);
  console.log(`📊 optionsIntegration poll: ${symbols.length} symbols [${symbols.join(", ")}]`);

  for (const [symbol, payload] of Object.entries(all)) {
    if (!payload) continue;
    const spotPrice = payload.spotPrice || payload.spot || 0;
    const lotSize   = payload.lotSize   || 1;
    const chains    = payload.chains    || {};
    const expiries  = payload.expiries  || Object.keys(chains);
    if (!spotPrice || !expiries.length) continue;

    const sorted = [...expiries].sort();
    for (const expiry of sorted.slice(0, 3)) {
      const chainData = chains[expiry];
      if (!chainData) continue;
      const rows = extractRows(chainData);
      if (rows) {
        runAnalysis(symbol, spotPrice, rows, expiry, lotSize);
      } else {
        console.warn(`⚠️ optionsIntegration: ${symbol}/${expiry} — unknown shape, keys: ${Object.keys(chainData || {}).join(",")}`);
      }
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
function startOptionsIntegration(io, { ingestOptionsSignal } = {}) {
  _io = io;
  _ingestOptionsSignal = ingestOptionsSignal;

  // First poll at 25s — after nseOIListener has completed its first fetch
  setTimeout(poll, 25_000);

  // Then every 15s
  setInterval(poll, 15_000);

  console.log("📊 Options Integration: polling every 15s (first run in 25s)");
}

module.exports = {
  startOptionsIntegration,
  ingestChainData,   // ← nseOIListener calls this directly
};