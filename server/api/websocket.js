"use strict";

/**
 * server/api/websocket.js
 *
 * FIXES:
 *  1. Merged sector + option-chain into one Socket.io instance
 *  2. Heartbeat ping/pong (25s interval, 10s timeout)
 *  3. Per-socket room subscriptions for option chains
 *  4. emitChainUpdate() for option chain engine
 *  5. broadcastUpstoxStatus()
 *  6. _intelCache — stores latest options-intelligence per symbol
 *  7. Replays all cached intel to new socket connections
 *  8. "request-intel-snapshot" handler
 *  9. FIX: setGannIntegration() — wires gannIntegration into websocket so
 *     "get-gann-analysis" events are handled even when the client connects
 *     before gannIntegration registers its own socket listeners.
 * 10. FIX: "get-gann-analysis" handler normalises symbol before forwarding.
 * 11. candle:subscribe / candle:unsubscribe handlers for Stockterminal live
 *     candle streaming via upstoxStream candle aggregator.
 */

const { Server } = require("socket.io");
const { subscribe } = require("../queue");

let _io = null;

// ── Gann integration reference (set from coordinator.js after boot) ───────────
let _gannIntegration = null;

function setGannIntegration(gi) {
  _gannIntegration = gi;
  console.log("📐 websocket.js: gannIntegration wired");
}

// ── upstoxStream lazy-loader ──────────────────────────────────────────────────
let _upstoxStream = null;
function getStream() {
  if (!_upstoxStream) {
    try { _upstoxStream = require("../services/upstoxStream"); } catch (_) {}
  }
  return _upstoxStream;
}

// ── Symbol normaliser (mirrors gannIntegration.normaliseSymbol) ───────────────
function normaliseSymbol(raw) {
  if (!raw) return "";
  return raw
    .toUpperCase()
    .trim()
    .replace(/^NIFTY\s+50$/, "NIFTY")
    .replace(/^NIFTY50$/, "NIFTY")
    .replace(/^BANK\s+NIFTY$/, "BANKNIFTY")
    .replace(/^NIFTY\s+BANK$/, "BANKNIFTY")
    .replace(/\s+/g, "");
}

function emitChainUpdate(underlying, data) {
  if (!_io) return;
  _io.to(`chain:${underlying}`).emit("option-chain-update", { underlying, data });
}

function broadcastUpstoxStatus(connected) {
  if (!_io) return;
  _io.emit("upstox-status", { connected });
}

// ── Intel snapshot cache ───────────────────────────────────────────────────────
const _intelCache    = new Map();
const _chainCache    = new Map();
const _expiriesCache = new Map();

function setCachedIntel(symbol, payload) {
  if (!symbol || !payload) return;
  _intelCache.set(symbol.toUpperCase(), payload);
}

function getCachedIntel(symbol) {
  if (!symbol) return null;
  return _intelCache.get(symbol.toUpperCase()) || null;
}

function setCachedChain(underlying, expiry, data) {
  _chainCache.set(`${underlying}_${expiry}`, data);
}

function getCachedChain(underlying, expiry) {
  if (!expiry) {
    for (const [key, val] of _chainCache) {
      if (key.startsWith(`${underlying}_`)) return val;
    }
    return null;
  }
  return _chainCache.get(`${underlying}_${expiry}`) || null;
}

function setCachedExpiries(underlying, expiries) {
  _expiriesCache.set(underlying, expiries);
  if (_io) _io.emit("option-expiries", { underlying, expiries });
}

function getCachedExpiries(underlying) {
  return _expiriesCache.get(underlying) || [];
}

/**
 * Attach Socket.io to an existing Express http.Server.
 */
function attachSocketIO(server) {
  const io = new Server(server, {
    cors:         { origin: "*" },
    pingInterval: 25000,
    pingTimeout:  10000,
    transports:   ["websocket", "polling"],
  });

  _io = io;

  subscribe("SECTOR_UPDATED", (data) => {
    io.emit("update", data);
  });

  io.on("connection", (socket) => {
    console.log(`👤 Client connected: ${socket.id}`);

    // Replay latest options-intelligence snapshots immediately
    if (_intelCache.size > 0) {
      for (const [, payload] of _intelCache) {
        socket.emit("options-intelligence", payload);
      }
      console.log(`📤 Replayed ${_intelCache.size} intel snapshot(s) to ${socket.id}`);
    }

    // ── Heartbeat ─────────────────────────────────────────────────────────
    socket.on("ping", () => socket.emit("pong"));

    // ── Explicit snapshot replay ───────────────────────────────────────────
    socket.on("request-intel-snapshot", () => {
      if (_intelCache.size === 0) return;
      for (const [, payload] of _intelCache) {
        socket.emit("options-intelligence", payload);
      }
      console.log(`📤 On-demand snapshot → ${socket.id} (${_intelCache.size} symbols)`);
    });

    // ── FIX: Gann analysis handler ─────────────────────────────────────────
    // Handles "get-gann-analysis" here as a safety net — works even if the
    // client connects before gannIntegration wires its own listeners.
    socket.on("get-gann-analysis", ({ symbol, ltp } = {}) => {
      if (!symbol) return;
      const sym = normaliseSymbol(symbol);

      if (_gannIntegration?.getGannAnalysis) {
        const analysis = _gannIntegration.getGannAnalysis(sym, ltp);
        if (analysis) {
          socket.emit("gann-analysis", analysis);
          console.log(`📤 gann-analysis [websocket.js] → ${socket.id} [${sym}]`);
          return;
        }
      }

      console.warn(`⚠️  get-gann-analysis: no result for ${sym} ltp=${ltp} — gannIntegration=${!!_gannIntegration}`);
    });

    // ── Option chain subscription ──────────────────────────────────────────
    socket.on("request-option-chain", ({ underlying, expiry } = {}) => {
      if (!underlying) return;
      const prevRooms = [...socket.rooms].filter(r => r.startsWith("chain:"));
      prevRooms.forEach(r => socket.leave(r));
      const room = `chain:${underlying}`;
      socket.join(room);
      console.log(`📊 ${socket.id} subscribed to ${room} expiry=${expiry}`);
      const cached = getCachedChain(underlying, expiry);
      if (cached) socket.emit("option-chain-update", { underlying, data: cached });
      const expiries = getCachedExpiries(underlying);
      if (expiries.length > 0) socket.emit("option-expiries", { underlying, expiries });
    });

    socket.on("request-expiries", ({ underlying } = {}) => {
      if (!underlying) return;
      const expiries = getCachedExpiries(underlying);
      socket.emit("option-expiries", { underlying, expiries: expiries || [] });
    });

    // ── Live candle subscriptions (Stockterminal) ──────────────────────────
    // payload: { symbol: "FLUOROCHEM", tf: "5min" }
    let watchedSymbol = null;
    let watchedTf     = null;

    socket.on("candle:subscribe", ({ symbol, tf } = {}) => {
      if (!symbol || !tf) return;
      const stream = getStream();
      if (!stream) return;
      // Unsubscribe previous watch if changed
      if (watchedSymbol && watchedTf) {
        stream.unregisterLiveCandleSubscription(watchedSymbol, watchedTf);
      }
      watchedSymbol = symbol.toUpperCase().trim();
      watchedTf     = tf;
      stream.registerLiveCandleSubscription(watchedSymbol, watchedTf);
      console.log(`📺 Socket ${socket.id} subscribed to live candles: ${watchedSymbol} @ ${watchedTf}`);
    });

    socket.on("candle:unsubscribe", ({ symbol, tf } = {}) => {
      const stream = getStream();
      if (!stream) return;
      const sym = (symbol || watchedSymbol || "").toUpperCase().trim();
      const t   = tf || watchedTf;
      if (sym && t) stream.unregisterLiveCandleSubscription(sym, t);
    });

    // ── Disconnect & error ─────────────────────────────────────────────────
    socket.on("disconnect", (reason) => {
      console.log(`👋 Client disconnected: ${socket.id} — ${reason}`);
      // Clean up candle subscription
      const stream = getStream();
      if (stream && watchedSymbol && watchedTf) {
        stream.unregisterLiveCandleSubscription(watchedSymbol, watchedTf);
      }
    });

    socket.on("error", (err) => {
      console.error(`Socket error [${socket.id}]:`, err.message);
    });
  });

  console.log("🌐 Socket.io server attached (option chain + sector + Gann + candles)");
  return io;
}

module.exports = {
  attachSocketIO,
  emitChainUpdate,
  broadcastUpstoxStatus,
  setCachedChain,
  setCachedExpiries,
  getCachedChain,
  getCachedExpiries,
  setCachedIntel,
  getCachedIntel,
  setGannIntegration,    // ← call from coordinator.js after startGannIntegration
};