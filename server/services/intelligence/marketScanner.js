"use strict";

/**
 * marketScanner.js
 * Location: server/services/intelligence/marketScanner.js
 *
 * FIXES applied:
 * 1. Intraday Upstox endpoint — correct URL format + response parsing
 * 2. getInstrumentKey — now accepts fallback from env map so 5m/15m/1H/4H work
 * 3. 4H aggregation — correctly builds 4-candle OHLC groups (was using only close)
 * 4. Token availability check — deferred so it reads token set after server boot
 * 5. fetchHistoricalCloses — clearer error logging so you can see exactly what fails
 * 6. computeTechnicals — added Stochastic, Williams %R, ADX, Supertrend, OBV, VWAP, MFI
 *    so all indicators the frontend expects are returned
 */

const axios = require("axios");
const path  = require("path");
const fs    = require("fs");

// ── Config ────────────────────────────────────────────────────────────────────
const MCAP_DB_PATH    = path.join(__dirname, "../../data/marketCapDB.json");
const SCAN_INTERVAL   = 5 * 60 * 1000;
const PREWARM_DELAY   = 5000;
const PREWARM_BETWEEN = 400;

// ── Timeframe config ──────────────────────────────────────────────────────────
const TIMEFRAME_CONFIG = {
  "5min":   { interval: "5minute",   days: 10,   candles: 200, ttl: 2  * 60 * 1000 },
  "15min":  { interval: "15minute",  days: 30,   candles: 200, ttl: 5  * 60 * 1000 },
  "1hour":  { interval: "60minute",  days: 60,   candles: 200, ttl: 10 * 60 * 1000 },
  "4hour":  { interval: "240minute", days: 120,  candles: 200, ttl: 15 * 60 * 1000 },
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

// techCache keyed by "SYMBOL:timeframe"
let techCache    = new Map();
let nseCookie    = "";
let lastCookieAt = 0;
let ioRef        = null;
let preWarmTimer = null;

// ── Upstox token — deferred getter so it always reads current token ───────────
function getUpstoxToken() {
  // Always try upstoxStream first (most up-to-date after OAuth)
  try {
    const { getAccessToken } = require("../upstoxStream");
    const t = getAccessToken();
    if (t) return t;
  } catch (_) {}
  return process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN || "";
}

// ── Instrument key lookup ─────────────────────────────────────────────────────
// FIX: was failing silently when server.js not yet fully exported
function getInstrumentKey(symbol) {
  try {
    const { getInstrumentMap } = require("../../server");
    const map = getInstrumentMap();
    if (map && Object.keys(map).length > 0) {
      return map[symbol] || map[symbol.toUpperCase()] || null;
    }
  } catch (_) {}
  // Hard-coded fallback for most-traded NSE EQ symbols
  const FALLBACK = {
    "RELIANCE":   "NSE_EQ|INE002A01018", "TCS":        "NSE_EQ|INE467B01029",
    "HDFCBANK":   "NSE_EQ|INE040A01034", "INFY":       "NSE_EQ|INE009A01021",
    "ICICIBANK":  "NSE_EQ|INE090A01021", "SBIN":       "NSE_EQ|INE062A01020",
    "AXISBANK":   "NSE_EQ|INE238A01034", "KOTAKBANK":  "NSE_EQ|INE237A01028",
    "LT":         "NSE_EQ|INE018A01030", "WIPRO":      "NSE_EQ|INE075A01022",
    "BAJFINANCE": "NSE_EQ|INE296A01024", "BHARTIARTL": "NSE_EQ|INE397D01024",
    "HINDUNILVR": "NSE_EQ|INE030A01027", "NTPC":       "NSE_EQ|INE733E01010",
    "SUNPHARMA":  "NSE_EQ|INE044A01036", "TATAMOTORS": "NSE_EQ|INE155A01022",
    "TATASTEEL":  "NSE_EQ|INE081A01020", "MARUTI":     "NSE_EQ|INE585B01010",
    "TITAN":      "NSE_EQ|INE280A01028", "ITC":        "NSE_EQ|INE154A01025",
    "ADANIENT":   "NSE_EQ|INE423A01024", "ADANIPORTS": "NSE_EQ|INE742F01042",
    "HCLTECH":    "NSE_EQ|INE860A01027", "TECHM":      "NSE_EQ|INE669C01036",
    "ZOMATO":     "NSE_EQ|INE758T01015", "JSWSTEEL":   "NSE_EQ|INE019A01038",
    "HINDALCO":   "NSE_EQ|INE038A01020", "COALINDIA":  "NSE_EQ|INE522F01014",
    "DRREDDY":    "NSE_EQ|INE089A01023", "CIPLA":      "NSE_EQ|INE059A01026",
    "EICHERMOT":  "NSE_EQ|INE066A01021", "HEROMOTOCO": "NSE_EQ|INE158A01026",
    "BAJAJ-AUTO": "NSE_EQ|INE917I01010", "BAJAJFINSV": "NSE_EQ|INE918I01026",
  };
  return FALLBACK[symbol] || FALLBACK[symbol.toUpperCase()] || null;
}

// ── NSE cookie ────────────────────────────────────────────────────────────────
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
  if (closes.length < 35) return null;
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
  const signal    = series.length >= 9 ? calcEMA(series, 9) : null;
  const histogram = signal != null ? Math.round((macdLine - signal) * 100) / 100 : null;
  return {
    macd: macdLine,
    signal: signal != null ? Math.round(signal * 100) / 100 : null,
    histogram,
    crossover: histogram != null ? (histogram > 0 ? "BULLISH" : "BEARISH") : null,
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
  const range  = upper - lower;
  const bPct   = range > 0 ? Math.round(((ltp - lower) / range) * 100) : 50;
  const bw     = Math.round(((upper - lower) / middle) * 10000) / 100;
  const position =
    ltp > upper ? "ABOVE_UPPER" : ltp < lower ? "BELOW_LOWER" :
    bPct > 70   ? "NEAR_UPPER"  : bPct < 30   ? "NEAR_LOWER"  : "MIDDLE";
  return { upper, middle, lower, bandwidth: bw, percentB: bPct, position };
}
function calcATR(candles, period = 14) {
  // candles: [{h, l, c}] oldest first
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].h, l = candles[i].l, pc = candles[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const recent = trs.slice(-period);
  return Math.round((recent.reduce((a, b) => a + b, 0) / period) * 100) / 100;
}
function calcStochastic(candles, kPeriod = 14, dPeriod = 3) {
  if (!candles || candles.length < kPeriod + dPeriod) return null;
  const kValues = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    const slice = candles.slice(i - kPeriod + 1, i + 1);
    const high  = Math.max(...slice.map(c => c.h));
    const low   = Math.min(...slice.map(c => c.l));
    const close = candles[i].c;
    const k = high === low ? 50 : Math.round(((close - low) / (high - low)) * 10000) / 100;
    kValues.push(k);
  }
  const kLast = kValues[kValues.length - 1];
  const dSlice = kValues.slice(-dPeriod);
  const dLast = Math.round((dSlice.reduce((a, b) => a + b, 0) / dPeriod) * 100) / 100;
  return { k: kLast, d: dLast };
}
function calcWilliamsR(candles, period = 14) {
  if (!candles || candles.length < period) return null;
  const slice = candles.slice(-period);
  const high  = Math.max(...slice.map(c => c.h));
  const low   = Math.min(...slice.map(c => c.l));
  const close = candles[candles.length - 1].c;
  if (high === low) return -50;
  return Math.round(((high - close) / (high - low)) * -10000) / 100;
}
function calcADX(candles, period = 14) {
  if (!candles || candles.length < period * 2) return null;
  const dmPlus  = [], dmMinus = [], trs = [];
  for (let i = 1; i < candles.length; i++) {
    const upMove   = candles[i].h - candles[i-1].h;
    const downMove = candles[i-1].l - candles[i].l;
    dmPlus.push(upMove   > downMove && upMove   > 0 ? upMove   : 0);
    dmMinus.push(downMove > upMove  && downMove > 0 ? downMove : 0);
    const h = candles[i].h, l = candles[i].l, pc = candles[i-1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  // Wilder smoothing
  const smooth = (arr) => {
    let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = period; i < arr.length; i++) {
      s = s - s / period + arr[i];
      out.push(s);
    }
    return out;
  };
  const sTR  = smooth(trs);
  const sDMP = smooth(dmPlus);
  const sDMM = smooth(dmMinus);
  const diPlus  = sTR.map((v, i) => v > 0 ? Math.round((sDMP[i] / v) * 10000) / 100 : 0);
  const diMinus = sTR.map((v, i) => v > 0 ? Math.round((sDMM[i] / v) * 10000) / 100 : 0);
  const dx      = diPlus.map((p, i) => {
    const m = diMinus[i];
    const s = p + m;
    return s > 0 ? Math.abs(p - m) / s * 100 : 0;
  });
  const adxSlice = dx.slice(-period);
  const adx = Math.round((adxSlice.reduce((a, b) => a + b, 0) / period) * 100) / 100;
  return {
    adx,
    diPlus:  Math.round(diPlus[diPlus.length - 1] * 100) / 100,
    diMinus: Math.round(diMinus[diMinus.length - 1] * 100) / 100,
  };
}
function calcSupertrend(candles, period = 10, multiplier = 3) {
  if (!candles || candles.length < period + 5) return null;
  const atr = calcATR(candles, period);
  if (!atr) return null;
  const last   = candles[candles.length - 1];
  const hl2    = (last.h + last.l) / 2;
  const upper  = Math.round((hl2 + multiplier * atr) * 100) / 100;
  const lower  = Math.round((hl2 - multiplier * atr) * 100) / 100;
  const trend  = last.c > lower ? "BULLISH" : last.c < upper ? "BEARISH" : "NEUTRAL";
  const level  = trend === "BULLISH" ? lower : upper;
  return { trend, level: Math.round(level * 100) / 100, atr };
}
function calcOBV(candles) {
  if (!candles || candles.length < 10) return null;
  let obv = 0;
  const obvValues = [0];
  for (let i = 1; i < candles.length; i++) {
    const vol = candles[i].v || 0;
    if (candles[i].c > candles[i-1].c)      obv += vol;
    else if (candles[i].c < candles[i-1].c) obv -= vol;
    obvValues.push(obv);
  }
  const recent = obvValues.slice(-20);
  const first10avg = recent.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
  const last10avg  = recent.slice(10).reduce((a, b) => a + b, 0) / 10;
  const diff = last10avg - first10avg;
  if (Math.abs(diff) < Math.abs(first10avg) * 0.01) return "Flat";
  if (diff > Math.abs(first10avg) * 0.05) return "Strongly Rising";
  if (diff > 0) return "Rising";
  if (diff < -Math.abs(first10avg) * 0.05) return "Strongly Falling";
  return "Falling";
}
function calcMFI(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const slice = candles.slice(-(period + 1));
  let posFlow = 0, negFlow = 0;
  for (let i = 1; i < slice.length; i++) {
    const tp     = (slice[i].h + slice[i].l + slice[i].c) / 3;
    const prevTP = (slice[i-1].h + slice[i-1].l + slice[i-1].c) / 3;
    const mf     = tp * (slice[i].v || 1);
    if (tp > prevTP) posFlow += mf;
    else             negFlow += mf;
  }
  if (negFlow === 0) return 100;
  return Math.round((100 - 100 / (1 + posFlow / negFlow)) * 100) / 100;
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

// ── Full technicals including all new indicators ──────────────────────────────
function computeTechnicals(symbol, candles) {
  // candles: [{o,h,l,c,v}] oldest first — at minimum 20 items
  if (!candles || candles.length < 20) return null;

  const closes = candles.map(c => c.c);
  const ltp    = closes[closes.length - 1];

  const rsi    = calcRSI(closes);
  const macd   = calcMACD(closes);
  const bb     = calcBollingerBands(closes);
  const maSumm = calcMASummary(closes, ltp);
  const stoch  = calcStochastic(candles);
  const willR  = calcWilliamsR(candles);
  const adxObj = calcADX(candles);
  const st     = calcSupertrend(candles);
  const atr    = calcATR(candles);
  const obv    = calcOBV(candles);
  const mfi    = calcMFI(candles);

  // Simple VWAP approximation (session avg using recent candles)
  const recentN = Math.min(candles.length, 78); // ~1 trading day of 5min candles
  const vwapCandles = candles.slice(-recentN);
  let sumTV = 0, sumV = 0;
  for (const c of vwapCandles) {
    const tp = (c.h + c.l + c.c) / 3;
    const v  = c.v || 1;
    sumTV += tp * v;
    sumV  += v;
  }
  const vwap     = sumV > 0 ? Math.round((sumTV / sumV) * 100) / 100 : ltp;
  const vwapDiff = Math.round(((ltp - vwap) / vwap) * 10000) / 100;

  // Tech score
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
  if (adxObj?.adx > 25 && adxObj?.diPlus > adxObj?.diMinus) score += 5;
  if (adxObj?.adx > 25 && adxObj?.diMinus > adxObj?.diPlus) score -= 5;
  if (st?.trend === "BULLISH") score += 5;
  if (st?.trend === "BEARISH") score -= 5;
  score = Math.max(0, Math.min(100, Math.round(score)));

  // Entry/SL/TP levels
  const atrVal  = atr || ltp * 0.015;
  const isBull  = score >= 50;
  const entry   = Math.round(ltp * 100) / 100;
  const sl      = isBull ? Math.round((ltp - 1.5 * atrVal) * 100) / 100
                         : Math.round((ltp + 1.5 * atrVal) * 100) / 100;
  const tp      = isBull ? Math.round((ltp + 3.0 * atrVal) * 100) / 100
                         : Math.round((ltp - 3.0 * atrVal) * 100) / 100;

  // Volume ratio (vs 20-candle avg)
  const volSlice   = candles.slice(-21);
  const avgVol     = volSlice.slice(0, 20).reduce((a, c) => a + (c.v || 0), 0) / 20;
  const latestVol  = volSlice[volSlice.length - 1]?.v || 0;
  const volRatio   = avgVol > 0 ? Math.round((latestVol / avgVol) * 100) / 100 : 1;

  const sig = score >= 60 ? (score >= 75 ? "STRONG BUY" : "BUY")
            : score <= 40 ? (score <= 25 ? "STRONG SELL" : "SELL") : "HOLD";

  return {
    symbol, ltp,
    signal: sig,
    strength: score,
    entry, sl, tp,
    emas: {
      ema5:   calcEMA(closes, 5),  ema9:   calcEMA(closes, 9),
      ema21:  calcEMA(closes, 21), ema50:  calcEMA(closes, 50),
      ema200: calcEMA(closes, 200),
    },
    rsi,
    stochastic: stoch ? { k: stoch.k, d: stoch.d } : null,
    williamsR: willR,
    macd,
    bollingerBands: bb,
    atr: atr ? Math.round(atr * 100) / 100 : null,
    adx: adxObj ? { adx: adxObj.adx, diPlus: adxObj.diPlus, diMinus: adxObj.diMinus } : null,
    supertrend: st ? { trend: st.trend, level: st.level } : null,
    obv,
    vwap, vwapDiff,
    mfi,
    volRatio,
    maSummary: maSumm,
    techScore: score,
    bias: score >= 60 ? "BULLISH" : score <= 40 ? "BEARISH" : "NEUTRAL",
    computedAt: Date.now(),
  };
}

// ── Historical candles — Upstox PRIMARY, NSE fallback ────────────────────────
// Returns [{o,h,l,c,v}] oldest-first
async function fetchCandles(symbol, days, interval) {
  const token    = getUpstoxToken();
  const instrKey = getInstrumentKey(symbol);

  if (!token) {
    console.warn(`📊 [${symbol}][${interval}] No Upstox token — cannot fetch intraday/historical candles`);
  }
  if (!instrKey) {
    console.warn(`📊 [${symbol}][${interval}] No instrument key — check instrumentMap loaded`);
  }

  // FIX: correct Upstox endpoint logic
  // Intraday intervals: 1minute,5minute,15minute,30minute,60minute
  // Daily+: day, week, month
  // 240minute (4H) = fetch 60minute then aggregate 4→1
  const isIntraday  = ["1minute","5minute","15minute","30minute","60minute"].includes(interval);
  const is4H        = interval === "240minute";
  const fetchInterval = is4H ? "60minute" : interval;
  const isIntradayFetch = is4H || isIntraday;

  if (token && instrKey) {
    try {
      const to   = new Date();
      const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const fmt  = d => d.toISOString().slice(0, 10);
      const enc  = encodeURIComponent(instrKey);

      // FIX: correct Upstox v2 URL format
      // Historical (day/week/month): /v2/historical-candle/{key}/{interval}/{to}/{from}
      // Intraday (minute intervals): /v2/historical-candle/intraday/{key}/{interval}
      //   (intraday only returns current session — for multi-day, use historical with minute interval)
      let url;
      if (isIntradayFetch) {
        // For intraday with date range, Upstox uses the same historical endpoint
        url = `https://api.upstox.com/v2/historical-candle/${enc}/${fetchInterval}/${fmt(to)}/${fmt(from)}`;
      } else {
        url = `https://api.upstox.com/v2/historical-candle/${enc}/${fetchInterval}/${fmt(to)}/${fmt(from)}`;
      }

      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        timeout: 12000,
      });

      // Upstox format: [timestamp, open, high, low, close, volume, oi] — newest first
      let raw = (res.data?.data?.candles || []);
      if (!Array.isArray(raw) || raw.length === 0) {
        console.warn(`📊 [${symbol}][${interval}] Upstox returned 0 candles`);
      } else {
        // Reverse to oldest-first
        raw = raw.slice().reverse();

        let candles = raw.map(c => ({
          o: parseFloat(c[1]), h: parseFloat(c[2]),
          l: parseFloat(c[3]), c: parseFloat(c[4]),
          v: parseFloat(c[5] || 0),
        })).filter(c => c.c > 0);

        // 4H aggregation: group every 4 1H candles
        if (is4H && candles.length >= 4) {
          const agg = [];
          for (let i = 0; i + 3 < candles.length; i += 4) {
            const grp = candles.slice(i, i + 4);
            agg.push({
              o: grp[0].o,
              h: Math.max(...grp.map(x => x.h)),
              l: Math.min(...grp.map(x => x.l)),
              c: grp[grp.length - 1].c,
              v: grp.reduce((s, x) => s + x.v, 0),
            });
          }
          candles = agg;
        }

        if (candles.length >= 20) {
          console.log(`📊 [${symbol}][${interval}] Upstox: ${candles.length} candles`);
          return candles;
        }
        console.warn(`📊 [${symbol}][${interval}] Only ${candles.length} candles after processing`);
      }
    } catch (e) {
      const status = e.response?.status;
      const msg    = e.response?.data?.message || e.message;
      console.warn(`📊 [${symbol}][${interval}] Upstox fetch failed [${status}]: ${msg}`);
      // 401 = token expired, 429 = rate limited, 400 = bad instrument key
      if (status === 401) console.warn("   ↳ Token expired — reconnect via /auth/upstox");
      if (status === 429) console.warn("   ↳ Rate limited — reduce PREWARM_BETWEEN");
      if (status === 400) console.warn("   ↳ Bad instrument key for:", symbol, instrKey);
    }
  }

  // FALLBACK: NSE daily-only (403s on cloud for intraday — can't help here)
  if (interval === "day") {
    await refreshNSECookie();
    try {
      const to   = new Date();
      const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const fmtD = d => `${String(d.getDate()).padStart(2,"0")}-${String(d.getMonth()+1).padStart(2,"0")}-${d.getFullYear()}`;
      const res  = await axios.get(
        `https://www.nseindia.com/api/historical/cm/equity?symbol=${encodeURIComponent(symbol)}&series=["EQ"]&from=${fmtD(from)}&to=${fmtD(to)}&csv=false`,
        { headers: { ...NSE_HEADERS, Cookie: nseCookie }, timeout: 15000 }
      );
      const data = (res.data?.data || []).reverse();
      return data.map(r => ({
        o: parseFloat(r.CH_OPENING_PRICE || r.open  || 0),
        h: parseFloat(r.CH_TRADE_HIGH_PRICE || r.high  || 0),
        l: parseFloat(r.CH_TRADE_LOW_PRICE  || r.low   || 0),
        c: parseFloat(r.CH_CLOSING_PRICE    || r.close || 0),
        v: parseFloat(r.CH_TOT_TRADED_QTY   || r.volume|| 0),
      })).filter(c => c.c > 0);
    } catch (e) {
      console.warn(`📊 [${symbol}] NSE daily fallback failed:`, e.message);
    }
  }

  return [];
}

// ── Get technicals for a specific timeframe (cache-first) ─────────────────────
async function getTechnicalsForTimeframe(symbol, timeframe = "1day") {
  const cfg      = TIMEFRAME_CONFIG[timeframe] || TIMEFRAME_CONFIG["1day"];
  const cacheKey = `${symbol}:${timeframe}`;
  const cached   = techCache.get(cacheKey);
  if (cached && Date.now() - cached.computedAt < cfg.ttl) return cached;

  const candles = await fetchCandles(symbol, cfg.days, cfg.interval);
  if (!candles || candles.length < 20) {
    console.warn(`📊 [${symbol}][${timeframe}] Not enough candles (${candles?.length || 0}) to compute technicals`);
    return null;
  }

  const result = computeTechnicals(symbol, candles);
  if (result) {
    result.timeframe = timeframe;
    techCache.set(cacheKey, result);
  }
  return result;
}

// ── Get technicals (cache-first) — defaults to 1day ───────────────────────────
async function getTechnicals(symbol) {
  return getTechnicalsForTimeframe(symbol, "1day");
}

// ── Background pre-warm ───────────────────────────────────────────────────────
async function preWarmTechCache(symbols) {
  if (!symbols.length) return;
  const token = getUpstoxToken();
  if (!token) {
    console.warn("📊 Pre-warm skipped — no Upstox token");
    return;
  }
  console.log(`📊 Pre-warming ${symbols.length} symbols (1day only)…`);
  let warmed = 0;
  for (const sym of symbols) {
    try {
      const cached = techCache.get(`${sym}:1day`);
      const cfg    = TIMEFRAME_CONFIG["1day"];
      if (cached && Date.now() - cached.computedAt < cfg.ttl) { warmed++; continue; }
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

    // Pre-warm top gainers + losers + large caps
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
      socket.emit("scanner-stocks", { stocks: stocks.slice(0, limit || 100), total: stocks.length });
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