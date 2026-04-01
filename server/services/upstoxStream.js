/**
 * upstoxStream.js
 * True WebSocket live market data using official Upstox JS SDK v3.
 * Streams NIFTY 50, SENSEX, BANK NIFTY tick-by-tick to frontend via Socket.io.
 *
 * Place at: server/services/upstoxStream.js
 * Install:  npm install upstox-js-sdk
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

const INSTRUMENTS = [
  "NSE_INDEX|Nifty 50",
  "BSE_INDEX|SENSEX",
  "NSE_INDEX|Nifty Bank",
];

const NAME_MAP = {
  "NSE_INDEX|Nifty 50":   "NIFTY 50",
  "BSE_INDEX|SENSEX":     "SENSEX",
  "NSE_INDEX|Nifty Bank": "BANK NIFTY",
};

function parseAndEmit(raw) {
  try {
    const text = typeof raw === "string" ? raw : raw.toString("utf-8");
    if (!text || text.trim() === "") return;
    const data  = JSON.parse(text);
    const feeds = data?.feeds || data?.feed || {};
    const updates = [];

    for (const [key, feed] of Object.entries(feeds)) {
      const name = NAME_MAP[key];
      if (!name) continue;

      // v3 SDK returns ff.indexFF.ltpc for indices
      const ltpc =
        feed?.ff?.indexFF?.ltpc ||
        feed?.ff?.marketFF?.ltpc ||
        feed?.ltpc ||
        null;

      if (!ltpc) continue;

      const price = parseFloat(ltpc.ltp  || 0);
      const prev  = parseFloat(ltpc.cp   || price);
      if (!price) continue;

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
        _ts:    Date.now(), // used by frontend to trigger blink animation
      });
    }

    if (updates.length > 0 && ioRef) {
      ioRef.emit("market-tick", updates);
    }
  } catch (e) {
    // silently skip malformed ticks — happens on ping frames
  }
}

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
      console.log("✅ Upstox Market WebSocket connected — subscribing to indices");
      try {
        streamer.subscribe(INSTRUMENTS, "ltpc");
      } catch (e) {
        console.log("⚠️  Upstox subscribe error:", e.message);
      }
      // Notify frontend that WS is live
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
    // Retry in 10s
    reconnTimer = setTimeout(() => {
      if (currentToken) startStreamer(currentToken, ioRef);
    }, 10000);
  }
}

module.exports = { startStreamer, stopStreamer };