"use strict";

/**
 * upstoxStream.js
 * Location: server/services/upstoxStream.js
 *
 * RECONNECT FIXES (this session):
 *
 * FIX-RC-1 — isConnecting guard bypassed by stopStreamer():
 *   stopStreamer() was resetting isConnecting = false, so if two callers hit
 *   startStreamer() before the async "open" event fired, both would pass the
 *   guard. Fix: isConnecting is now set to true BEFORE stopStreamer() is called,
 *   and stopStreamer() no longer resets it (only startStreamer controls it).
 *
 * FIX-RC-2 — lastErrorWas401 race condition:
 *   startStreamer() reset lastErrorWas401 = false at the top, so if the "close"
 *   event from the previous 401 fired AFTER the new startStreamer() call began,
 *   the guard was already cleared and another reconnect was scheduled.
 *   Fix: 401 state is tracked per-instance via a local closure variable, not
 *   a module-level flag that gets clobbered by the next call.
 *
 * FIX-RC-3 — Exponential backoff with cap:
 *   Flat 5s reconnect meant 12 attempts/minute during network outages.
 *   Fix: backoff starts at 5s, doubles each failure, caps at 60s.
 *   Resets to 5s on successful open.
 *
 * FIX-RC-4 — Max reconnect attempts before giving up:
 *   No cap meant infinite reconnect loop burning RAM with each dead socket.
 *   Fix: after MAX_RECONNECT_ATTEMPTS (10) consecutive failures, the streamer
 *   stops and emits "upstox-status" { connected: false, reason: "max_retries" }.
 *   A /auth/upstox visit will restart it via the existing token refresh flow.
 *
 * FIX-RC-5 — Multiple pending reconnect timers:
 *   If startStreamer() was called while a reconnTimer was already pending,
 *   two timers would both fire and create two WebSocket instances.
 *   Fix: reconnTimer is always cleared at the top of startStreamer().
 *
 * EXISTING FIXES (kept):
 *   - instrKeyToSymbol Map capped at 500, FIFO eviction
 *   - prevCloseCache Map capped at 500, FIFO eviction
 *   - patchStreamerInternals() for clearSubscriptions crash
 *   - stopStreamer() disconnects cleanly
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
let isConnecting = false;

// FIX-RC-3: exponential backoff state
let reconnectDelay    = 5000;
let reconnectAttempts = 0;
const MIN_RECONNECT_DELAY  =  5_000;
const MAX_RECONNECT_DELAY  = 60_000;
const MAX_RECONNECT_ATTEMPTS = 10;

let ltpTickHandler = null;
let oiTickHandler  = null;
let backtestEngine = null;

const MAX_MAP_ENTRIES = 500;

function evictMapIfNeeded(map, maxSize) {
  if (map.size < maxSize) return;
  const deleteCount = Math.ceil(maxSize * 0.2);
  let i = 0;
  for (const key of map.keys()) {
    if (i++ >= deleteCount) break;
    map.delete(key);
  }
}

function setLTPTickHandler(fn) {
  if (typeof fn === "function") {
    ltpTickHandler = fn;
    console.log("✅ Upstox: LTP tick handler registered");
  }
}

function setOITickHandler(handler) {
  oiTickHandler = handler;
}

function setBacktestEngine(engine) {
  if (engine && typeof engine.onLTPTick === "function") {
    backtestEngine = engine;
    console.log("✅ Upstox: Backtest engine wired");
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

const optionInstruments   = new Set();
const stockInstruments    = new Set();
const stockInstrumentKeys = new Set();

const instrKeyToSymbol = new Map();
const prevCloseCache   = new Map();

function getSafePrevClose(key, ltpc, currentPrice) {
  const cp = parseFloat(ltpc.cp || 0);
  if (cp > 0) {
    evictMapIfNeeded(prevCloseCache, MAX_MAP_ENTRIES);
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
    try { streamer.subscribe(newKeys, "full_d30"); } catch (e) {
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
    evictMapIfNeeded(instrKeyToSymbol, MAX_MAP_ENTRIES);
    instrKeyToSymbol.set(`NSE_EQ|${sym.toUpperCase()}`, sym.toUpperCase());
  }

  if (streamer) {
    try { streamer.subscribe(newKeys, "ltpc"); } catch (e) {
      console.warn("⚠️ Upstox stock subscribe error:", e.message);
    }
  }
}

function subscribeWithInstrumentKeys(instrKeys, symbolMap) {
  if (!instrKeys || !instrKeys.length) return;
  const newKeys = instrKeys.filter(k => !stockInstrumentKeys.has(k));
  if (!newKeys.length) return;
  newKeys.forEach(k => stockInstrumentKeys.add(k));

  if (symbolMap && typeof symbolMap === "object") {
    for (const [sym, key] of Object.entries(symbolMap)) {
      evictMapIfNeeded(instrKeyToSymbol, MAX_MAP_ENTRIES);
      instrKeyToSymbol.set(key, sym.toUpperCase());
    }
  }

  if (streamer) {
    try { streamer.subscribe(newKeys, "ltpc"); } catch (e) {
      console.warn("⚠️ Upstox instrument key subscribe error:", e.message);
    }
  }
}

function getAccessToken() {
  return currentToken || process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN || "";
}

let _scanner = null;
function getScanner() {
  if (!_scanner) {
    try { _scanner = require("./intelligence/marketScanner"); } catch (_) {}
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

      if (key.startsWith("NSE_FO|") || key.startsWith("BSE_FO|")) {
        if (oiTickHandler) oiTickHandler(key, ff || {});
        continue;
      }

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
            if (cp > 0) {
              evictMapIfNeeded(prevCloseCache, MAX_MAP_ENTRIES);
              prevCloseCache.set(key, cp);
            }
            const prevClose = prevCloseCache.get(key) || null;

            let changePct = null;
            let change    = null;
            if (prevClose && prevClose > 0) {
              change    = Math.round((price - prevClose) * 100) / 100;
              changePct = Math.round(((price - prevClose) / prevClose) * 10000) / 100;
            }

            let symbol = instrKeyToSymbol.get(key);
            if (!symbol) symbol = key.replace(/^(NSE_EQ|BSE_EQ)\|/, "");

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
  } catch (_) {}
}

function patchStreamerInternals(streamerInstance) {
  setImmediate(() => {
    try {
      if (streamerInstance._streamer && typeof streamerInstance._streamer.clearSubscriptions === "undefined") {
        streamerInstance._streamer.clearSubscriptions = () => {};
      }
      if (streamerInstance.streamer && typeof streamerInstance.streamer.clearSubscriptions === "undefined") {
        streamerInstance.streamer.clearSubscriptions = () => {};
      }
    } catch (_) {}
  });

  const origConnect = streamerInstance.connect?.bind(streamerInstance);
  if (origConnect) {
    streamerInstance.connect = function (...args) {
      const result = origConnect(...args);
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

// FIX-RC-1: stopStreamer no longer touches isConnecting
// Caller controls isConnecting to prevent the guard being cleared mid-init
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

function resubscribeAll() {
  if (!streamer) return;

  try { streamer.subscribe(INDEX_INSTRUMENTS, "ltpc"); } catch (e) {
    console.log("⚠️  Upstox index subscribe error:", e.message);
  }

  if (optionInstruments.size > 0) {
    try { streamer.subscribe(Array.from(optionInstruments), "full_d30"); } catch (e) {
      console.log("⚠️  Upstox option subscribe error:", e.message);
    }
  }

  if (stockInstruments.size > 0) {
    try { streamer.subscribe(Array.from(stockInstruments), "ltpc"); } catch (e) {
      console.log("⚠️  Upstox stock re-subscribe error:", e.message);
    }
  }

  if (stockInstrumentKeys.size > 0) {
    try { streamer.subscribe(Array.from(stockInstrumentKeys), "ltpc"); } catch (e) {
      console.log("⚠️  Upstox instrument key re-subscribe error:", e.message);
    }
  }
}

// FIX-RC-3: schedule next reconnect with exponential backoff
function scheduleReconnect() {
  reconnectAttempts++;

  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    console.log(`❌ Upstox: max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached — giving up.`);
    console.log("   Visit /auth/upstox to refresh the token and restart the stream.");
    if (ioRef) ioRef.emit("upstox-status", { connected: false, reason: "max_retries" });
    isConnecting = false;
    return;
  }

  console.log(`⚠️  Upstox WS closed — reconnecting in ${reconnectDelay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

  reconnTimer = setTimeout(() => {
    reconnTimer = null;
    if (currentToken) startStreamer(currentToken, ioRef);
  }, reconnectDelay);

  // FIX-RC-3: double the delay, cap at MAX
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

function startStreamer(accessToken, io) {
  if (!UpstoxClient) { console.log("⚠️  upstox-js-sdk not available"); return; }
  if (!accessToken)  { console.log("⚠️  Upstox stream: no access token"); return; }

  // FIX-RC-5: always clear any pending reconnect timer first
  if (reconnTimer) { clearTimeout(reconnTimer); reconnTimer = null; }

  // FIX-RC-1: check guard BEFORE doing anything else
  if (isConnecting) {
    console.log("⚠️  Upstox: already connecting — skipping duplicate startStreamer call");
    return;
  }

  // FIX-RC-1: set guard BEFORE stopStreamer so it stays set throughout init
  isConnecting = true;
  currentToken = accessToken;
  ioRef        = io;

  // Stop any existing streamer cleanly (does NOT reset isConnecting)
  stopStreamer();

  // FIX-RC-2: 401 flag is per-instance via closure, not shared module state
  let thisInstanceGot401 = false;

  try {
    const defaultClient        = UpstoxClient.ApiClient.instance;
    const oauth2               = defaultClient.authentications["OAUTH2"];
    oauth2.accessToken         = accessToken;

    const newStreamer = new UpstoxClient.MarketDataStreamerV3();

    if (newStreamer.attemptReconnect) {
      newStreamer.attemptReconnect = function () { /* no-op — we handle reconnect */ };
    }

    patchStreamerInternals(newStreamer);

    newStreamer.on("open", () => {
      console.log("✅ Upstox Market WebSocket connected");
      isConnecting   = false;
      // FIX-RC-3: reset backoff on successful connect
      reconnectDelay    = MIN_RECONNECT_DELAY;
      reconnectAttempts = 0;

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

    newStreamer.on("error", (e) => {
      const msg = e?.message || String(e);
      console.log("⚠️  Upstox WS error:", msg);

      // FIX-RC-2: set per-instance flag, not module-level flag
      if (msg.includes("401")) {
        thisInstanceGot401 = true;
        console.log("🔑 Upstox token expired (401) — stopping reconnect loop. Visit /auth/upstox to refresh.");
        if (ioRef) ioRef.emit("upstox-status", { connected: false, reason: "token_expired" });
      }
    });

    newStreamer.on("close", () => {
      // FIX-RC-2: read per-instance flag — immune to clobbering by next startStreamer() call
      if (thisInstanceGot401) {
        console.log("⚠️  Upstox WS closed (401 — not retrying)");
        streamer     = null;
        isConnecting = false;
        return;
      }

      if (ioRef) ioRef.emit("upstox-status", { connected: false });
      streamer     = null;
      isConnecting = false;

      // FIX-RC-3/4: exponential backoff with attempt cap
      scheduleReconnect();
    });

    streamer = newStreamer;
    streamer.connect();
    console.log("🔌 Upstox Market WebSocket connecting...");
  } catch (e) {
    console.log("❌ Upstox streamer init failed:", e.message);
    isConnecting = false;
    streamer     = null;
    scheduleReconnect();
  }
}

// Call this when a new token is obtained from /auth/upstox
// Resets backoff so it starts fresh
function restartWithNewToken(accessToken, io) {
  reconnectDelay    = MIN_RECONNECT_DELAY;
  reconnectAttempts = 0;
  startStreamer(accessToken, io);
}

module.exports = {
  startStreamer,
  stopStreamer,
  restartWithNewToken,
  subscribeOptions,
  setOITickHandler,
  setLTPTickHandler,
  getAccessToken,
  setBacktestEngine,
  subscribeStocksForBacktest,
  subscribeWithInstrumentKeys,
};