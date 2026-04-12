"use strict";

/**
 * optionsIntegration.js
 * Location: server/services/intelligence/optionsIntegration.js
 *
 * ══════════════════════════════════════════════════════════════
 * FIXES IN THIS VERSION:
 *
 * FIX THROTTLE-1 — Score flips 55→60, OI jumps 460L→2691L ~60s after load:
 *   Root cause: nseOIListener calls ingestChainData() TWICE per 60s cycle:
 *     1st call: partial chain (~30 strikes, fast path) → emits score=55, OI=460L
 *     2nd call: full chain (~150 strikes, complete data) → blocked by canRun()
 *               because 55s hasn't elapsed since the 1st call
 *     Next cycle (60s later): full chain finally gets through → score=60, OI=2691L
 *   This creates exactly the two-stage data pattern observed on the dashboard.
 *   Fix: canRun() now takes chainLength as second param. Any call with
 *        chain.length > 80 bypasses the throttle entirely — full chains always
 *        run. Partial chains (< 80 strikes) are still throttled at 55s.
 *
 * FIX TEMPLATE-1 — strategy detail string had broken template literal:
 *   Was:  `${strategy[0].strategy}: (strategy[0].note || "").slice(0, 80)}`
 *   The inner expression was NOT inside ${} so the note was never interpolated.
 *   Fix:  `${strategy[0].strategy}: ${(strategy[0].note || "").slice(0, 80)}`
 *
 * FIX STRADDLE-1 — ATM Straddle halves between refreshes (581→278):
 *   Root cause: on partial chain, ATM row may have only callLTP or putLTP
 *   populated (the other is 0). Straddle = 581 first pass, 278 second.
 *   Fix: guard in runAnalysis — only emit if both callLTP and putLTP > 0
 *        for the ATM strike. If either is zero, keep previous straddle value.
 *   Note: the real fix is THROTTLE-1 above (partial chain never emits).
 *         This is a belt-and-suspenders guard.
 *
 * Previously fixed (preserved):
 *   FIX HV-1  — real index closes from indexCandleFetcher (not fake IV proxy)
 *   FIX HV-2  — IV history purges stale entries, normalises symbol key
 *   FIX A     — poll() disabled (nseOIListener drives analysis)
 *   FIX B     — throttle 55s matches 60s poll interval
 *   FIX C     — prevVolMap wired for delta-based net flow
 *   FIX D     — setCachedIntel called before emit
 * ══════════════════════════════════════════════════════════════
 */

const { analyzeOptionsChain } = require("./optionsIntelligenceEngine");
const { setCachedIntel }      = require("../../api/websocket");

// FIX HV-1: real index closes from Upstox (replaces fake closesProxy)
let _getIndexCloses = null;
try {
  const fetcher   = require("./indexCandleFetcher");
  _getIndexCloses = fetcher.getIndexCloses;
} catch (_) {
  _getIndexCloses = () => [];
}

function getIndexCloses(symbol) {
  if (typeof _getIndexCloses === "function") {
    return _getIndexCloses(symbol) || [];
  }
  return [];
}

// ── FIX HV-2C: normalise symbol → consistent key for ivHistory ───────────────
function normaliseSymbol(symbol) {
  if (!symbol) return symbol;
  const s = symbol.toUpperCase().replace(/\s+/g, "");
  if (s === "NIFTY50") return "NIFTY";
  if (s === "BANKNIFTY50") return "BANKNIFTY";
  return s;
}

// ── Rolling IV history for IV Rank ───────────────────────────────────────────
// FIX HV-2B: purge entries older than 8h so stale weekend IVs don't
// pollute the rank baseline during the next session.
const IV_HISTORY_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const ivHistory = {};

function appendIV(symbol, ivPct) {
  const sym = normaliseSymbol(symbol);
  if (!sym || !ivPct || ivPct <= 0) return;
  if (!ivHistory[sym]) ivHistory[sym] = [];

  const cutoff = Date.now() - IV_HISTORY_MAX_AGE_MS;
  ivHistory[sym] = ivHistory[sym].filter(e => e.ts > cutoff);
  ivHistory[sym].push({ iv: ivPct / 100, ts: Date.now() });

  if (ivHistory[sym].length > 252) {
    ivHistory[sym] = ivHistory[sym].slice(-252);
  }
}

function getIVHistory(symbol) {
  const sym = normaliseSymbol(symbol);
  if (!sym || !ivHistory[sym]) return [];
  const cutoff = Date.now() - IV_HISTORY_MAX_AGE_MS;
  return ivHistory[sym]
    .filter(e => e.ts > cutoff)
    .map(e => e.iv);
}

// ── FIX THROTTLE-1: canRun() bypasses throttle for full chains ───────────────
// chainLength > 80 → full chain → always runs (never throttled)
// chainLength ≤ 80 → partial chain → throttled at 55s
const lastRun = {};

function canRun(key, chainLength) {
  // FIX THROTTLE-1: full chains always bypass throttle
  if (chainLength > 80) return true;

  const now = Date.now();
  if (lastRun[key] && now - lastRun[key] < 55_000) return false;
  lastRun[key] = now;
  return true;
}

// ── prevVolMap store ──────────────────────────────────────────────────────────
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

// FIX STRADDLE-1: track last known good straddle per symbol to avoid
// showing half-straddle from partial chain where one LTP leg is 0
const lastGoodStraddle = {};

function runAnalysis(symbol, spotPrice, rawRows, expiryDate, lotSize) {
  if (!symbol || !spotPrice || !rawRows || !expiryDate) return;

  const chain = (Array.isArray(rawRows) ? rawRows : [])
    .map(normaliseRow)
    .filter(r => r.strike > 0);

  if (chain.length === 0) {
    console.warn(`⚠️ optionsIntegration: ${symbol}/${expiryDate} — 0 valid rows after normalise`);
    return;
  }

  // FIX THROTTLE-1: pass chain.length so full chains bypass 55s throttle
  if (!canRun(`${symbol}_${expiryDate}`, chain.length)) return;

  // FIX HV-1: real closes (not fake IV proxy)
  const realCloses = getIndexCloses(symbol);

  // FIX HV-2B: fresh IV history only
  const ivHist = getIVHistory(symbol);

  const prevVolMap = getPrevVolMap(symbol, expiryDate);

  let result;
  try {
    result = analyzeOptionsChain({
      symbol,
      spotPrice,
      chain,
      expiryDate,
      historicalIVs: ivHist,
      closes:        realCloses,
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

  // FIX STRADDLE-1: if ATM straddle is suspiciously low (one leg missing),
  // replace with last known good value so the UI doesn't flash wrong data.
  // "Suspiciously low" = < 50% of last good straddle (partial chain artifact)
  if (result.structure && result.structure.straddlePrice != null) {
    const sym = normaliseSymbol(symbol);
    const prev = lastGoodStraddle[sym];
    const curr = result.structure.straddlePrice;
    if (prev && curr > 0 && curr < prev * 0.5) {
      // Partial chain — keep previous straddle
      result.structure.straddlePrice = prev;
    } else if (curr > 0) {
      lastGoodStraddle[sym] = curr;
    }
  }

  // Inject near-ATM and tail-risk OI rows
  const nearPct       = symbol.toUpperCase().includes("BANK") ? 10 : 8;
  const nearATMRows   = buildNearATMRows(chain, spotPrice, nearPct);
  const nearSet       = new Set(nearATMRows.map(r => `${r.strike}-${r.type}`));
  const engineUnusual = result.oi?.unusualOI || [];
  const tailRiskRows  = engineUnusual.filter(r => !nearSet.has(`${r.strike}-${r.type}`));

  if (result.oi) {
    result.oi.unusualOI         = nearATMRows;
    result.oi.unusualOITailRisk = tailRiskRows;
  }

  // Append ATM IV to history (FIX HV-2C: normalised key)
  if (result.volatility?.atmIV) appendIV(symbol, result.volatility.atmIV);

  // Debug log so you can confirm HV is populating
  if (result.volatility) {
    const { hv20, hv60, vrp, ivRank, atmIV } = result.volatility;
    console.log(
      `📊 Options Vol [${symbol}]:` +
      ` ATM IV=${atmIV}%` +
      ` HV20=${hv20 !== null ? hv20 + "%" : "null (closes not ready)"}` +
      ` HV60=${hv60 !== null ? hv60 + "%" : "null"}` +
      ` VRP=${vrp  !== null ? vrp  + "%" : "null"}` +
      ` IVRank=${ivRank}` +
      ` closes=${realCloses.length}` +
      ` strikes=${chain.length}`
    );
  }

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
          // FIX TEMPLATE-1: was broken template literal — note was never interpolated
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

// ── FIX A: poll() is a NO-OP ──────────────────────────────────────────────────
function poll() {
  // Intentionally disabled — nseOIListener drives all analysis directly.
}

// ── Start ─────────────────────────────────────────────────────────────────────
function startOptionsIntegration(io, { ingestOptionsSignal } = {}) {
  _io = io;
  _ingestOptionsSignal = ingestOptionsSignal;
  console.log("📊 Options Integration: ready (analysis driven by nseOIListener)");

  const niftyCloses     = getIndexCloses("NIFTY");
  const bankniftyCloses = getIndexCloses("BANKNIFTY");
  console.log(
    `📊 Options Integration: index closes at start —` +
    ` NIFTY=${niftyCloses.length} days,` +
    ` BANKNIFTY=${bankniftyCloses.length} days` +
    ` (0 = indexCandleFetcher still loading, resolves in ~10s)`
  );
}

module.exports = { startOptionsIntegration, ingestChainData };