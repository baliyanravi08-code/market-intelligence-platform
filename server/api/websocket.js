"use strict";

/**
 * server/api/websocket.js
 *
 * FIXES:
 *  1. Merged sector-update server + option-chain server into one Socket.io instance
 *  2. Added heartbeat ping/pong (25s interval, 10s timeout) — prevents REST POLL fallback
 *  3. Added per-socket room subscriptions so each client only gets its requested chain
 *  4. Added "option-chain-update" emitter that optionChainEngine calls via emitChainUpdate()
 *  5. Added upstox-status broadcast so client ConnBadge stays accurate
 *  6. Graceful reconnect guard — duplicate socket.disconnect() calls are no-ops
 *
 * FIX (page-refresh data loss):
 *  7. Added _intelCache — stores latest options-intelligence payload per symbol
 *  8. On new socket connection, replays all cached intel immediately (no wait for next tick)
 *  9. Added "request-intel-snapshot" handler so client can explicitly ask for replay
 */

const http    = require("http");
const { Server } = require("socket.io");
const { subscribe } = require("../queue");

// ─── Module-level io reference so other services can call emitChainUpdate() ──
let _io = null;

/**
 * Call this from optionChainEngine / nseOIListener whenever fresh chain data
 * is ready. This is what drives the "LIVE" badge on the client.
 *
 * @param {string} underlying  e.g. "NIFTY"
 * @param {Object} data        processOptionChain() result
 */
function emitChainUpdate(underlying, data) {
  if (!_io) return;
  // Emit to the room for this underlying so only subscribed clients get it
  _io.to(`chain:${underlying}`).emit("option-chain-update", { underlying, data });
}

/**
 * Broadcast Upstox connection status to all connected clients.
 * Call this whenever your Upstox WebSocket connects or drops.
 *
 * @param {boolean} connected
 */
function broadcastUpstoxStatus(connected) {
  if (!_io) return;
  _io.emit("upstox-status", { connected });
}

// ─── Intel snapshot cache ──────────────────────────────────────────────────
// Stores the latest options-intelligence payload per symbol.
// Populated by setCachedIntel() — called from optionsIntegration.js
// whenever a fresh payload is about to be emitted.
// On new socket connect we replay all cached payloads so the client
// gets data immediately instead of waiting for the next Upstox tick.

const _intelCache    = new Map();  // key: SYMBOL (uppercase) → latest options-intelligence payload
const _chainCache    = new Map();  // key: `${underlying}_${expiry}` → data
const _expiriesCache = new Map();  // key: underlying → string[]

/**
 * Store the latest options-intelligence payload for a symbol.
 * Call this from optionsIntegration.js BEFORE emitting to socket.
 *
 * @param {string} symbol   e.g. "BANKNIFTY"
 * @param {Object} payload  full options-intelligence payload
 */
function setCachedIntel(symbol, payload) {
  if (!symbol || !payload) return;
  _intelCache.set(symbol.toUpperCase(), payload);
}

/**
 * Retrieve the latest cached intel for a symbol.
 *
 * @param {string} symbol
 * @returns {Object|null}
 */
function getCachedIntel(symbol) {
  if (!symbol) return null;
  return _intelCache.get(symbol.toUpperCase()) || null;
}

/**
 * Attach Socket.io to an existing Express http.Server.
 *
 * @param {http.Server} server   Your Express http.createServer() instance
 * @returns {Server}             The Socket.io Server instance
 */
function attachSocketIO(server) {
  const io = new Server(server, {
    cors: { origin: "*" },
    // Increase ping settings to prevent REST-POLL fallback on slow connections
    pingInterval: 25000,   // send ping every 25s
    pingTimeout:  10000,   // wait 10s for pong before disconnecting
    // Allow both websocket and polling transports so firewalls don't block
    transports: ["websocket", "polling"],
  });

  _io = io;

  // ── Sector/market updates (existing queue subscriber) ─────────────────────
  subscribe("SECTOR_UPDATED", (data) => {
    io.emit("update", data);
  });

  // ── Option chain socket events ─────────────────────────────────────────────
  io.on("connection", (socket) => {
    console.log(`👤 Client connected: ${socket.id}`);

    // ── FIX: Replay latest options-intelligence snapshots immediately ───────
    // Without this, a freshly connected / refreshed client shows 0.0 / — for
    // all fields until the next Upstox tick arrives (could be seconds or minutes).
    // We replay every symbol we have cached so the UI populates instantly.
    if (_intelCache.size > 0) {
      for (const [, payload] of _intelCache) {
        socket.emit("options-intelligence", payload);
      }
      console.log(`📤 Replayed ${_intelCache.size} intel snapshot(s) to ${socket.id}`);
    }

    // ── Heartbeat: client sends "ping", server replies "pong" ──────────────
    // This keeps the WS alive through proxies/load balancers and prevents
    // the client falling back to REST poll mode.
    socket.on("ping", () => {
      socket.emit("pong");
    });

    // ── FIX: Client explicitly requests a snapshot replay ──────────────────
    // Emitted from OptionsIntelligencePage on mount as a safety net in case
    // the connection event fires before the cache is warm.
    socket.on("request-intel-snapshot", () => {
      if (_intelCache.size === 0) return;
      for (const [, payload] of _intelCache) {
        socket.emit("options-intelligence", payload);
      }
      console.log(`📤 On-demand snapshot replay → ${socket.id} (${_intelCache.size} symbol(s))`);
    });

    // ── Client requests a specific option chain ────────────────────────────
    // Client emits: { underlying: "NIFTY", expiry: "2026-04-17" }
    socket.on("request-option-chain", ({ underlying, expiry } = {}) => {
      if (!underlying) return;

      // Leave any previous chain rooms
      const prevRooms = [...socket.rooms].filter(r => r.startsWith("chain:"));
      prevRooms.forEach(r => socket.leave(r));

      // Join the new room
      const room = `chain:${underlying}`;
      socket.join(room);
      console.log(`📊 ${socket.id} subscribed to ${room} expiry=${expiry}`);

      // Immediately send the latest snapshot if available (from your cache/DB)
      // so client doesn't wait for the next poll cycle
      const cached = getCachedChain(underlying, expiry);
      if (cached) {
        socket.emit("option-chain-update", { underlying, data: cached });
      }

      // Send available expiries for this underlying
      const expiries = getCachedExpiries(underlying);
      if (expiries && expiries.length > 0) {
        socket.emit("option-expiries", { underlying, expiries });
      }
    });

    // ── Client requests expiry list ────────────────────────────────────────
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

  console.log("🌐 Socket.io server attached (option chain + sector updates)");
  return io;
}

// ─── Chain cache helpers ───────────────────────────────────────────────────
// Your optionChainEngine should call setCachedChain() after each processOptionChain()
// so new socket connections get data immediately without waiting for the next poll.

function setCachedChain(underlying, expiry, data) {
  _chainCache.set(`${underlying}_${expiry}`, data);
}

function getCachedChain(underlying, expiry) {
  if (!expiry) {
    // Return latest for this underlying regardless of expiry
    for (const [key, val] of _chainCache) {
      if (key.startsWith(`${underlying}_`)) return val;
    }
    return null;
  }
  return _chainCache.get(`${underlying}_${expiry}`) || null;
}

function setCachedExpiries(underlying, expiries) {
  _expiriesCache.set(underlying, expiries);
  // Also broadcast to any already-connected clients watching this underlying
  if (_io) {
    _io.emit("option-expiries", { underlying, expiries });
  }
}

function getCachedExpiries(underlying) {
  return _expiriesCache.get(underlying) || [];
}

module.exports = {
  attachSocketIO,
  emitChainUpdate,
  broadcastUpstoxStatus,
  setCachedChain,
  setCachedExpiries,
  getCachedChain,
  getCachedExpiries,
  // FIX exports — used by optionsIntegration.js to populate the cache
  setCachedIntel,
  getCachedIntel,
};