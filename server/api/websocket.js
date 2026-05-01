"use strict";

/**
 * server/api/websocket.js
 *
 * ARCHITECTURE: Room-based targeted delivery — clients receive only what
 * their current page needs. No global io.emit() for data events.
 *
 * ROOMS:
 *  "scanner"            — MarketScannerPage clients
 *  "chart:{SYMBOL}"     — clients viewing a specific stock chart
 *  "chain:{UNDERLYING}" — clients viewing an option chain
 *  "backtest:{socketId}"— private room per backtest session
 *  "alerts"             — circuit / delivery / smart money alert subscribers
 *
 * CLIENT EVENTS (emit these from your React pages):
 *  join:scanner                        → join scanner room
 *  leave:scanner                       → leave scanner room
 *  watch:chart   { symbol }            → join chart room for symbol
 *  backtest:start                      → join private backtest room
 *  candle:subscribe   { symbol, tf }   → live candle aggregation
 *  candle:unsubscribe { symbol, tf }   → stop live candle aggregation
 *  request-option-chain { underlying, expiry }
 *  request-expiries     { underlying }
 *  get-gann-analysis    { symbol, ltp }
 *  request-intel-snapshot
 *  join:alerts                         → receive circuit/delivery alerts
 *  ping                                → heartbeat
 *
 * SERVER EVENTS (listen for these in your React pages):
 *  scanner:diff        [ ...changedStocks ]   (1/sec, scanner room only)
 *  scanner:snapshot    [ ...allStocks ]       (on join, scanner room only)
 *  ltp                 { s, p, t }            (chart room only, 500ms throttle)
 *  candle:tick         { symbol, tf, candle }
 *  candle:closed       { symbol, tf, candle }
 *  option-chain-update { underlying, data }
 *  option-expiries     { underlying, expiries }
 *  options-intelligence { ... }
 *  gann-analysis       { ... }
 *  backtest-live-tick  { symbol, price, ... } (private room only)
 *  circuit-alerts      [ ...alerts ]
 *  delivery-spikes     [ ...spikes ]
 *  composite-scores    [ ... ]
 *  composite-update    { ... }
 *  market-tick         [ ...indices ]
 *  upstox-status       { connected, reason? }
 *  system_event        { type, time }
 *  pong
 */

const { Server } = require("socket.io");
const { subscribe } = require("../queue");

let _io = null;

// ── Gann integration reference (set from coordinator.js after boot) ──────────
let _gannIntegration = null;

function setGannIntegration(gi) {
  _gannIntegration = gi;
  console.log("📐 websocket.js: gannIntegration wired");
}

// ── upstoxStream lazy-loader ─────────────────────────────────────────────────
let _upstoxStream = null;
function getStream() {
  if (!_upstoxStream) {
    try { _upstoxStream = require("../services/upstoxStream"); } catch (_) {}
  }
  return _upstoxStream;
}

// ── Symbol normaliser ────────────────────────────────────────────────────────
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

// ── Option chain helpers ─────────────────────────────────────────────────────
function emitChainUpdate(underlying, data) {
  if (!_io) return;
  _io.to(`chain:${underlying}`).emit("option-chain-update", { underlying, data });
}

function broadcastUpstoxStatus(connected) {
  if (!_io) return;
  _io.emit("upstox-status", { connected });
}

// ── Intel / chain / expiry caches ────────────────────────────────────────────
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

// ── Scanner diff engine ──────────────────────────────────────────────────────
// marketScanner.js calls updateScannerTick() instead of io.emit()
// We flush diffs to the "scanner" room every second.

const _scannerLastEmit = new Map(); // symbol → last emitted snapshot
const _scannerBuffer   = new Map(); // symbol → latest pending data

/**
 * Called by marketScanner.js on every tick for any stock.
 * Buffers the update; the flush interval decides what actually gets sent.
 */
function updateScannerTick(stockData) {
  if (!stockData?.symbol) return;
  _scannerBuffer.set(stockData.symbol.toUpperCase(), stockData);
}

/**
 * Called once on scanner page load to send the full current state.
 */
function getScannerSnapshot() {
  return [..._scannerLastEmit.values()];
}

function _startScannerFlush(io) {
  setInterval(() => {
    if (_scannerBuffer.size === 0) return;

    // Check if anyone is actually in the scanner room
    const room = io.sockets.adapter.rooms.get("scanner");
    if (!room || room.size === 0) {
      // Nobody watching — update state silently, skip emit
      for (const [sym, data] of _scannerBuffer) {
        _scannerLastEmit.set(sym, data);
      }
      _scannerBuffer.clear();
      return;
    }

    const diff = [];
    for (const [sym, data] of _scannerBuffer) {
      const prev = _scannerLastEmit.get(sym);
      // Only include if something meaningful changed
      if (
        !prev ||
        prev.price     !== data.price     ||
        prev.changePct !== data.changePct ||
        prev.rsi       !== data.rsi       ||
        prev.macd      !== data.macd      ||
        prev.volume    !== data.volume
      ) {
        diff.push(data);
        _scannerLastEmit.set(sym, data);
      }
    }
    _scannerBuffer.clear();

    if (diff.length > 0) {
      io.to("scanner").emit("scanner:diff", diff);
    }
  }, 1000); // 1 second flush — scanner room only
}

// ── LTP chart throttle ───────────────────────────────────────────────────────
// upstoxStream calls emitChartLTP() for EQ ticks.
// We throttle to 500ms per symbol and target only chart:{SYMBOL} rooms.

const _ltpThrottle = new Map(); // symbol → lastEmitMs

function emitChartLTP(symbol, price) {
  if (!_io) return;
  const sym  = symbol.toUpperCase();
  const room = `chart:${sym}`;

  // Check room has subscribers before doing any work
  const members = _io.sockets.adapter.rooms.get(room);
  if (!members || members.size === 0) return;

  const now  = Date.now();
  const last = _ltpThrottle.get(sym) || 0;
  if (now - last < 500) return; // max 2 updates/sec per symbol
  _ltpThrottle.set(sym, now);

  _io.to(room).emit("ltp", { s: sym, p: price, t: now });
}

// ── Backtest tick delivery ───────────────────────────────────────────────────
// upstoxStream calls emitBacktestTick() instead of io.emit("backtest-live-tick")

function emitBacktestTick(socketId, payload) {
  if (!_io) return;
  _io.to(`backtest:${socketId}`).emit("backtest-live-tick", payload);
}

/**
 * Broadcast to ALL active backtest sessions.
 * Call this from upstoxStream when a stock tick arrives and
 * you don't know which session wants it — we filter server-side.
 */
function broadcastBacktestTick(payload) {
  if (!_io) return;
  // Find all sockets in any backtest: room and emit only to them
  for (const [roomName] of _io.sockets.adapter.rooms) {
    if (roomName.startsWith("backtest:")) {
      _io.to(roomName).emit("backtest-live-tick", payload);
    }
  }
}

// ── Alert broadcasting ───────────────────────────────────────────────────────
// coordinator.js calls these instead of io.emit()

function emitCircuitAlerts(alerts) {
  if (!_io || !alerts?.length) return;
  _io.to("alerts").emit("circuit-alerts", alerts);
}

function emitDeliverySpikes(spikes) {
  if (!_io || !spikes?.length) return;
  _io.to("alerts").emit("delivery-spikes", spikes);
}

function emitCompositeUpdate(data) {
  if (!_io || !data) return;
  // Composite scores go to everyone (small payload, infrequent)
  _io.emit("composite-update", data);
}

// ── Main attach function ─────────────────────────────────────────────────────
function attachSocketIO(server) {
  const io = new Server(server, {
    cors:         { origin: "*" },
    pingInterval: 25_000,
    pingTimeout:  10_000,
    transports:   ["websocket", "polling"],
  });

  _io = io;

  // Queue-based sector updates (unchanged)
  subscribe("SECTOR_UPDATED", (data) => {
    io.emit("update", data);
  });

  // Start scanner diff flush loop
  _startScannerFlush(io);

  io.on("connection", (socket) => {
    console.log(`👤 Client connected: ${socket.id}`);

    // ── Replay intel snapshots on connect ──────────────────────────────────
    if (_intelCache.size > 0) {
      for (const [, payload] of _intelCache) {
        socket.emit("options-intelligence", payload);
      }
    }

    // ── Heartbeat ──────────────────────────────────────────────────────────
    socket.on("ping", () => socket.emit("pong"));

    // ── Intel snapshot on demand ───────────────────────────────────────────
    socket.on("request-intel-snapshot", () => {
      for (const [, payload] of _intelCache) {
        socket.emit("options-intelligence", payload);
      }
    });

    // ── Scanner room ───────────────────────────────────────────────────────
    socket.on("join:scanner", () => {
      socket.join("scanner");
      // Send full snapshot immediately so page doesn't wait for first diff
      const snapshot = getScannerSnapshot();
      if (snapshot.length > 0) {
        socket.emit("scanner:snapshot", snapshot);
      }
      console.log(`📊 ${socket.id} joined scanner room (${snapshot.length} stocks sent)`);
    });

    socket.on("leave:scanner", () => {
      socket.leave("scanner");
      console.log(`📊 ${socket.id} left scanner room`);
    });

    // ── Chart LTP room ─────────────────────────────────────────────────────
    socket.on("watch:chart", (symbol) => {
      // Leave any previous chart room first
      [...socket.rooms]
        .filter(r => r.startsWith("chart:"))
        .forEach(r => socket.leave(r));

      if (symbol) {
        const sym = symbol.toUpperCase().trim();
        socket.join(`chart:${sym}`);
        console.log(`📈 ${socket.id} watching chart: ${sym}`);
      }
    });

    // ── Backtest private room ──────────────────────────────────────────────
    socket.on("backtest:start", () => {
      socket.join(`backtest:${socket.id}`);
      console.log(`🔬 ${socket.id} joined private backtest room`);
    });

    socket.on("backtest:stop", () => {
      socket.leave(`backtest:${socket.id}`);
    });

    // ── Alerts room ────────────────────────────────────────────────────────
    socket.on("join:alerts", () => {
      socket.join("alerts");
      console.log(`🔔 ${socket.id} joined alerts room`);
    });

    socket.on("leave:alerts", () => {
      socket.leave("alerts");
    });

    // ── Gann analysis ──────────────────────────────────────────────────────
    socket.on("get-gann-analysis", ({ symbol, ltp } = {}) => {
      if (!symbol) return;
      const sym = normaliseSymbol(symbol);

      if (_gannIntegration?.getGannAnalysis) {
        const analysis = _gannIntegration.getGannAnalysis(sym, ltp);
        if (analysis) {
          socket.emit("gann-analysis", analysis);
          return;
        }
      }

      console.warn(`⚠️ get-gann-analysis: no result for ${sym} — gannIntegration=${!!_gannIntegration}`);
    });

    // ── Option chain ───────────────────────────────────────────────────────
    socket.on("request-option-chain", ({ underlying, expiry } = {}) => {
      if (!underlying) return;

      // Leave previous chain rooms
      [...socket.rooms]
        .filter(r => r.startsWith("chain:"))
        .forEach(r => socket.leave(r));

      socket.join(`chain:${underlying}`);
      console.log(`📊 ${socket.id} subscribed to chain:${underlying} expiry=${expiry}`);

      const cached = getCachedChain(underlying, expiry);
      if (cached) socket.emit("option-chain-update", { underlying, data: cached });

      const expiries = getCachedExpiries(underlying);
      if (expiries.length > 0) socket.emit("option-expiries", { underlying, expiries });
    });

    socket.on("request-expiries", ({ underlying } = {}) => {
      if (!underlying) return;
      socket.emit("option-expiries", {
        underlying,
        expiries: getCachedExpiries(underlying),
      });
    });

    // ── Live candle subscriptions ──────────────────────────────────────────
    let _watchedSymbol = null;
    let _watchedTf     = null;

    socket.on("candle:subscribe", ({ symbol, tf } = {}) => {
      if (!symbol || !tf) return;
      const stream = getStream();
      if (!stream) return;

      // Unsubscribe previous if switching symbol/tf
      if (_watchedSymbol && _watchedTf) {
        stream.unregisterLiveCandleSubscription(_watchedSymbol, _watchedTf);
      }

      _watchedSymbol = symbol.toUpperCase().trim();
      _watchedTf     = tf;
      stream.registerLiveCandleSubscription(_watchedSymbol, _watchedTf);
      console.log(`📺 ${socket.id} subscribed candles: ${_watchedSymbol} @ ${_watchedTf}`);
    });

    socket.on("candle:unsubscribe", ({ symbol, tf } = {}) => {
      const stream = getStream();
      if (!stream) return;
      const sym = (symbol || _watchedSymbol || "").toUpperCase().trim();
      const t   = tf || _watchedTf;
      if (sym && t) stream.unregisterLiveCandleSubscription(sym, t);
    });

    // ── Disconnect ─────────────────────────────────────────────────────────
    socket.on("disconnect", (reason) => {
      console.log(`👋 ${socket.id} disconnected — ${reason}`);

      // Clean up candle subscription
      const stream = getStream();
      if (stream && _watchedSymbol && _watchedTf) {
        stream.unregisterLiveCandleSubscription(_watchedSymbol, _watchedTf);
      }
      // backtest: room auto-cleaned by socket.io on disconnect
    });

    socket.on("error", (err) => {
      console.error(`Socket error [${socket.id}]:`, err?.message);
    });
  });

  console.log("🌐 Socket.io attached — rooms: scanner | chart:{SYM} | chain:{SYM} | backtest:{id} | alerts");
  return io;
}

module.exports = {
  // Core
  attachSocketIO,
  setGannIntegration,

  // Option chain
  emitChainUpdate,
  setCachedChain,
  getCachedChain,
  setCachedExpiries,
  getCachedExpiries,
  setCachedIntel,
  getCachedIntel,

  // Scanner (call from marketScanner.js)
  updateScannerTick,
  getScannerSnapshot,

  // Chart LTP (call from upstoxStream.js)
  emitChartLTP,

  // Backtest (call from upstoxStream.js)
  emitBacktestTick,
  broadcastBacktestTick,

  // Alerts (call from coordinator.js)
  emitCircuitAlerts,
  emitDeliverySpikes,
  emitCompositeUpdate,

  // Status
  broadcastUpstoxStatus,
};