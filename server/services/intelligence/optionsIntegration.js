"use strict";

/**
 * optionsIntegration.js
 * Location: server/services/intelligence/optionsIntegration.js
 *
 * KEY FIX: nseOIListener is required LAZILY inside poll() — not at module load
 * time — to break the circular dependency that caused getAllCached() to return
 * an incomplete module during startup.
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

// ── Normalise chain row to engine format ──────────────────────────────────────
function normaliseRow(r) {
  return {
    strike:  Number(r.strike  || r.strikePrice || r.SP     || 0),
    callOI:  Number(r.callOI  || r.CE_OI  || r.ceOI  || r.cOI  || 0),
    putOI:   Number(r.putOI   || r.PE_OI  || r.peOI  || r.pOI  || 0),
    callVol: Number(r.callVol || r.CE_Vol || r.ceVol || r.cVol || 0),
    putVol:  Number(r.putVol  || r.PE_Vol || r.peVol || r.pVol || 0),
    callLTP: Number(r.callLTP || r.CE_LTP || r.ceLTP || r.cLTP || 0),
    putLTP:  Number(r.putLTP  || r.PE_LTP || r.peLTP || r.pLTP || 0),
    callIV:  r.callIV != null ? Number(r.callIV) : null,
    putIV:   r.putIV  != null ? Number(r.putIV)  : null,
  };
}

// ── Analyse one symbol+expiry ─────────────────────────────────────────────────
function analyse(symbol, spotPrice, rawRows, expiryDate, lotSize, io, ingestOptionsSignal) {
  if (!symbol || !spotPrice || !rawRows || !expiryDate) return;
  if (!canRun(`${symbol}_${expiryDate}`)) return;

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

  if (result.volatility?.atmIV) appendIV(symbol, result.volatility.atmIV);

  if (io) {
    io.emit("options-intelligence", {
      symbol,
      data: result,
      ltp:  spotPrice,
      ts:   Date.now(),
    });
    console.log(`📡 options-intelligence: ${symbol} score=${result.score} bias=${result.bias} chain=${chain.length} strikes`);
  }

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

// ── Poll — lazy-require nseOIListener here, not at module load ────────────────
function poll(io, ingestOptionsSignal) {
  // LAZY require: by the time poll() runs (20s+ after startup), the circular
  // dependency is fully resolved and getAllCached() works correctly.
  let nseOI;
  try {
    nseOI = require("./nseOIListener");
  } catch (e) {
    console.warn("⚠️ optionsIntegration: cannot require nseOIListener:", e.message);
    return;
  }

  if (typeof nseOI.getAllCached !== "function") {
    console.warn("⚠️ optionsIntegration: getAllCached not a function on nseOIListener");
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
    console.warn("⚠️ optionsIntegration: getAllCached() returned nothing");
    return;
  }

  const symbols = Object.keys(all);
  console.log(`📊 optionsIntegration poll: ${symbols.length} symbols [${symbols.join(", ")}]`);

  for (const [symbol, payload] of Object.entries(all)) {
    if (!payload) continue;

    const spotPrice = payload.spotPrice || payload.spot || 0;
    const lotSize   = payload.lotSize   || 1;
    const chains    = payload.chains    || {};
    const expiries  = payload.expiries  || Object.keys(chains);

    if (!spotPrice || !expiries.length) {
      console.warn(`⚠️ optionsIntegration: ${symbol} — spot=${spotPrice} expiries=${expiries.length}`);
      continue;
    }

    // Nearest expiry first, max 3
    const sorted = [...expiries].sort();
    for (const expiry of sorted.slice(0, 3)) {
      const chainData = chains[expiry];
      if (!chainData) continue;

      const rows = chainData.rows
        || chainData.data
        || (Array.isArray(chainData) ? chainData : null);

      if (!rows || rows.length === 0) continue;

      analyse(symbol, spotPrice, rows, expiry, lotSize, io, ingestOptionsSignal);
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
function startOptionsIntegration(io, { ingestOptionsSignal } = {}) {
  // First poll at 25s — well after nseOIListener has completed its first fetch
  setTimeout(() => poll(io, ingestOptionsSignal), 25_000);

  // Then every 15s
  setInterval(() => poll(io, ingestOptionsSignal), 15_000);

  console.log("📊 Options Integration: polling every 15s (first run in 25s)");
}

module.exports = { startOptionsIntegration };