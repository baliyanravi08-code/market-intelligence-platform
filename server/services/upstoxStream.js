/**
 * upstoxStream.js
 * Location: server/services/upstoxStream.js
 *
 * FIXES:
 *  1. Stock subscriptions now persist across reconnects — on every "open" event,
 *     ALL queued stocks are re-subscribed automatically via resubscribeAll()
 *  2. Day-end price display fixed — tracks prevClose per symbol in prevCloseCache
 *     so % change never resets to zero when Upstox sends cp=0 after market close
 *  3. Backtest engine wired for auto WIN/LOSS resolution
 *  4. Stock ticks now always emit backtest-live-tick to frontend for live prices
 *  5. NEW: subscribeWithInstrumentKeys(keys) — accepts pre-resolved NSE_EQ|ISIN keys
 *     directly, bypassing the NSE_EQ|SYMBOL mapping in subscribeStocksForBacktest.
 *     This is the correct path for scanner stock subscriptions.
 *  6. FIX: parseAndEmit now extracts symbol name from instrument key properly
 *     so backtest-live-tick fires even when key format is NSE_EQ|INE002A01018
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

// ── Stock instruments for live tracking ──────────────────────────────────────
// FIX: Two sets — one for ISIN-based keys (NSE_EQ|INE002A01018),
// one for symbol-based keys (NSE_EQ|RELIANCE). Both work with Upstox WS,
// but ISIN-based keys are more reliable.
const stockInstruments = new Set();           // symbol-based: NSE_EQ|RELIANCE
const stockInstrumentKeys = new Set();         // ISIN-based:   NSE_EQ|INE002A01018

// FIX: Reverse map from instrument key → trading symbol
// so parseAndEmit can emit backtest-live-tick with the right symbol
const instrKeyToSymbol = new Map();

// ── Per-symbol prevClose cache ────────────────────────────────────────────────
const prevCloseCache = new Map();

function getSafePrevClose(key, ltpc, currentPrice) {
  const cp = parseFloat(ltpc.cp || 0);
  if (cp > 0) {
    prevCloseCache.set(key, cp);
    return cp;
  }
  const cached = prevCloseCache.get(key);
  if (cached && cached > 0) return cached;
  return currentPrice;
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

// ── subscribeStocksForBacktest ────────────────────────────────────────────────
// Legacy path: converts symbol → NSE_EQ|SYMBOL format.
// Still works but subscribeWithInstrumentKeys is preferred for scanner stocks.
function subscribeStocksForBacktest(symbols) {
  if (!symbols || !symbols.length) return;
  const keys    = symbols.map(s => `NSE_EQ|${s.toUpperCase()}`);
  const newKeys = keys.filter(k => !stockInstruments.has(k));
  if (!newKeys.length) return;
  newKeys.forEach(k => stockInstruments.add(k));
  // Build reverse map: NSE_EQ|RELIANCE → RELIANCE
  for (const sym of symbols) {
    instrKeyToSymbol.set(`NSE_EQ|${sym.toUpperCase()}`, sym.toUpperCase());
  }
  if (streamer) {
    try {
      streamer.subscribe(newKeys, "ltpc");
      console.log(`📡 Upstox: subscribed ${newKeys.length} stocks (symbol format) for live tracking`);
    } catch (e) {
      console.warn("⚠️ Upstox stock subscribe error:", e.message);
    }
  } else {
    console.log(`📡 Upstox: queued ${newKeys.length} stocks (will subscribe on next connect)`);
  }
}

// ── subscribeWithInstrumentKeys ───────────────────────────────────────────────
// FIX: New export — accepts pre-resolved instrument keys like NSE_EQ|INE002A01018.
// Called by marketScanner after resolving keys from the instrument master.
// Also accepts a symbolMap to populate instrKeyToSymbol for backtest-live-tick.
function subscribeWithInstrumentKeys(instrKeys, symbolMap) {
  if (!instrKeys || !instrKeys.length) return;
  const newKeys = instrKeys.filter(k => !stockInstrumentKeys.has(k));
  if (!newKeys.length) {
    console.log("📡 Upstox: all instrument keys already subscribed");
    return;
  }
  newKeys.forEach(k => stockInstrumentKeys.add(k));

  // Build reverse map if provided
  if (symbolMap && typeof symbolMap === "object") {
    for (const [sym, key] of Object.entries(symbolMap)) {
      instrKeyToSymbol.set(key, sym.toUpperCase());
    }
  }

  if (streamer) {
    try {
      streamer.subscribe(newKeys, "ltpc");
      console.log(`📡 Upstox: subscribed ${newKeys.length} stocks (instrument key format) for live tracking`);
    } catch (e) {
      console.warn("⚠️ Upstox instrument key subscribe error:", e.message);
    }
  } else {
    console.log(`📡 Upstox: queued ${newKeys.length} instrument keys (will subscribe on next connect)`);
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

      // ── STOCK tick ────────────────────────────────────────────────────────
      if (key.startsWith("NSE_EQ|") || key.startsWith("BSE_EQ|")) {
        const ltpc =
          ff?.equityFF?.ltpc ||
          ff?.marketFF?.ltpc ||
          feed?.ltpc         ||
          null;
        if (ltpc) {
          const price = parseFloat(ltpc.ltp || 0);
          if (price > 0) {
            // FIX: Resolve symbol from key.
            // - instrKeyToSymbol covers ISIN-based keys (NSE_EQ|INE002A01018 → RELIANCE)
            // - Fallback: strip prefix for symbol-based keys (NSE_EQ|RELIANCE → RELIANCE)
            let symbol = instrKeyToSymbol.get(key);
            if (!symbol) {
              // Symbol-format key: NSE_EQ|RELIANCE → RELIANCE
              symbol = key.replace(/^(NSE_EQ|BSE_EQ)\|/, "");
            }

            // Always emit to frontend — every subscribed stock gets live price
            if (ioRef) ioRef.emit("backtest-live-tick", { symbol, price });

            // Also forward to backtest engine for WIN/LOSS auto-resolution
            if (backtestEngine) backtestEngine.onLTPTick(symbol, price);
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

// ── resubscribeAll — called on every "open" event ─────────────────────────────
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

  // Stocks — symbol-format (legacy)
  if (stockInstruments.size > 0) {
    try {
      streamer.subscribe(Array.from(stockInstruments), "ltpc");
      console.log(`📡 Upstox: re-subscribed ${stockInstruments.size} stocks (symbol format)`);
    } catch (e) {
      console.log("⚠️  Upstox stock re-subscribe error:", e.message);
    }
  }

  // Stocks — ISIN instrument key format (new, preferred)
  if (stockInstrumentKeys.size > 0) {
    try {
      streamer.subscribe(Array.from(stockInstrumentKeys), "ltpc");
      console.log(`📡 Upstox: re-subscribed ${stockInstrumentKeys.size} stocks (instrument key format)`);
    } catch (e) {
      console.log("⚠️  Upstox instrument key re-subscribe error:", e.message);
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
  subscribeWithInstrumentKeys,   // ← NEW: accepts pre-resolved ISIN-based keys
};