/**
 * circuitWatcher.js
 * Location: server/services/intelligence/circuitWatcher.js
 *
 * Monitors F&O stocks for proximity to upper/lower circuit limits.
 * Data source: Upstox REST /v2/market-quote/quotes (works on Render — no IP blocking).
 * prevClose = ohlc.close from Upstox response.
 * Circuit bands: ±20% default, ±10% narrow-band.
 */

"use strict";

const axios        = require("axios");
const EventEmitter = require("events");

// ─── Config ──────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS    = 30_000;
const COOLDOWN_MS         = 30 * 60 * 1000;
const DEFAULT_CIRCUIT_PCT = 20;
const NARROW_CIRCUIT_PCT  = 10;
const UPSTOX_BATCH_SIZE   = 500;

// NSE F&O stock symbols — top liquid names
// Add/remove as needed. Full list from NSE F&O page.
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
const TIER_THRESHOLDS     = { LOCKED: 0, CRITICAL: 1, WARNING: 2, WATCH: 5 };

// ─── State ───────────────────────────────────────────────────────────────────
const cooldownMap   = new Map();
const lockedSymbols = new Set();

let ioRef     = null;
let pollTimer = null;
let isRunning = false;
let getToken  = () => null;

const emitter = new EventEmitter();

// ─── Helpers ─────────────────────────────────────────────────────────────────
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
  const token = getToken();
  if (!token) {
    console.warn("⚠️ Circuit watcher: no Upstox token — skipping poll");
    return;
  }

  try {
    const keys   = FNO_SYMBOLS.map((s) => `NSE_EQ|${s}`);
    const chunks = [];
    for (let i = 0; i < keys.length; i += UPSTOX_BATCH_SIZE) {
      chunks.push(keys.slice(i, i + UPSTOX_BATCH_SIZE));
    }

    const stocks = [];

    for (const chunk of chunks) {
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
        const symbol    = key.split(/[|:]/).pop();
        const ltp       = parseFloat(quote.last_price || 0);
        const prevClose = parseFloat(quote.ohlc?.close || 0);
        if (ltp > 0 && prevClose > 0) {
          const change    = ltp - prevClose;
          const changePct = (change / prevClose) * 100;
          stocks.push({
            symbol,
            ltp,
            prevClose,
            change:        +change.toFixed(2),
            changePercent: +changePct.toFixed(2),
          });
        }
      }
    }

    console.log(`🔔 Circuit watcher: checked ${stocks.length} stocks via Upstox`);

    const alerts = [];
    for (const stock of stocks) {
      const { symbol, ltp, prevClose, change, changePercent } = stock;
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
        tradedValue:   0,
        timestamp:     new Date().toISOString(),
        _ts:           Date.now(),
      });

      cooldownMap.set(symbol, Date.now());
      if (tier === "LOCKED") lockedSymbols.add(symbol);
      else lockedSymbols.delete(symbol);
    }

    if (!alerts.length) return;
    console.log(`⚡ ${alerts.length} circuit alert(s) fired`);
    if (ioRef) ioRef.emit("circuit-alerts", alerts);
    emitter.emit("circuit-alerts", alerts);

   } catch (err) {
      if (err.response?.status === 401) {
        console.error("❌ Circuit watcher: Upstox token expired — reconnect via /auth/upstox");
      } else {
        console.error("❌ Circuit watcher poll error:", err.message);
        console.error("❌ Upstox response body:", JSON.stringify(err.response?.data));
        console.error("❌ Upstox status:", err.response?.status);
      }
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────
function startCircuitWatcher(io, tokenGetter) {
  if (isRunning) return;
  isRunning = true;
  ioRef     = io;
  if (tokenGetter) getToken = tokenGetter;
  console.log("🔔 Circuit watcher started — polling Upstox every 30s");
  runPoll();
  pollTimer = setInterval(runPoll, POLL_INTERVAL_MS);
}

function stopCircuitWatcher() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  isRunning = false;
}

function onCircuitAlert(cb)                { emitter.on("circuit-alerts", cb); }
function registerNarrowBandSymbols(syms)   { syms.forEach((s) => NARROW_BAND_SYMBOLS.add(s)); }

module.exports = { startCircuitWatcher, stopCircuitWatcher, onCircuitAlert, registerNarrowBandSymbols };