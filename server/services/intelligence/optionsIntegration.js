"use strict";

/**
 * optionsIntegration.js
 * Location: server/services/intelligence/optionsIntegration.js
 *
 * ══════════════════════════════════════════════════════════════
 * FIXES APPLIED:
 *
 * FIX A — poll() fallback disabled:
 *   Root cause: poll() re-read getAllCached() from nseOIListener every 15s
 *   and re-ran analyzeOptionsChain() AGAIN — even though nseOIListener's
 *   pollChains() already called ingestChainData() directly after each fetch.
 *   This created a SECOND emit within the same 60s window using slightly
 *   different (stale) data, causing the flashing absurd values to linger.
 *   Fix: poll() is now a no-op. nseOIListener drives all analysis by calling
 *   ingestChainData() directly with clean data after every successful fetch.
 *
 * FIX B — Throttle reduced to match nseOIListener poll interval:
 *   canRun() was throttling to 15s, but nseOIListener polls every 60s.
 *   This meant the first call from nseOIListener always ran, but if anything
 *   triggered a second call within 15s it would be silently dropped.
 *   Fix: throttle now uses 55s (just under the 60s poll interval) so each
 *   legitimate poll from nseOIListener always gets through, but duplicate
 *   calls within the same poll cycle are rejected.
 *
 * FIX C — prevVolMap wired through for delta-based net flow:
 *   analyzeOptionsChain() supports prevVolMap for delta-based netPremiumFlow
 *   but optionsIntegration was never passing it. Now manages prevVolMap per
 *   symbol/expiry and passes it through so the engine computes delta flow,
 *   not full vol×LTP recalc which explodes mid-session.
 *
 * FIX D — setCachedIntel called before emit (preserved from previous session).
 *
 * Previously fixed (preserved):
 *  - Direct require of websocket.js
 *  - extractRows() handles processChain() output shape (s.ce/s.pe)
 *  - safeIV() normalises Upstox decimal AND NSE %
 *  - ingestChainData exported for nseOIListener's 5 positional-arg call
 *  - HV closes array from ivHistory proxy
 *  - buildNearATMRows injects all CE+PE strikes near spot
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
// Passed to analyzeOptionsChain so it can compute delta-based net flow
// instead of full vol×LTP recalc (which explodes mid-session).
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

  // processChain() output shape: { strikes: [{ strike, ce: {oi,vol,...}, pe: {oi,vol,...} }] }
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
      rows.push({ strike: r.strike, type: "call", oi: r.callOI || 0, vol: r.callVol || 0, ltp: r.callLTP || 0, iv: r.callIV || null, note: "Near ATM call" });
    }
    if (r.putOI > 0 || r.putVol > 0) {
      rows.push({ strike: r.strike, type: "put",  oi: r.putOI  || 0, vol: r.putVol  || 0, ltp: r.putLTP  || 0, iv: r.putIV  || null, note: "Near ATM put"  });
    }
  }
  return rows;
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

  const ivHist      = ivHistory[symbol] || [];
  const closesProxy = ivHist.length > 20
    ? ivHist.map(iv => spotPrice * (1 - iv))
    : [];

  // FIX C: get prevVolMap for delta-based net flow
  const prevVolMap = getPrevVolMap(symbol, expiryDate);

  let result;
  try {
    result = analyzeOptionsChain({
      symbol,
      spotPrice,
      chain,
      expiryDate,
      historicalIVs: ivHist,
      closes:        closesProxy,
      lotSize:       lotSize || 1,
      riskFreeRate:  0.065,
      prevVolMap,           // FIX C: delta net flow
    });
  } catch (e) {
    console.warn(`⚠️ optionsIntegration [${symbol}]:`, e.message);
    return;
  }

  if (!result || result.error) return;

  // FIX C: update prevVolMap for next cycle
  updatePrevVolMap(symbol, expiryDate, chain);

  // Inject near-ATM and tail-risk OI rows
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
      ` nearATM=${nearATMRows.length} tail=${tailRiskRows.length}`
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

// ── FIX A: poll() is now a NO-OP ─────────────────────────────────────────────
// nseOIListener.pollChains() calls ingestChainData() directly after every
// successful Upstox fetch with clean normalised data. The old poll() here
// was reading stale getAllCached() data and re-running analysis 15s later,
// causing a second conflicting emit with different (sometimes raw-lot-scale)
// values — the root cause of values that "stayed wrong for longer".
function poll() {
  // Intentionally disabled — nseOIListener drives all analysis directly.
  // Kept as a stub so startOptionsIntegration() wiring is unchanged.
}

// ── Start ─────────────────────────────────────────────────────────────────────
function startOptionsIntegration(io, { ingestOptionsSignal } = {}) {
  _io = io;
  _ingestOptionsSignal = ingestOptionsSignal;
  // FIX A: no longer start poll interval — nseOIListener drives analysis
  console.log("📊 Options Integration: ready (analysis driven by nseOIListener)");
}

module.exports = { startOptionsIntegration, ingestChainData };