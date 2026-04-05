/**
 * circuitWatcher.js
 * Location: server/services/intelligence/circuitWatcher.js
 *
 * Monitors F&O stocks for proximity to upper/lower circuit limits.
 * Self-contained — polls NSE F&O endpoint directly (same source as deliveryAnalyzer).
 * Derives circuit bands from previousClose field in NSE response.
 * Emits `circuit-alerts` via Socket.io + internal EventEmitter (for compositeScoreEngine).
 */

"use strict";

const https        = require("https");
const EventEmitter = require("events");

// ─── Config ──────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS    = 30_000;          // every 30s
const COOLDOWN_MS         = 30 * 60 * 1000;  // same stock max once per 30 min
const MIN_TRADED_VALUE    = 5_00_00_000;     // ₹5 Cr minimum
const DEFAULT_CIRCUIT_PCT = 20;              // ±20% from prevClose (standard NSE)
const NARROW_CIRCUIT_PCT  = 10;              // ±10% for narrow-band stocks

// Add NSE symbols known to be in ±10% category here
const NARROW_BAND_SYMBOLS = new Set([
  // e.g. 'YESBANK', 'RBLBANK'
]);

// NSE F&O stocks endpoint (same as deliveryAnalyzer — no auth needed)
const NSE_FNO_URL =
  "https://www.nseindia.com/api/equity-stockIndices?index=SECURITIES%20IN%20F%26O";

// Alert tiers — distance from circuit as % of LTP
const TIER_THRESHOLDS = { LOCKED: 0, CRITICAL: 1, WARNING: 2, WATCH: 5 };

// ─── State ───────────────────────────────────────────────────────────────────
const cooldownMap   = new Map();
const lockedSymbols = new Set();

let ioRef     = null;
let pollTimer = null;
let isRunning = false;

const emitter = new EventEmitter();

// ─── NSE HTTP helper (same pattern as deliveryAnalyzer) ──────────────────────
function nseGet(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120",
        "Accept":          "application/json, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer":         "https://www.nseindia.com/",
        "Connection":      "keep-alive",
      },
    };
    https.get(url, options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`NSE parse error at ${url}`)); }
      });
    }).on("error", reject);
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getCircuitLimits(symbol, prevClose) {
  const pct = NARROW_BAND_SYMBOLS.has(symbol)
    ? NARROW_CIRCUIT_PCT
    : DEFAULT_CIRCUIT_PCT;
  return {
    upper:   +(prevClose * (1 + pct / 100)).toFixed(2),
    lower:   +(prevClose * (1 - pct / 100)).toFixed(2),
    bandPct: pct,
  };
}

function circuitProximity(ltp, upper, lower) {
  const distUpper = ((upper - ltp) / ltp) * 100;
  const distLower = ((ltp - lower) / ltp) * 100;
  if (distUpper <= distLower) {
    return { side: "UPPER", distPct: +distUpper.toFixed(2), limit: upper };
  }
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

// ─── Fetch + parse NSE F&O data ───────────────────────────────────────────────
async function fetchStockData() {
  const data = await nseGet(NSE_FNO_URL);

  if (!data?.data || !Array.isArray(data.data)) {
    throw new Error("Unexpected NSE response format");
  }

  return data.data
    .filter((s) => s.symbol && s.lastPrice != null && s.previousClose != null)
    .map((s) => ({
      symbol:        s.symbol,
      ltp:           parseFloat(s.lastPrice       || 0),
      prevClose:     parseFloat(s.previousClose   || 0),
      tradedValue:   parseFloat(s.totalTradedValue || 0) * 1_00_000,
      change:        parseFloat(s.change          || 0),
      changePercent: parseFloat(s.pChange         || 0),
    }))
    .filter(
      (s) =>
        s.ltp > 0 &&
        s.prevClose > 0 &&
        s.tradedValue >= MIN_TRADED_VALUE
    );
}

// ─── Core analysis ────────────────────────────────────────────────────────────
function analyzeStocks(stocks) {
  const alerts = [];

  for (const stock of stocks) {
    const { symbol, ltp, prevClose, tradedValue, change, changePercent } = stock;

    if (isOnCooldown(symbol)) continue;

    const { upper, lower, bandPct } = getCircuitLimits(symbol, prevClose);
    const { side, distPct, limit }  = circuitProximity(ltp, upper, lower);
    const tier = getTier(distPct);

    if (!tier) {
      lockedSymbols.delete(symbol);
      continue;
    }

    if (tier === "LOCKED" && lockedSymbols.has(symbol)) continue;

    alerts.push({
      symbol,
      ltp,
      prevClose,
      circuitLimit:  limit,
      bandPct,
      distPct,
      side,
      tier,
      action:        getActionTag(side, tier),
      change,
      changePercent,
      tradedValue,
      timestamp:     new Date().toISOString(),
      _ts:           Date.now(),
    });

    cooldownMap.set(symbol, Date.now());
    if (tier === "LOCKED") lockedSymbols.add(symbol);
    else lockedSymbols.delete(symbol);
  }

  return alerts;
}

// ─── Poll loop ────────────────────────────────────────────────────────────────
async function runPoll() {
  try {
    const stocks = await fetchStockData();
    console.log(`🔔 Circuit watcher: checked ${stocks.length} stocks`);

    const alerts = analyzeStocks(stocks);
    if (!alerts.length) return;

    console.log(`⚡ ${alerts.length} circuit alert(s) fired`);

    if (ioRef) ioRef.emit("circuit-alerts", alerts);
    emitter.emit("circuit-alerts", alerts);

  } catch (err) {
    console.error("❌ Circuit watcher poll error:", err.message);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
function startCircuitWatcher(io) {
  if (isRunning) return;
  isRunning = true;
  ioRef     = io;

  console.log("🔔 Circuit watcher started — polling NSE every 30s");

  runPoll();
  pollTimer = setInterval(runPoll, POLL_INTERVAL_MS);
}

function stopCircuitWatcher() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  isRunning = false;
  console.log("🔔 Circuit watcher stopped");
}

function onCircuitAlert(cb) {
  emitter.on("circuit-alerts", cb);
}

function registerNarrowBandSymbols(symbols = []) {
  symbols.forEach((s) => NARROW_BAND_SYMBOLS.add(s));
  console.log(`[circuitWatcher] Registered ${symbols.length} narrow-band symbols`);
}

module.exports = {
  startCircuitWatcher,
  stopCircuitWatcher,
  onCircuitAlert,
  registerNarrowBandSymbols,
};