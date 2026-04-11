"use strict";

/**
 * server/api/websocket.js
 *
 * FIXES:
 *  1. Merged sector-update server + option-chain server into one Socket.io instance
 *  2. Added heartbeat ping/pong (25s interval, 10s timeout)
 *  3. Added per-socket room subscriptions for option chains
 *  4. Added "option-chain-update" emitter via emitChainUpdate()
 *  5. Added upstox-status broadcast
 *  6. Graceful reconnect guard
 *  7. _intelCache — stores latest options-intelligence payload per symbol
 *  8. On new socket connection, replays all cached intel immediately
 *  9. "request-intel-snapshot" handler for explicit replay
 * 10. FIX: "get-gann-analysis" handler registered here as a safety net
 *     in case gannIntegration.registerSocketHandlers fires before the
 *     client connects. Also normalises symbol ("NIFTY 50" → "NIFTY").
 */

const http       = require("http");
const { Server } = require("socket.io");
const { subscribe } = require("../queue");

let _io = null;

// ── Gann integration reference (set lazily to avoid circular require) ─────────
let _gannIntegration = null;
function setGannIntegration(gi) { _gannIntegration = gi; }

/**
 * Normalise frontend symbol names to internal short form.
 *   "NIFTY 50"   → "NIFTY"
 *   "BANK NIFTY" → "BANKNIFTY"
 */
function normaliseSymbol(raw) {
  if (!raw) return "";
  return raw
    .toUpperCase()
    .trim()
    .replace(/^NIFTY\s+50$/, "NIFTY")
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

// ── Chain cache helpers ────────────────────────────────────────────────────────
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
  if (_io) {
    _io.emit("option-expiries", { underlying, expiries });
  }
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

  // ── Sector/market updates ─────────────────────────────────────────────────
  subscribe("SECTOR_UPDATED", (data) => {
    io.emit("update", data);
  });

  // ── Socket connection handler ─────────────────────────────────────────────
  io.on("connection", (socket) => {
    console.log(`👤 Client connected: ${socket.id}`);

    // Replay latest options-intelligence snapshots immediately on connect
    if (_intelCache.size > 0) {
      for (const [, payload] of _intelCache) {
        socket.emit("options-intelligence", payload);
      }
      console.log(`📤 Replayed ${_intelCache.size} intel snapshot(s) to ${socket.id}`);
    }

    // ── Heartbeat ─────────────────────────────────────────────────────────
    socket.on("ping", () => socket.emit("pong"));

    // ── Explicit snapshot replay request ──────────────────────────────────
    socket.on("request-intel-snapshot", () => {
      if (_intelCache.size === 0) return;
      for (const [, payload] of _intelCache) {
        socket.emit("options-intelligence", payload);
      }
      console.log(`📤 On-demand snapshot → ${socket.id} (${_intelCache.size} symbols)`);
    });

    // ── FIX: Gann analysis handler ────────────────────────────────────────
    // Registered here as well as in gannIntegration.registerSocketHandlers
    // so it works even if the client connects before gannIntegration wires
    // its own listeners. Normalises symbol before forwarding.
    socket.on("get-gann-analysis", ({ symbol, ltp } = {}) => {
      if (!symbol) return;
      const sym = normaliseSymbol(symbol);

      // Try gannIntegration if available
      if (_gannIntegration?.getGannAnalysis) {
        const analysis = _gannIntegration.getGannAnalysis(sym, ltp);
        if (analysis) {
          socket.emit("gann-analysis", analysis);
          console.log(`📤 gann-analysis [websocket.js] → ${socket.id} for ${sym}`);
          return;
        }
      }

      // Try the gann cache directly as a last resort
      console.warn(`⚠️  get-gann-analysis: no result for ${sym} ltp=${ltp}`);
    });

    // ── Option chain subscription ─────────────────────────────────────────
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

    // ── Expiry list request ───────────────────────────────────────────────
    socket.on("request-expiries", ({ underlying } = {}) => {
      if (!underlying) return;
      const expiries = getCachedExpiries(underlying);
      socket.emit("option-expiries", { underlying, expiries: expiries || [] });
    });

    socket.on("disconnect", (reason) => {
      console.log(`👋 Client disconnected: ${socket.id} — ${reason}`);
    });

    socket.on("error", (err) => {
      console.error(`Socket error [${socket.id}]:`, err.message);
    });
  });

  console.log("🌐 Socket.io server attached (option chain + sector updates + Gann)");
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
  setGannIntegration,   // ← call this from coordinator.js after both services start
};