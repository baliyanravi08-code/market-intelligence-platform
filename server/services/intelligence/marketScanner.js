"use strict";

/**
 * marketScanner.js
 * Location: server/services/intelligence/marketScanner.js
 *
 * KEY FIX: Historical OHLC now fetched via Upstox historical-candle API
 * (token-based, works from any server IP including Render/AWS).
 * NSE historical API 403s on cloud servers — kept only as fallback.
 *
 * MULTI-TIMEFRAME: Added TIMEFRAME_CONFIG, getTechnicalsForTimeframe,
 * and updated fetchHistoricalCloses to accept interval param.
 */

const axios = require("axios");
const path  = require("path");
const fs    = require("fs");

// ── Config ────────────────────────────────────────────────────────────────────
const MCAP_DB_PATH    = path.join(__dirname, "../../data/marketCapDB.json");
const SCAN_INTERVAL   = 5 * 60 * 1000;
const TECH_CACHE_TTL  = 15 * 60 * 1000;
const PREWARM_DELAY   = 5000;
const PREWARM_BETWEEN = 400;   // ms between Upstox requests

// ── Timeframe config ──────────────────────────────────────────────────────────
// interval = Upstox candle interval string
// NOTE: "240minute" is not a native Upstox interval — we fetch "60minute"
//       and aggregate every 4 candles. Handled in fetchHistoricalCloses.
const TIMEFRAME_CONFIG = {
  "5min":   { interval: "5minute",   days: 30,   candles: 200, ttl: 2  * 60 * 1000 },
  "15min":  { interval: "15minute",  days: 60,   candles: 200, ttl: 5  * 60 * 1000 },
  "1hour":  { interval: "60minute",  days: 120,  candles: 200, ttl: 10 * 60 * 1000 },
  "4hour":  { interval: "240minute", days: 180,  candles: 200, ttl: 15 * 60 * 1000 },
  "1day":   { interval: "day",       days: 365,  candles: 250, ttl: 15 * 60 * 1000 },
  "1week":  { interval: "week",      days: 730,  candles: 104, ttl: 30 * 60 * 1000 },
  "1month": { interval: "month",     days: 1825, candles: 60,  ttl: 60 * 60 * 1000 },
};

// ── NSE public endpoints ──────────────────────────────────────────────────────
const NSE_BASE    = "https://www.nseindia.com";
const NSE_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept":          "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer":         "https://www.nseindia.com/market-data/live-equity-market",
  "Connection":      "keep-alive",
};

// ── Market cap buckets (Crores) ───────────────────────────────────────────────
const MCAP_BUCKETS = {
  largecap:  { min: 20000,             label: "Large Cap"  },
  midcap:    { min: 5000,  max: 20000, label: "Mid Cap"   },
  smallcap:  { min: 500,   max: 5000,  label: "Small Cap" },
  microcap:  { min: 0,     max: 500,   label: "Micro Cap" },
};

// ── In-memory store ───────────────────────────────────────────────────────────
let scanCache = {
  gainers: [], losers: [], allStocks: [],
  byMcap: { largecap: [], midcap: [], smallcap: [], microcap: [] },
  bySector: [], updatedAt: 0,
  advancing: 0, declining: 0, unchanged: 0, totalCount: 0,
};

// techCache keyed by "SYMBOL:timeframe" e.g. "RELIANCE:1day", "TCS:15min"
let techCache    = new Map();
let nseCookie    = "";
let lastCookieAt = 0;
let ioRef        = null;
let preWarmTimer = null;

// ── Upstox token ──────────────────────────────────────────────────────────────
let _getToken;
try { _getToken = require("../upstoxStream").getAccessToken; } catch (_) {}

function getUpstoxToken() {
  if (typeof _getToken === "function") return _getToken();
  return process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN || "";
}

// ── Instrument key lookup from server's shared map ────────────────────────────
function getInstrumentKey(symbol) {
  try {
    const { getInstrumentMap } = require("../../server");
    const map = getInstrumentMap();
    return map[symbol] || map[symbol.toUpperCase()] || null;
  } catch (_) { return null; }
}

// ── NSE cookie (for live data endpoint only) ──────────────────────────────────
async function refreshNSECookie() {
  if (nseCookie && Date.now() - lastCookieAt < 20 * 60 * 1000) return;
  try {
    const res = await axios.get(NSE_BASE, {
      headers: { ...NSE_HEADERS, Accept: "text/html" }, timeout: 15000,
    });
    nseCookie    = (res.headers["set-cookie"] || []).map(c => c.split(";")[0]).join("; ");
    lastCookieAt = Date.now();
  } catch (e) {
    console.warn("📊 Scanner: NSE cookie refresh failed —", e.message);
  }
}

// ── Fetch NSE 500 live data ───────────────────────────────────────────────────
async function fetchNSEMarketData() {
  await refreshNSECookie();
  const res = await axios.get(
    "https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%20500",
    { headers: { ...NSE_HEADERS, Cookie: nseCookie }, timeout: 15000 }
  );
  return res.data?.data || [];
}

// ── Mcap helpers ──────────────────────────────────────────────────────────────
function loadMcapDB() {
  try {
    if (fs.existsSync(MCAP_DB_PATH)) return JSON.parse(fs.readFileSync(MCAP_DB_PATH, "utf8"));
  } catch (_) {}
  return {};
}
function getMcapBucket(mcapCr) {
  if (!mcapCr) return "microcap";
  if (mcapCr >= 20000) return "largecap";
  if (mcapCr >= 5000)  return "midcap";
  if (mcapCr >= 500)   return "smallcap";
  return "microcap";
}

// ── Technical calculations ────────────────────────────────────────────────────
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return Math.round(ema * 100) / 100;
}
function calcSMA(closes, period) {
  if (closes.length < period) return null;
  return Math.round((closes.slice(-period).reduce((a, b) => a + b, 0) / period) * 100) / 100;
}
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const recent = closes.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const d = recent[i] - recent[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return Math.round((100 - 100 / (1 + (gains / period) / avgLoss)) * 100) / 100;
}
function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (!ema12 || !ema26) return null;
  const macdLine = Math.round((ema12 - ema26) * 100) / 100;
  const series   = [];
  for (let i = 26; i <= closes.length; i++) {
    const e12 = calcEMA(closes.slice(0, i), 12);
    const e26 = calcEMA(closes.slice(0, i), 26);
    if (e12 && e26) series.push(e12 - e26);
  }
  const signal    = calcEMA(series, 9);
  const histogram = signal ? Math.round((macdLine - signal) * 100) / 100 : null;
  return {
    macd: macdLine,
    signal: signal ? Math.round(signal * 100) / 100 : null,
    histogram,
    crossover: histogram !== null ? (histogram > 0 ? "BULLISH" : "BEARISH") : null,
  };
}
function calcBollingerBands(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice  = closes.slice(-period);
  const sma    = slice.reduce((a, b) => a + b, 0) / period;
  const stdDev = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - sma, 2), 0) / period);
  const upper  = Math.round((sma + mult * stdDev) * 100) / 100;
  const lower  = Math.round((sma - mult * stdDev) * 100) / 100;
  const middle = Math.round(sma * 100) / 100;
  const ltp    = closes[closes.length - 1];
  const bPct   = Math.round(((ltp - lower) / (upper - lower)) * 100);
  const position =
    ltp > upper ? "ABOVE_UPPER" : ltp < lower ? "BELOW_LOWER" :
    bPct > 70   ? "NEAR_UPPER"  : bPct < 30   ? "NEAR_LOWER"  : "MIDDLE";
  return {
    upper, middle, lower,
    bandwidth: Math.round(((upper - lower) / middle) * 10000) / 100,
    percentB:  bPct, position,
  };
}
function calcMASummary(closes, ltp) {
  const mas = {
    ema5: calcEMA(closes,5), ema9: calcEMA(closes,9), ema21: calcEMA(closes,21),
    ema50: calcEMA(closes,50), ema200: calcEMA(closes,200),
    sma10: calcSMA(closes,10), sma20: calcSMA(closes,20), sma50: calcSMA(closes,50),
    sma100: calcSMA(closes,100), sma200: calcSMA(closes,200),
  };
  let buy = 0, sell = 0, neutral = 0;
  const signals = {};
  for (const [k, v] of Object.entries(mas)) {
    if (!v)                   { neutral++; signals[k] = { value: null, signal: "N/A"     }; }
    else if (ltp > v * 1.001) { buy++;     signals[k] = { value: v,    signal: "BUY"     }; }
    else if (ltp < v * 0.999) { sell++;    signals[k] = { value: v,    signal: "SELL"    }; }
    else                      { neutral++; signals[k] = { value: v,    signal: "NEUTRAL" }; }
  }
  const summary =
    buy  > sell + 2 ? "STRONG BUY"  : buy  > sell ? "BUY"  :
    sell > buy  + 2 ? "STRONG SELL" : sell > buy  ? "SELL" : "NEUTRAL";
  return { buy, sell, neutral, total: buy + sell + neutral, summary, signals };
}
function computeTechnicals(symbol, closes, ltp) {
  if (!closes || closes.length < 20) return null;
  const rsi    = calcRSI(closes);
  const macd   = calcMACD(closes);
  const bb     = calcBollingerBands(closes);
  const maSumm = calcMASummary(closes, ltp);
  let score = 50;
  if (rsi) {
    if (rsi > 70) score -= 10; else if (rsi < 30) score += 10;
    else if (rsi > 55) score += 5; else if (rsi < 45) score -= 5;
  }
  if (macd?.crossover === "BULLISH") score += 10;
  if (macd?.crossover === "BEARISH") score -= 10;
  if (maSumm.summary === "STRONG BUY")  score += 15;
  if (maSumm.summary === "BUY")         score += 8;
  if (maSumm.summary === "STRONG SELL") score -= 15;
  if (maSumm.summary === "SELL")        score -= 8;
  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    symbol, ltp,
    emas: {
      ema5:   calcEMA(closes, 5),  ema9:   calcEMA(closes, 9),
      ema21:  calcEMA(closes, 21), ema50:  calcEMA(closes, 50),
      ema200: calcEMA(closes, 200),
    },
    rsi, macd, bollingerBands: bb, maSummary: maSumm,
    techScore: score,
    bias: score >= 60 ? "BULLISH" : score <= 40 ? "BEARISH" : "NEUTRAL",
    computedAt: Date.now(),
  };
}

// ── Historical closes — Upstox PRIMARY, NSE fallback ─────────────────────────
// interval: Upstox candle interval string e.g. "day", "60minute", "15minute"
// "240minute" (4H) is handled by fetching "60minute" and aggregating 4→1
async function fetchHistoricalCloses(symbol, days = 365, interval = "day") {
  const token    = getUpstoxToken();
  const instrKey = getInstrumentKey(symbol);

  // 4H is not a native Upstox interval — fetch 1H and aggregate every 4 candles
  const actualInterval = interval === "240minute" ? "60minute" : interval;
  const aggregate4H    = interval === "240minute";

  // PRIMARY: Upstox historical-candle API — works from any IP with token
  if (token && instrKey) {
    try {
      const to   = new Date();
      const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const fmt  = d => d.toISOString().slice(0, 10);

      // Intraday intervals use a different Upstox endpoint
      const isIntraday = ["1minute","5minute","15minute","30minute","60minute"].includes(actualInterval);
      const url = isIntraday
        ? `https://api.upstox.com/v2/historical-candle/intraday/${encodeURIComponent(instrKey)}/${actualInterval}`
        : `https://api.upstox.com/v2/historical-candle/${encodeURIComponent(instrKey)}/${actualInterval}/${fmt(to)}/${fmt(from)}`;

      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        timeout: 10000,
      });

      // Format: [timestamp, open, high, low, close, volume, oi] — newest first
      let rawCandles = (res.data?.data?.candles || []).reverse(); // oldest first

      // Aggregate 1H → 4H: take close of every 4th candle (last in group)
      if (aggregate4H && rawCandles.length >= 4) {
        const agg = [];
        for (let i = 3; i < rawCandles.length; i += 4) {
          agg.push(rawCandles[i]);
        }
        rawCandles = agg;
      }

      const closes = rawCandles
        .map(c => parseFloat(c[4]))
        .filter(v => v > 0);

      if (closes.length >= 20) return closes;
      console.warn(`📊 Upstox: only ${closes.length} candles for ${symbol} [${interval}]`);
    } catch (e) {
      console.warn(`📊 Upstox historical failed [${symbol}][${interval}]:`, e.response?.status || e.message);
    }
  } else {
    if (!token)    console.warn(`📊 No Upstox token for ${symbol} technicals`);
    if (!instrKey) console.warn(`📊 No instrument key for ${symbol}`);
  }

  // FALLBACK: NSE daily — only for "day" interval (403s on cloud)
  if (interval === "day") {
    await refreshNSECookie();
    try {
      const to   = new Date();
      const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const fmt  = d => `${String(d.getDate()).padStart(2,"0")}-${String(d.getMonth()+1).padStart(2,"0")}-${d.getFullYear()}`;
      const res  = await axios.get(
        `https://www.nseindia.com/api/historical/cm/equity?symbol=${encodeURIComponent(symbol)}&series=["EQ"]&from=${fmt(from)}&to=${fmt(to)}&csv=false`,
        { headers: { ...NSE_HEADERS, Cookie: nseCookie }, timeout: 15000 }
      );
      return (res.data?.data || [])
        .map(r => parseFloat(r.CH_CLOSING_PRICE || r.close || 0))
        .filter(v => v > 0)
        .reverse();
    } catch (_) { return []; }
  }

  return [];
}

// ── Get technicals for a specific timeframe (cache-first) ─────────────────────
// Cache key: "SYMBOL:timeframe" e.g. "RELIANCE:1day", "TCS:15min"
async function getTechnicalsForTimeframe(symbol, timeframe = "1day") {
  const cfg      = TIMEFRAME_CONFIG[timeframe] || TIMEFRAME_CONFIG["1day"];
  const cacheKey = `${symbol}:${timeframe}`;
  const cached   = techCache.get(cacheKey);
  if (cached && Date.now() - cached.computedAt < cfg.ttl) return cached;

  const ltp    = scanCache.allStocks.find(s => s.symbol === symbol)?.ltp || 0;
  const closes = await fetchHistoricalCloses(symbol, cfg.days, cfg.interval);
  if (closes.length < 20) return null;

  const result = computeTechnicals(symbol, closes, ltp || closes[closes.length - 1]);
  if (result) {
    result.timeframe = timeframe;
    techCache.set(cacheKey, result);
  }
  return result;
}

// ── Get technicals (cache-first) — defaults to 1day for backward compat ───────
async function getTechnicals(symbol) {
  return getTechnicalsForTimeframe(symbol, "1day");
}

// ── Background pre-warm ───────────────────────────────────────────────────────
async function preWarmTechCache(symbols) {
  if (!symbols.length) return;
  console.log(`📊 Pre-warming ${symbols.length} symbols…`);
  let warmed = 0;
  for (const sym of symbols) {
    try {
      const cached = techCache.get(`${sym}:1day`);
      if (cached && Date.now() - cached.computedAt < TECH_CACHE_TTL) { warmed++; continue; }
      await getTechnicals(sym);
      warmed++;
      await new Promise(r => setTimeout(r, PREWARM_BETWEEN));
    } catch (_) {}
  }
  console.log(`📊 Pre-warm done: ${warmed}/${symbols.length}`);
}

// ── Main scan ─────────────────────────────────────────────────────────────────
async function runScanner() {
  try {
    console.log("📊 Scanner: running…");
    const mcapDB = loadMcapDB();

    let stocks = [];
    try {
      stocks = (await fetchNSEMarketData()).map(s => ({
        symbol:     s.symbol,
        name:       s.meta?.companyName    || s.symbol,
        ltp:        parseFloat(s.lastPrice        || 0),
        change:     parseFloat(s.change           || 0),
        changePct:  parseFloat(s.pChange          || 0),
        open:       parseFloat(s.open             || 0),
        high:       parseFloat(s.dayHigh          || 0),
        low:        parseFloat(s.dayLow           || 0),
        prevClose:  parseFloat(s.previousClose    || 0),
        volume:     parseInt (s.totalTradedVolume || 0),
        totalValue: parseFloat(s.totalTradedValue || 0),
        yearHigh:   parseFloat(s.yearHigh         || 0),
        yearLow:    parseFloat(s.yearLow          || 0),
        sector:     s.meta?.industry              || "",
      })).filter(s => s.ltp > 0);
    } catch (e) {
      console.warn("📊 NSE 500 fetch failed —", e.message);
    }

    if (!stocks.length) { console.warn("📊 No data — skipping"); return; }

    stocks = stocks.map(s => {
      const db     = Object.values(mcapDB).find(d => (d.symbol||"").toUpperCase() === s.symbol) || {};
      const mcapCr = db.mcap || null;
      const bucket = getMcapBucket(mcapCr);
      return { ...s, mcap: mcapCr, mcapBucket: bucket, mcapLabel: MCAP_BUCKETS[bucket]?.label || "Micro Cap" };
    });

    const sorted  = [...stocks].sort((a, b) => b.changePct - a.changePct);
    const gainers = sorted.filter(s => s.changePct > 0).slice(0, 20);
    const losers  = [...sorted].reverse().filter(s => s.changePct < 0).slice(0, 20);

    const byMcap = { largecap: [], midcap: [], smallcap: [], microcap: [] };
    for (const s of stocks) byMcap[s.mcapBucket]?.push(s);

    const sectorMap = {};
    for (const s of stocks) {
      if (!s.sector) continue;
      if (!sectorMap[s.sector]) sectorMap[s.sector] = [];
      sectorMap[s.sector].push(s);
    }
    const bySector = Object.entries(sectorMap).map(([sector, ss]) => ({
      sector,
      avgChange: Math.round((ss.reduce((sum, s) => sum + s.changePct, 0) / ss.length) * 100) / 100,
      advancing: ss.filter(s => s.changePct > 0).length,
      declining: ss.filter(s => s.changePct < 0).length,
      total:     ss.length,
      topGainer: [...ss].sort((a, b) => b.changePct - a.changePct)[0],
    })).sort((a, b) => b.avgChange - a.avgChange);

    scanCache = {
      gainers, losers, allStocks: stocks, byMcap, bySector,
      updatedAt:  Date.now(),
      totalCount: stocks.length,
      advancing:  stocks.filter(s => s.changePct > 0).length,
      declining:  stocks.filter(s => s.changePct < 0).length,
      unchanged:  stocks.filter(s => s.changePct === 0).length,
    };

    console.log(`📊 ${stocks.length} stocks — ${scanCache.advancing}↑ ${scanCache.declining}↓`);

    if (ioRef) {
      ioRef.emit("scanner-update", {
        gainers, losers,
        byMcap: {
          largecap:  byMcap.largecap.slice(0, 50),
          midcap:    byMcap.midcap.slice(0, 50),
          smallcap:  byMcap.smallcap.slice(0, 50),
          microcap:  byMcap.microcap.slice(0, 50),
        },
        bySector,
        market: {
          advancing: scanCache.advancing, declining: scanCache.declining,
          unchanged: scanCache.unchanged, total: scanCache.totalCount,
        },
        updatedAt: scanCache.updatedAt,
      });
    }

    // Pre-warm top gainers + losers + large caps (1day only)
    const toWarm = [
      ...gainers.map(s => s.symbol),
      ...losers.map(s => s.symbol),
      ...byMcap.largecap.slice(0, 10).map(s => s.symbol),
    ].filter((s, i, a) => a.indexOf(s) === i);

    if (preWarmTimer) clearTimeout(preWarmTimer);
    preWarmTimer = setTimeout(() => preWarmTechCache(toWarm), PREWARM_DELAY);

  } catch (e) {
    console.error("📊 Scanner error:", e.message);
  }
}

// ── Socket handlers ───────────────────────────────────────────────────────────
function registerScannerHandlers(io) {
  io.on("connection", socket => {
    if (scanCache.updatedAt > 0) {
      socket.emit("scanner-update", {
        gainers: scanCache.gainers, losers: scanCache.losers,
        byMcap: {
          largecap:  scanCache.byMcap.largecap.slice(0, 50),
          midcap:    scanCache.byMcap.midcap.slice(0, 50),
          smallcap:  scanCache.byMcap.smallcap.slice(0, 50),
          microcap:  scanCache.byMcap.microcap.slice(0, 50),
        },
        bySector: scanCache.bySector,
        market: {
          advancing: scanCache.advancing, declining: scanCache.declining,
          unchanged: scanCache.unchanged, total: scanCache.totalCount,
        },
        updatedAt: scanCache.updatedAt,
      });
    }

    // Kept for compatibility — frontend now uses REST /api/scanner/technicals/:symbol
    socket.on("get-technicals", async ({ symbol } = {}) => {
      if (!symbol) return;
      try {
        const result = await getTechnicals(symbol.toUpperCase());
        if (result) socket.emit("scanner-technicals", result);
      } catch (e) { console.warn("📊 Socket technicals error:", e.message); }
    });

    socket.on("get-scanner-stocks", ({ bucket, sector, sortBy, limit } = {}) => {
      let stocks = [...(scanCache.allStocks || [])];
      if (bucket && bucket !== "all") stocks = scanCache.byMcap[bucket] || [];
      if (sector) stocks = stocks.filter(s => s.sector === sector);
      if (sortBy === "gainers")  stocks.sort((a, b) => b.changePct  - a.changePct);
      if (sortBy === "losers")   stocks.sort((a, b) => a.changePct  - b.changePct);
      if (sortBy === "volume")   stocks.sort((a, b) => b.volume     - a.volume);
      if (sortBy === "value")    stocks.sort((a, b) => b.totalValue - a.totalValue);
      if (sortBy === "52whigh")  stocks.sort((a, b) => (b.ltp/b.yearHigh) - (a.ltp/a.yearHigh));
      socket.emit("scanner-stocks", { stocks: stocks.slice(0, limit || 100), total: stocks.length, bucket, sector, sortBy });
    });
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
function startMarketScanner(io) {
  ioRef = io;
  registerScannerHandlers(io);
  runScanner();
  setInterval(runScanner, SCAN_INTERVAL);
  console.log("📊 Market Scanner started");
}

function getScannerData()                { return scanCache; }
async function getTechnicalsREST(symbol) { return getTechnicals(symbol); }

module.exports = {
  startMarketScanner,
  getScannerData,
  getTechnicalsREST,
  getTechnicalsForTimeframe,
};