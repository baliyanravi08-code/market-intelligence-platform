"use strict";

/**
 * smartCircuitTracker.js
 * server/services/intelligence/smartCircuitTracker.js
 *
 * FIXES:
 *   - Removed SCAN_BATCH reference error (was undefined)
 *   - Waits for instrument map before initial scan
 *   - Score filter lowered to 0 (show all scanned stocks, not just near-circuit)
 *   - Added logging throughout for easy debugging
 */

const axios = require("axios");
const ws = require("../../api/websocket");

// ── Config ────────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS     = 3 * 60 * 1000;   // 3 min during market hours
const CIRCUIT_SCAN_SYMBOLS = 100;              // top N stocks to scan
const TRAP_WINDOW_MINS     = 30;               // first 30 min = opening trap window
const MAGNET_MIN_DAYS      = 3;               // 3 consecutive days approaching circuit = magnet

// Tier thresholds (% distance from circuit)
const TIERS = [
  { name: "LOCKED",   maxDist: 0,        score: 100 },
  { name: "CRITICAL", maxDist: 2,        score: 85  },
  { name: "WARNING",  maxDist: 5,        score: 65  },
  { name: "WATCH",    maxDist: 10,       score: 40  },
  { name: "SAFE",     maxDist: Infinity, score: 10  }, // score=10 so SAFE stocks still show
];

// ── State ─────────────────────────────────────────────────────────────────────
const watchlist    = new Map(); // symbol → watchlistEntry
const alertLog     = [];        // recent circuit alerts
const dayHistory   = new Map(); // symbol → [{ date, side, distPct }]
const alertCbs     = [];        // onCircuitAlert subscribers
const watchlistCbs = [];        // onCircuitWatchlist subscribers

let ioRef            = null;
let tokenGetter      = null;
let instrumentGetter = null;
let pollTimer        = null;

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
  const upper = quote.upper_circuit_limit || 0;
  const lower = quote.lower_circuit_limit || 0;
  if (!ltp || !upper || !lower) {
    if (ltp && !upper) console.log(`⚠️ Circuit: ${quote.symbol || '?'} ltp=${ltp} but no circuit limits — keys: ${Object.keys(quote).join(',')}`);
    return null;
  }

  const distUpper = ((upper - ltp) / ltp) * 100;
  const distLower = ((ltp - lower) / ltp) * 100;

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

  const todayIdx = hist.findIndex(h => h.date === today);
  if (todayIdx >= 0) { hist[todayIdx] = { date: today, side, distPct }; }
  else { hist.push({ date: today, side, distPct }); }

  if (hist.length > 7) hist.splice(0, hist.length - 7);

  if (hist.length >= MAGNET_MIN_DAYS) {
    const recent   = hist.slice(-MAGNET_MIN_DAYS);
    const sameSide = recent.every(h => h.side === side);
    const shrinking = recent.every((h, i) => i === 0 || h.distPct <= recent[i - 1].distPct + 1);
    if (sameSide && shrinking && distPct <= 5) {
      return {
        isMagnet: true,
        days:     MAGNET_MIN_DAYS,
        side,
        avgDist:  +(recent.reduce((a, h) => a + h.distPct, 0) / recent.length).toFixed(2),
      };
    }
  }
  return null;
}

// ── Scan symbols via Upstox quote API ────────────────────────────────────────

async function scanCircuits(symbols) {
  const token    = tokenGetter?.();
  const instrMap = instrumentGetter?.() || {};
  const toScan   = symbols.filter(s => instrMap[s]).slice(0, CIRCUIT_SCAN_SYMBOLS);

  console.log(`🔍 SmartCircuit scan: token=${!!token}, instrMap=${Object.keys(instrMap).length}, toScan=${toScan.length}`);

  if (!token)         { console.warn("⚠️ SmartCircuit: no token");                          return; }
  if (!toScan.length) { console.warn("⚠️ SmartCircuit: no symbols matched in instrument map"); return; }

  const BATCH    = 100;
  const alerts   = [];

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
      console.log(`📊 SmartCircuit batch ${i / BATCH + 1}: got ${Object.keys(data).length} quotes`);

      for (const sym of batch) {
        const key   = instrMap[sym];
        const quote = data[key] || data[key?.replace("|", ":")] || null;
        if (!quote) continue;

        const info = calcCircuitInfo(quote);
        if (!info) continue;

        const prev  = watchlist.get(sym);
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

        const isTrap = isOpeningWindow() && info.distPct <= 2 && info.tier !== "SAFE";
        const magnet = updateDayHistory(sym, info.side, info.distPct);

        if (isTrap) {
          entry.trapAlert = true;
          entry.trapMsg   = `⚡ TRAP ALERT — ${sym} within ${info.distPct}% of ${info.side} circuit in opening window`;
        }

        if (magnet) {
          entry.magnetAlert = true;
          entry.magnetMsg   = `🧲 MAGNET — ${sym} approaching ${info.side} circuit for ${magnet.days} days`;
        }

        // Alert if WARNING or above
        if (info.score >= 65 && (!prev || prev.tier !== info.tier || isTrap || magnet)) {
          const alert = {
            symbol:    sym,
            ltp:       info.ltp,
            side:      info.side,
            distPct:   info.distPct,
            tier:      info.tier,
            score:     info.score,
            trap:      isTrap || false,
            magnet:    !!magnet,
            timestamp: Date.now(),
            msg: isTrap  ? entry.trapMsg  :
                 magnet  ? entry.magnetMsg :
                 `${sym} — ${info.tier} · ${info.side} circuit · ${info.distPct}% away`,
          };
          alerts.push(alert);
          alertLog.unshift(alert);
          if (alertLog.length > 50) alertLog.pop();
        }

        watchlist.set(sym, entry);
      }
    } catch (e) {
      console.warn(`⚠️ SmartCircuit batch scan error:`, e.message);
    }
  }

  // ── Broadcast ─────────────────────────────────────────────────────────────
  // Show ALL scanned stocks (score >= 0), sorted by score DESC
  // Change score threshold back to 40 once confirmed working
  const sortedWatchlist = Array.from(watchlist.values())
    .filter(e => e.score >= 0)
    .sort((a, b) => b.score - a.score);

  console.log(`📡 SmartCircuit broadcasting: ${sortedWatchlist.length} watchlist stocks, ${alerts.length} alerts`);

  if (ioRef) {
    ioRef.to("alerts").emit("circuit-watchlist", sortedWatchlist);
    watchlistCbs.forEach(cb => { try { cb(sortedWatchlist); } catch {} });

    if (alerts.length > 0) {
      ioRef.to("alerts").emit("circuit-alerts", alerts);
      alertCbs.forEach(cb => { try { cb(alerts); } catch {} });
      console.log(`🔔 SmartCircuit: ${alerts.length} new alert(s) emitted`);
    }
  }
}

// ── Default symbol list ───────────────────────────────────────────────────────

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
  "SUNTV","BRITANNIA","DABUR","MARICO","GODREJCP","EMAMILTD",
];

// ── Lifecycle ─────────────────────────────────────────────────────────────────

function startSmartCircuitTracker(io, tokenGetterFn, instrumentGetterFn) {
  ioRef            = io;
  tokenGetter      = tokenGetterFn;
  instrumentGetter = instrumentGetterFn;

  // Poll every 3 min during market hours
  pollTimer = setInterval(() => {
    if (isMarketOpen()) {
      scanCircuits(DEFAULT_SYMBOLS).catch(e => console.warn("SmartCircuit poll error:", e.message));
    } else {
      console.log("⏸ SmartCircuit: market closed — skipping poll");
    }
  }, POLL_INTERVAL_MS);

  // Initial scan — wait for instrument map to be populated first
  let attempts = 0;
  const waitForMap = setInterval(() => {
    attempts++;
    const map   = instrumentGetter?.() || {};
    const count = Object.keys(map).length;
    console.log(`🔍 SmartCircuit waiting for instrument map... attempt ${attempts}, size=${count}`);

    if (count >= 50) {
      clearInterval(waitForMap);
      console.log(`✅ SmartCircuit: instrument map ready (${count} symbols) — starting scan`);
      if (isMarketOpen()) {
        scanCircuits(DEFAULT_SYMBOLS).catch(e =>
          console.warn("SmartCircuit initial scan error:", e.message)
        );
      } else {
        console.log("⏸ SmartCircuit: market closed — initial scan skipped");
      }
      return;
    }

    if (attempts >= 24) {
      clearInterval(waitForMap);
      console.warn("⚠️ SmartCircuit: gave up waiting for instrument map after 2 min");
    }
  }, 5_000);

  console.log("🔔 SmartCircuitTracker started");
}

function stopSmartCircuitTracker() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Public event subscriptions ────────────────────────────────────────────────

function onCircuitAlert(cb)     { alertCbs.push(cb); }
function onCircuitWatchlist(cb) { watchlistCbs.push(cb); }

// ── Public data getters ───────────────────────────────────────────────────────

function getCircuitWatchlist() {
  return Array.from(watchlist.values())
    .filter(e => e.score >= 0)
    .sort((a, b) => b.score - a.score);
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