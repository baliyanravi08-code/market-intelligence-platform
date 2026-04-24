"use strict";

/**
 * upstoxStream.js
 * Location: server/services/upstoxStream.js
 *
 * FIX: Patches MarketDataStreamerV3's internal streamer.clearSubscriptions
 *      which doesn't exist in this SDK version, causing a crash on reconnect.
 */

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

const optionInstruments    = new Set();
const stockInstruments     = new Set();
const stockInstrumentKeys  = new Set();
const instrKeyToSymbol     = new Map();
const prevCloseCache       = new Map();

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
  if (streamer) {
    try {
      streamer.subscribe(newKeys, "full_d30");
      console.log(`✅ Upstox: subscribed ${newKeys.length} option instruments`);
    } catch (e) {
      console.warn("⚠️ Upstox option subscribe error:", e.message);
    }
  }
}

function subscribeStocksForBacktest(symbols) {
  if (!symbols || !symbols.length) return;
  const keys    = symbols.map(s => `NSE_EQ|${s.toUpperCase()}`);
  const newKeys = keys.filter(k => !stockInstruments.has(k));
  if (!newKeys.length) return;
  newKeys.forEach(k => stockInstruments.add(k));
  for (const sym of symbols) {
    instrKeyToSymbol.set(`NSE_EQ|${sym.toUpperCase()}`, sym.toUpperCase());
  }
  if (streamer) {
    try {
      streamer.subscribe(newKeys, "ltpc");
      console.log(`📡 Upstox: subscribed ${newKeys.length} stocks for live tracking`);
    } catch (e) {
      console.warn("⚠️ Upstox stock subscribe error:", e.message);
    }
  } else {
    console.log(`📡 Upstox: queued ${newKeys.length} stocks (will subscribe on next connect)`);
  }
}

function subscribeWithInstrumentKeys(instrKeys, symbolMap) {
  if (!instrKeys || !instrKeys.length) return;
  const newKeys = instrKeys.filter(k => !stockInstrumentKeys.has(k));
  if (!newKeys.length) {
    console.log("📡 Upstox: all instrument keys already subscribed");
    return;
  }
  newKeys.forEach(k => stockInstrumentKeys.add(k));

  if (symbolMap && typeof symbolMap === "object") {
    for (const [sym, key] of Object.entries(symbolMap)) {
      instrKeyToSymbol.set(key, sym.toUpperCase());
    }
  }

  if (streamer) {
    try {
      streamer.subscribe(newKeys, "ltpc");
      console.log(`📡 Upstox: subscribed ${newKeys.length} stocks (instrument key format)`);
    } catch (e) {
      console.warn("⚠️ Upstox instrument key subscribe error:", e.message);
    }
  } else {
    console.log(`📡 Upstox: queued ${newKeys.length} instrument keys`);
  }
}

function getAccessToken() {
  return currentToken || process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN || "";
}

let _scanner = null;
function getScanner() {
  if (!_scanner) {
    try {
      _scanner = require("./intelligence/marketScanner");
    } catch (_) {}
  }
  return _scanner;
}

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
            const cp = parseFloat(ltpc.cp || 0);
            if (cp > 0) prevCloseCache.set(key, cp);
            const prevClose = prevCloseCache.get(key) || null;

            let changePct = null;
            let change    = null;
            if (prevClose && prevClose > 0) {
              change    = Math.round((price - prevClose) * 100) / 100;
              changePct = Math.round(((price - prevClose) / prevClose) * 10000) / 100;
            }

            let symbol = instrKeyToSymbol.get(key);
            if (!symbol) {
              symbol = key.replace(/^(NSE_EQ|BSE_EQ)\|/, "");
            }

            if (ioRef) {
              ioRef.emit("backtest-live-tick", { symbol, price, prevClose, change, changePct });
            }

            const scanner = getScanner();
            if (scanner && typeof scanner.applyLiveTick === "function") {
              scanner.applyLiveTick({ symbol, price, changePct, change });
            }

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

/**
 * CRITICAL FIX: Patch the internal WebSocket object inside the streamer
 * to add a no-op clearSubscriptions() method, preventing the SDK crash.
 * The SDK calls this.streamer.clearSubscriptions() on reconnect, but the
 * underlying ws object doesn't have this method in this SDK version.
 */
function patchStreamerInternals(streamerInstance) {
  // Patch after a tick so the internal ws is initialized
  setImmediate(() => {
    try {
      // The SDK stores its internal ws as this.streamer inside MarketDataStreamerV3
      // We need to patch it wherever it lives
      if (streamerInstance._streamer && typeof streamerInstance._streamer.clearSubscriptions === "undefined") {
        streamerInstance._streamer.clearSubscriptions = () => {};
      }
      // Also patch the streamer property directly (different SDK versions use different names)
      if (streamerInstance.streamer && typeof streamerInstance.streamer.clearSubscriptions === "undefined") {
        streamerInstance.streamer.clearSubscriptions = () => {};
      }
    } catch (_) {}
  });

  // Also override the attemptReconnect-like behavior by wrapping
  // We intercept the close event at the raw ws level
  const origConnect = streamerInstance.connect?.bind(streamerInstance);
  if (origConnect) {
    streamerInstance.connect = function(...args) {
      const result = origConnect(...args);
      // After connect, patch internal ws
      setTimeout(() => {
        try {
          if (streamerInstance._streamer && !streamerInstance._streamer.clearSubscriptions) {
            streamerInstance._streamer.clearSubscriptions = () => {};
          }
          if (streamerInstance.streamer && !streamerInstance.streamer.clearSubscriptions) {
            streamerInstance.streamer.clearSubscriptions = () => {};
          }
        } catch (_) {}
      }, 500);
      return result;
    };
  }

  return streamerInstance;
}

function stopStreamer() {
  if (reconnTimer) { clearTimeout(reconnTimer); reconnTimer = null; }
  if (streamer) {
    try {
      // Safely call clearSubscriptions if available
      if (typeof streamer.clearSubscriptions === "function") streamer.clearSubscriptions();
      streamer.disconnect();
    } catch { /* ok */ }
    streamer = null;
  }
}

function resubscribeAll() {
  if (!streamer) return;

  try {
    streamer.subscribe(INDEX_INSTRUMENTS, "ltpc");
    console.log("📡 Upstox: subscribed 3 index instruments (ltpc)");
  } catch (e) {
    console.log("⚠️  Upstox index subscribe error:", e.message);
  }

  if (optionInstruments.size > 0) {
    try {
      streamer.subscribe(Array.from(optionInstruments), "full_d30");
      console.log(`📡 Upstox: re-subscribed ${optionInstruments.size} option instruments`);
    } catch (e) {
      console.log("⚠️  Upstox option subscribe error:", e.message);
    }
  }

  if (stockInstruments.size > 0) {
    try {
      streamer.subscribe(Array.from(stockInstruments), "ltpc");
      console.log(`📡 Upstox: re-subscribed ${stockInstruments.size} stocks (symbol format)`);
    } catch (e) {
      console.log("⚠️  Upstox stock re-subscribe error:", e.message);
    }
  }

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

    const newStreamer = new UpstoxClient.MarketDataStreamerV3();

    // ── CRITICAL FIX: Disable SDK's internal reconnect entirely ──────────
    // The SDK's attemptReconnect calls clearSubscriptions which doesn't exist.
    // We handle reconnection ourselves in the 'close' event below.
    if (newStreamer.attemptReconnect) {
      newStreamer.attemptReconnect = function() {
        // no-op — we handle reconnect ourselves
      };
    }

    // Patch internal streamer object after connect
    patchStreamerInternals(newStreamer);

    newStreamer.on("open", () => {
      console.log("✅ Upstox Market WebSocket connected");
      // Patch again after open in case internal ws was re-created
      setTimeout(() => {
        try {
          if (newStreamer._streamer && !newStreamer._streamer.clearSubscriptions) {
            newStreamer._streamer.clearSubscriptions = () => {};
          }
          if (newStreamer.streamer && !newStreamer.streamer.clearSubscriptions) {
            newStreamer.streamer.clearSubscriptions = () => {};
          }
        } catch (_) {}
      }, 100);
      resubscribeAll();
      if (ioRef) ioRef.emit("upstox-status", { connected: true });
    });

    newStreamer.on("message", parseAndEmit);

    newStreamer.on("close", () => {
      console.log("⚠️  Upstox WS closed — reconnecting in 5s");
      if (ioRef) ioRef.emit("upstox-status", { connected: false });
      streamer    = null;
      reconnTimer = setTimeout(() => {
        if (currentToken) startStreamer(currentToken, ioRef);
      }, 5000);
    });

    newStreamer.on("error", (e) => {
      console.log("⚠️  Upstox WS error:", e?.message || e);
    });

    streamer = newStreamer;
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
  subscribeWithInstrumentKeys,
};