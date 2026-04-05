/**
 * deliveryAnalyzer.js
 * Detects sudden delivery % spikes — one of the strongest conviction signals.
 * When delivery % jumps from ~20% to 70%+, it means institutional/smart money
 * is accumulating with INTENT TO HOLD — not day trading.
 *
 * Place at: server/services/intelligence/deliveryAnalyzer.js
 *
 * Data source: NSE bhav copy (free, published daily + intraday)
 * Emits alerts via Socket.io when spike detected.
 *
 * Wire up in coordinator.js:
 *   const { startDeliveryAnalyzer } = require('./services/intelligence/deliveryAnalyzer');
 *   startDeliveryAnalyzer(io);
 */

"use strict";

const https    = require("https");
const EventEmitter = require("events");

// ─── Config ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS   = 5 * 60 * 1000;  // poll NSE every 5 minutes
const SPIKE_THRESHOLD    = 40;              // delivery % must jump by 40+ points
const MIN_DELIVERY_PCT   = 60;             // AND current delivery must be above 60%
const MIN_TRADED_VALUE   = 5_00_00_000;    // min ₹5Cr traded (filter penny stocks)
const HISTORY_DAYS       = 5;              // compare against 5-day average

// NSE endpoints (no auth needed — public data)
const NSE_QUOTE_URL   = "https://www.nseindia.com/api/quote-equity?symbol=";
const NSE_BHAV_URL    = "https://www.nseindia.com/api/equity-stockIndices?index=SECURITIES%20IN%20F%26O";

// ─── State ─────────────────────────────────────────────────────────────────

const deliveryHistory  = {};   // symbol → [last N delivery %]
const lastAlerted      = {};   // symbol → timestamp (prevent spam)
const ALERT_COOLDOWN   = 60 * 60 * 1000;  // re-alert same stock max once/hour

let ioRef      = null;
let pollTimer  = null;
let isRunning  = false;

// Internal event bus — other engines can listen
const emitter = new EventEmitter();

// ─── NSE HTTP helper ───────────────────────────────────────────────────────

/**
 * NSE requires browser-like headers or it returns 401/403.
 * This is public market data — no login needed.
 */
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
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`NSE parse error at ${url}`));
        }
      });
    }).on("error", reject);
  });
}

// ─── Core Logic ────────────────────────────────────────────────────────────

/**
 * Fetch F&O stock list with delivery data from NSE.
 * Returns array of { symbol, deliveryPct, tradedValue, ltp, change }
 */
async function fetchDeliveryData() {
  const data = await nseGet(NSE_BHAV_URL);

  if (!data?.data || !Array.isArray(data.data)) {
    throw new Error("Unexpected NSE response format");
  }

  return data.data
    .filter((s) => s.symbol && s.deliveryToTradedQuantity != null)
    .map((s) => ({
      symbol:      s.symbol,
      deliveryPct: parseFloat(s.deliveryToTradedQuantity || 0),
      tradedValue: parseFloat(s.totalTradedValue || 0) * 1_00_000, // NSE returns in lakhs
      ltp:         parseFloat(s.lastPrice || 0),
      change:      parseFloat(s.pChange || 0),
      series:      s.series || "EQ",
    }))
    .filter((s) => s.tradedValue >= MIN_TRADED_VALUE && s.ltp > 0);
}

/**
 * Update rolling history and detect spikes.
 * Returns array of spike alerts.
 */
function analyzeDelivery(stocks) {
  const spikes = [];
  const now    = Date.now();

  for (const stock of stocks) {
    const { symbol, deliveryPct, tradedValue, ltp, change } = stock;

    // Initialise history array
    if (!deliveryHistory[symbol]) {
      deliveryHistory[symbol] = [];
    }

    const history = deliveryHistory[symbol];

    // Need at least 2 data points to compare
    if (history.length >= 2) {
      const avgPast = history.reduce((a, b) => a + b, 0) / history.length;
      const spike   = deliveryPct - avgPast;
      const cooldownOk = !lastAlerted[symbol] || now - lastAlerted[symbol] > ALERT_COOLDOWN;

      if (
        spike   >= SPIKE_THRESHOLD  &&
        deliveryPct >= MIN_DELIVERY_PCT &&
        cooldownOk
      ) {
        const alert = buildAlert(symbol, deliveryPct, avgPast, spike, ltp, change, tradedValue);
        spikes.push(alert);
        lastAlerted[symbol] = now;

        console.log(
          `🚀 Delivery spike: ${symbol} | ${avgPast.toFixed(1)}% → ${deliveryPct.toFixed(1)}% (+${spike.toFixed(1)}pts)`
        );
      }
    }

    // Store latest reading (keep last N)
    history.push(deliveryPct);
    if (history.length > HISTORY_DAYS) history.shift();
  }

  return spikes;
}

/**
 * Build a structured alert object (same shape as your radar alerts).
 */
function buildAlert(symbol, current, avg, spike, ltp, change, tradedValue) {
  const strength = spike >= 60 ? "EXTREME" : spike >= 50 ? "STRONG" : "MODERATE";
  const tradedCr = (tradedValue / 1_00_00_000).toFixed(1);

  return {
    type:        "DELIVERY_SPIKE",
    symbol,
    strength,    // EXTREME / STRONG / MODERATE
    deliveryPct: parseFloat(current.toFixed(1)),
    avgPast:     parseFloat(avg.toFixed(1)),
    spikePts:    parseFloat(spike.toFixed(1)),
    ltp,
    change,
    tradedCr:    parseFloat(tradedCr),  // ₹Cr traded today
    signal:      `Delivery jumped from ${avg.toFixed(0)}% avg → ${current.toFixed(0)}% (+${spike.toFixed(0)}pts). Smart money accumulating.`,
    action:      change > 0 ? "POSSIBLE_BREAKOUT" : "POSSIBLE_ACCUMULATION",
    timestamp:   new Date().toISOString(),
    _ts:         Date.now(),
  };
}

// ─── Poll Loop ─────────────────────────────────────────────────────────────

async function runPoll() {
  try {
    const stocks = await fetchDeliveryData();
    console.log(`📦 Delivery analyzer: fetched ${stocks.length} stocks`);

    const spikes = analyzeDelivery(stocks);

    if (spikes.length > 0) {
      // Emit to all connected frontend clients
      if (ioRef) {
        ioRef.emit("delivery-spikes", spikes);
      }

      // Also emit on internal bus for other engines (compositeScoreEngine, etc.)
      emitter.emit("delivery-spikes", spikes);

      console.log(`⚡ ${spikes.length} delivery spike(s) detected and emitted`);
    }
  } catch (err) {
    console.error("❌ Delivery analyzer poll error:", err.message);
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Start the delivery analyzer.
 * @param {Object} io - Socket.io server instance
 */
function startDeliveryAnalyzer(io) {
  if (isRunning) return;
  isRunning = true;
  ioRef     = io;

  console.log("📊 Delivery analyzer started — polling NSE every 5 min");

  // Run immediately, then on interval
  runPoll();
  pollTimer = setInterval(runPoll, POLL_INTERVAL_MS);
}

function stopDeliveryAnalyzer() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  isRunning = false;
  console.log("📊 Delivery analyzer stopped");
}

/**
 * Get current delivery history (for API endpoint / debug)
 */
function getDeliveryHistory() {
  return deliveryHistory;
}

/**
 * Get last alerts (for REST API)
 */
function getLastAlerts() {
  return lastAlerted;
}

// Allow other engines to subscribe to delivery spikes
function onDeliverySpike(cb) {
  emitter.on("delivery-spikes", cb);
}

module.exports = {
  startDeliveryAnalyzer,
  stopDeliveryAnalyzer,
  getDeliveryHistory,
  getLastAlerts,
  onDeliverySpike,
};