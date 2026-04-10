"use strict";

/**
 * optionsIntegration.js
 * Location: server/services/intelligence/optionsIntegration.js
 *
 * Bridges nseOIListener → optionsIntelligenceEngine → socket.io
 *
 * Strategy:
 *   - Every 15 seconds, call getAllCached() from nseOIListener
 *   - For each symbol+expiry pair, run analyzeOptionsChain()
 *   - Emit "options-intelligence" socket event to all clients
 *   - Feed strong signals (score ≥65 or ≤35) into composite score engine
 */

const { analyzeOptionsChain } = require("./optionsIntelligenceEngine");

let nseOI = null;
try {
  nseOI = require("./nseOIListener");
} catch (e) {
  console.warn("⚠️ optionsIntegration: could not load nseOIListener:", e.message);
}

// ── Rolling IV history for IV Rank calculation ────────────────────────────────
const ivHistory = {};   // symbol → number[] (fractions, e.g. 0.176)

function appendIV(symbol, ivPct) {
  // ivPct comes from engine as % (e.g. 17.6) — store as fraction
  if (!symbol || !ivPct || ivPct <= 0) return;
  if (!ivHistory[symbol]) ivHistory[symbol] = [];
  ivHistory[symbol].push(ivPct / 100);
  if (ivHistory[symbol].length > 252) ivHistory[symbol] = ivHistory[symbol].slice(-252);
}

// ── Throttle: max one analysis per symbol per 15 seconds ─────────────────────
const lastRun = {};

function canRun(key) {
  const now = Date.now();
  if (lastRun[key] && now - lastRun[key] < 15_000) return false;
  lastRun[key] = now;
  return true;
}

// ── Normalise a chain row to engine format ────────────────────────────────────
function normaliseRow(r) {
  return {
    strike:  Number(r.strike  || r.strikePrice || r.SP                || 0),
    callOI:  Number(r.callOI  || r.CE_OI       || r.ceOI  || r.cOI   || 0),
    putOI:   Number(r.putOI   || r.PE_OI       || r.peOI  || r.pOI   || 0),
    callVol: Number(r.callVol || r.CE_Vol      || r.ceVol || r.cVol  || 0),
    putVol:  Number(r.putVol  || r.PE_Vol      || r.peVol || r.pVol  || 0),
    callLTP: Number(r.callLTP || r.CE_LTP      || r.ceLTP || r.cLTP  || 0),
    putLTP:  Number(r.putLTP  || r.PE_LTP      || r.peLTP || r.pLTP  || 0),
    callIV:  r.callIV != null ? Number(r.callIV) : null,
    putIV:   r.putIV  != null ? Number(r.putIV)  : null,
  };
}

// ── Run analysis for one symbol+expiry ───────────────────────────────────────
function analyse(symbol, spotPrice, rawRows, expiryDate, lotSize, io, ingestOptionsSignal) {
  if (!symbol || !spotPrice || !rawRows || !expiryDate) return;
  const key = `${symbol}_${expiryDate}`;
  if (!canRun(key)) return;

  const chain = (Array.isArray(rawRows) ? rawRows : [])
    .map(normaliseRow)
    .filter(r => r.strike > 0);

  if (chain.length === 0) return;

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

  // Store IV for future rank calculation
  if (result.volatility?.atmIV) appendIV(symbol, result.volatility.atmIV);

  // Emit to all socket clients
  if (io) {
    io.emit("options-intelligence", {
      symbol,
      data:  result,
      ltp:   spotPrice,
      ts:    Date.now(),
    });
    console.log(`📡 options-intelligence emitted: ${symbol} score=${result.score} bias=${result.bias}`);
  }

  // Feed into composite score engine
  if (typeof ingestOptionsSignal === "function") {
    const { score, bias, strategy } = result;
    if (score != null && (score >= 65 || score <= 35)) {
      try {
        ingestOptionsSignal({
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

// ── Main poll loop ────────────────────────────────────────────────────────────
function poll(io, ingestOptionsSignal) {
  if (!nseOI || typeof nseOI.getAllCached !== "function") {
    console.warn("⚠️ optionsIntegration: getAllCached not available");
    return;
  }

  let all;
  try {
    all = nseOI.getAllCached();
  } catch (e) {
    console.warn("⚠️ optionsIntegration: getAllCached() threw:", e.message);
    return;
  }

  if (!all || typeof all !== "object") {
    console.warn("⚠️ optionsIntegration: getAllCached() returned empty");
    return;
  }

  const symbols = Object.keys(all);
  console.log(`📊 optionsIntegration poll: ${symbols.length} symbols cached [${symbols.join(", ")}]`);

  for (const [symbol, payload] of Object.entries(all)) {
    if (!payload) continue;

    const spotPrice = payload.spotPrice || payload.spot || 0;
    const lotSize   = payload.lotSize   || 1;
    const chains    = payload.chains    || {};
    const expiries  = payload.expiries  || Object.keys(chains);

    if (!spotPrice || !expiries.length) {
      console.warn(`⚠️ optionsIntegration: ${symbol} has no spot or expiries`);
      continue;
    }

    // Analyse nearest expiry first, then up to 2 more
    const sorted = [...expiries].sort();
    for (const expiry of sorted.slice(0, 3)) {
      const chainData = chains[expiry];
      if (!chainData) continue;

      // chainData may be { rows: [...] } or { data: [...] } or the array itself
      const rows = chainData.rows || chainData.data || (Array.isArray(chainData) ? chainData : null);
      if (!rows || rows.length === 0) {
        console.warn(`⚠️ optionsIntegration: ${symbol}/${expiry} chain has no rows`);
        continue;
      }

      analyse(symbol, spotPrice, rows, expiry, lotSize, io, ingestOptionsSignal);
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
function startOptionsIntegration(io, { ingestOptionsSignal } = {}) {
  if (!nseOI) {
    console.warn("⚠️ optionsIntegration: nseOIListener unavailable — options disabled");
    return;
  }

  console.log("📊 Options Integration: nseOIListener exports →",
    Object.keys(nseOI).join(", "));

  // First pass after 20s (give nseOIListener time to fetch first chain)
  setTimeout(() => poll(io, ingestOptionsSignal), 20_000);

  // Then every 15 seconds
  setInterval(() => poll(io, ingestOptionsSignal), 15_000);

  console.log("📊 Options Integration: polling getAllCached() every 15s (first run in 20s)");
}

module.exports = { startOptionsIntegration };