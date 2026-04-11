"use strict";

/**
 * optionsIntegration.js
 * Location: server/services/intelligence/optionsIntegration.js
 *
 * ALL FIXES APPLIED:
 *  1. Direct require of websocket.js (no lazy load) — file now exists
 *  2. setCachedIntel() called BEFORE every io.emit so page-refresh replay works
 *  3. extractRows() correctly handles processChain() output shape (s.ce/s.pe)
 *  4. safeIV() normalises Upstox decimal (0.15) AND NSE % (15.0) — fixes ATM IV = —
 *  5. ingestChainData exported for nseOIListener's 5 positional-arg call
 */

const { analyzeOptionsChain } = require("./optionsIntelligenceEngine");
const { setCachedIntel }      = require("../../api/websocket"); // direct require — file exists

// ── Rolling IV history for IV Rank ────────────────────────────────────────────
const ivHistory = {};
function appendIV(symbol, ivPct) {
  if (!symbol || !ivPct || ivPct <= 0) return;
  if (!ivHistory[symbol]) ivHistory[symbol] = [];
  ivHistory[symbol].push(ivPct / 100);
  if (ivHistory[symbol].length > 252) ivHistory[symbol] = ivHistory[symbol].slice(-252);
}

// ── Throttle — max one analysis per symbol/expiry per 15 s ───────────────────
const lastRun = {};
function canRun(key) {
  const now = Date.now();
  if (lastRun[key] && now - lastRun[key] < 15_000) return false;
  lastRun[key] = now;
  return true;
}

// ── Normalise IV — handles Upstox decimal (0.15) AND NSE % (15.0) ────────────
function safeIV(raw) {
  if (raw == null || raw <= 0) return null;
  return raw > 5 ? raw / 100 : raw; // >5 means it's already a percentage
}

// ── Extract rows from ANY chain shape nseOIListener might produce ─────────────
function extractRows(chainData) {
  if (!chainData) return null;

  // Plain array passed directly from nseOIListener's ingestChainData call
  if (Array.isArray(chainData)) return chainData.length > 0 ? chainData : null;

  // processChain() output — .strikes array with s.ce / s.pe sub-objects
  if (Array.isArray(chainData.strikes) && chainData.strikes.length > 0) {
    return chainData.strikes.map(s => ({
      strike:  s.strike,
      callOI:  s.ce?.oi      || 0,
      putOI:   s.pe?.oi      || 0,
      callVol: s.ce?.volume  || 0,
      putVol:  s.pe?.volume  || 0,
      callLTP: s.ce?.ltp     || 0,
      putLTP:  s.pe?.ltp     || 0,
      callIV:  s.ce?.iv != null ? safeIV(s.ce.iv) : null,
      putIV:   s.pe?.iv != null ? safeIV(s.pe.iv) : null,
    }));
  }

  // Other named arrays
  for (const key of ["rows", "data", "chain", "records", "options"]) {
    if (Array.isArray(chainData[key]) && chainData[key].length > 0) return chainData[key];
  }

  // Object keyed by strike number e.g. { "24000": { CE: {}, PE: {} } }
  const entries = Object.entries(chainData);
  if (entries.length > 0 && !isNaN(Number(entries[0][0]))) {
    const rows = entries.map(([strike, v]) => ({
      strike:  Number(strike),
      callOI:  v?.CE?.openInterest      || v?.CE?.oi || v?.ce?.oi || 0,
      putOI:   v?.PE?.openInterest      || v?.PE?.oi || v?.pe?.oi || 0,
      callVol: v?.CE?.totalTradedVolume || v?.CE?.vol || v?.ce?.vol || 0,
      putVol:  v?.PE?.totalTradedVolume || v?.PE?.vol || v?.pe?.vol || 0,
      callLTP: v?.CE?.lastPrice         || v?.CE?.ltp || v?.ce?.ltp || 0,
      putLTP:  v?.PE?.lastPrice         || v?.PE?.ltp || v?.pe?.ltp || 0,
      callIV:  v?.CE?.impliedVolatility != null ? safeIV(v.CE.impliedVolatility) : null,
      putIV:   v?.PE?.impliedVolatility != null ? safeIV(v.PE.impliedVolatility) : null,
    })).filter(r => r.strike > 0);
    return rows.length > 0 ? rows : null;
  }

  return null;
}

// ── Normalise a single row to engine format ───────────────────────────────────
function normaliseRow(r) {
  return {
    strike:  Number(r.strike  || r.strikePrice || r.SP || 0),
    callOI:  Number(r.callOI  || r.CE_OI  || r.ceOI  || r.CE?.openInterest || 0),
    putOI:   Number(r.putOI   || r.PE_OI  || r.peOI  || r.PE?.openInterest || 0),
    callVol: Number(r.callVol || r.CE_Vol || r.ceVol || r.CE?.totalTradedVolume || 0),
    putVol:  Number(r.putVol  || r.PE_Vol || r.peVol || r.PE?.totalTradedVolume || 0),
    callLTP: Number(r.callLTP || r.CE_LTP || r.ceLTP || r.CE?.lastPrice || 0),
    putLTP:  Number(r.putLTP  || r.PE_LTP || r.peLTP || r.PE?.lastPrice  || 0),
    callIV:  r.callIV != null ? safeIV(r.callIV)
           : r.CE?.impliedVolatility != null ? safeIV(r.CE.impliedVolatility) : null,
    putIV:   r.putIV  != null ? safeIV(r.putIV)
           : r.PE?.impliedVolatility != null ? safeIV(r.PE.impliedVolatility) : null,
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
    const payload = { symbol, data: result, ltp: spotPrice, ts: Date.now() };

    // Cache BEFORE emit — so clients connecting during/after this tick
    // get the snapshot immediately via attachSocketIO's "connection" handler
    try { setCachedIntel(symbol, payload); } catch (_) {}

    _io.emit("options-intelligence", payload);
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

// ── ingestChainData — called by nseOIListener with 5 positional args ──────────
function ingestChainData(symbol, spotPrice, chainData, expiryDate, lotSize) {
  if (!symbol || !spotPrice || !chainData || !expiryDate) return;
  const rows = extractRows(chainData);
  if (!rows || rows.length === 0) {
    console.warn(`⚠️ ingestChainData: ${symbol}/${expiryDate} — could not extract rows`);
    return;
  }
  runAnalysis(symbol, spotPrice, rows, expiryDate, lotSize || 1);
}

// ── Poll fallback — reads nseOIListener cache every 15s ──────────────────────
function poll() {
  let nseOI;
  try { nseOI = require("./nseOIListener"); } catch (e) { return; }

  const hasGetChain    = typeof nseOI.getChain    === "function";
  const hasGetExpiries = typeof nseOI.getExpiries === "function";
  const hasGetAll      = typeof nseOI.getAllCached === "function";

  if (hasGetChain && hasGetExpiries) {
    const symbols = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];
    for (const symbol of symbols) {
      let expiries = [];
      try { expiries = nseOI.getExpiries(symbol) || []; } catch (_) {}
      if (!expiries.length) continue;

      let spotPrice = 0;
      if (hasGetAll) {
        try {
          const all = nseOI.getAllCached();
          spotPrice = all?.[symbol]?.spotPrice || 0;
        } catch (_) {}
      }
      if (!spotPrice) continue;

      for (const expiry of [...expiries].sort().slice(0, 3)) {
        let chainData;
        try { chainData = nseOI.getChain(symbol, expiry); } catch (_) { continue; }
        if (!chainData) continue;
        const rows = extractRows(chainData);
        if (rows && rows.length > 0) {
          runAnalysis(symbol, spotPrice, rows, expiry, 1);
        } else {
          console.warn(`⚠️ optionsIntegration poll: ${symbol}/${expiry} — no rows (keys: ${Object.keys(chainData || {}).join(",")})`);
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

  for (const [symbol, payload] of Object.entries(all)) {
    if (!payload) continue;
    const spotPrice = payload.spotPrice || 0;
    const lotSize   = payload.lotSize   || 1;
    const chains    = payload.chains    || {};
    const expiries  = payload.expiries  || Object.keys(chains);
    if (!spotPrice || !expiries.length) continue;

    for (const expiry of [...expiries].sort().slice(0, 3)) {
      const chainData = chains[expiry];
      if (!chainData) continue;
      const rows = extractRows(chainData);
      if (rows && rows.length > 0) {
        runAnalysis(symbol, spotPrice, rows, expiry, lotSize);
      }
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
function startOptionsIntegration(io, { ingestOptionsSignal } = {}) {
  _io = io;
  _ingestOptionsSignal = ingestOptionsSignal;
  setTimeout(poll, 25_000);
  setInterval(poll, 15_000);
  console.log("📊 Options Integration: polling every 15s (first run in 25s)");
}

module.exports = { startOptionsIntegration, ingestChainData };