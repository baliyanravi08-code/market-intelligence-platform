/**
 * upstoxStream.js
 * True WebSocket live market data using official Upstox JS SDK v3.
 * Streams NIFTY 50, SENSEX, BANK NIFTY tick-by-tick to frontend via Socket.io.
 * EXTENDED: Also subscribes NSE_FO option instruments for live OI ticks (Plus plan).
 *
 * Place at: server/services/upstoxStream.js
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

// ── Index instruments (always subscribed) ────────────────────────────────────
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

// ── Option instruments (added dynamically by nseOIListener) ──────────────────
// Set of NSE_FO|... instrument keys to subscribe for OI ticks
const optionInstruments = new Set();

// OI tick handler — injected by nseOIListener
let oiTickHandler = null;

/**
 * Register the OI tick handler from nseOIListener.
 * Called once during startup wiring.
 */
function setOITickHandler(handler) {
  oiTickHandler = handler;
}

/**
 * Subscribe a batch of NSE_FO instrument keys for live OI ticks.
 * Safe to call anytime — queues if streamer not yet open.
 */
function subscribeOptions(instrKeys) {
  if (!instrKeys || !instrKeys.length) return;
  const newKeys = instrKeys.filter(k => !optionInstruments.has(k));
  if (!newKeys.length) return;

  newKeys.forEach(k => optionInstruments.add(k));
  console.log(`📡 Upstox: queuing ${newKeys.length} option instruments for OI subscription`);

  // If streamer is connected, subscribe immediately
  if (streamer) {
    try {
      streamer.subscribe(newKeys, "full_d30");
      console.log(`✅ Upstox: subscribed ${newKeys.length} option instruments (full_d30)`);
    } catch (e) {
      console.warn("⚠️ Upstox option subscribe error:", e.message);
    }
  }
  // If not connected yet, they'll be subscribed on next 'open' event
}

// ── Parse incoming feed ───────────────────────────────────────────────────────
function parseAndEmit(raw) {
  try {
    const text = typeof raw === "string" ? raw : raw.toString("utf-8");
    if (!text || text.trim() === "") return;
    const data  = JSON.parse(text);
    const feeds = data?.feeds || data?.feed || {};
    const updates = [];

    for (const [key, feed] of Object.entries(feeds)) {
      const ff = feed?.ff || feed;

      // ── Index tick (NIFTY / SENSEX / BANKNIFTY price) ─────────────────────
      const name = NAME_MAP[key];
      if (name) {
        const ltpc =
          ff?.indexFF?.ltpc ||
          ff?.marketFF?.ltpc ||
          feed?.ltpc ||
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
          }
        }
        continue; // handled as index
      }

      // ── Option instrument tick (NSE_FO|...) — OI data ─────────────────────
      if (key.startsWith("NSE_FO|") || key.startsWith("BSE_FO|")) {
        if (oiTickHandler) {
          const feedData = ff || {};
          oiTickHandler(key, feedData);
        }
      }
    }

    if (updates.length > 0 && ioRef) {
      ioRef.emit("market-tick", updates);
    }
  } catch (e) {
    // silently skip malformed ticks — happens on ping frames
  }
}

// ── Streamer lifecycle ────────────────────────────────────────────────────────
function stopStreamer() {
  if (reconnTimer) { clearTimeout(reconnTimer); reconnTimer = null; }
  if (streamer) {
    try { streamer.disconnect(); } catch { /* ok */ }
    streamer = null;
  }
}

function startStreamer(accessToken, io) {
  if (!UpstoxClient) {
    console.log("⚠️  upstox-js-sdk not available — run: npm install upstox-js-sdk");
    return;
  }
  if (!accessToken) {
    console.log("⚠️  Upstox stream: no access token");
    return;
  }

  currentToken = accessToken;
  ioRef = io;

  stopStreamer(); // clean up any previous connection

  try {
    const defaultClient = UpstoxClient.ApiClient.instance;
    const oauth2 = defaultClient.authentications["OAUTH2"];
    oauth2.accessToken = accessToken;

    streamer = new UpstoxClient.MarketDataStreamerV3();

    streamer.on("open", () => {
      console.log("✅ Upstox Market WebSocket connected");

      // Subscribe indices (always)
      try {
        streamer.subscribe(INDEX_INSTRUMENTS, "ltpc");
        console.log("📡 Upstox: subscribed 3 index instruments (ltpc)");
      } catch (e) {
        console.log("⚠️  Upstox index subscribe error:", e.message);
      }

      // Subscribe any queued option instruments
      if (optionInstruments.size > 0) {
        try {
          const keys = Array.from(optionInstruments);
          streamer.subscribe(keys, "full_d30");
          console.log(`📡 Upstox: subscribed ${keys.length} option instruments (full_d30)`);
        } catch (e) {
          console.log("⚠️  Upstox option subscribe error:", e.message);
        }
      }

      if (ioRef) ioRef.emit("upstox-status", { connected: true });
    });

    streamer.on("message", (data) => {
      parseAndEmit(data);
    });

    streamer.on("close", () => {
      console.log("⚠️  Upstox WS closed — reconnecting in 5s");
      if (ioRef) ioRef.emit("upstox-status", { connected: false });
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
    reconnTimer = setTimeout(() => {
      if (currentToken) startStreamer(currentToken, ioRef);
    }, 10000);
  }
}

module.exports = { startStreamer, stopStreamer, subscribeOptions, setOITickHandler };