/**
 * upstoxStream.js
 * Place at: server/services/upstoxStream.js
 *
 * FIX: circular dependency causing registerLTPTick = null
 *
 * Root cause: upstoxStream.js was doing:
 *   ({ registerLTPTick } = require("../coordinator"))
 *   at module load time. But coordinator.js requires upstoxStream.js
 *   during its own load — so when upstoxStream runs that require(),
 *   coordinator's exports object is still empty → registerLTPTick = null.
 *   LTP ticks never reached gannIntegration → Gann panel blank.
 *
 * Fix: remove the require("../coordinator") entirely from this file.
 *   Instead expose setLTPTickHandler(fn) — same pattern already used
 *   for setOITickHandler. server.js calls it after both modules are loaded.
 *   Zero circular dependency. LTP ticks now flow correctly.
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

// ── Injected handlers (set via setters after all modules load) ────────────────
let ltpTickHandler = null;   // replaces circular require("../coordinator")
let oiTickHandler  = null;

/**
 * FIX: Call this from server.js AFTER coordinator is loaded.
 * Replaces the broken require("../coordinator") pattern.
 *
 * In server.js .finally() block, add:
 *   const { registerLTPTick } = require("./coordinator");
 *   setLTPTickHandler(registerLTPTick);
 */
function setLTPTickHandler(fn) {
  if (typeof fn === "function") {
    ltpTickHandler = fn;
    console.log("✅ Upstox: LTP tick handler registered (Gann + composite engine wired)");
  }
}

function setOITickHandler(handler) {
  oiTickHandler = handler;
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

      if (name) {
        const ltpc =
          ff?.indexFF?.ltpc  ||
          ff?.marketFF?.ltpc ||
          feed?.ltpc         ||
          null;

        if (ltpc) {
          const price = parseFloat(ltpc.ltp || 0);
          const prev  = parseFloat(ltpc.cp  || price);
          if (price) {
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

            // FIX: use injected handler instead of circular require
            if (typeof ltpTickHandler === "function") {
              const gannSym = GANN_SYMBOL_MAP[name] || name;
              ltpTickHandler(gannSym, price);
            }
          }
        }
        continue;
      }

      // Option tick
      if (key.startsWith("NSE_FO|") || key.startsWith("BSE_FO|")) {
        if (oiTickHandler) oiTickHandler(key, ff || {});
      }
    }

    if (updates.length > 0 && ioRef) {
      ioRef.emit("market-tick", updates);
    }
  } catch (e) {
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

function startStreamer(accessToken, io) {
  if (!UpstoxClient) {
    console.log("⚠️  upstox-js-sdk not available");
    return;
  }
  if (!accessToken) {
    console.log("⚠️  Upstox stream: no access token");
    return;
  }

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
      try {
        streamer.subscribe(INDEX_INSTRUMENTS, "ltpc");
        console.log("📡 Upstox: subscribed 3 index instruments (ltpc)");
      } catch (e) {
        console.log("⚠️  Upstox index subscribe error:", e.message);
      }
      if (optionInstruments.size > 0) {
        try {
          streamer.subscribe(Array.from(optionInstruments), "full_d30");
          console.log(`📡 Upstox: subscribed ${optionInstruments.size} option instruments`);
        } catch (e) {
          console.log("⚠️  Upstox option subscribe error:", e.message);
        }
      }
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
  setLTPTickHandler,   // NEW — wire this in server.js
  getAccessToken,
};