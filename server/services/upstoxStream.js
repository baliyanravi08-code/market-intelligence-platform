"use strict";

let UpstoxClient = null;
try { UpstoxClient = require("upstox-js-sdk"); } catch (e) { console.warn("⚠️  upstox-js-sdk not installed."); }

let streamer     = null;
let currentToken = null;
let ioRef        = null;
let reconnTimer  = null;
let isConnecting = false;

let reconnectDelay    = 5000;
let reconnectAttempts = 0;
const MIN_RECONNECT_DELAY    =  5_000;
const MAX_RECONNECT_DELAY    = 60_000;
const MAX_RECONNECT_ATTEMPTS = 10;

let ltpTickHandler = null;
let oiTickHandler  = null;
let backtestEngine = null;

const MAX_MAP_ENTRIES = 500;

function evictMapIfNeeded(map, maxSize) {
  if (map.size < maxSize) return;
  const deleteCount = Math.ceil(maxSize * 0.2);
  let i = 0;
  for (const key of map.keys()) { if (i++ >= deleteCount) break; map.delete(key); }
}

function setLTPTickHandler(fn) {
  if (typeof fn === "function") { ltpTickHandler = fn; console.log("✅ Upstox: LTP tick handler registered"); }
}
function setOITickHandler(handler) { oiTickHandler = handler; }
function setBacktestEngine(engine) {
  if (engine && typeof engine.onLTPTick === "function") { backtestEngine = engine; console.log("✅ Upstox: Backtest engine wired"); }
}

const INDEX_INSTRUMENTS = ["NSE_INDEX|Nifty 50", "BSE_INDEX|SENSEX", "NSE_INDEX|Nifty Bank"];
const NAME_MAP = { "NSE_INDEX|Nifty 50": "NIFTY 50", "BSE_INDEX|SENSEX": "SENSEX", "NSE_INDEX|Nifty Bank": "BANK NIFTY" };
const GANN_SYMBOL_MAP = { "NIFTY 50": "NIFTY", "BANK NIFTY": "BANKNIFTY", "SENSEX": "SENSEX" };

const optionInstruments   = new Set();
const stockInstruments    = new Set();
const stockInstrumentKeys = new Set();
const instrKeyToSymbol    = new Map();
const prevCloseCache      = new Map();

function getSafePrevClose(key, ltpc, currentPrice) {
  const cp = parseFloat(ltpc.cp || 0);
  if (cp > 0) { evictMapIfNeeded(prevCloseCache, MAX_MAP_ENTRIES); prevCloseCache.set(key, cp); return cp; }
  const cached = prevCloseCache.get(key);
  if (cached && cached > 0) return cached;
  return currentPrice;
}

function subscribeOptions(instrKeys) {
  if (!instrKeys || !instrKeys.length) return;
  const newKeys = instrKeys.filter(k => !optionInstruments.has(k));
  if (!newKeys.length) return;
  newKeys.forEach(k => optionInstruments.add(k));
  if (streamer) { try { streamer.subscribe(newKeys, "full_d30"); } catch (e) { console.warn("⚠️ option subscribe error:", e.message); } }
}

function subscribeStocksForBacktest(symbols) {
  if (!symbols || !symbols.length) return;
  const keys    = symbols.map(s => `NSE_EQ|${s.toUpperCase()}`);
  const newKeys = keys.filter(k => !stockInstruments.has(k));
  if (!newKeys.length) return;
  newKeys.forEach(k => stockInstruments.add(k));
  for (const sym of symbols) { evictMapIfNeeded(instrKeyToSymbol, MAX_MAP_ENTRIES); instrKeyToSymbol.set(`NSE_EQ|${sym.toUpperCase()}`, sym.toUpperCase()); }
  // FIX-PRICE: "ltpc" → "full" for live ticks
  if (streamer) { try { streamer.subscribe(newKeys, "full"); } catch (e) { console.warn("⚠️ stock subscribe error:", e.message); } }
}

function subscribeWithInstrumentKeys(instrKeys, symbolMap) {
  if (!instrKeys || !instrKeys.length) return;
  const newKeys = instrKeys.filter(k => !stockInstrumentKeys.has(k));
  if (!newKeys.length) return;
  newKeys.forEach(k => stockInstrumentKeys.add(k));
  if (symbolMap && typeof symbolMap === "object") {
    for (const [sym, key] of Object.entries(symbolMap)) { evictMapIfNeeded(instrKeyToSymbol, MAX_MAP_ENTRIES); instrKeyToSymbol.set(key, sym.toUpperCase()); }
  }
  // FIX-PRICE: "ltpc" → "full"
  if (streamer) { try { streamer.subscribe(newKeys, "full"); } catch (e) { console.warn("⚠️ instrument key subscribe error:", e.message); } }
}

function getAccessToken() {
  return currentToken || process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN || "";
}

let _scanner = null;
function getScanner() {
  if (!_scanner) { try { _scanner = require("./intelligence/marketScanner"); } catch (_) {} }
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
        const ltpc = ff?.indexFF?.ltpc || ff?.marketFF?.ltpc || feed?.ltpc || null;
        if (ltpc) {
          const price = parseFloat(ltpc.ltp || 0);
          if (price) {
            const prev = getSafePrevClose(name, ltpc, price);
            const diff = parseFloat((price - prev).toFixed(2));
            const pct  = prev > 0 ? parseFloat(((diff / prev) * 100).toFixed(2)) : 0;
            const up   = diff >= 0;
            updates.push({
              name, price: price.toLocaleString("en-IN", { maximumFractionDigits: 2 }),
              raw: price, change: (up ? "+" : "") + diff.toFixed(2),
              pct: (up ? "+" : "") + pct.toFixed(2) + "%", up, _ts: Date.now(),
            });
            if (typeof ltpTickHandler === "function") ltpTickHandler(GANN_SYMBOL_MAP[name] || name, price);
          }
        }
        continue;
      }

      if (key.startsWith("NSE_FO|") || key.startsWith("BSE_FO|")) {
        if (oiTickHandler) oiTickHandler(key, ff || {});
        continue;
      }

      if (key.startsWith("NSE_EQ|") || key.startsWith("BSE_EQ|")) {
        const ltpc = ff?.equityFF?.ltpc || ff?.marketFF?.ltpc || feed?.ltpc || null;
        if (ltpc) {
          const price = parseFloat(ltpc.ltp || 0);
          if (price > 0) {
            const cp = parseFloat(ltpc.cp || 0);
            if (cp > 0) { evictMapIfNeeded(prevCloseCache, MAX_MAP_ENTRIES); prevCloseCache.set(key, cp); }
            const prevClose = prevCloseCache.get(key) || null;
            let changePct = null, change = null;
            if (prevClose && prevClose > 0) {
              change    = Math.round((price - prevClose) * 100) / 100;
              changePct = Math.round(((price - prevClose) / prevClose) * 10000) / 100;
            }
            let symbol = instrKeyToSymbol.get(key);
            if (!symbol) symbol = key.replace(/^(NSE_EQ|BSE_EQ)\|/, "");
            if (ioRef) ioRef.emit("backtest-live-tick", { symbol, price, prevClose, change, changePct });
            const scanner = getScanner();
            if (scanner && typeof scanner.applyLiveTick === "function") scanner.applyLiveTick({ symbol, price, changePct, change, prevClose });
            if (backtestEngine) backtestEngine.onLTPTick(symbol, price);
          }
        }
        continue;
      }
    }

    if (updates.length > 0 && ioRef) ioRef.emit("market-tick", updates);
  } catch (_) {}
}

function patchStreamerInternals(streamerInstance) {
  setImmediate(() => {
    try {
      if (streamerInstance._streamer && typeof streamerInstance._streamer.clearSubscriptions === "undefined") streamerInstance._streamer.clearSubscriptions = () => {};
      if (streamerInstance.streamer  && typeof streamerInstance.streamer.clearSubscriptions  === "undefined") streamerInstance.streamer.clearSubscriptions  = () => {};
    } catch (_) {}
  });
  const origConnect = streamerInstance.connect?.bind(streamerInstance);
  if (origConnect) {
    streamerInstance.connect = function (...args) {
      const result = origConnect(...args);
      setTimeout(() => {
        try {
          if (streamerInstance._streamer && !streamerInstance._streamer.clearSubscriptions) streamerInstance._streamer.clearSubscriptions = () => {};
          if (streamerInstance.streamer  && !streamerInstance.streamer.clearSubscriptions)  streamerInstance.streamer.clearSubscriptions  = () => {};
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
    try { if (typeof streamer.clearSubscriptions === "function") streamer.clearSubscriptions(); streamer.disconnect(); } catch { /* ok */ }
    streamer = null;
  }
}

function resubscribeAll() {
  if (!streamer) return;
  // FIX-PRICE: all "ltpc" → "full" for continuous live ticks
  try { streamer.subscribe(INDEX_INSTRUMENTS, "full"); } catch (e) { console.log("⚠️  index subscribe error:", e.message); }
  if (optionInstruments.size   > 0) { try { streamer.subscribe(Array.from(optionInstruments),   "full_d30"); } catch (e) { console.log("⚠️  option re-subscribe error:",          e.message); } }
  if (stockInstruments.size    > 0) { try { streamer.subscribe(Array.from(stockInstruments),    "full");     } catch (e) { console.log("⚠️  stock re-subscribe error:",           e.message); } }
  if (stockInstrumentKeys.size > 0) { try { streamer.subscribe(Array.from(stockInstrumentKeys), "full");     } catch (e) { console.log("⚠️  instrument key re-subscribe error:",  e.message); } }
}

function scheduleReconnect() {
  reconnectAttempts++;
  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    console.log(`❌ Upstox: max reconnect attempts reached — giving up.`);
    if (ioRef) ioRef.emit("upstox-status", { connected: false, reason: "max_retries" });
    isConnecting = false;
    return;
  }
  console.log(`⚠️  Upstox WS closed — reconnecting in ${reconnectDelay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  reconnTimer = setTimeout(() => { reconnTimer = null; if (currentToken) startStreamer(currentToken, ioRef); }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

function startStreamer(accessToken, io) {
  if (!UpstoxClient) { console.log("⚠️  upstox-js-sdk not available"); return; }
  if (!accessToken)  { console.log("⚠️  Upstox stream: no access token"); return; }
  if (reconnTimer)   { clearTimeout(reconnTimer); reconnTimer = null; }
  if (isConnecting)  { console.log("⚠️  Upstox: already connecting — skipping duplicate call"); return; }

  isConnecting = true;
  currentToken = accessToken;
  ioRef        = io;
  stopStreamer();

  let thisInstanceGot401 = false;

  try {
    const defaultClient    = UpstoxClient.ApiClient.instance;
    const oauth2           = defaultClient.authentications["OAUTH2"];
    oauth2.accessToken     = accessToken;
    const newStreamer       = new UpstoxClient.MarketDataStreamerV3();
    if (newStreamer.attemptReconnect) newStreamer.attemptReconnect = function () {};
    patchStreamerInternals(newStreamer);

    newStreamer.on("open", () => {
      console.log("✅ Upstox Market WebSocket connected");
      isConnecting      = false;
      reconnectDelay    = MIN_RECONNECT_DELAY;
      reconnectAttempts = 0;
      setTimeout(() => {
        try {
          if (newStreamer._streamer && !newStreamer._streamer.clearSubscriptions) newStreamer._streamer.clearSubscriptions = () => {};
          if (newStreamer.streamer  && !newStreamer.streamer.clearSubscriptions)  newStreamer.streamer.clearSubscriptions  = () => {};
        } catch (_) {}
      }, 100);
      resubscribeAll();
      if (ioRef) ioRef.emit("upstox-status", { connected: true });
    });

    newStreamer.on("message", parseAndEmit);

    newStreamer.on("error", (e) => {
      const msg = e?.message || String(e);
      console.log("⚠️  Upstox WS error:", msg);
      if (msg.includes("401")) {
        thisInstanceGot401 = true;
        console.log("🔑 Upstox token expired (401) — Visit /auth/upstox to refresh.");
        if (ioRef) ioRef.emit("upstox-status", { connected: false, reason: "token_expired" });
      }
    });

    newStreamer.on("close", () => {
      if (thisInstanceGot401) { console.log("⚠️  Upstox WS closed (401 — not retrying)"); streamer = null; isConnecting = false; return; }
      if (ioRef) ioRef.emit("upstox-status", { connected: false });
      streamer     = null;
      isConnecting = false;
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

function restartWithNewToken(accessToken, io) {
  reconnectDelay    = MIN_RECONNECT_DELAY;
  reconnectAttempts = 0;
  startStreamer(accessToken, io);
}

module.exports = {
  startStreamer, stopStreamer, restartWithNewToken,
  subscribeOptions, setOITickHandler, setLTPTickHandler,
  getAccessToken, setBacktestEngine,
  subscribeStocksForBacktest, subscribeWithInstrumentKeys,
};