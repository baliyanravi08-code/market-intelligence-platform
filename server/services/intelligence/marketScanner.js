"use strict";

/**
 * marketScanner.js
 * Location: server/services/intelligence/marketScanner.js
 *
 * MEMORY FIXES v4:
 *  1. techCache — capped at MAX_TECH_CACHE_SIZE (500 entries), LRU eviction
 *     Old: unlimited growth → 500 symbols × 7 TFs × 500 candles = hundreds of MB
 *  2. _candles in cache capped at 200 bars (was 500) — cuts RAM by 60%
 *  3. applyLiveTick — no longer re-sorts full allStocks array on every tick
 *     Old: O(n log n) sort on every WebSocket tick = CPU + GC pressure
 *     New: just updates the stock object in-place, deferred sort on next scan
 *  4. stockBySymbol — cleared before rebuild to release old references
 *  5. preWarmTechCache — only warms 1day timeframe (not all 7)
 *     Other TFs fetched on-demand when user requests them
 *  6. NSE cookie refresh — guarded with 20min TTL (was already there, kept)
 *  7. buildSymbolBucketMap — called once at startup only
 *  8. techCache eviction — when over limit, evict oldest-computedAt entries
 */

const axios = require("axios");
const path  = require("path");
const fs    = require("fs");

// ── Config ────────────────────────────────────────────────────────────────────
const MCAP_DB_PATH      = path.join(__dirname, "../../data/marketCapDB.json");
const SCAN_INTERVAL     = 5 * 60 * 1000;
const PREWARM_DELAY     = 8000;
const PREWARM_BETWEEN   = 350;
const MAX_TECH_CACHE    = 500;   // FIX: cap techCache entries
const MAX_CANDLES_STORE = 200;   // FIX: cap _candles per result (was 500)

// ── Timeframe config ──────────────────────────────────────────────────────────
const TIMEFRAME_CONFIG = {
  "5min":   { interval: "5minute",  days: 10,   candles: 200, ttl: 2  * 60 * 1000 },
  "15min":  { interval: "15minute", days: 30,   candles: 200, ttl: 5  * 60 * 1000 },
  "1hour":  { interval: "60minute", days: 60,   candles: 200, ttl: 10 * 60 * 1000 },
  "4hour":  { interval: "60minute", days: 120,  candles: 200, ttl: 15 * 60 * 1000 },
  "1day":   { interval: "day",      days: 365,  candles: 250, ttl: 15 * 60 * 1000 },
  "1week":  { interval: "week",     days: 730,  candles: 104, ttl: 30 * 60 * 1000 },
  "1month": { interval: "month",    days: 1825, candles: 60,  ttl: 60 * 60 * 1000 },
};

// ── NSE / BSE endpoints ───────────────────────────────────────────────────────
const NSE_BASE    = "https://www.nseindia.com";
const NSE_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept":          "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer":         "https://www.nseindia.com/market-data/live-equity-market",
  "Connection":      "keep-alive",
};
const BSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept":     "application/json, text/plain, */*",
  "Referer":    "https://www.bseindia.com",
  "Origin":     "https://www.bseindia.com",
};

const MCAP_BUCKETS = {
  largecap:  { label: "Large Cap"  },
  midcap:    { label: "Mid Cap"    },
  smallcap:  { label: "Small Cap"  },
  microcap:  { label: "Micro Cap"  },
};

// ── In-memory store ───────────────────────────────────────────────────────────
let scanCache = {
  gainers: [], losers: [], allStocks: [],
  byMcap: { largecap: [], midcap: [], smallcap: [], microcap: [] },
  bySector: [], updatedAt: 0,
  advancing: 0, declining: 0, unchanged: 0, totalCount: 0,
};

let stockBySymbol = new Map();
let techCache     = new Map();   // FIX: eviction applied in setTechCache()
let nseCookie     = "";
let lastCookieAt  = 0;
let ioRef         = null;
let preWarmTimer  = null;
let lastBacktestCapture = "";
let symbolBucketMap = {};
let _instrumentMap  = {};

// ── FIX: LRU-style techCache setter with size cap ─────────────────────────────
function setTechCache(key, value) {
  if (techCache.size >= MAX_TECH_CACHE) {
    // Evict oldest 50 entries by computedAt
    const entries = [...techCache.entries()]
      .sort((a, b) => (a[1].computedAt || 0) - (b[1].computedAt || 0))
      .slice(0, 50);
    for (const [k] of entries) techCache.delete(k);
  }
  techCache.set(key, value);
}

function setToken(t) {
  // proxy to indexCandleFetcher if needed — no-op here
}

function setInstrumentMap(map) {
  _instrumentMap = map;
  console.log(`📊 Scanner: instrument map loaded — ${Object.keys(map).length} symbols`);
}

function buildSymbolBucketMap() {
  try {
    if (!fs.existsSync(MCAP_DB_PATH)) return;
    const raw = fs.readFileSync(MCAP_DB_PATH, "utf8");
    if (!raw || !raw.trim()) return;
    const db = JSON.parse(raw);

    const KNOWN_LARGECAP = new Set([
      "RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK","SBIN","AXISBANK","KOTAKBANK",
      "LT","WIPRO","BAJFINANCE","BHARTIARTL","HINDUNILVR","NTPC","SUNPHARMA",
      "TATAMOTORS","TATASTEEL","MARUTI","TITAN","ITC","ADANIENT","ADANIPORTS",
      "HCLTECH","TECHM","ZOMATO","JSWSTEEL","HINDALCO","COALINDIA","DRREDDY",
      "CIPLA","EICHERMOT","HEROMOTOCO","BAJAJ-AUTO","BAJAJFINSV","NESTLEIND",
      "ASIANPAINT","BRITANNIA","TATACONSUM","SBILIFE","HDFCLIFE","HAL","BEL",
      "RECLTD","PFC","ULTRACEMCO","POWERGRID","ONGC","BPCL","GRASIM","DIVISLAB",
      "INDUSINDBK","SHREECEM","DABUR","PIDILITIND","BERGEPAINT","HAVELLS",
      "CHOLAFIN","MUTHOOTFIN","LICI","NHPC","IRCTC","IRFC","TRENT","VEDL",
      "ZYDUSLIFE","TORNTPHARM","LUPIN","AUROPHARMA","ABBOTINDIA","GLAXO",
      "MCDOWELL-N","TATAPOWER","ADANIGREEN","ADANITRANS","ADANIPOWER","AWL",
      "APOLLOHOSP","FORTIS","MAXHEALTH","METROPOLIS","LALPATHLAB",
      "PERSISTENT","COFORGE","MPHASIS","LTIM","LTTS","OFSS",
      "BANKBARODA","PNB","CANBK","UNIONBANK","IDFCFIRSTB","FEDERALBNK",
      "M&M","TVSMOTOR","ASHOKLEY","ESCORTS","BALKRISIND",
      "TATACHEM","DEEPAKNTR","AARTIIND","NAVINFLUOR",
      "DLF","GODREJPROP","OBEROIRLTY","PHOENIXLTD",
      "VOLTAS","WHIRLPOOL","BLUESTARCO","CROMPTON",
      "PAGEIND","ABFRL","VEDANT","MANYAVAR",
      "JUBLFOOD","DEVYANI","SAPPHIRE","WESTLIFE",
      "CONCOR","BLUEDART","GATI",
      "SIEMENS","ABB","CUMMINSIND","THERMAX","BHEL",
      "GLAND","DIVI","ALKEM","IPCALAB","NATCOPHARM",
      "SAIL","NMDC","HINDCOPPER","NATIONALUM",
      "MARICO","COLPAL","PGHH","EMAMILTD","JYOTHYLAB",
    ]);

    const KNOWN_MIDCAP = new Set([
      "EXIDEIND","JPPOWER","BALRAMCHIN","MOTHERSON","HEXT","TARIL",
      "360ONE","ECLERX","3MINDIA","AIAENG","APARINDS","ATUL","BASF",
      "BAYERCROP","BBTC","BIOCON","CAMLINFINE","CANFINHOME","CASTROLIND",
      "CESC","CHENNPETRO","CREDITACC","CRISIL","DCMSHRIRAM","EDELWEISS",
      "ELECON","ELGIEQUIP","ENGINERSIN","EPL","EQUITASBNK","ESABINDIA",
      "FINEORG","FLUOROCHEM","FORCEMOT","GESHIP","GLENMARK","GMRAIRPORT",
      "GRINDWELL","HATSUN","HEIDELBERG","HIMATSEIDE","HUDCO","IBREALEST",
      "IDBI","IIFL","INDHOTEL","INDIANB","INDIABULLS","INDIGO","INDUSTOWER",
      "JINDALSAW","JKCEMENT","JKLAKSHMI","JSWENERGY","JTEKTINDIA","JUBLINGREA",
      "KAJARIACER","KPIL","KRBL","KSB","LAXMIMACH","LINDEINDIA",
      "MAHLOG","MFSL","MHRIL","MIDHANI","MKPL","MNRINDIA","MOFSL",
      "MOTILALOFS","MRF","NBCC","NESCO","NETWORK18","NOCIL","NUVOCO",
      "OLECTRA","PNBHOUSING","POLYCAB","POLYMED","PRESTIGE","PRINCEPIPES",
      "RADICO","RAJESHEXPO","RAMCOCEM","RATNAMANI","RCF","REDINGTON",
      "RELAXO","RITES","RVNL","SAREGAMA","SCHAEFFLER","SEQUENT",
      "SHYAMMETL","SKFINDIA","SOLARINDS","SOMANYCERA","SRTRANSFIN",
      "STARCEMENT","SUMICHEM","SUPRAJIT","SUVENPHAR",
      "SYMPHONY","TANLA","TIINDIA","TIMKEN","TTKPRESTIG",
      "TVTODAY","UCOBANK","UJJIVAN","UNIONBANK","USHAMART",
      "VAIBHAVGBL","VGUARD","VHL","VINATIORGA","VMART","VSTIND",
      "WABCOINDIA","WELCORP","WELSPUNLIV","WONDERLA","YESBANK",
    ]);

    for (const [, entry] of Object.entries(db)) {
      const sym = (entry.symbol || "").toUpperCase();
      if (!sym) continue;
      if (KNOWN_LARGECAP.has(sym))    symbolBucketMap[sym] = "largecap";
      else if (KNOWN_MIDCAP.has(sym)) symbolBucketMap[sym] = "midcap";
      else {
        const lp = entry.lastPrice || 0;
        if (lp >= 2000)     symbolBucketMap[sym] = "midcap";
        else if (lp >= 500) symbolBucketMap[sym] = "smallcap";
        else                symbolBucketMap[sym] = "microcap";
      }
    }
    console.log(`📊 Symbol bucket map built: ${Object.keys(symbolBucketMap).length} symbols`);
  } catch (e) {
    console.warn("📊 Could not build symbol bucket map:", e.message);
  }
}

buildSymbolBucketMap();

function getMcapBucket(symbol, ltp, volume) {
  if (symbolBucketMap[symbol]) return symbolBucketMap[symbol];
  if (ltp >= 1000 && volume >= 500000)  return "largecap";
  if (ltp >= 500  && volume >= 200000)  return "largecap";
  if (ltp >= 200  && volume >= 1000000) return "largecap";
  if (ltp >= 500  && volume >= 50000)   return "midcap";
  if (ltp >= 100  && volume >= 200000)  return "midcap";
  if (ltp >= 50   && volume >= 10000)   return "smallcap";
  return "microcap";
}

function getUpstoxToken() {
  try {
    const { getAccessToken } = require("../upstoxStream");
    const t = getAccessToken();
    if (t) return t;
  } catch (_) {}
  return process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN || "";
}

function getInstrumentKey(symbol) {
  if (_instrumentMap[symbol]) return _instrumentMap[symbol];
  if (_instrumentMap[symbol?.toUpperCase()]) return _instrumentMap[symbol.toUpperCase()];

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
    "BAJAJ-AUTO": "NSE_EQ|INE917I01010", "BAJAJFINSV": "NSE_EQ|INE918I01026",
    "NESTLEIND":  "NSE_EQ|INE239A01016", "ASIANPAINT": "NSE_EQ|INE021A01026",
    "HAL":        "NSE_EQ|INE066F01020", "BEL":        "NSE_EQ|INE263A01024",
    "RECLTD":     "NSE_EQ|INE020B01018", "PFC":        "NSE_EQ|INE134E01011",
    "POLYCAB":    "NSE_EQ|INE455K01017", "PERSISTENT": "NSE_EQ|INE262H01021",
  };
  return FALLBACK[symbol] || FALLBACK[symbol?.toUpperCase()] || null;
}

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

async function fetchNSEMarketData() {
  await refreshNSECookie();

  const res = await axios.get(
    "https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%20500",
    { headers: { ...NSE_HEADERS, Cookie: nseCookie }, timeout: 15000 }
  );
  const nifty500 = (res.data?.data || []).map(s => ({ ...s, _exchange: "NSE" }));

  let extras = [];
  try {
    const [midRes, smRes] = await Promise.allSettled([
      axios.get("https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%20MIDCAP%20150",
        { headers: { ...NSE_HEADERS, Cookie: nseCookie }, timeout: 12000 }),
      axios.get("https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%20SMALLCAP%20250",
        { headers: { ...NSE_HEADERS, Cookie: nseCookie }, timeout: 12000 }),
    ]);
    if (midRes.status === "fulfilled") extras.push(...(midRes.value.data?.data || []).map(s => ({ ...s, _exchange: "NSE" })));
    if (smRes.status  === "fulfilled") extras.push(...(smRes.value.data?.data  || []).map(s => ({ ...s, _exchange: "NSE" })));
  } catch (_) {}

  const seen = new Set(nifty500.map(s => s.symbol));
  const all  = [...nifty500];
  for (const s of extras) {
    if (s.symbol && !seen.has(s.symbol)) { seen.add(s.symbol); all.push(s); }
  }
  return all;
}

async function fetchBSEMarketData() {
  try {
    const res = await axios.get(
      "https://api.bseindia.com/BseIndiaAPI/api/GetSensexData/w",
      { headers: BSE_HEADERS, timeout: 12000 }
    );
    const data = res.data?.Table || res.data?.data || [];
    return data.map(s => ({ ...s, _exchange: "BSE" }));
  } catch (e) {
    console.warn("📊 BSE GetSensexData failed:", e.message);
  }
  try {
    const res = await axios.get(
      "https://api.bseindia.com/BseIndiaAPI/api/liveMktData/w?Type=EQ&Grp=500",
      { headers: BSE_HEADERS, timeout: 12000 }
    );
    const data = res.data?.Table || res.data?.data || (Array.isArray(res.data) ? res.data : []);
    return data.map(s => ({ ...s, _exchange: "BSE" }));
  } catch (e2) {
    console.warn("📊 BSE 500 fallback also failed:", e2.message);
    return [];
  }
}

function normaliseNSE(s) {
  if (!s.symbol || !s.lastPrice) return null;
  const ltp       = parseFloat(s.lastPrice || 0);
  const changePct = parseFloat(s.pChange   || 0);
  const volume    = parseInt(s.totalTradedVolume || 0, 10);
  if (ltp <= 0) return null;
  return {
    symbol:     s.symbol,
    name:       s.meta?.companyName || s.symbol,
    ltp, changePct, volume,
    change:     parseFloat(s.change   || 0),
    open:       parseFloat(s.open     || 0),
    high:       parseFloat(s.dayHigh  || 0),
    low:        parseFloat(s.dayLow   || 0),
    prevClose:  parseFloat(s.previousClose || 0),
    totalValue: parseFloat(s.totalTradedValue || 0),
    yearHigh:   parseFloat(s.yearHigh || 0),
    yearLow:    parseFloat(s.yearLow  || 0),
    sector:     s.meta?.industry || "",
    exchange:   "NSE",
  };
}

function normaliseBSE(s) {
  const symbol =
    s.NSE_Symbol || s.NseSymbol || s.nseSymbol ||
    s.scrip_id   || s.Scrip_Id  || s.SCRIP_ID  || null;
  const name   = s.Scrip_Name || s.LONG_NAME || s.CompanyName || s.name || symbol || "";
  const ltp    = parseFloat(s.LTP || s.CurrentValue || s.Close || s.lastPrice || 0);
  if (!ltp || ltp <= 0 || !symbol) return null;
  const prevClose = parseFloat(s.PrevClose || s.PreviousClose || s.ClosePrice || ltp);
  const change    = ltp - prevClose;
  const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;
  const volume    = parseInt(s.TotalVolume || s.Volume || s.TotalTradedVolume || 0, 10);
  return {
    symbol: symbol.toUpperCase(), name, ltp, volume,
    change:     Math.round(change * 100) / 100,
    changePct:  Math.round(changePct * 100) / 100,
    open:       parseFloat(s.Open || s.OpenValue || ltp),
    high:       parseFloat(s.High || s.DayHigh   || ltp),
    low:        parseFloat(s.Low  || s.DayLow    || ltp),
    prevClose,
    totalValue: parseFloat(s.TotalTurnover || s.Turnover || 0),
    yearHigh:   parseFloat(s["52WeekHigh"] || s.YearHigh || 0),
    yearLow:    parseFloat(s["52WeekLow"]  || s.YearLow  || 0),
    sector:     s.Industry || s.Sector || s.industry || "",
    exchange:   "BSE",
  };
}

// ── FIX: applyLiveTick — no more full-array sort on every tick ────────────────
// Old: re-sorted entire allStocks (600+ items) on every WebSocket message
// New: just mutate the stock object in-place; scanner rebuild handles sort
function applyLiveTick({ symbol, price, changePct, change }) {
  if (!symbol || !price) return;
  const stock = stockBySymbol.get(symbol);
  if (!stock) return;
  stock.ltp = price;
  if (changePct != null) stock.changePct = changePct;
  if (change    != null) stock.change    = change;
  // No sort here — O(n log n) on every tick was burning CPU and triggering GC
}

// ══════════════════════════════════════════════════════════════════════════════
// ── SIGNAL FILTER SYSTEM ──────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

function passesLiquidityGate(tech, stock) {
  const price  = tech.ltp || stock?.ltp || 0;
  const volume = stock?.volume || 0;
  if (price  < 20)     return { pass: false, reason: `Price ₹${price} < ₹20 (penny)` };
  if (volume < 200000) return { pass: false, reason: `Volume ${volume} < 2L (illiquid)` };
  return { pass: true };
}

function passesTrendFilter(tech, signalType) {
  const isBuy  = !["SELL", "STRONG SELL", "STRONG_SELL"].includes(signalType);
  const ltp    = tech.ltp || 0;
  const ema20  = tech.emas?.ema21 || null;
  const ema50  = tech.emas?.ema50 || null;
  const adx    = tech.adx?.adx   || 0;

  if (adx > 0 && adx < 20) {
    return { pass: false, reason: `ADX ${adx.toFixed(1)} < 20 (ranging/sideways)` };
  }
  if (ema20 && ema50) {
    if (isBuy  && !(ltp > ema20 && ema20 > ema50)) {
      return { pass: false, reason: `BUY but price ${ltp} not in uptrend (EMA20:${ema20} EMA50:${ema50})` };
    }
    if (!isBuy && !(ltp < ema20 && ema20 < ema50)) {
      return { pass: false, reason: `SELL but price ${ltp} not in downtrend (EMA20:${ema20} EMA50:${ema50})` };
    }
  }
  return { pass: true };
}

function passesConsensusFilter(tech, signalType) {
  const isBuy = !["SELL", "STRONG SELL", "STRONG_SELL"].includes(signalType);
  const rsi   = tech.rsi;
  const macd  = tech.macd?.crossover || "NEUTRAL";

  if (rsi != null) {
    if (isBuy) {
      if (rsi < 38) return { pass: false, reason: `BUY but RSI ${rsi} < 38 — oversold panic` };
      if (rsi > 72) return { pass: false, reason: `BUY but RSI ${rsi} > 72 — already overbought` };
    } else {
      if (rsi > 62) return { pass: false, reason: `SELL but RSI ${rsi} > 62 — overbought, may bounce` };
      if (rsi < 28) return { pass: false, reason: `SELL but RSI ${rsi} < 28 — already oversold` };
    }
  }
  if (macd !== "NEUTRAL") {
    if (isBuy  && macd === "BEARISH") return { pass: false, reason: `BUY signal but MACD is BEARISH` };
    if (!isBuy && macd === "BULLISH") return { pass: false, reason: `SELL signal but MACD is BULLISH` };
  }
  return { pass: true };
}

function passesVolumeConfirmation(tech) {
  const volRatio = tech.volRatio || 0;
  if (volRatio === 0 || volRatio === 1) return { pass: true };
  if (volRatio < 1.2) {
    return { pass: false, reason: `Volume ratio ${volRatio}× < 1.2× avg — no conviction` };
  }
  return { pass: true };
}

function passesRRGate(entry, target, stopLoss) {
  if (!entry || !target || !stopLoss) return { pass: true };
  const reward = Math.abs(target - entry);
  const risk   = Math.abs(entry  - stopLoss);
  if (risk === 0) return { pass: true };
  const rr = reward / risk;
  if (rr < 1.5) {
    return { pass: false, reason: `R:R ${rr.toFixed(2)} < 1.5 — reward doesn't justify risk` };
  }
  return { pass: true };
}

function applyAllFilters(tech, stock, signalType) {
  const checks = [
    { n: 1, label: "Liquidity", fn: () => passesLiquidityGate(tech, stock)              },
    { n: 2, label: "Trend",     fn: () => passesTrendFilter(tech, signalType)            },
    { n: 3, label: "Consensus", fn: () => passesConsensusFilter(tech, signalType)        },
    { n: 4, label: "Volume",    fn: () => passesVolumeConfirmation(tech)                 },
    { n: 5, label: "R:R",       fn: () => passesRRGate(tech.entry, tech.target, tech.sl) },
  ];
  for (const { n, label, fn } of checks) {
    const result = fn();
    if (!result.pass) {
      return { pass: false, failedFilter: n, filterLabel: label, reason: result.reason };
    }
  }
  return { pass: true };
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Technical calculations ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

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
    const k     = high === low ? 50 : Math.round(((close - low) / (high - low)) * 10000) / 100;
    kValues.push(k);
  }
  const kLast  = kValues[kValues.length - 1];
  const dSlice = kValues.slice(-dPeriod);
  const dLast  = Math.round((dSlice.reduce((a, b) => a + b, 0) / dPeriod) * 100) / 100;
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
  const dmPlus = [], dmMinus = [], trs = [];
  for (let i = 1; i < candles.length; i++) {
    const upMove   = candles[i].h - candles[i - 1].h;
    const downMove = candles[i - 1].l - candles[i].l;
    dmPlus.push(upMove   > downMove && upMove   > 0 ? upMove   : 0);
    dmMinus.push(downMove > upMove  && downMove > 0 ? downMove : 0);
    const h = candles[i].h, l = candles[i].l, pc = candles[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const smooth = (arr) => {
    let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = period; i < arr.length; i++) { s = s - s / period + arr[i]; out.push(s); }
    return out;
  };
  const sTR  = smooth(trs);
  const sDMP = smooth(dmPlus);
  const sDMM = smooth(dmMinus);
  const diPlus  = sTR.map((v, i) => v > 0 ? Math.round((sDMP[i] / v) * 10000) / 100 : 0);
  const diMinus = sTR.map((v, i) => v > 0 ? Math.round((sDMM[i] / v) * 10000) / 100 : 0);
  const dx      = diPlus.map((p, i) => { const m = diMinus[i], s = p + m; return s > 0 ? Math.abs(p - m) / s * 100 : 0; });
  const adxSlice = dx.slice(-period);
  const adx = Math.round((adxSlice.reduce((a, b) => a + b, 0) / period) * 100) / 100;
  return { adx, diPlus: Math.round(diPlus[diPlus.length - 1] * 100) / 100, diMinus: Math.round(diMinus[diMinus.length - 1] * 100) / 100 };
}
function calcSupertrend(candles, period = 10, multiplier = 3) {
  if (!candles || candles.length < period + 5) return null;
  const atr = calcATR(candles, period);
  if (!atr) return null;
  const last  = candles[candles.length - 1];
  const hl2   = (last.h + last.l) / 2;
  const upper = Math.round((hl2 + multiplier * atr) * 100) / 100;
  const lower = Math.round((hl2 - multiplier * atr) * 100) / 100;
  const trend = last.c > lower ? "BULLISH" : last.c < upper ? "BEARISH" : "NEUTRAL";
  const level = trend === "BULLISH" ? lower : upper;
  return { trend, level: Math.round(level * 100) / 100, atr };
}
function calcOBV(candles) {
  if (!candles || candles.length < 10) return null;
  let obv = 0;
  const obvValues = [0];
  for (let i = 1; i < candles.length; i++) {
    const vol = candles[i].v || 0;
    if (candles[i].c > candles[i - 1].c)      obv += vol;
    else if (candles[i].c < candles[i - 1].c) obv -= vol;
    obvValues.push(obv);
  }
  const recent     = obvValues.slice(-20);
  const first10avg = recent.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
  const last10avg  = recent.slice(10).reduce((a, b) => a + b, 0) / 10;
  const diff       = last10avg - first10avg;
  if (Math.abs(diff) < Math.abs(first10avg) * 0.01) return "Flat";
  if (diff > Math.abs(first10avg) * 0.05)           return "Strongly Rising";
  if (diff > 0)                                     return "Rising";
  if (diff < -Math.abs(first10avg) * 0.05)          return "Strongly Falling";
  return "Falling";
}
function calcMFI(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const slice = candles.slice(-(period + 1));
  let posFlow = 0, negFlow = 0;
  for (let i = 1; i < slice.length; i++) {
    const tp     = (slice[i].h + slice[i].l + slice[i].c) / 3;
    const prevTP = (slice[i - 1].h + slice[i - 1].l + slice[i - 1].c) / 3;
    const mf     = tp * (slice[i].v || 1);
    if (tp > prevTP) posFlow += mf; else negFlow += mf;
  }
  if (negFlow === 0) return 100;
  return Math.round((100 - 100 / (1 + posFlow / negFlow)) * 100) / 100;
}
function calcMASummary(closes, ltp) {
  const mas = {
    ema5:  calcEMA(closes, 5),   ema9:   calcEMA(closes, 9),
    ema21: calcEMA(closes, 21),  ema50:  calcEMA(closes, 50),  ema200: calcEMA(closes, 200),
    sma10: calcSMA(closes, 10),  sma20:  calcSMA(closes, 20),
    sma50: calcSMA(closes, 50),  sma100: calcSMA(closes, 100), sma200: calcSMA(closes, 200),
  };
  let buy = 0, sell = 0, neutral = 0;
  for (const v of Object.values(mas)) {
    if (!v)                   neutral++;
    else if (ltp > v * 1.001) buy++;
    else if (ltp < v * 0.999) sell++;
    else                      neutral++;
  }
  const summary =
    buy  > sell + 2 ? "STRONG BUY"  : buy  > sell ? "BUY"  :
    sell > buy  + 2 ? "STRONG SELL" : sell > buy  ? "SELL" : "NEUTRAL";
  return { buy, sell, neutral, total: buy + sell + neutral, summary, emas: mas };
}

function computeTechnicals(symbol, candles) {
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

  const recentN   = Math.min(candles.length, 78);
  const vwapSlice = candles.slice(-recentN);
  let sumTV = 0, sumV = 0;
  for (const c of vwapSlice) {
    const tp = (c.h + c.l + c.c) / 3;
    const v  = c.v || 1;
    sumTV += tp * v;
    sumV  += v;
  }
  const vwap     = sumV > 0 ? Math.round((sumTV / sumV) * 100) / 100 : ltp;
  const vwapDiff = Math.round(((ltp - vwap) / vwap) * 10000) / 100;

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
  if (adxObj?.adx > 25 && adxObj?.diPlus  > adxObj?.diMinus) score += 5;
  if (adxObj?.adx > 25 && adxObj?.diMinus > adxObj?.diPlus)  score -= 5;
  if (st?.trend === "BULLISH") score += 5;
  if (st?.trend === "BEARISH") score -= 5;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const atrVal    = atr || ltp * 0.015;
  const isBull    = score >= 50;
  const todayOpen = candles[candles.length - 1]?.o || ltp;
  const entry     = Math.round(todayOpen * 100) / 100;

  const sl  = isBull
    ? Math.round((entry - 1.5 * atrVal) * 100) / 100
    : Math.round((entry + 1.5 * atrVal) * 100) / 100;
  const tp2 = isBull
    ? Math.round((entry + 3.0 * atrVal) * 100) / 100
    : Math.round((entry - 3.0 * atrVal) * 100) / 100;

  const volSlice  = candles.slice(-21);
  const avgVol    = volSlice.slice(0, 20).reduce((a, c) => a + (c.v || 0), 0) / 20;
  const latestVol = volSlice[volSlice.length - 1]?.v || 0;
  const volRatio  = avgVol > 0 ? Math.round((latestVol / avgVol) * 100) / 100 : 1;

  const sig =
    score >= 60 ? (score >= 75 ? "STRONG BUY"  : "BUY") :
    score <= 40 ? (score <= 25 ? "STRONG SELL" : "SELL") : "HOLD";

  return {
    symbol, ltp,
    signal: sig,
    strength: score,
    entry, sl, tp: tp2,
    target:    tp2,
    stopLoss:  sl,
    price:     entry,
    techScore: score,
    emas: maSumm.emas || {
      ema5:  calcEMA(closes, 5),  ema9:  calcEMA(closes, 9),
      ema21: calcEMA(closes, 21), ema50: calcEMA(closes, 50), ema200: calcEMA(closes, 200),
    },
    rsi,
    stochastic:     stoch ? { k: stoch.k, d: stoch.d } : null,
    williamsR:      willR,
    macd,
    bollingerBands: bb,
    atr:            atr ? Math.round(atr * 100) / 100 : null,
    adx:            adxObj ? { adx: adxObj.adx, diPlus: adxObj.diPlus, diMinus: adxObj.diMinus } : null,
    supertrend:     st ? { trend: st.trend, level: st.level } : null,
    obv,
    vwap, vwapDiff,
    mfi,
    volRatio,
    maSummary:  maSumm,
    bias:       score >= 60 ? "BULLISH" : score <= 40 ? "BEARISH" : "NEUTRAL",
    computedAt: Date.now(),
  };
}

// ── NSE intraday candles ──────────────────────────────────────────────────────
async function fetchNSEIntraday(symbol) {
  await refreshNSECookie();

  try {
    const url = `https://www.nseindia.com/api/chartData?symbol=${encodeURIComponent(symbol)}&type=EQ`;
    const res = await axios.get(url, {
      headers: { ...NSE_HEADERS, Cookie: nseCookie },
      timeout: 12000,
    });

    const raw = res.data?.grapthData || res.data?.graphData || res.data?.data || [];
    if (!Array.isArray(raw) || raw.length < 5) {
      throw new Error(`chartData returned ${raw.length} rows`);
    }

    const isOHLC = Array.isArray(raw[0]) && raw[0].length >= 5;
    const candles = [];

    for (let i = 0; i < raw.length; i++) {
      if (isOHLC) {
        const [ts, o, h, l, c] = raw[i];
        const close = parseFloat(c);
        if (!close || close <= 0) continue;
        candles.push({ ts, o: parseFloat(o), h: parseFloat(h), l: parseFloat(l), c: close, v: 0 });
      } else {
        const [ts, closeRaw] = raw[i];
        const close = parseFloat(closeRaw);
        if (!close || close <= 0) continue;
        const prev = i > 0 ? (parseFloat(raw[i - 1][1]) || close) : close;
        const next = i < raw.length - 1 ? (parseFloat(raw[i + 1][1]) || close) : close;
        candles.push({ ts, o: prev, h: Math.max(close, prev, next), l: Math.min(close, prev, next), c: close, v: 0 });
      }
    }

    if (candles.length >= 5) {
      console.log(`📊 [${symbol}] NSE chartData: ${candles.length} intraday candles`);
      return candles;
    }
    throw new Error(`Only ${candles.length} valid candles after parse`);
  } catch (e) {
    console.warn(`📊 [${symbol}] NSE chartData failed: ${e.message}`);
  }

  try {
    const res = await axios.get(
      `https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(symbol)}`,
      { headers: { ...NSE_HEADERS, Cookie: nseCookie }, timeout: 10000 }
    );
    const d = res.data?.priceInfo || res.data;
    if (d?.lastPrice) {
      const c = parseFloat(d.lastPrice);
      const o = parseFloat(d.open || c);
      const h = parseFloat(d.intraDayHighLow?.max || d.high || c);
      const l = parseFloat(d.intraDayHighLow?.min || d.low  || c);
      return [{ o, h, l, c, v: 0 }];
    }
  } catch (_) {}

  return [];
}

function resampleCandles(candles1min, targetMinutes) {
  if (!candles1min.length) return [];
  const buckets = [];
  let bucket    = null;
  let count     = 0;

  for (const c of candles1min) {
    if (!bucket) {
      bucket = { o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0 };
      count  = 1;
    } else {
      bucket.h  = Math.max(bucket.h, c.h);
      bucket.l  = Math.min(bucket.l, c.l);
      bucket.c  = c.c;
      bucket.v += (c.v || 0);
      count++;
    }
    if (count >= targetMinutes) {
      buckets.push({ ...bucket });
      bucket = null;
      count  = 0;
    }
  }
  if (bucket && count >= Math.floor(targetMinutes / 2)) buckets.push(bucket);
  return buckets;
}

async function fetchCandles(symbol, days, interval) {
  const token      = getUpstoxToken();
  const instrKey   = getInstrumentKey(symbol);
  const is4H       = interval === "240minute";
  const isIntraday = ["5minute", "15minute", "60minute", "240minute"].includes(interval);

  // ── ATTEMPT 1: Upstox API ──────────────────────────────────────────────────
  if (token && instrKey) {
    try {
      const to     = new Date();
      const from   = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const fmtD   = d => d.toISOString().slice(0, 10);
      const enc    = encodeURIComponent(instrKey);
      const upstoxInterval = is4H ? "60minute" : interval;

      // FIX: Use days <= 1 to decide endpoint, NOT date comparison.
      const useIntradayEndpoint = isIntraday && days <= 1;
      let url;
      if (useIntradayEndpoint) {
        url = `https://api.upstox.com/v2/historical-candle/intraday/${enc}/${upstoxInterval}`;
      } else {
        url = `https://api.upstox.com/v2/historical-candle/${enc}/${upstoxInterval}/${fmtD(to)}/${fmtD(from)}`;
      }

      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        timeout: 12000,
      });

      let raw = res.data?.data?.candles || [];
      if (Array.isArray(raw) && raw.length > 0) {
        if (!useIntradayEndpoint) raw = raw.slice().reverse();

        let candles = raw.map(c => ({
          o: parseFloat(c[1]), h: parseFloat(c[2]),
          l: parseFloat(c[3]), c: parseFloat(c[4]),
          v: parseFloat(c[5] || 0),
        })).filter(c => c.c > 0);

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

        if (candles.length >= 5) {
          console.log(`📊 [${symbol}][${interval}] Upstox: ${candles.length} candles`);
          return candles;
        }
      }
    } catch (e) {
      console.warn(`📊 [${symbol}][${interval}] Upstox failed [${e.response?.status}]: ${e.response?.data?.message || e.message}`);
    }
  }

  // ── ATTEMPT 2: NSE intraday fallback ──────────────────────────────────────
  if (isIntraday) {
    try {
      console.log(`📊 [${symbol}][${interval}] trying NSE intraday fallback`);
      const rawCandles = await fetchNSEIntraday(symbol);

      if (rawCandles.length >= 5) {
        let candles;
        if      (interval === "5minute")   candles = resampleCandles(rawCandles, 5);
        else if (interval === "15minute")  candles = resampleCandles(rawCandles, 15);
        else if (interval === "60minute")  candles = resampleCandles(rawCandles, 60);
        else if (interval === "240minute") candles = resampleCandles(rawCandles, 240);
        else                               candles = rawCandles;

        if (candles && candles.length >= 5) {
          console.log(`📊 [${symbol}][${interval}] NSE fallback: ${candles.length} candles`);
          return candles;
        }
      }
    } catch (e) {
      console.warn(`📊 [${symbol}] NSE intraday fallback failed:`, e.message);
    }

    try {
      console.log(`📊 [${symbol}][${interval}] Trying synthetic from daily data`);
      const to   = new Date();
      const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const fmtD = d => `${String(d.getDate()).padStart(2,"0")}-${String(d.getMonth()+1).padStart(2,"0")}-${d.getFullYear()}`;
      await refreshNSECookie();
      const res = await axios.get(
        `https://www.nseindia.com/api/historical/cm/equity?symbol=${encodeURIComponent(symbol)}&series=["EQ"]&from=${fmtD(from)}&to=${fmtD(to)}&csv=false`,
        { headers: { ...NSE_HEADERS, Cookie: nseCookie }, timeout: 15000 }
      );
      const data = (res.data?.data || []).slice().reverse();
      const daily = data.map(r => ({
        o: parseFloat(r.CH_OPENING_PRICE    || 0),
        h: parseFloat(r.CH_TRADE_HIGH_PRICE || 0),
        l: parseFloat(r.CH_TRADE_LOW_PRICE  || 0),
        c: parseFloat(r.CH_CLOSING_PRICE    || 0),
        v: parseFloat(r.CH_TOT_TRADED_QTY   || 0),
      })).filter(c => c.c > 0);

      if (daily.length >= 5) {
        console.log(`📊 [${symbol}][${interval}] Synthetic from ${daily.length} daily candles`);
        return daily;
      }
    } catch (e) {
      console.warn(`📊 [${symbol}] Synthetic intraday fallback failed:`, e.message);
    }

    return [];
  }

  // ── ATTEMPT 2b: NSE daily ─────────────────────────────────────────────────
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
      const data = (res.data?.data || []).slice().reverse();
      const candles = data.map(r => ({
        o: parseFloat(r.CH_OPENING_PRICE    || r.open   || 0),
        h: parseFloat(r.CH_TRADE_HIGH_PRICE || r.high   || 0),
        l: parseFloat(r.CH_TRADE_LOW_PRICE  || r.low    || 0),
        c: parseFloat(r.CH_CLOSING_PRICE    || r.close  || 0),
        v: parseFloat(r.CH_TOT_TRADED_QTY   || r.volume || 0),
      })).filter(c => c.c > 0);
      if (candles.length >= 20) return candles;
    } catch (e) {
      console.warn(`📊 [${symbol}] NSE daily fallback failed:`, e.message);
    }
  }

  // ── ATTEMPT 2c: NSE weekly/monthly ───────────────────────────────────────
  if (interval === "week" || interval === "month") {
    await refreshNSECookie();
    try {
      const to   = new Date();
      const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const fmtD = d => `${String(d.getDate()).padStart(2,"0")}-${String(d.getMonth()+1).padStart(2,"0")}-${d.getFullYear()}`;
      const res  = await axios.get(
        `https://www.nseindia.com/api/historical/cm/equity?symbol=${encodeURIComponent(symbol)}&series=["EQ"]&from=${fmtD(from)}&to=${fmtD(to)}&csv=false`,
        { headers: { ...NSE_HEADERS, Cookie: nseCookie }, timeout: 15000 }
      );
      const data = (res.data?.data || []).slice().reverse();
      const daily = data.map(r => ({
        o: parseFloat(r.CH_OPENING_PRICE    || 0),
        h: parseFloat(r.CH_TRADE_HIGH_PRICE || 0),
        l: parseFloat(r.CH_TRADE_LOW_PRICE  || 0),
        c: parseFloat(r.CH_CLOSING_PRICE    || 0),
        v: parseFloat(r.CH_TOT_TRADED_QTY   || 0),
      })).filter(c => c.c > 0);
      if (daily.length >= 5) return daily;
    } catch (e) {
      console.warn(`📊 [${symbol}] NSE weekly/monthly fallback failed:`, e.message);
    }
  }

  return [];
}

// ── Timeframe → seconds per bar ───────────────────────────────────────────────
const TF_SECONDS = {
  "5min":   5   * 60,
  "15min":  15  * 60,
  "1hour":  60  * 60,
  "4hour":  4   * 60 * 60,
  "1day":   24  * 60 * 60,
  "1week":  7   * 24 * 60 * 60,
  "1month": 30  * 24 * 60 * 60,
};

async function getTechnicalsForTimeframe(symbol, timeframe = "1day") {
  const cfg      = TIMEFRAME_CONFIG[timeframe] || TIMEFRAME_CONFIG["1day"];
  const cacheKey = `${symbol}:${timeframe}`;
  const cached   = techCache.get(cacheKey);
  if (cached && Date.now() - cached.computedAt < cfg.ttl) return cached;

  const candles = await fetchCandles(symbol, cfg.days, cfg.interval);
  if (!candles || candles.length < 20) return null;

  const result = computeTechnicals(symbol, candles);
  if (result) {
    result.timeframe = timeframe;

    const tfSecs     = TF_SECONDS[timeframe] || TF_SECONDS["1day"];
    const nowSecs    = Math.floor(Date.now() / 1000);
    const alignedNow = Math.floor(nowSecs / tfSecs) * tfSecs;

    // FIX: cap _candles at MAX_CANDLES_STORE (200) instead of 500
    // 500 candles × 500 symbols × ~200 bytes each = ~50MB just for _candles
    const slice = candles.slice(-MAX_CANDLES_STORE);

    result._candles = slice.map((c, i) => ({
      time:   alignedNow - (slice.length - 1 - i) * tfSecs,
      open:   c.o,
      high:   c.h,
      low:    c.l,
      close:  c.c,
      volume: c.v || 0,
    }));

    // FIX: use setTechCache (with eviction) instead of techCache.set directly
    setTechCache(cacheKey, result);
  }
  return result;
}

async function getTechnicals(symbol) {
  return getTechnicalsForTimeframe(symbol, "1day");
}

// FIX: preWarmTechCache — only warms 1day, not all 7 timeframes
// Old: 500 symbols × 7 TFs = 3500 Upstox API calls at startup → huge RAM + rate limits
// New: 1day only at startup; other TFs fetched on-demand when client requests them
async function preWarmTechCache(symbols) {
  if (!symbols || !symbols.length) return;
  const token = getUpstoxToken();
  if (!token) { console.warn("📊 Pre-warm skipped — no Upstox token"); return; }
  console.log(`📊 Pre-warming ${symbols.length} symbols (1day only)…`);
  const BATCH_EMIT_SIZE = 10;
  let batch  = [];
  let warmed = 0;

  for (const sym of symbols) {
    try {
      const cfg      = TIMEFRAME_CONFIG["1day"];
      const cacheKey = `${sym}:1day`;
      let result     = techCache.get(cacheKey);
      if (!result || Date.now() - result.computedAt >= cfg.ttl) {
        result = await getTechnicals(sym);
      }
      if (result) {
        batch.push({ key: cacheKey, data: result });
        warmed++;

        const stock = stockBySymbol.get(sym);
        if (stock && result._candles?.length >= 2) {
          const last = result._candles[result._candles.length - 1];
          const prev = result._candles[result._candles.length - 2];
          if (last && prev && prev.close > 0) {
            stock.ltp       = last.close;
            stock.changePct = Math.round(((last.close - prev.close) / prev.close) * 10000) / 100;
            stock.change    = Math.round((last.close  - prev.close) * 100) / 100;
            stock.prevClose = prev.close;
          }
        }
      }
      if (batch.length >= BATCH_EMIT_SIZE) {
        if (ioRef) ioRef.emit("scanner-tech-batch", batch);
        batch = [];
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, PREWARM_BETWEEN));
  }
  if (batch.length > 0 && ioRef) ioRef.emit("scanner-tech-batch", batch);
  console.log(`📊 Pre-warm done: ${warmed}/${symbols.length} | techCache size: ${techCache.size}`);
}

function buildPayload(cache) {
  return {
    gainers:   cache.gainers  || [],
    losers:    cache.losers   || [],
    allStocks: (cache.allStocks || []).slice(0, 600),
    byMcap: {
      largecap:  (cache.byMcap?.largecap  || []).slice(0, 100),
      midcap:    (cache.byMcap?.midcap    || []).slice(0, 100),
      smallcap:  (cache.byMcap?.smallcap  || []).slice(0, 100),
      microcap:  (cache.byMcap?.microcap  || []).slice(0, 100),
    },
    bySector:  cache.bySector || [],
    market: {
      advancing: cache.advancing  || 0,
      declining: cache.declining  || 0,
      unchanged: cache.unchanged  || 0,
      total:     cache.totalCount || 0,
    },
    updatedAt: cache.updatedAt,
  };
}

function tryBacktestCapture(stocks) {
  try {
    const backtestEngine = require("../backtestEngine");
    const { subscribeStocksForBacktest } = require("../upstoxStream");

    const now  = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const h    = now.getHours(), m = now.getMinutes();
    const mins = h * 60 + m;
    const isCaptureWindow = mins >= 555 && mins <= 920;

    if (!isCaptureWindow) return;

    const today    = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const todayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
    if (lastBacktestCapture === todayKey) return;

    const signals  = [];
    const rejected = { f1: 0, f2: 0, f3: 0, f4: 0, f5: 0, hold: 0 };

    for (const stock of stocks) {
      const cacheKey = `${stock.symbol}:1day`;
      const tech     = techCache.get(cacheKey);
      if (!tech) continue;

      if (tech.signal === "HOLD") { rejected.hold++; continue; }

      const filterResult = applyAllFilters(tech, stock, tech.signal);
      if (!filterResult.pass) {
        rejected[`f${filterResult.failedFilter}`]++;
        continue;
      }

      signals.push({
        symbol:    stock.symbol,
        sector:    stock.sector || tech.sector || "Unknown",
        signal:    tech.signal,
        price:     tech.ltp || stock.ltp,
        target:    tech.tp  || tech.target,
        stopLoss:  tech.sl  || tech.stopLoss,
        rsi:       tech.rsi,
        techScore: tech.techScore || tech.strength,
        macd:      tech.macd,
        volRatio:  tech.volRatio,
        adx:       tech.adx?.adx,
        isSwing:   false,
      });
    }

    console.log(`📊 Filter — HOLD:${rejected.hold} F1:${rejected.f1} F2:${rejected.f2} F3:${rejected.f3} F4:${rejected.f4} F5:${rejected.f5} PASSED:${signals.length}`);

    if (!signals.length) return;

    const result = backtestEngine.captureSession(signals);
    if (result.success) {
      lastBacktestCapture = todayKey;
      console.log(`✅ Backtest captured: ${signals.length} filtered signals`);
      subscribeStocksForBacktest(signals.map(s => s.symbol));
    }
  } catch (e) {
    console.warn("📊 Backtest auto-capture skipped:", e.message);
  }
}

async function runScanner() {
  try {
    console.log("📊 Scanner: running…");

    let nseRaw = [];
    try {
      nseRaw = await fetchNSEMarketData();
      console.log(`📊 NSE: ${nseRaw.length} raw records`);
    } catch (e) { console.warn("📊 NSE 500 fetch failed —", e.message); }

    let bseRaw = [];
    try {
      bseRaw = await fetchBSEMarketData();
      console.log(`📊 BSE: ${bseRaw.length} raw records`);
    } catch (e) { console.warn("📊 BSE fetch failed —", e.message); }

    const nseStocks  = nseRaw.map(normaliseNSE).filter(Boolean);
    const nseSymbols = new Set(nseStocks.map(s => s.symbol));
    const bseStocks  = bseRaw.map(normaliseBSE).filter(Boolean).filter(s => !nseSymbols.has(s.symbol));

    let stocks = [...nseStocks, ...bseStocks];
    if (!stocks.length) { console.warn("📊 No stocks — skipping"); return; }

    stocks = stocks.map(s => {
      const bucket = getMcapBucket(s.symbol, s.ltp, s.volume);
      return { ...s, mcapBucket: bucket, mcapLabel: MCAP_BUCKETS[bucket]?.label || "Micro Cap" };
    });

    // FIX: clear old map before rebuild so old stock objects are GC-eligible
    stockBySymbol.clear();
    for (const s of stocks) stockBySymbol.set(s.symbol, s);

    const sorted  = [...stocks].sort((a, b) => b.changePct - a.changePct);
    const gainers = sorted.filter(s => s.changePct > 0).slice(0, 20);
    const losers  = [...sorted].reverse().filter(s => s.changePct < 0).slice(0, 20);

    const byMcap = { largecap: [], midcap: [], smallcap: [], microcap: [] };
    for (const s of stocks) {
      const bucket = s.mcapBucket || "microcap";
      if (byMcap[bucket]) byMcap[bucket].push(s);
    }
    for (const bucket of Object.keys(byMcap)) {
      byMcap[bucket].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
    }

    console.log(`📊 Buckets — Large:${byMcap.largecap.length} Mid:${byMcap.midcap.length} Small:${byMcap.smallcap.length} Micro:${byMcap.microcap.length}`);

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

    console.log(`📊 ${stocks.length} total stocks | techCache: ${techCache.size} entries`);

    if (ioRef) ioRef.emit("scanner-update", buildPayload(scanCache));

    try {
      const { subscribeStocksForBacktest } = require("../upstoxStream");
      const topSymbols = [
        ...gainers.map(s => s.symbol),
        ...losers.map(s => s.symbol),
        ...byMcap.largecap.slice(0, 30).map(s => s.symbol),
        ...byMcap.midcap.slice(0, 20).map(s => s.symbol),
        ...byMcap.smallcap.slice(0, 10).map(s => s.symbol),
      ].filter((sym, i, arr) => arr.indexOf(sym) === i);
      subscribeStocksForBacktest(topSymbols);
      console.log(`📊 Scanner: subscribed ${topSymbols.length} stocks for live ticks`);
    } catch (e) {
      console.error("📊 Scanner: stock subscription FAILED —", e.message);
    }

    const toWarm = [
      ...gainers.map(s => s.symbol),
      ...losers.map(s => s.symbol),
      ...byMcap.largecap.map(s => s.symbol),
      ...byMcap.midcap.map(s => s.symbol),
      ...byMcap.smallcap.slice(0, 50).map(s => s.symbol),
    ].filter((sym, i, a) => a.indexOf(sym) === i);

    if (preWarmTimer) clearTimeout(preWarmTimer);
    preWarmTimer = setTimeout(() => {
      preWarmTechCache(toWarm).then(() => {
        tryBacktestCapture(toWarm.map(sym => stocks.find(s => s.symbol === sym)).filter(Boolean));
      });
    }, PREWARM_DELAY);

  } catch (e) {
    console.error("📊 Scanner error:", e.message, e.stack);
  }
}

function registerScannerHandlers(io) {
  io.on("connection", socket => {
    if (scanCache.updatedAt > 0) socket.emit("scanner-update", buildPayload(scanCache));

    // FIX: only send 1day cached entries (not all TFs)
    const cachedEntries = [];
    for (const [key, data] of techCache.entries()) {
      if (key.endsWith(":1day")) cachedEntries.push({ key, data });
    }
    if (cachedEntries.length > 0) {
      const CHUNK = 20;
      for (let i = 0; i < cachedEntries.length; i += CHUNK) {
        const chunk = cachedEntries.slice(i, i + CHUNK);
        setTimeout(() => socket.emit("scanner-tech-batch", chunk), i * 50);
      }
    }

    socket.on("get-technicals", async ({ symbol } = {}) => {
      if (!symbol) return;
      try {
        const result = await getTechnicals(symbol.toUpperCase());
        if (result) {
          socket.emit("scanner-technicals", result);
          socket.emit("scanner-tech-batch", [{ key: `${symbol.toUpperCase()}:1day`, data: result }]);
        }
      } catch (e) {
        console.warn("📊 Socket technicals error:", e.message);
      }
    });

    socket.on("get-scanner-stocks", ({ bucket, sector, sortBy, limit } = {}) => {
      let stocks = [...(scanCache.allStocks || [])];
      if (bucket && bucket !== "all") stocks = scanCache.byMcap[bucket] || [];
      if (sector) stocks = stocks.filter(s => s.sector === sector);
      if (sortBy === "gainers")  stocks.sort((a, b) => b.changePct  - a.changePct);
      if (sortBy === "losers")   stocks.sort((a, b) => a.changePct  - b.changePct);
      if (sortBy === "volume")   stocks.sort((a, b) => b.volume     - a.volume);
      if (sortBy === "value")    stocks.sort((a, b) => b.totalValue - a.totalValue);
      socket.emit("scanner-stocks", { stocks: stocks.slice(0, limit || 100), total: stocks.length });
    });
  });
}

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
  setInstrumentMap,
  applyLiveTick,

  forceCaptureNow: async function () {
    const backtestEngine = require("../backtestEngine");
    const { subscribeStocksForBacktest } = require("../upstoxStream");

    const stocks   = scanCache.allStocks || [];
    const signals  = [];
    const seen     = new Set();
    const rejected = { f1: 0, f2: 0, f3: 0, f4: 0, f5: 0, hold: 0 };

    for (const stock of stocks) {
      const sym = stock.symbol;
      if (!sym || seen.has(sym)) continue;
      seen.add(sym);

      const tech = techCache.get(`${sym}:1day`);
      if (!tech) continue;

      if (tech.signal === "HOLD") { rejected.hold++; continue; }

      const filterResult = applyAllFilters(tech, stock, tech.signal);
      if (!filterResult.pass) {
        rejected[`f${filterResult.failedFilter}`]++;
        continue;
      }

      signals.push({
        symbol:    sym,
        sector:    stock.sector || tech.sector || "Unknown",
        signal:    tech.signal,
        price:     tech.ltp    || stock.ltp,
        target:    tech.tp     || tech.target,
        stopLoss:  tech.sl     || tech.stopLoss,
        rsi:       tech.rsi,
        techScore: tech.techScore || tech.strength,
        macd:      tech.macd,
        volRatio:  tech.volRatio,
        adx:       tech.adx?.adx,
        isSwing:   false,
      });
    }

    console.log(`📊 forceCaptureNow — HOLD:${rejected.hold} F1:${rejected.f1} F2:${rejected.f2} F3:${rejected.f3} F4:${rejected.f4} F5:${rejected.f5} PASSED:${signals.length}`);

    if (!signals.length) return { error: "No signals passed all 5 filters" };

    const result = backtestEngine.captureSession(signals);
    if (result.success) subscribeStocksForBacktest(signals.map(s => s.symbol));
    return { ...result, filterBreakdown: rejected, signalCount: signals.length };
  },
};