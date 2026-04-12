"use strict";

/**
 * optionsIntegration.js
 * Location: server/services/intelligence/optionsIntegration.js
 *
 * ══════════════════════════════════════════════════════════════
 * FIXES APPLIED (on top of previous session fixes):
 *
 * FIX 3 — closes[] now accepted and forwarded to analyzeOptionsChain:
 *   ingestChainData() now accepts a 6th positional arg: closes[]
 *   This is the rolling spot history from nseOIListener (appended once
 *   per 60s poll). Forwarded to analyzeOptionsChain() so the engine can
 *   compute real HV20 and HV60 instead of returning null.
 *   The old closesProxy (spotPrice * (1 - iv)) was a garbage approximation
 *   that produced null from historicalVolatility() — now replaced.
 *
 * Previously fixed (preserved):
 *   FIX A — poll() is a NO-OP (nseOIListener drives all analysis)
 *   FIX B — throttle 55s to match 60s poll interval
 *   FIX C — prevVolMap wired for delta-based net flow
 *   FIX D — setCachedIntel called before emit
 * ══════════════════════════════════════════════════════════════
 */

const { analyzeOptionsChain } = require("./optionsIntelligenceEngine");
const { setCachedIntel }      = require("../../api/websocket");

// ── Rolling IV history for IV Rank ────────────────────────────────────────────
const ivHistory = {};
function appendIV(symbol, ivPct) {
  if (!symbol || !ivPct || ivPct <= 0) return;
  if (!ivHistory[symbol]) ivHistory[symbol] = [];
  ivHistory[symbol].push(ivPct / 100);
  if (ivHistory[symbol].length > 252) ivHistory[symbol] = ivHistory[symbol].slice(-252);
}

// ── FIX B: Throttle — 55s matches the 60s poll interval in nseOIListener ─────
const lastRun = {};
function canRun(key) {
  const now = Date.now();
  if (lastRun[key] && now - lastRun[key] < 55_000) return false;
  lastRun[key] = now;
  return true;
}

// ── FIX C: prevVolMap store — one map per symbol+expiry ──────────────────────
const prevVolMaps = {};

function getPrevVolMap(symbol, expiry) {
  const key = `${symbol}__${expiry}`;
  if (!prevVolMaps[key]) prevVolMaps[key] = {};
  return prevVolMaps[key];
}

function updatePrevVolMap(symbol, expiry, chain) {
  const key = `${symbol}__${expiry}`;
  const map = {};
  for (const row of chain) {
    if (row.strike) {
      map[`${row.strike}_ce`] = row.callVol || 0;
      map[`${row.strike}_pe`] = row.putVol  || 0;
    }
  }
  prevVolMaps[key] = map;
}

// ── Normalise IV ──────────────────────────────────────────────────────────────
function safeIV(raw) {
  if (raw == null || raw <= 0) return null;
  return raw > 5 ? raw / 100 : raw;
}

// ── Extract rows from ANY chain shape nseOIListener might produce ─────────────
function extractRows(chainData) {
  if (!chainData) return null;
  if (Array.isArray(chainData)) return chainData.length > 0 ? chainData : null;

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

  for (const key of ["rows", "data", "chain", "records", "options"]) {
    if (Array.isArray(chainData[key]) && chainData[key].length > 0) return chainData[key];
  }

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

// ── Build near-ATM rows for OI table ─────────────────────────────────────────
function buildNearATMRows(chain, spot, pct = 8) {
  if (!chain || !spot || spot <= 0) return [];
  const lo = spot * (1 - pct / 100);
  const hi = spot * (1 + pct / 100);
  const rows = [];

  const nearStrikes = chain
    .filter(r => r.strike >= lo && r.strike <= hi)
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));

  for (const r of nearStrikes) {
    if (r.callOI > 0 || r.callVol > 0) {
      rows.push({
        strike:  r.strike,
        type:    "call",
        oi:      r.callOI || 0,
        vol:     r.callVol || 0,
        ltp:     r.callLTP || 0,
        iv:      r.callIV || null,
        note:    "Near ATM call",
        // distPct: signed distance from spot in percent (+ = above, - = below)
        distPct: Math.round(((r.strike - spot) / spot) * 10000) / 100,
      });
    }
    if (r.putOI > 0 || r.putVol > 0) {
      rows.push({
        strike:  r.strike,
        type:    "put",
        oi:      r.putOI  || 0,
        vol:     r.putVol  || 0,
        ltp:     r.putLTP  || 0,
        iv:      r.putIV   || null,
        note:    "Near ATM put",
        distPct: Math.round(((r.strike - spot) / spot) * 10000) / 100,
      });
    }
  }
  return rows;
}

// ── Core analysis runner ──────────────────────────────────────────────────────
let _io = null;
let _ingestOptionsSignal = null;

// FIX 3: accepts closes[] as 6th arg — real spot history from nseOIListener
function runAnalysis(symbol, spotPrice, rawRows, expiryDate, lotSize, closes = []) {
  if (!symbol || !spotPrice || !rawRows || !expiryDate) return;
  if (!canRun(`${symbol}_${expiryDate}`)) return;

  const chain = (Array.isArray(rawRows) ? rawRows : [])
    .map(normaliseRow)
    .filter(r => r.strike > 0);

  if (chain.length === 0) {
    console.warn(`⚠️ optionsIntegration: ${symbol}/${expiryDate} — 0 valid rows after normalise`);
    return;
  }

  const ivHist = ivHistory[symbol] || [];

  // FIX 3: use real closes[] passed from nseOIListener (rolling spot history).
  // Only fall back to the synthetic proxy when no real closes available.
  // The proxy (spotPrice * (1 - iv)) was producing garbage that made
  // historicalVolatility() return null → HV20/HV60/VRP all showed "—".
  const closesForEngine = closes.length >= 21
    ? closes
    : (ivHist.length > 20
        ? ivHist.map(iv => spotPrice * Math.exp(-iv))  // better proxy than (1-iv)
        : []);

  const prevVolMap = getPrevVolMap(symbol, expiryDate);

  let result;
  try {
    result = analyzeOptionsChain({
      symbol,
      spotPrice,
      chain,
      expiryDate,
      historicalIVs: ivHist,
      closes:        closesForEngine,   // FIX 3: real closes, not garbage proxy
      lotSize:       lotSize || 1,
      riskFreeRate:  0.065,
      prevVolMap,
    });
  } catch (e) {
    console.warn(`⚠️ optionsIntegration [${symbol}]:`, e.message);
    return;
  }

  if (!result || result.error) return;

  updatePrevVolMap(symbol, expiryDate, chain);

  const nearPct        = symbol.toUpperCase().includes("BANK") ? 10 : 8;
  const nearATMRows    = buildNearATMRows(chain, spotPrice, nearPct);
  const nearSet        = new Set(nearATMRows.map(r => `${r.strike}-${r.type}`));
  const engineUnusual  = result.oi?.unusualOI || [];
  const tailRiskRows   = engineUnusual.filter(r => !nearSet.has(`${r.strike}-${r.type}`));

  if (result.oi) {
    result.oi.unusualOI         = nearATMRows;
    result.oi.unusualOITailRisk = tailRiskRows;
  }

  if (result.volatility?.atmIV) appendIV(symbol, result.volatility.atmIV);

  if (_io) {
    const payload = { symbol, data: result, ltp: spotPrice, ts: Date.now() };

    // FIX D: cache before emit so new clients get fresh snapshot
    try { setCachedIntel(symbol, payload); } catch (_) {}

    _io.emit("options-intelligence", payload);
    console.log(
      `📡 options-intelligence: ${symbol}` +
      ` score=${result.score} bias=${result.bias}` +
      ` strikes=${chain.length}` +
      ` nearATM=${nearATMRows.length} tail=${tailRiskRows.length}` +
      ` hv20=${result.volatility?.hv20 ?? "—"}` +
      ` vrp=${result.volatility?.vrp  ?? "—"}`
    );
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

// ── ingestChainData — called by nseOIListener with up to 6 positional args ───
// FIX 3: 6th arg closes[] is now accepted and forwarded to runAnalysis
function ingestChainData(symbol, spotPrice, chainData, expiryDate, lotSize, closes = []) {
  if (!symbol || !spotPrice || !chainData || !expiryDate) return;
  const rows = extractRows(chainData);
  if (!rows || rows.length === 0) {
    console.warn(`⚠️ ingestChainData: ${symbol}/${expiryDate} — could not extract rows`);
    return;
  }
  runAnalysis(symbol, spotPrice, rows, expiryDate, lotSize || 1, closes);
}

// ── FIX A: poll() is now a NO-OP ─────────────────────────────────────────────
function poll() {
  // Intentionally disabled — nseOIListener drives all analysis directly.
}

// ── Start ─────────────────────────────────────────────────────────────────────
function startOptionsIntegration(io, { ingestOptionsSignal } = {}) {
  _io = io;
  _ingestOptionsSignal = ingestOptionsSignal;
  console.log("📊 Options Integration: ready (analysis driven by nseOIListener)");
}

module.exports = { startOptionsIntegration, ingestChainData };