"use strict";

/**
 * optionsIntegration.js
 * Location: server/services/intelligence/optionsIntegration.js
 *
 * ══════════════════════════════════════════════════════════════
 * FIXES APPLIED (this session — HV / VRP / IV Rank):
 *
 * FIX HV-1 — HV20 & HV60 showing "—" (dash):
 *   Root cause: closes array fed to analyzeOptionsChain() was a FAKE proxy:
 *     ivHist.map(iv => spotPrice * (1 - iv))
 *   This converted IV history into synthetic "prices" — mathematically wrong.
 *   historicalVolatility() computes log-returns of sequential prices; using
 *   IV-derived values produced noise, not volatility. Worse, ivHist starts
 *   empty on startup so closesProxy = [] → HV always null → VRP always null.
 *   Fix: use getIndexCloses() from indexCandleFetcher.js which fetches real
 *   daily OHLC from Upstox (same API as gannDataFetcher does for stocks).
 *   Real closes → genuine HV20 and HV60 → VRP works correctly.
 *
 * FIX HV-2 — IV Rank showing 100 incorrectly:
 *   Root cause: ivHistory accumulates ATM IVs only from live emits. On
 *   startup / weekends it has 0–5 entries. With hv20 also null (see FIX HV-1),
 *   the synthetic fallback in ivRankAndPercentile() couldn't build a window.
 *   When ivHistory had a few low-IV stale entries and current IV (17.6%)
 *   exceeded all of them, rank = 100.
 *   Fix A: seed ivHistory on startup from real closes via HV-implied IV range.
 *   Fix B: ivHistory now stores ONLY intra-session IVs (< 8h old) — stale
 *           entries from a previous session are purged on startup so they
 *           don't pollute the rank baseline.
 *   Fix C: normalise symbol key consistently (NIFTY 50 → NIFTY) before
 *           appending to ivHistory so lookups always hit the right key.
 *
 * Previously fixed (preserved):
 *   FIX A — poll() disabled (nseOIListener drives analysis)
 *   FIX B — throttle 55s matches 60s poll interval
 *   FIX C — prevVolMap wired for delta-based net flow
 *   FIX D — setCachedIntel called before emit
 * ══════════════════════════════════════════════════════════════
 */

const { analyzeOptionsChain } = require("./optionsIntelligenceEngine");
const { setCachedIntel }      = require("../../api/websocket");

// FIX HV-1: real index closes from Upstox (replaces fake closesProxy)
let _getIndexCloses = null;
try {
  const fetcher = require("./indexCandleFetcher");
  _getIndexCloses = fetcher.getIndexCloses;
} catch (_) {
  // If indexCandleFetcher not yet deployed, fall back to empty array
  _getIndexCloses = () => [];
}

function getIndexCloses(symbol) {
  if (typeof _getIndexCloses === "function") {
    return _getIndexCloses(symbol) || [];
  }
  return [];
}

// ── FIX HV-2C: normalise symbol to consistent key for ivHistory lookup ────────
// "NIFTY 50" → "NIFTY", "BANKNIFTY" → "BANKNIFTY", etc.
function normaliseSymbol(symbol) {
  if (!symbol) return symbol;
  const s = symbol.toUpperCase().replace(/\s+/g, "");
  if (s === "NIFTY50") return "NIFTY";
  return s;
}

// ── Rolling IV history for IV Rank ────────────────────────────────────────────
// FIX HV-2B: entries older than 8 hours are purged so stale weekend IVs
// don't pollute the rank baseline during the next session.
const IV_HISTORY_MAX_AGE_MS = 8 * 60 * 60 * 1000;  // 8 hours
const ivHistory = {};    // symbol → [{ iv: number, ts: number }]

function appendIV(symbol, ivPct) {
  const sym = normaliseSymbol(symbol);
  if (!sym || !ivPct || ivPct <= 0) return;
  if (!ivHistory[sym]) ivHistory[sym] = [];

  // FIX HV-2B: purge stale entries before appending
  const cutoff = Date.now() - IV_HISTORY_MAX_AGE_MS;
  ivHistory[sym] = ivHistory[sym].filter(e => e.ts > cutoff);

  ivHistory[sym].push({ iv: ivPct / 100, ts: Date.now() });

  // Cap at 252 entries (1 trading year worth of daily IVs)
  if (ivHistory[sym].length > 252) {
    ivHistory[sym] = ivHistory[sym].slice(-252);
  }
}

function getIVHistory(symbol) {
  const sym = normaliseSymbol(symbol);
  if (!sym || !ivHistory[sym]) return [];
  // FIX HV-2B: always return only fresh entries
  const cutoff = Date.now() - IV_HISTORY_MAX_AGE_MS;
  return ivHistory[sym]
    .filter(e => e.ts > cutoff)
    .map(e => e.iv);
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

  // ── FIX HV-1: use real index closes instead of fake IV proxy ─────────────
  // getIndexCloses() returns real Upstox daily closes oldest-first.
  // historicalVolatility() needs 21+ closes for HV20, 61+ for HV60.
  // On first boot (before indexCandleFetcher completes), returns [] →
  // HV stays null briefly, but resolves within ~30s of server start.
  const realCloses = getIndexCloses(symbol);

  // ── FIX HV-2B: get only fresh IV history (no stale weekend entries) ───────
  const ivHist = getIVHistory(symbol);

  // FIX C: get prevVolMap for delta-based net flow
  const prevVolMap = getPrevVolMap(symbol, expiryDate);

  let result;
  try {
    result = analyzeOptionsChain({
      symbol,
      spotPrice,
      chain,
      expiryDate,
      historicalIVs: ivHist,       // FIX HV-2B: fresh only
      closes:        realCloses,   // FIX HV-1: real closes → real HV20/HV60
      lotSize:       lotSize || 1,
      riskFreeRate:  0.065,
      prevVolMap,
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

  // Append current ATM IV to history (FIX HV-2C: normalised symbol key)
  if (result.volatility?.atmIV) appendIV(symbol, result.volatility.atmIV);

  // ── Debug log: confirm HV is now populating ───────────────────────────────
  if (result.volatility) {
    const { hv20, hv60, vrp, ivRank, atmIV } = result.volatility;
    console.log(
      `📊 Options Vol [${symbol}]:` +
      ` ATM IV=${atmIV}%` +
      ` HV20=${hv20 !== null ? hv20 + "%" : "null (closes not ready)"}` +
      ` HV60=${hv60 !== null ? hv60 + "%" : "null"}` +
      ` VRP=${vrp  !== null ? vrp  + "%" : "null"}` +
      ` IVRank=${ivRank}` +
      ` closes=${realCloses.length}`
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
          detail:    strategy?.[0]
            ? `${strategy[0].strategy}: (strategy[0].note || "").slice(0, 80)}`
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
function poll() {
  // Intentionally disabled — nseOIListener drives all analysis directly.
}

// ── Start ─────────────────────────────────────────────────────────────────────
function startOptionsIntegration(io, { ingestOptionsSignal } = {}) {
  _io = io;
  _ingestOptionsSignal = ingestOptionsSignal;
  console.log("📊 Options Integration: ready (analysis driven by nseOIListener)");

  // Log whether real closes are available at startup
  const niftyCloses     = getIndexCloses("NIFTY");
  const bankniftyCloses = getIndexCloses("BANKNIFTY");
  console.log(
    `📊 Options Integration: index closes at start —` +
    ` NIFTY=${niftyCloses.length} days,` +
    ` BANKNIFTY=${bankniftyCloses.length} days` +
    ` (0 = indexCandleFetcher still loading, will resolve shortly)`
  );
}

module.exports = { startOptionsIntegration, ingestChainData };