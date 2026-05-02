"use strict";

/**
 * smartCircuitTracker.js
 * server/services/intelligence/smartCircuitTracker.js
 *
 * Replaces: circuitWatcher.js
 *
 * What's new vs old circuitWatcher:
 *   1. TRAP DETECTION — stock hits circuit in first 30 min = operator trapped = signal
 *   2. CIRCUIT MAGNET — stock approaches same circuit 3+ consecutive days = pattern
 *   3. CONSECUTIVE DAYS tracking — not just today's proximity, but multi-day pattern
 *   4. SMART TIERS — proximity scored on distance + time of day (early = more significant)
 *   5. Still emits "circuit-alerts" and "circuit-watchlist" for backward compat
 */

const axios = require("axios");

// ── Config ────────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS     = 3 * 60 * 1000;   // 3 min during market hours
const CIRCUIT_SCAN_SYMBOLS = 100;              // top N stocks to scan
const TRAP_WINDOW_MINS     = 30;               // first 30 min = opening trap window
const MAGNET_MIN_DAYS      = 3;               // 3 consecutive days approaching circuit = magnet

// Tier thresholds (% distance from circuit)
const TIERS = [
  { name: "LOCKED",   maxDist: 0,   score: 100 },
  { name: "CRITICAL", maxDist: 2,   score: 85  },
  { name: "WARNING",  maxDist: 5,   score: 65  },
  { name: "WATCH",    maxDist: 10,  score: 40  },
  { name: "SAFE",     maxDist: Infinity, score: 0 },
];

// ── State ──────────────────────────────────────────────────────────────────────
const watchlist   = new Map(); // symbol → watchlistEntry
const alertLog    = [];        // recent circuit alerts
const dayHistory  = new Map(); // symbol → [{ date, side, distPct }] — for magnet detection
const alertCbs    = [];        // onCircuitAlert subscribers
const watchlistCbs = [];       // onCircuitWatchlist subscribers

let ioRef         = null;
let tokenGetter   = null;
let instrumentGetter = null;
let pollTimer     = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function istNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

function isMarketOpen() {
  const ist = istNow();
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
}

function isOpeningWindow() {
  const ist = istNow();
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const marketStart = 9 * 60 + 15;
  return mins >= marketStart && mins < marketStart + TRAP_WINDOW_MINS;
}

function getTier(distPct) {
  for (const t of TIERS) {
    if (Math.abs(distPct) <= t.maxDist) return t;
  }
  return TIERS[TIERS.length - 1];
}

function todayIST() {
  return istNow().toISOString().split("T")[0];
}

// ── Circuit limit calculation from Upstox quote data ─────────────────────────

function calcCircuitInfo(quote) {
  const ltp   = quote.last_price || 0;
  const upper = quote.upper_circuit_limit || quote.ohlc?.high || 0;
  const lower = quote.lower_circuit_limit || quote.ohlc?.low  || 0;
  if (!ltp || !upper || !lower) return null;

  const distUpper = ((upper - ltp) / ltp) * 100;
  const distLower = ((ltp - lower) / ltp) * 100;

  // Which circuit is closer?
  const side    = distUpper <= distLower ? "UPPER" : "LOWER";
  const distPct = side === "UPPER" ? distUpper : distLower;
  const tier    = getTier(distPct);

  return { ltp, upper, lower, side, distPct: +distPct.toFixed(2), tier: tier.name, score: tier.score };
}

// ── Magnet detection: approaching same circuit 3+ days ────────────────────────

function updateDayHistory(symbol, side, distPct) {
  const today = todayIST();
  if (!dayHistory.has(symbol)) dayHistory.set(symbol, []);
  const hist = dayHistory.get(symbol);

  // Replace today's entry or add new
  const todayIdx = hist.findIndex(h => h.date === today);
  if (todayIdx >= 0) { hist[todayIdx] = { date: today, side, distPct }; }
  else { hist.push({ date: today, side, distPct }); }

  // Keep last 7 days only
  if (hist.length > 7) hist.splice(0, hist.length - 7);

  // Check for magnet: last N days all approaching same circuit with decreasing distance
  if (hist.length >= MAGNET_MIN_DAYS) {
    const recent = hist.slice(-MAGNET_MIN_DAYS);
    const sameSide = recent.every(h => h.side === side);
    const shrinking = recent.every((h, i) => i === 0 || h.distPct <= recent[i - 1].distPct + 1);
    if (sameSide && shrinking && distPct <= 5) {
      return { isMagnet: true, days: MAGNET_MIN_DAYS, side, avgDist: +(recent.reduce((a, h) => a + h.distPct, 0) / recent.length).toFixed(2) };
    }
  }
  return null;
}

// ── Scan symbols via Upstox quote API ─────────────────────────────────────────

async function scanCircuits(symbols) {
  const token = tokenGetter?.();
  if (!token) return;

  const instrMap   = instrumentGetter?.() || {};
  const toScan     = symbols.filter(s => instrMap[s]).slice(0, SCAN_BATCH);
  if (!toScan.length) return;

  // Upstox allows up to 500 keys per request
  const BATCH = 100;
  const alerts = [];
  const newWatchlist = [];

  for (let i = 0; i < toScan.length; i += BATCH) {
    const batch = toScan.slice(i, i + BATCH);
    const keys  = batch.map(s => instrMap[s]).join(",");
    try {
      const r = await axios.get("https://api.upstox.com/v2/market-quote/quotes", {
        params:  { instrument_key: keys },
        headers: { Authorization: "Bearer " + token, Accept: "application/json" },
        timeout: 10_000,
      });
      const data = r.data?.data || {};
      for (const sym of batch) {
        const key   = instrMap[sym];
        const quote = data[key] || data[key?.replace("|", ":")] || null;
        if (!quote) continue;

        const info = calcCircuitInfo(quote);
        if (!info) continue;

        // Update watchlist entry
        const prev = watchlist.get(sym);
        const entry = {
          symbol:    sym,
          ltp:       info.ltp,
          upper:     info.upper,
          lower:     info.lower,
          side:      info.side,
          distPct:   info.distPct,
          tier:      info.tier,
          score:     info.score,
          updatedAt: Date.now(),
        };

        // Trap detection: critical proximity in opening window
        const isTrap = isOpeningWindow() && info.distPct <= 2 && info.tier !== "SAFE";

        // Magnet detection
        const magnet = updateDayHistory(sym, info.side, info.distPct);

        if (isTrap) {
          entry.trapAlert = true;
          entry.trapMsg   = `⚡ TRAP ALERT — ${sym} within ${info.distPct}% of ${info.side} circuit in opening window`;
        }

        if (magnet) {
          entry.magnetAlert = true;
          entry.magnetMsg   = `🧲 MAGNET — ${sym} approaching ${info.side} circuit for ${magnet.days} days`;
        }

        // Emit alert if tier is WARNING or above
        if (info.score >= 65 && (!prev || prev.tier !== info.tier || isTrap || magnet)) {
          const alert = {
            symbol:  sym,
            ltp:     info.ltp,
            side:    info.side,
            distPct: info.distPct,
            tier:    info.tier,
            score:   info.score,
            trap:    isTrap || false,
            magnet:  !!magnet,
            timestamp: Date.now(),
            msg: isTrap ? entry.trapMsg : magnet ? entry.magnetMsg :
              `${sym} — ${info.tier} · ${info.side} circuit · ${info.distPct}% away`,
          };
          alerts.push(alert);
          alertLog.unshift(alert);
          if (alertLog.length > 50) alertLog.pop();
        }

        watchlist.set(sym, entry);
        newWatchlist.push(entry);
      }
    } catch (e) {
      console.warn(`⚠️ SmartCircuit batch scan error:`, e.message);
    }
  }

  // Broadcast
  const sortedWatchlist = Array.from(watchlist.values())
    .filter(e => e.score >= 40)
    .sort((a, b) => b.score - a.score);

  if (ioRef) {
    if (alerts.length > 0) {
      ioRef.emit("circuit-alerts", alerts);
      alertCbs.forEach(cb => { try { cb(alerts); } catch {} });
      console.log(`🔔 SmartCircuit: ${alerts.length} new alert(s) emitted`);
    }
    ioRef.emit("circuit-watchlist", sortedWatchlist);
    watchlistCbs.forEach(cb => { try { cb(sortedWatchlist); } catch {} });
  }
}

const SCAN_BATCH = CIRCUIT_SCAN_SYMBOLS;

// ── Default symbol list (NIFTY 500 large caps first) ─────────────────────────

const DEFAULT_SYMBOLS = [
  "RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK","SBIN","AXISBANK","KOTAKBANK",
  "LT","WIPRO","BAJFINANCE","BHARTIARTL","HINDUNILVR","NTPC","SUNPHARMA",
  "TATAMOTORS","TATASTEEL","MARUTI","TITAN","ITC","ADANIENT","ADANIPORTS",
  "HCLTECH","TECHM","ZOMATO","JSWSTEEL","HINDALCO","COALINDIA","DRREDDY","CIPLA",
  "EICHERMOT","HEROMOTOCO","BAJAJ-AUTO","BAJAJFINSV","NESTLEIND","ASIANPAINT",
  "ULTRACEMCO","POWERGRID","ONGC","BPCL","GRASIM","DIVISLAB","INDUSINDBK",
  "HAL","BEL","RECLTD","PFC","TATACONSUM","SBILIFE","HDFCLIFE","IRCTC","IRFC",
  "TRENT","NHPC","POLYCAB","STLTECH","BOSCHLTD","OBEROIRLTY","MOTHERSON",
  "NLCINDIA","SJVN","NBCC","RAILTEL","RITES","RVNL","CUMMINSIND","BHEL",
  "SUZLON","TORNTPOWER","TATAPOWER","JSWENERGY","PGEL","INOXWIND","KEC",
  "KALPATPOWER","ABB","SIEMENS","LTIM","LTTS","MPHASIS","PERSISTENT","COFORGE",
  "OFSS","NAUKRI","ZYDUSLIFE","AUROPHARMA","IPCALAB","ALKEM","LUPIN",
  "SUNTV","NESTLEIND","BRITANNIA","DABUR","MARICO","GODREJCP","EMAMILTD",
];

// ── Lifecycle ──────────────────────────────────────────────────────────────────

function startSmartCircuitTracker(io, tokenGetterFn, instrumentGetterFn) {
  ioRef            = io;
  tokenGetter      = tokenGetterFn;
  instrumentGetter = instrumentGetterFn;

  // Restore any stored alerts on client connect
  io.on("connection", (socket) => {
    const recent = alertLog.slice(0, 20);
    if (recent.length > 0) socket.emit("circuit-alerts", recent);
    const wl = Array.from(watchlist.values()).filter(e => e.score >= 40).sort((a, b) => b.score - a.score);
    if (wl.length > 0) socket.emit("circuit-watchlist", wl);
  });

  // Start polling during market hours
  pollTimer = setInterval(() => {
    if (isMarketOpen()) {
      scanCircuits(DEFAULT_SYMBOLS).catch(e => console.warn("SmartCircuit poll error:", e.message));
    }
  }, POLL_INTERVAL_MS);

  // Initial scan
  if (isMarketOpen()) {
    setTimeout(() => scanCircuits(DEFAULT_SYMBOLS), 5_000);
  }

  console.log("🔔 SmartCircuitTracker started");
}

function stopSmartCircuitTracker() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Public event subscriptions (same API as old circuitWatcher) ───────────────

function onCircuitAlert(cb) { alertCbs.push(cb); }
function onCircuitWatchlist(cb) { watchlistCbs.push(cb); }

// ── Public data getters ────────────────────────────────────────────────────────

function getCircuitWatchlist() {
  return Array.from(watchlist.values()).filter(e => e.score >= 40).sort((a, b) => b.score - a.score);
}

function getRecentAlerts(n = 20) {
  return alertLog.slice(0, n);
}

function getCircuitForSymbol(symbol) {
  return watchlist.get(symbol?.toUpperCase()) || null;
}

module.exports = {
  startSmartCircuitTracker,
  stopSmartCircuitTracker,
  onCircuitAlert,
  onCircuitWatchlist,
  getCircuitWatchlist,
  getRecentAlerts,
  getCircuitForSymbol,
};