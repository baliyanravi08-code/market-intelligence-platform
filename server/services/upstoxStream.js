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

// ── PATCH: wire live LTP ticks into coordinator (feeds Gann + composite engine)
let registerLTPTick = null;
try {
  ({ registerLTPTick } = require("../../coordinator"));
} catch (e) {
  console.warn("⚠️  coordinator not found — registerLTPTick disabled:", e.message);
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
const optionInstruments = new Set();

// OI tick handler — injected by nseOIListener
let oiTickHandler = null;

/**
 * Register the OI tick handler from nseOIListener.
 */
function setOITickHandler(handler) {
  oiTickHandler = handler;
}

/**
 * Expose current token so other modules (e.g. gannDataFetcher) can read it.
 */
function getAccessToken() {
  return currentToken || process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN || "";
}

/**
 * Subscribe a batch of NSE_FO instrument keys for live OI ticks.
 */
function subscribeOptions(instrKeys) {
  if (!instrKeys || !instrKeys.length) return;
  const newKeys = instrKeys.filter(k => !optionInstruments.has(k));
  if (!newKeys.length) return;

  newKeys.forEach(k => optionInstruments.add(k));
  console.log(`📡 Upstox: queuing ${newKeys.length} option instruments for OI subscription`);

  if (streamer) {
    try {
      streamer.subscribe(newKeys, "full_d30");
      console.log(`✅ Upstox: subscribed ${newKeys.length} option instruments (full_d30)`);
    } catch (e) {
      console.warn("⚠️ Upstox option subscribe error:", e.message);
    }
  }
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

      // ── Index tick ─────────────────────────────────────────────────────────
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

            // ── PATCH: feed Gann re-analysis + composite score engine ─────────
            if (typeof registerLTPTick === "function") {
              registerLTPTick(name, price);
            }
            // ─────────────────────────────────────────────────────────────────
          }
        }
        continue;
      }

      // ── Option instrument tick ─────────────────────────────────────────────
      if (key.startsWith("NSE_FO|") || key.startsWith("BSE_FO|")) {
        if (oiTickHandler) {
          oiTickHandler(key, ff || {});
        }
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
      // Guard against SDK versions where clearSubscriptions may not exist
      if (typeof streamer.clearSubscriptions === "function") {
        streamer.clearSubscriptions();
      }
      streamer.disconnect();
    } catch { /* ok */ }
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

      try {
        streamer.subscribe(INDEX_INSTRUMENTS, "ltpc");
        console.log("📡 Upstox: subscribed 3 index instruments (ltpc)");
      } catch (e) {
        console.log("⚠️  Upstox index subscribe error:", e.message);
      }

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
      // Clear streamer ref before reconnecting to avoid stale state
      streamer = null;
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
    streamer = null;
    reconnTimer = setTimeout(() => {
      if (currentToken) startStreamer(currentToken, ioRef);
    }, 10000);
  }
}

module.exports = { startStreamer, stopStreamer, subscribeOptions, setOITickHandler, getAccessToken };