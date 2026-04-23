/**
 * upstoxStream.js
 * Location: server/services/upstoxStream.js   ← REPLACE EXISTING
 *
 * FIXES:
 *  1. Stock subscriptions now persist across reconnects — on every "open" event,
 *     ALL queued stocks are re-subscribed automatically via resubscribeAll()
 *  2. Day-end price display fixed — tracks prevClose per symbol in prevCloseCache
 *     so % change never resets to zero when Upstox sends cp=0 after market close
 *  3. Backtest engine wired for auto WIN/LOSS resolution
 */

"use strict";

let UpstoxClient = null;
try {
  UpstoxClient = require("upstox-js-sdk");
} catch (e) {
  console.warn("⚠️  upstox-js-sdk not installed. Run: npm install upstox-js-sdk");
}

let streamer     = null;
let currentToken = null;
let ioRef        = null;
let reconnTimer  = null;

// ── Injected handlers ─────────────────────────────────────────────────────────
let ltpTickHandler = null;
let oiTickHandler  = null;
let backtestEngine = null;

function setLTPTickHandler(fn) {
  if (typeof fn === "function") {
    ltpTickHandler = fn;
    console.log("✅ Upstox: LTP tick handler registered (Gann + composite engine wired)");
  }
}

function setOITickHandler(handler) {
  oiTickHandler = handler;
}

function setBacktestEngine(engine) {
  if (engine && typeof engine.onLTPTick === "function") {
    backtestEngine = engine;
    console.log("✅ Upstox: Backtest engine wired — stock LTP → auto WIN/LOSS resolution");
  }
}

// ── Index instruments ─────────────────────────────────────────────────────────
const INDEX_INSTRUMENTS = [
  "NSE_INDEX|Nifty 50",
  "BSE_INDEX|SENSEX",
  "NSE_INDEX|Nifty Bank",
];

const NAME_MAP = {
  "NSE_INDEX|Nifty 50":   "NIFTY 50",
  "BSE_INDEX|SENSEX":     "SENSEX",
  "NSE_INDEX|Nifty Bank": "BANK NIFTY",
};

const GANN_SYMBOL_MAP = {
  "NIFTY 50":   "NIFTY",
  "BANK NIFTY": "BANKNIFTY",
  "SENSEX":     "SENSEX",
};

// ── Option instruments ────────────────────────────────────────────────────────
const optionInstruments = new Set();

// ── Stock instruments for backtest live tracking ──────────────────────────────
// Stored as a Set so they survive reconnects — resubscribeAll() uses this Set
const stockInstruments = new Set();

// ── FIX 2: Per-symbol prevClose cache ────────────────────────────────────────
// Upstox sends ltpc.cp = previous close. After market hours / on reconnect,
// cp often comes as 0 which makes % change show as 0%. We cache the first valid
// cp per symbol so the correct % is always shown even after reconnects.
const prevCloseCache = new Map();

function getSafePrevClose(key, ltpc, currentPrice) {
  const cp = parseFloat(ltpc.cp || 0);
  if (cp > 0) {
    prevCloseCache.set(key, cp);   // cache valid value
    return cp;
  }
  // cp=0 (post-market / reconnect) — use our cached value
  const cached = prevCloseCache.get(key);
  if (cached && cached > 0) return cached;
  return currentPrice; // last resort — shows 0% change, better than wrong %
}

function subscribeOptions(instrKeys) {
  if (!instrKeys || !instrKeys.length) return;
  const newKeys = instrKeys.filter(k => !optionInstruments.has(k));
  if (!newKeys.length) return;
  newKeys.forEach(k => optionInstruments.add(k));
  console.log(`📡 Upstox: queuing ${newKeys.length} option instruments`);
  if (streamer) {
    try {
      streamer.subscribe(newKeys, "full_d30");
      console.log(`✅ Upstox: subscribed ${newKeys.length} option instruments (full_d30)`);
    } catch (e) {
      console.warn("⚠️ Upstox option subscribe error:", e.message);
    }
  }
}

// ── FIX 1: subscribeStocksForBacktest ────────────────────────────────────────
// Adds keys to stockInstruments Set. resubscribeAll() (called on every "open")
// will re-subscribe the full Set so reconnects never lose subscriptions.
function subscribeStocksForBacktest(symbols) {
  if (!symbols || !symbols.length) return;
  const keys    = symbols.map(s => `NSE_EQ|${s.toUpperCase()}`);
  const newKeys = keys.filter(k => !stockInstruments.has(k));
  if (!newKeys.length) return;
  newKeys.forEach(k => stockInstruments.add(k));
  if (streamer) {
    try {
      streamer.subscribe(newKeys, "ltpc");
      console.log(`📡 Upstox: subscribed ${newKeys.length} stocks for backtest live tracking`);
    } catch (e) {
      console.warn("⚠️ Upstox stock subscribe error:", e.message);
    }
  } else {
    console.log(`📡 Upstox: queued ${newKeys.length} stocks (will subscribe on next connect)`);
  }
}

function getAccessToken() {
  return currentToken || process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN || "";
}

// ── Parse and emit ticks ──────────────────────────────────────────────────────
function parseAndEmit(raw) {
  try {
    const text = typeof raw === "string" ? raw : raw.toString("utf-8");
    if (!text || text.trim() === "") return;
    const data    = JSON.parse(text);
    const feeds   = data?.feeds || data?.feed || {};
    const updates = [];

    for (const [key, feed] of Object.entries(feeds)) {
      const ff   = feed?.ff || feed;
      const name = NAME_MAP[key];

      // ── INDEX tick ────────────────────────────────────────────────────────
      if (name) {
        const ltpc =
          ff?.indexFF?.ltpc  ||
          ff?.marketFF?.ltpc ||
          feed?.ltpc         ||
          null;

        if (ltpc) {
          const price = parseFloat(ltpc.ltp || 0);
          if (price) {
            // FIX 2: safe prevClose — never resets to 0% after market close
            const prev = getSafePrevClose(name, ltpc, price);
            const diff = parseFloat((price - prev).toFixed(2));
            const pct  = prev > 0 ? parseFloat(((diff / prev) * 100).toFixed(2)) : 0;
            const up   = diff >= 0;

            updates.push({
              name,
              price:  price.toLocaleString("en-IN", { maximumFractionDigits: 2 }),
              raw:    price,
              change: (up ? "+" : "") + diff.toFixed(2),
              pct:    (up ? "+" : "") + pct.toFixed(2) + "%",
              up,
              _ts:    Date.now(),
            });

            if (typeof ltpTickHandler === "function") {
              const gannSym = GANN_SYMBOL_MAP[name] || name;
              ltpTickHandler(gannSym, price);
            }
          }
        }
        continue;
      }

      // ── OPTION tick ───────────────────────────────────────────────────────
      if (key.startsWith("NSE_FO|") || key.startsWith("BSE_FO|")) {
        if (oiTickHandler) oiTickHandler(key, ff || {});
        continue;
      }

      // ── STOCK tick — forward to backtest engine ───────────────────────────
      if (key.startsWith("NSE_EQ|") || key.startsWith("BSE_EQ|")) {
        if (backtestEngine) {
          const ltpc =
            ff?.equityFF?.ltpc ||
            ff?.marketFF?.ltpc ||
            feed?.ltpc         ||
            null;
          if (ltpc) {
            const price = parseFloat(ltpc.ltp || 0);
            if (price > 0) {
              const symbol = key.replace("NSE_EQ|", "").replace("BSE_EQ|", "");
              backtestEngine.onLTPTick(symbol, price);
            }
          }
        }
        continue;
      }
    }

    if (updates.length > 0 && ioRef) {
      ioRef.emit("market-tick", updates);
    }
  } catch (_) {
    // silently skip malformed ticks
  }
}

// ── Streamer lifecycle ────────────────────────────────────────────────────────
function stopStreamer() {
  if (reconnTimer) { clearTimeout(reconnTimer); reconnTimer = null; }
  if (streamer) {
    try {
      if (typeof streamer.clearSubscriptions === "function") streamer.clearSubscriptions();
      streamer.disconnect();
    } catch { /* ok */ }
    streamer = null;
  }
}

// ── FIX 1: resubscribeAll — called on every "open" event ─────────────────────
// Subscribes indexes + options + ALL backtest stocks from their Sets.
// This means reconnects automatically restore all subscriptions.
function resubscribeAll() {
  if (!streamer) return;

  // Indexes (always)
  try {
    streamer.subscribe(INDEX_INSTRUMENTS, "ltpc");
    console.log("📡 Upstox: subscribed 3 index instruments (ltpc)");
  } catch (e) {
    console.log("⚠️  Upstox index subscribe error:", e.message);
  }

  // Options (if any)
  if (optionInstruments.size > 0) {
    try {
      streamer.subscribe(Array.from(optionInstruments), "full_d30");
      console.log(`📡 Upstox: re-subscribed ${optionInstruments.size} option instruments`);
    } catch (e) {
      console.log("⚠️  Upstox option subscribe error:", e.message);
    }
  }

  // FIX 1: Backtest stocks — re-subscribed on EVERY reconnect
  if (stockInstruments.size > 0) {
    try {
      streamer.subscribe(Array.from(stockInstruments), "ltpc");
      console.log(`📡 Upstox: re-subscribed ${stockInstruments.size} backtest stocks`);
    } catch (e) {
      console.log("⚠️  Upstox stock re-subscribe error:", e.message);
    }
  }
}

function startStreamer(accessToken, io) {
  if (!UpstoxClient) { console.log("⚠️  upstox-js-sdk not available"); return; }
  if (!accessToken)  { console.log("⚠️  Upstox stream: no access token"); return; }

  currentToken = accessToken;
  ioRef        = io;
  stopStreamer();

  try {
    const defaultClient        = UpstoxClient.ApiClient.instance;
    const oauth2               = defaultClient.authentications["OAUTH2"];
    oauth2.accessToken         = accessToken;

    streamer = new UpstoxClient.MarketDataStreamerV3();

    streamer.on("open", () => {
      console.log("✅ Upstox Market WebSocket connected");
      // FIX 1: always resubscribe ALL instruments after every connect/reconnect
      resubscribeAll();
      if (ioRef) ioRef.emit("upstox-status", { connected: true });
    });

    streamer.on("message", parseAndEmit);

    streamer.on("close", () => {
      console.log("⚠️  Upstox WS closed — reconnecting in 5s");
      if (ioRef) ioRef.emit("upstox-status", { connected: false });
      streamer    = null;
      reconnTimer = setTimeout(() => {
        if (currentToken) startStreamer(currentToken, ioRef);
      }, 5000);
    });

    streamer.on("error", (e) => {
      console.log("⚠️  Upstox WS error:", e?.message || e);
    });

    streamer.connect();
    console.log("🔌 Upstox Market WebSocket connecting...");
  } catch (e) {
    console.log("❌ Upstox streamer init failed:", e.message);
    streamer    = null;
    reconnTimer = setTimeout(() => {
      if (currentToken) startStreamer(currentToken, ioRef);
    }, 10000);
  }
}

module.exports = {
  startStreamer,
  stopStreamer,
  subscribeOptions,
  setOITickHandler,
  setLTPTickHandler,
  getAccessToken,
  setBacktestEngine,
  subscribeStocksForBacktest,
};