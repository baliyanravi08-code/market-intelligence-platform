/**
 * circuitWatcher.js
 * Location: server/services/intelligence/circuitWatcher.js
 *
 * Monitors F&O stocks for proximity to upper/lower circuit limits.
 * Data source: Upstox REST /v2/market-quote/quotes (works on Render — no IP blocking).
 * Instrument keys resolved via instrument master map injected from server.js.
 */

"use strict";

const axios        = require("axios");
const EventEmitter = require("events");

// ─── Config ───────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS    = 30_000;
const COOLDOWN_MS         = 30 * 60 * 1000;
const DEFAULT_CIRCUIT_PCT = 20;
const NARROW_CIRCUIT_PCT  = 10;
const UPSTOX_BATCH_SIZE   = 500;

// NSE F&O stock symbols (trading symbols only — instrument keys resolved via map)
const FNO_SYMBOLS = [
  "RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK","HINDUNILVR","SBIN","BAJFINANCE",
  "BHARTIARTL","KOTAKBANK","LT","ASIANPAINT","AXISBANK","MARUTI","TITAN",
  "SUNPHARMA","ULTRACEMCO","WIPRO","NESTLEIND","POWERGRID","NTPC","TECHM",
  "HCLTECH","ONGC","JSWSTEEL","TATASTEEL","COALINDIA","BPCL","GRASIM","DIVISLAB",
  "BRITANNIA","CIPLA","DRREDDY","EICHERMOT","APOLLOHOSP","BAJAJ-AUTO","BAJAJFINSV",
  "HEROMOTOCO","HINDALCO","INDUSINDBK","ITC","M&M","SBILIFE","HDFCLIFE",
  "TATACONSUM","ADANIENT","ADANIPORTS","LTIM","UPL","VEDL",
  "BANKBARODA","CANBK","PNB","UNIONBANK","FEDERALBNK","IDFCFIRSTB","RBLBANK",
  "YESBANK","BANDHANBNK","AUBANK","CHOLAFIN","MUTHOOTFIN","MANAPPURAM",
  "RECLTD","PFC","IRFC","HUDCO","NHPC","SJVN",
  "ADANIPOWER","ADANIGREEN","TATAPOWER","CESC","TORNTPOWER","JSWENERGY",
  "SUZLON","INOXWIND",
  "HAL","BEL","BHEL","COCHINSHIP","MAZDOCK","GRSE","BEML","DATAPATTNS",
  "MTAR","RVNL","RAILTEL","IRCTC","TITAGARH",
  "TATAMOTORS","M&MFIN","ASHOKLEY","BALKRISIND","EXIDEIND","MOTHERSON","BOSCHLTD",
  "ABB","SIEMENS","HAVELLS","POLYCAB","CGPOWER",
  "AIAENG","GRINDWELL","CARBORUNIV","SCHAEFFLER","TIMKEN","SKF",
  "PIDILITIND","ASTRAL","AARTIIND","DEEPAKNITR","GNFC","CHAMBLFERT",
  "COROMANDEL","PIIND","RALLIS","SUMICHEM",
  "ZOMATO","NYKAA","PAYTM","POLICYBZR","DELHIVERY",
  "KEC","KALPATPOWR","THERMAX","APLAPOLLO",
  "GODREJCP","DABUR","MARICO","EMAMILTD","VBL","RADICO","MCDOWELL-N",
  "ZYDUSLIFE","LUPIN","ALKEM","TORNTPHARM","IPCALAB","LAURUSLABS",
  "GRANULES","BIOCON","ABBOTINDIA",
  "OBEROIRLTY","PHOENIXLTD","DLF","GODREJPROP","PRESTIGE","BRIGADE","SOBHA",
  "MCX","BSE","CDSL","CAMS","ANGELONE","MOFSL","360ONE",
  "HDFCAMC","NIPPONLIFE","UTIAMC","ICICIGI","STARHEALTH",
  "SAIL","NMDC","MOIL","GMRINFRA","CONCOR","BLUEDART",
  "ZEEL","SUNTV","PVRINOX",
  "HFCL","STLTECH","TATACOMM","INDIAMART","NAUKRI","AFFLE","TANLA",
];

const NARROW_BAND_SYMBOLS = new Set(["YESBANK", "RBLBANK", "BANDHANBNK"]);

// TIER_THRESHOLDS: how many % away from circuit limit to trigger each tier
// These are % of LTP distance to the circuit limit
const TIER_THRESHOLDS = {
  LOCKED:   0,   // AT the circuit
  CRITICAL: 1,   // within 1%
  WARNING:  3,   // within 3%
  WATCH:    15,  // within 15% — wide net, catches meaningful moves
};

// ─── State ────────────────────────────────────────────────────────────────────
const cooldownMap   = new Map();
const lockedSymbols = new Set();

let ioRef      = null;
let pollTimer  = null;
let isRunning  = false;
let getToken   = () => null;
let getInstMap = () => ({});

// Store last poll's full stock data for diagnostic + last alerts for replay
let lastPollStocks = [];
let lastAlerts     = [];

const emitter = new EventEmitter();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getCircuitLimits(symbol, prevClose) {
  const pct = NARROW_BAND_SYMBOLS.has(symbol) ? NARROW_CIRCUIT_PCT : DEFAULT_CIRCUIT_PCT;
  return {
    upper:   +(prevClose * (1 + pct / 100)).toFixed(2),
    lower:   +(prevClose * (1 - pct / 100)).toFixed(2),
    bandPct: pct,
  };
}

function circuitProximity(ltp, upper, lower) {
  const distUpper = ((upper - ltp) / ltp) * 100;
  const distLower = ((ltp - lower) / ltp) * 100;
  if (distUpper <= distLower) return { side: "UPPER", distPct: +distUpper.toFixed(2), limit: upper };
  return { side: "LOWER", distPct: +distLower.toFixed(2), limit: lower };
}

function getTier(distPct) {
  if (distPct <= TIER_THRESHOLDS.LOCKED)   return "LOCKED";
  if (distPct <= TIER_THRESHOLDS.CRITICAL) return "CRITICAL";
  if (distPct <= TIER_THRESHOLDS.WARNING)  return "WARNING";
  if (distPct <= TIER_THRESHOLDS.WATCH)    return "WATCH";
  return null;
}

function getActionTag(side, tier) {
  if (tier === "LOCKED")
    return side === "UPPER" ? "UPPER_CIRCUIT_LOCKED" : "LOWER_CIRCUIT_LOCKED";
  return side === "UPPER" ? "UPPER_CIRCUIT_NEAR" : "LOWER_CIRCUIT_NEAR";
}

function isOnCooldown(symbol) {
  const last = cooldownMap.get(symbol);
  return last && Date.now() - last < COOLDOWN_MS;
}

// ─── Poll loop ────────────────────────────────────────────────────────────────
async function runPoll() {
  const token   = getToken();
  const instMap = getInstMap();

  if (!token) {
    console.warn("⚠️ Circuit watcher: no Upstox token — skipping poll");
    return;
  }

  if (!instMap || Object.keys(instMap).length === 0) {
    console.warn("⚠️ Circuit watcher: instrument map not ready yet — skipping poll");
    return;
  }

  // Resolve trading symbols → instrument keys, skip unknown symbols
  const symbolToKey = {};
  for (const sym of FNO_SYMBOLS) {
    const key = instMap[sym];
    if (key) symbolToKey[sym] = key;
  }

  const instrumentKeys = Object.values(symbolToKey);
  if (instrumentKeys.length === 0) {
    console.warn("⚠️ Circuit watcher: no valid instrument keys resolved — check instrument map");
    return;
  }

  // Reverse map: instrument_key → trading symbol
  const keyToSymbol = {};
  for (const [sym, key] of Object.entries(symbolToKey)) {
    keyToSymbol[key] = sym;
  }

  // Batch into chunks of 500
  const chunks = [];
  for (let i = 0; i < instrumentKeys.length; i += UPSTOX_BATCH_SIZE) {
    chunks.push(instrumentKeys.slice(i, i + UPSTOX_BATCH_SIZE));
  }

  const stocks = [];

  for (const chunk of chunks) {
    try {
      const res = await axios.get(
        "https://api.upstox.com/v2/market-quote/quotes",
        {
          params:  { instrument_key: chunk.join(",") },
          headers: { Authorization: "Bearer " + token, Accept: "application/json" },
          timeout: 15_000,
        }
      );

      const data = res.data?.data || {};
      for (const [key, quote] of Object.entries(data)) {
        const symbol    = keyToSymbol[key] || key.split(/[|:]/).pop();
        const ltp       = parseFloat(quote.last_price || 0);
        const prevClose = parseFloat(quote.ohlc?.close || 0);
        const volume    = parseInt(quote.volume || 0, 10);
        const value     = parseFloat(quote.average_price || 0) * volume; // traded value estimate
        if (ltp > 0 && prevClose > 0) {
          const change    = ltp - prevClose;
          const changePct = (change / prevClose) * 100;
          stocks.push({
            symbol,
            ltp,
            prevClose,
            change:        +change.toFixed(2),
            changePercent: +changePct.toFixed(2),
            tradedValue:   +value.toFixed(0),
            volume,
          });
        }
      }
    } catch (err) {
      if (err.response?.status === 401) {
        console.error("❌ Circuit watcher: Upstox token expired — reconnect via /auth/upstox");
        return;
      }
      console.error("❌ Circuit watcher poll error:", err.message);
      console.error("❌ Upstox response:", JSON.stringify(err.response?.data));
      continue;
    }
  }

  console.log(`🔔 Circuit watcher: checked ${stocks.length} stocks via Upstox`);
  lastPollStocks = stocks; // store for diagnostics

  const alerts = [];
  for (const stock of stocks) {
    const { symbol, ltp, prevClose, change, changePercent, tradedValue, volume } = stock;
    if (isOnCooldown(symbol)) continue;

    const { upper, lower, bandPct } = getCircuitLimits(symbol, prevClose);
    const { side, distPct, limit }  = circuitProximity(ltp, upper, lower);
    const tier = getTier(distPct);

    if (!tier) { lockedSymbols.delete(symbol); continue; }
    if (tier === "LOCKED" && lockedSymbols.has(symbol)) continue;

    alerts.push({
      symbol, ltp, prevClose,
      circuitLimit: limit, bandPct, distPct, side, tier,
      action:        getActionTag(side, tier),
      change, changePercent,
      tradedValue,
      volume,
      timestamp:     new Date().toISOString(),
      _ts:           Date.now(),
    });

    cooldownMap.set(symbol, Date.now());
    if (tier === "LOCKED") lockedSymbols.add(symbol);
    else lockedSymbols.delete(symbol);
  }

  // Always emit the full watch list (all stocks with their proximity data)
  // so the UI can show a live dashboard even with no alerts
  const watchList = stocks.map((stock) => {
    const { symbol, ltp, prevClose, change, changePercent, tradedValue, volume } = stock;
    const { upper, lower, bandPct } = getCircuitLimits(symbol, prevClose);
    const { side, distPct, limit }  = circuitProximity(ltp, upper, lower);
    const tier = getTier(distPct) || "SAFE";
    return { symbol, ltp, prevClose, change, changePercent, tradedValue, volume, circuitLimit: limit, bandPct, distPct, side, tier, _ts: Date.now() };
  }).sort((a, b) => a.distPct - b.distPct); // closest to circuit first

  if (ioRef) ioRef.emit("circuit-watchlist", watchList);
  emitter.emit("circuit-watchlist", watchList);

  if (!alerts.length) return;

  console.log(`⚡ ${alerts.length} circuit alert(s) fired`);
  lastAlerts = alerts;
  if (ioRef) ioRef.emit("circuit-alerts", alerts);
  emitter.emit("circuit-alerts", alerts);
}

// ─── Public API ───────────────────────────────────────────────────────────────
function startCircuitWatcher(io, tokenGetter, instrumentMapGetter) {
  if (isRunning) return;
  isRunning = true;
  ioRef     = io;
  if (tokenGetter)         getToken   = tokenGetter;
  if (instrumentMapGetter) getInstMap = instrumentMapGetter;
  console.log("🔔 Circuit watcher started — polling Upstox every 30s");
  runPoll();
  pollTimer = setInterval(runPoll, POLL_INTERVAL_MS);
}

function stopCircuitWatcher() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  isRunning = false;
}

function onCircuitAlert(cb)              { emitter.on("circuit-alerts", cb); }
function onCircuitWatchlist(cb)          { emitter.on("circuit-watchlist", cb); }
function getLastAlerts()                 { return lastAlerts; }
function getLastPollStocks()             { return lastPollStocks; }
function registerNarrowBandSymbols(syms) { syms.forEach((s) => NARROW_BAND_SYMBOLS.add(s)); }

module.exports = {
  startCircuitWatcher,
  stopCircuitWatcher,
  onCircuitAlert,
  onCircuitWatchlist,
  getLastAlerts,
  getLastPollStocks,
  registerNarrowBandSymbols,
};