"use strict";

/**
 * marketScanner.js
 * Location: server/services/intelligence/marketScanner.js
 *
 * Full market scanner — Moneycontrol-style.
 * Data: Upstox (live LTP) + NSE public API (historical OHLC for technicals)
 *
 * Features:
 *   - Top gainers / losers (NSE EQ, live via Upstox or NSE API)
 *   - Market cap filter: LargeCap / MidCap / SmallCap / MicroCap
 *   - Technical indicators: EMA 5/9/21/50/200, RSI, MACD, Bollinger Bands
 *   - Moving average summary (all timeframes): 1D/1W/1M signal
 *   - Sector-wise performance
 *   - Socket events: scanner-update, scanner-technicals
 *   - Background tech cache pre-warming after every scan
 */

const axios = require("axios");
const path  = require("path");
const fs    = require("fs");

// ── Config ────────────────────────────────────────────────────────────────────
const MCAP_DB_PATH    = path.join(__dirname, "../../data/marketCapDB.json");
const SCAN_INTERVAL   = 5 * 60 * 1000;   // refresh every 5 min during market hours
const TECH_CACHE_TTL  = 15 * 60 * 1000;  // 15 min tech cache
const PREWARM_DELAY   = 5000;            // start pre-warm 5s after scan
const PREWARM_BETWEEN = 300;             // 300ms between each NSE request

// ── NSE public endpoints (no auth needed) ────────────────────────────────────
const NSE_BASE    = "https://www.nseindia.com";
const NSE_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept":          "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer":         "https://www.nseindia.com/market-data/live-equity-market",
  "Connection":      "keep-alive",
};

// ── Market cap buckets (in Crores) ────────────────────────────────────────────
const MCAP_BUCKETS = {
  largecap:  { min: 20000,              label: "Large Cap"  },
  midcap:    { min: 5000,  max: 20000,  label: "Mid Cap"   },
  smallcap:  { min: 500,   max: 5000,   label: "Small Cap" },
  microcap:  { min: 0,     max: 500,    label: "Micro Cap" },
};

// ── In-memory store ───────────────────────────────────────────────────────────
let scanCache = {
  gainers:    [],
  losers:     [],
  allStocks:  [],
  byMcap:     { largecap: [], midcap: [], smallcap: [], microcap: [] },
  bySector:   [],
  updatedAt:  0,
  advancing:  0,
  declining:  0,
  unchanged:  0,
  totalCount: 0,
};

let techCache    = new Map();  // symbol → technical analysis result
let nseCookie    = "";
let lastCookieAt = 0;
let ioRef        = null;
let preWarmTimer = null;       // track pre-warm so we don't stack runs

// ── Token getter ──────────────────────────────────────────────────────────────
let _getToken;
try {
  const stream = require("../upstoxStream");
  _getToken = stream.getAccessToken;
} catch (_) {}

function getUpstoxToken() {
  if (typeof _getToken === "function") return _getToken();
  return process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN || "";
}

// ── NSE cookie ────────────────────────────────────────────────────────────────
async function refreshNSECookie() {
  if (nseCookie && Date.now() - lastCookieAt < 20 * 60 * 1000) return;
  try {
    const res = await axios.get(NSE_BASE, {
      headers: { ...NSE_HEADERS, Accept: "text/html" },
      timeout: 15000,
    });
    const cookies = res.headers["set-cookie"] || [];
    nseCookie    = cookies.map(c => c.split(";")[0]).join("; ");
    lastCookieAt = Date.now();
  } catch (e) {
    console.warn("📊 Scanner: NSE cookie refresh failed —", e.message);
  }
}

// ── Fetch NSE live market data ────────────────────────────────────────────────
async function fetchNSEMarketData(index = "NIFTY 500") {
  await refreshNSECookie();
  const indexMap = {
    "NIFTY 50":           "https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050",
    "NIFTY 500":          "https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%20500",
    "NIFTY MIDCAP 100":   "https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%20MIDCAP%20100",
    "NIFTY SMALLCAP 100": "https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%20SMALLCAP%20100",
  };
  const url = indexMap[index] || indexMap["NIFTY 500"];
  const res = await axios.get(url, {
    headers: { ...NSE_HEADERS, Cookie: nseCookie },
    timeout: 15000,
  });
  return res.data?.data || [];
}

// ── Load mcap db ──────────────────────────────────────────────────────────────
function loadMcapDB() {
  try {
    if (fs.existsSync(MCAP_DB_PATH)) {
      return JSON.parse(fs.readFileSync(MCAP_DB_PATH, "utf8"));
    }
  } catch (e) {}
  return {};
}

function getMcapBucket(mcapCr) {
  if (!mcapCr) return "microcap";
  if (mcapCr >= MCAP_BUCKETS.largecap.min) return "largecap";
  if (mcapCr >= MCAP_BUCKETS.midcap.min)   return "midcap";
  if (mcapCr >= MCAP_BUCKETS.smallcap.min) return "smallcap";
  return "microcap";
}

// ── Technical indicator calculations ─────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k   = 2 / (period + 1);
  let ema   = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return Math.round(ema * 100) / 100;
}

function calcSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return Math.round((slice.reduce((a, b) => a + b, 0) / period) * 100) / 100;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const recent = closes.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    if (diff > 0) gains  += diff;
    else          losses += Math.abs(diff);
  }
  const avgGain = gains  / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (!ema12 || !ema26) return null;
  const macdLine = Math.round((ema12 - ema26) * 100) / 100;

  // Signal: 9-day EMA of MACD series
  const macdSeries = [];
  for (let i = 26; i <= closes.length; i++) {
    const e12 = calcEMA(closes.slice(0, i), 12);
    const e26 = calcEMA(closes.slice(0, i), 26);
    if (e12 && e26) macdSeries.push(e12 - e26);
  }
  const signal    = calcEMA(macdSeries, 9);
  const histogram = signal ? Math.round((macdLine - signal) * 100) / 100 : null;

  return {
    macd:      macdLine,
    signal:    signal ? Math.round(signal * 100) / 100 : null,
    histogram,
    crossover: histogram !== null ? (histogram > 0 ? "BULLISH" : "BEARISH") : null,
  };
}

function calcBollingerBands(closes, period = 20, stdDevMult = 2) {
  if (closes.length < period) return null;
  const slice  = closes.slice(-period);
  const sma    = slice.reduce((a, b) => a + b, 0) / period;
  const stdDev = Math.sqrt(slice.reduce((sum, v) => sum + Math.pow(v - sma, 2), 0) / period);
  const upper  = Math.round((sma + stdDevMult * stdDev) * 100) / 100;
  const lower  = Math.round((sma - stdDevMult * stdDev) * 100) / 100;
  const middle = Math.round(sma * 100) / 100;
  const ltp    = closes[closes.length - 1];
  const bWidth = Math.round(((upper - lower) / middle) * 10000) / 100;
  const bPct   = Math.round(((ltp - lower) / (upper - lower)) * 100);

  let position;
  if      (ltp > upper)  position = "ABOVE_UPPER";
  else if (ltp < lower)  position = "BELOW_LOWER";
  else if (bPct > 70)    position = "NEAR_UPPER";
  else if (bPct < 30)    position = "NEAR_LOWER";
  else                   position = "MIDDLE";

  return { upper, middle, lower, bandwidth: bWidth, percentB: bPct, position };
}

// ── MA Summary (TradingView-style) ────────────────────────────────────────────
function calcMASummary(closes, ltp) {
  const emas = {
    ema5:   calcEMA(closes, 5),
    ema9:   calcEMA(closes, 9),
    ema21:  calcEMA(closes, 21),
    ema50:  calcEMA(closes, 50),
    ema200: calcEMA(closes, 200),
  };
  const smas = {
    sma10:  calcSMA(closes, 10),
    sma20:  calcSMA(closes, 20),
    sma50:  calcSMA(closes, 50),
    sma100: calcSMA(closes, 100),
    sma200: calcSMA(closes, 200),
  };

  let buy = 0, sell = 0, neutral = 0;
  const signals = {};

  for (const [key, val] of Object.entries({ ...emas, ...smas })) {
    if (!val) {
      neutral++;
      signals[key] = { value: null, signal: "N/A" };
      continue;
    }
    if      (ltp > val * 1.001) { buy++;     signals[key] = { value: val, signal: "BUY"     }; }
    else if (ltp < val * 0.999) { sell++;    signals[key] = { value: val, signal: "SELL"    }; }
    else                        { neutral++; signals[key] = { value: val, signal: "NEUTRAL" }; }
  }

  const summary =
    buy  > sell + 2 ? "STRONG BUY"  :
    buy  > sell     ? "BUY"         :
    sell > buy  + 2 ? "STRONG SELL" :
    sell > buy      ? "SELL"        : "NEUTRAL";

  return { buy, sell, neutral, total: buy + sell + neutral, summary, signals };
}

// ── Full technical analysis for one symbol ────────────────────────────────────
function computeTechnicals(symbol, closes, ltp) {
  if (!closes || closes.length < 20) return null;

  const rsi    = calcRSI(closes);
  const macd   = calcMACD(closes);
  const bb     = calcBollingerBands(closes);
  const maSumm = calcMASummary(closes, ltp);
  const ema5   = calcEMA(closes, 5);
  const ema9   = calcEMA(closes, 9);
  const ema21  = calcEMA(closes, 21);
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);

  let techScore = 50;
  if (rsi) {
    if      (rsi > 70) techScore -= 10;
    else if (rsi < 30) techScore += 10;
    else if (rsi > 55) techScore += 5;
    else if (rsi < 45) techScore -= 5;
  }
  if (macd?.crossover === "BULLISH") techScore += 10;
  if (macd?.crossover === "BEARISH") techScore -= 10;
  if (maSumm.summary === "STRONG BUY")  techScore += 15;
  if (maSumm.summary === "BUY")         techScore += 8;
  if (maSumm.summary === "STRONG SELL") techScore -= 15;
  if (maSumm.summary === "SELL")        techScore -= 8;

  techScore = Math.max(0, Math.min(100, Math.round(techScore)));
  const bias = techScore >= 60 ? "BULLISH" : techScore <= 40 ? "BEARISH" : "NEUTRAL";

  return {
    symbol,
    ltp,
    emas:           { ema5, ema9, ema21, ema50, ema200 },
    rsi,
    macd,
    bollingerBands: bb,
    maSummary:      maSumm,
    techScore,
    bias,
    computedAt:     Date.now(),
  };
}

// ── Fetch historical OHLC from NSE ────────────────────────────────────────────
async function fetchNSEHistorical(symbol, days = 365) {
  await refreshNSECookie();
  try {
    const toDate   = new Date();
    const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const fmt      = d =>
      `${String(d.getDate()).padStart(2,"0")}-${String(d.getMonth()+1).padStart(2,"0")}-${d.getFullYear()}`;
    const url = `https://www.nseindia.com/api/historical/cm/equity?symbol=${encodeURIComponent(symbol)}&series=["EQ"]&from=${fmt(fromDate)}&to=${fmt(toDate)}&csv=false`;
    const res = await axios.get(url, {
      headers: { ...NSE_HEADERS, Cookie: nseCookie },
      timeout: 15000,
    });
    const rows = res.data?.data || [];
    // NSE returns newest first — reverse to oldest first
    return rows
      .map(r => parseFloat(r.CH_CLOSING_PRICE || r.close || 0))
      .filter(v => v > 0)
      .reverse();
  } catch (e) {
    return [];
  }
}

// ── Get technicals (cache-first) ──────────────────────────────────────────────
async function getTechnicals(symbol) {
  const cached = techCache.get(symbol);
  if (cached && Date.now() - cached.computedAt < TECH_CACHE_TTL) return cached;

  const stockData = scanCache.allStocks.find(s => s.symbol === symbol);
  const ltp       = stockData?.ltp || 0;

  const closes = await fetchNSEHistorical(symbol, 365);
  if (closes.length < 20) return null;

  const result = computeTechnicals(symbol, closes, ltp || closes[closes.length - 1]);
  if (result) techCache.set(symbol, result);
  return result;
}

// ── Background pre-warm: fetch technicals for top stocks silently ─────────────
async function preWarmTechCache(symbols) {
  if (!symbols.length) return;
  console.log(`📊 Scanner: pre-warming tech cache for ${symbols.length} symbols…`);
  let warmed = 0;
  for (const sym of symbols) {
    try {
      // Skip if already fresh in cache
      const cached = techCache.get(sym);
      if (cached && Date.now() - cached.computedAt < TECH_CACHE_TTL) {
        warmed++;
        continue;
      }
      await getTechnicals(sym);
      warmed++;
      // Throttle — don't hammer NSE
      await new Promise(r => setTimeout(r, PREWARM_BETWEEN));
    } catch (_) {}
  }
  console.log(`📊 Scanner: pre-warm done — ${warmed}/${symbols.length} cached`);
}

// ── Main scanner ──────────────────────────────────────────────────────────────
async function runScanner() {
  try {
    console.log("📊 Scanner: starting scan…");
    const mcapDB = loadMcapDB();

    // Fetch NSE 500 live data
    let stocks = [];
    try {
      const nifty500 = await fetchNSEMarketData("NIFTY 500");
      stocks = nifty500.map(s => ({
        symbol:     s.symbol,
        name:       s.meta?.companyName || s.symbol,
        ltp:        parseFloat(s.lastPrice          || 0),
        change:     parseFloat(s.change             || 0),
        changePct:  parseFloat(s.pChange            || 0),
        open:       parseFloat(s.open               || 0),
        high:       parseFloat(s.dayHigh            || 0),
        low:        parseFloat(s.dayLow             || 0),
        prevClose:  parseFloat(s.previousClose      || 0),
        volume:     parseInt (s.totalTradedVolume   || 0),
        totalValue: parseFloat(s.totalTradedValue   || 0),
        yearHigh:   parseFloat(s.yearHigh           || 0),
        yearLow:    parseFloat(s.yearLow            || 0),
        sector:     s.meta?.industry                || "",
      })).filter(s => s.ltp > 0);
    } catch (e) {
      console.warn("📊 Scanner: NSE 500 fetch failed —", e.message);
    }

    if (stocks.length === 0) {
      console.warn("📊 Scanner: no data from NSE — skipping this cycle");
      return;
    }

    // Enrich with mcap data
    stocks = stocks.map(s => {
      const dbEntry = Object.values(mcapDB).find(d =>
        (d.symbol || "").toUpperCase() === s.symbol.toUpperCase()
      ) || {};
      const mcapCr = dbEntry.mcap || null;
      return {
        ...s,
        mcap:       mcapCr,
        mcapBucket: getMcapBucket(mcapCr),
        mcapLabel:  MCAP_BUCKETS[getMcapBucket(mcapCr)]?.label || "Micro Cap",
      };
    });

    // Sort gainers / losers
    const sorted  = [...stocks].sort((a, b) => b.changePct - a.changePct);
    const gainers = sorted.filter(s => s.changePct > 0).slice(0, 20);
    const losers  = [...sorted].reverse().filter(s => s.changePct < 0).slice(0, 20);

    // Group by mcap
    const byMcap = { largecap: [], midcap: [], smallcap: [], microcap: [] };
    for (const s of stocks) byMcap[s.mcapBucket]?.push(s);

    // Group by sector → performance summary
    const bySector = {};
    for (const s of stocks) {
      if (!s.sector) continue;
      if (!bySector[s.sector]) bySector[s.sector] = [];
      bySector[s.sector].push(s);
    }
    const sectorSummary = Object.entries(bySector).map(([sector, ss]) => ({
      sector,
      avgChange:  Math.round((ss.reduce((sum, s) => sum + s.changePct, 0) / ss.length) * 100) / 100,
      advancing:  ss.filter(s => s.changePct > 0).length,
      declining:  ss.filter(s => s.changePct < 0).length,
      total:      ss.length,
      topGainer:  [...ss].sort((a, b) => b.changePct - a.changePct)[0],
    })).sort((a, b) => b.avgChange - a.avgChange);

    scanCache = {
      gainers,
      losers,
      allStocks:  stocks,
      byMcap,
      bySector:   sectorSummary,
      updatedAt:  Date.now(),
      totalCount: stocks.length,
      advancing:  stocks.filter(s => s.changePct > 0).length,
      declining:  stocks.filter(s => s.changePct < 0).length,
      unchanged:  stocks.filter(s => s.changePct === 0).length,
    };

    console.log(`📊 Scanner: ${stocks.length} stocks — ${scanCache.advancing} up, ${scanCache.declining} down`);

    // Broadcast to all connected clients
    if (ioRef) {
      ioRef.emit("scanner-update", {
        gainers,
        losers,
        byMcap: {
          largecap:  byMcap.largecap.slice(0, 50),
          midcap:    byMcap.midcap.slice(0, 50),
          smallcap:  byMcap.smallcap.slice(0, 50),
          microcap:  byMcap.microcap.slice(0, 50),
        },
        bySector:  sectorSummary,
        market: {
          advancing: scanCache.advancing,
          declining: scanCache.declining,
          unchanged: scanCache.unchanged,
          total:     scanCache.totalCount,
        },
        updatedAt: scanCache.updatedAt,
      });
    }

    // ── Pre-warm tech cache for most-viewed stocks ────────────────────────────
    // Deduplicated list: top gainers + losers + large caps
    const toPreWarm = [
      ...gainers.map(s => s.symbol),
      ...losers.map(s => s.symbol),
      ...byMcap.largecap.slice(0, 10).map(s => s.symbol),
    ].filter((sym, i, arr) => arr.indexOf(sym) === i);

    // Cancel any in-progress pre-warm from previous scan
    if (preWarmTimer) clearTimeout(preWarmTimer);
    preWarmTimer = setTimeout(() => preWarmTechCache(toPreWarm), PREWARM_DELAY);

  } catch (e) {
    console.error("📊 Scanner error:", e.message);
  }
}

// ── Socket handlers ───────────────────────────────────────────────────────────
function registerScannerHandlers(io) {
  io.on("connection", socket => {
    // Send cached data to new client immediately
    if (scanCache.updatedAt > 0) {
      socket.emit("scanner-update", {
        gainers:  scanCache.gainers,
        losers:   scanCache.losers,
        byMcap: {
          largecap:  scanCache.byMcap.largecap.slice(0, 50),
          midcap:    scanCache.byMcap.midcap.slice(0, 50),
          smallcap:  scanCache.byMcap.smallcap.slice(0, 50),
          microcap:  scanCache.byMcap.microcap.slice(0, 50),
        },
        bySector:  scanCache.bySector,
        market: {
          advancing: scanCache.advancing,
          declining: scanCache.declining,
          unchanged: scanCache.unchanged,
          total:     scanCache.totalCount,
        },
        updatedAt: scanCache.updatedAt,
      });
    }

    // on-demand technicals via socket (kept for compatibility)
    // Note: frontend now uses REST /api/scanner/technicals/:symbol instead
    socket.on("get-technicals", async ({ symbol } = {}) => {
      if (!symbol) return;
      try {
        const result = await getTechnicals(symbol.toUpperCase());
        if (result) socket.emit("scanner-technicals", result);
      } catch (e) {
        console.warn("📊 Technicals socket error:", e.message);
      }
    });

    // Full stock list with filters
    socket.on("get-scanner-stocks", ({ bucket, sector, sortBy, limit } = {}) => {
      let stocks = [...(scanCache.allStocks || [])];
      if (bucket && bucket !== "all") stocks = scanCache.byMcap[bucket] || [];
      if (sector) stocks = stocks.filter(s => s.sector === sector);
      if (sortBy === "gainers")  stocks.sort((a, b) => b.changePct  - a.changePct);
      if (sortBy === "losers")   stocks.sort((a, b) => a.changePct  - b.changePct);
      if (sortBy === "volume")   stocks.sort((a, b) => b.volume     - a.volume);
      if (sortBy === "value")    stocks.sort((a, b) => b.totalValue - a.totalValue);
      if (sortBy === "52whigh")  stocks.sort((a, b) => (b.ltp / b.yearHigh) - (a.ltp / a.yearHigh));
      socket.emit("scanner-stocks", {
        stocks: stocks.slice(0, limit || 100),
        total:  stocks.length,
        bucket,
        sector,
        sortBy,
      });
    });
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
function startMarketScanner(io) {
  ioRef = io;
  registerScannerHandlers(io);
  runScanner();                              // first run immediately
  setInterval(runScanner, SCAN_INTERVAL);   // then every 5 min
  console.log("📊 Market Scanner started");
}

// ── REST API handlers ─────────────────────────────────────────────────────────
function getScannerData() { return scanCache; }
async function getTechnicalsREST(symbol) { return getTechnicals(symbol); }

module.exports = { startMarketScanner, getScannerData, getTechnicalsREST };