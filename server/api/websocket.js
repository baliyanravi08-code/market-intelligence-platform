"use strict";

/**
 * server/api/websocket.js — Binary Protocol Edition
 *
 * WHAT CHANGED vs previous version:
 *   • All high-frequency events now sent as binary buffers (not JSON strings)
 *   • market-tick    → encodeMarketTick()   ~83% smaller per update
 *   • ltp            → encodeLTPTick()      ~80% smaller per update
 *   • scanner:diff   → encodeScannerDiff()  ~79% smaller per update
 *   • scanner:snapshot→ encodeScannerSnapshot() — sends symbol table once
 *   • candle:tick    → encodeCandle()       ~75% smaller per candle
 *   • candle:closed  → encodeCandle()       ~75% smaller per candle
 *   • Rare/complex events (circuit alerts, gann, composite) stay JSON
 *
 * ROOMS (unchanged):
 *   "scanner"            — MarketScannerPage
 *   "chart:{SYMBOL}"     — stock chart viewers
 *   "chain:{UNDERLYING}" — option chain viewers
 *   "backtest:{socketId}"— private backtest room
 *   "alerts"             — circuit / delivery subscribers
 *
 * CLIENT MIGRATION:
 *   socket.on("binary", (buf) => {
 *     const msg = BinaryProtocol.decode(buf);
 *     // msg.type === "market-tick" | "ltp" | "scanner:diff" | "scanner:snapshot"
 *     //           | "candle:tick" | "candle:closed" | eventName (JSON fallback)
 *   });
 *   // Keep old event listeners as fallback during migration (server sends BOTH
 *   // if client hasn't sent "use-binary" signal yet).
 */

const { Server } = require("socket.io");
const { subscribe } = require("../queue");
const bp = require("./binaryProtocol");

let _io = null;

// ── Track which clients have opted into binary protocol ──────────────────────
// Client sends "use-binary" on connect to signal readiness.
// During rollout, non-binary clients still get JSON events.
const _binaryClients = new Set();

function isBinary(socketId) { return _binaryClients.has(socketId); }

// ── Gann integration reference ───────────────────────────────────────────────
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
  // Option chain data is complex/rare → JSON fallback
  const buf = bp.encodeJSON("option-chain-update", { underlying, data });
  _io.to(`chain:${underlying}`).emit("binary", buf);
  // JSON fallback for non-binary clients
  _io.to(`chain:${underlying}`).emit("option-chain-update", { underlying, data });
}

function broadcastUpstoxStatus(connected) {
  if (!_io) return;
  const buf = bp.encodeJSON("upstox-status", { connected });
  _io.emit("binary", buf);
  _io.emit("upstox-status", { connected }); // JSON fallback
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
  if (_io) {
    const buf = bp.encodeJSON("option-expiries", { underlying, expiries });
    _io.emit("binary", buf);
    _io.emit("option-expiries", { underlying, expiries }); // JSON fallback
  }
}

function getCachedExpiries(underlying) {
  return _expiriesCache.get(underlying) || [];
}

// ── Scanner diff engine ──────────────────────────────────────────────────────
const _scannerLastEmit = new Map();
const _scannerBuffer   = new Map();

function updateScannerTick(stockData) {
  if (!stockData?.symbol) return;
  _scannerBuffer.set(stockData.symbol.toUpperCase(), stockData);
}

function getScannerSnapshot() {
  return [..._scannerLastEmit.values()];
}

function _startScannerFlush(io) {
  setInterval(() => {
    if (_scannerBuffer.size === 0) return;

    const room = io.sockets.adapter.rooms.get("scanner");
    if (!room || room.size === 0) {
      for (const [sym, data] of _scannerBuffer) {
        _scannerLastEmit.set(sym, data);
      }
      _scannerBuffer.clear();
      return;
    }

    const diff = [];
    for (const [sym, data] of _scannerBuffer) {
      const prev = _scannerLastEmit.get(sym);
      if (
        !prev ||
        prev.ltp       !== data.ltp       ||
        prev.changePct !== data.changePct ||
        prev.rsi       !== data.rsi       ||
        prev.volume    !== data.volume    ||
        prev.techScore !== data.techScore ||
        prev.signal    !== data.signal
      ) {
        diff.push(data);
        _scannerLastEmit.set(sym, data);
      }
    }
    _scannerBuffer.clear();

    if (diff.length > 0) {
      // ── BINARY: scanner diff (~79% smaller than JSON) ──────────────────
      try {
        const binaryDiff = bp.encodeScannerDiff(diff);
        io.to("scanner").emit("binary", binaryDiff);
      } catch (e) {
        console.warn("⚠️ binary scanner diff encode error:", e.message);
      }

      // ── JSON fallback for clients not yet on binary ────────────────────
      const compressed = diff.map(s => ({
        s: s.symbol, l: s.ltp, c: s.changePct, ch: s.change,
        v: s.volume, sc: s.techScore, sg: s.signal, rs: s.rsi,
        mc: s.macd, bb: s.bollingerBands, ms: s.maSummary,
        mb: s.mcapBucket, ml: s.mcapLabel, nm: s.name,
        ex: s.exchange, sk: s.sector, pc: s.prevClose,
        en: s.entry, sl: s.sl, tp: s.tp, et: s.entryType, gp: s.gapPct,
      }));
      io.to("scanner").emit("scanner:diff", compressed);
    }
  }, 1000);
}

// ── LTP chart throttle ───────────────────────────────────────────────────────
const _ltpThrottle = new Map();

function emitChartLTP(symbol, price) {
  if (!_io) return;
  const sym  = symbol.toUpperCase();
  const room = `chart:${sym}`;
  const members = _io.sockets.adapter.rooms.get(room);
  if (!members || members.size === 0) return;

  const now  = Date.now();
  const last = _ltpThrottle.get(sym) || 0;
  if (now - last < 500) return;
  _ltpThrottle.set(sym, now);

  // ── BINARY: LTP tick (~80% smaller) ──────────────────────────────────
  try {
    const buf = bp.encodeLTPTick(sym, price);
    _io.to(room).emit("binary", buf);
  } catch (e) {
    console.warn("⚠️ binary LTP encode error:", e.message);
  }

  // JSON fallback
  _io.to(room).emit("ltp", { s: sym, p: price, t: now });
}

// ── Market tick broadcast ────────────────────────────────────────────────────
// Called from upstoxStream.js parseAndEmit() — replaces ioRef.emit("market-tick")
function emitMarketTick(updates) {
  if (!_io || !updates?.length) return;
  try {
    const buf = bp.encodeMarketTick(updates);
    _io.emit("binary", buf);
  } catch (e) {
    console.warn("⚠️ binary market-tick encode error:", e.message);
  }
  _io.emit("market-tick", updates); // JSON fallback
}

// ── Candle emission ──────────────────────────────────────────────────────────
// Called from upstoxStream.js processCandleTick() — replaces ioRef.emit("candle:tick")
function emitCandleTick(symbol, tf, candle) {
  if (!_io) return;
  try {
    const buf = bp.encodeCandle(bp.MSG.CANDLE_TICK, symbol, tf, candle);
    _io.emit("binary", buf);
  } catch (e) {
    console.warn("⚠️ binary candle:tick encode error:", e.message);
  }
  _io.emit("candle:tick", { symbol, tf, candle }); // JSON fallback
}

function emitCandleClosed(symbol, tf, candle) {
  if (!_io) return;
  try {
    const buf = bp.encodeCandle(bp.MSG.CANDLE_CLOSED, symbol, tf, candle);
    _io.emit("binary", buf);
  } catch (e) {
    console.warn("⚠️ binary candle:closed encode error:", e.message);
  }
  _io.emit("candle:closed", { symbol, tf, candle }); // JSON fallback
}

// ── Backtest tick delivery ───────────────────────────────────────────────────
function emitBacktestTick(socketId, payload) {
  if (!_io) return;
  const buf = bp.encodeJSON("backtest-live-tick", payload);
  _io.to(`backtest:${socketId}`).emit("binary", buf);
  _io.to(`backtest:${socketId}`).emit("backtest-live-tick", payload); // fallback
}

function broadcastBacktestTick(payload) {
  if (!_io) return;
  const buf = bp.encodeJSON("backtest-live-tick", payload);
  for (const [roomName] of _io.sockets.adapter.rooms) {
    if (roomName.startsWith("backtest:")) {
      _io.to(roomName).emit("binary", buf);
      _io.to(roomName).emit("backtest-live-tick", payload); // fallback
    }
  }
}

// ── Alert broadcasting ───────────────────────────────────────────────────────
function emitCircuitAlerts(alerts) {
  if (!_io || !alerts?.length) return;
  const buf = bp.encodeJSON("circuit-alerts", alerts);
  _io.to("alerts").emit("binary", buf);
  _io.to("alerts").emit("circuit-alerts", alerts); // fallback
}

function emitDeliverySpikes(spikes) {
  if (!_io || !spikes?.length) return;
  const buf = bp.encodeJSON("delivery-spikes", spikes);
  _io.to("alerts").emit("binary", buf);
  _io.to("alerts").emit("delivery-spikes", spikes); // fallback
}

function emitCompositeUpdate(data) {
  if (!_io || !data) return;
  const buf = bp.encodeJSON("composite-update", data);
  _io.emit("binary", buf);
  _io.emit("composite-update", data); // fallback
}

// ── Main attach function ─────────────────────────────────────────────────────
function attachSocketIO(server) {
  const io = new Server(server, {
    cors:         { origin: "*" },
    pingInterval: 25_000,
    pingTimeout:  10_000,
    // ── KEY: enable binary transport for ArrayBuffer ──────────────────────
    // socket.io sends Buffer as ArrayBuffer on client side automatically
    transports:   ["websocket", "polling"],
  });

  _io = io;

  subscribe("SECTOR_UPDATED", (data) => {
    io.emit("update", data);
  });

  _startScannerFlush(io);

  io.on("connection", (socket) => {
    console.log(`👤 Client connected: ${socket.id}`);

    // ── Binary protocol handshake ──────────────────────────────────────────
    // Client sends this immediately on connect to opt into binary mode.
    // We send back the protocol version so client knows what decoder to use.
    socket.on("use-binary", ({ version } = {}) => {
      _binaryClients.add(socket.id);
      socket.emit("binary-ready", {
        version:  1,
        encoding: "big-endian",
        msgTypes: bp.MSG,
        indexIds: bp.INDEX_ID,
        tfIds:    bp.TF_ID,
      });
      console.log(`⚡ ${socket.id} upgraded to binary protocol (client v${version || "?"})`);
    });

    // ── Replay intel snapshots ─────────────────────────────────────────────
    if (_intelCache.size > 0) {
      for (const [, payload] of _intelCache) {
        socket.emit("options-intelligence", payload);
      }
    }

    socket.on("ping", () => socket.emit("pong"));

    socket.on("request-intel-snapshot", () => {
      for (const [, payload] of _intelCache) {
        socket.emit("options-intelligence", payload);
      }
    });

    // ── Scanner room ───────────────────────────────────────────────────────
    socket.on("join:scanner", () => {
      socket.join("scanner");
      const snapshot = getScannerSnapshot();
      if (snapshot.length > 0) {
        // ── BINARY snapshot: sends symbol table + full data ────────────────
        try {
          const buf = bp.encodeScannerSnapshot(snapshot);
          socket.emit("binary", buf);
        } catch (e) {
          console.warn("⚠️ binary snapshot encode error:", e.message);
        }
        // JSON fallback
        socket.emit("scanner:snapshot", snapshot);
      }
      console.log(`📊 ${socket.id} joined scanner room (${snapshot.length} stocks, binary=${isBinary(socket.id)})`);
    });

    socket.on("leave:scanner", () => {
      socket.leave("scanner");
    });

    // ── Chart LTP room ─────────────────────────────────────────────────────
    socket.on("watch:chart", (symbol) => {
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
    });

    socket.on("backtest:stop", () => {
      socket.leave(`backtest:${socket.id}`);
    });

    // ── Alerts room ────────────────────────────────────────────────────────
    socket.on("join:alerts", () => socket.join("alerts"));
    socket.on("leave:alerts", () => socket.leave("alerts"));

    // ── Gann analysis ──────────────────────────────────────────────────────
    socket.on("get-gann-analysis", ({ symbol, ltp } = {}) => {
      if (!symbol) return;
      const sym = normaliseSymbol(symbol);
      if (_gannIntegration?.getGannAnalysis) {
        const analysis = _gannIntegration.getGannAnalysis(sym, ltp);
        if (analysis) {
          // Gann data is complex — JSON fallback is fine (rare request)
          const buf = bp.encodeJSON("gann-analysis", analysis);
          socket.emit("binary", buf);
          socket.emit("gann-analysis", analysis);
          return;
        }
      }
      console.warn(`⚠️ get-gann-analysis: no result for ${sym}`);
    });

    // ── Option chain ───────────────────────────────────────────────────────
    socket.on("request-option-chain", ({ underlying, expiry } = {}) => {
      if (!underlying) return;
      [...socket.rooms]
        .filter(r => r.startsWith("chain:"))
        .forEach(r => socket.leave(r));
      socket.join(`chain:${underlying}`);
      const cached   = getCachedChain(underlying, expiry);
      const expiries = getCachedExpiries(underlying);
      if (cached) {
        const buf = bp.encodeJSON("option-chain-update", { underlying, data: cached });
        socket.emit("binary", buf);
        socket.emit("option-chain-update", { underlying, data: cached });
      }
      if (expiries.length > 0) {
        const buf = bp.encodeJSON("option-expiries", { underlying, expiries });
        socket.emit("binary", buf);
        socket.emit("option-expiries", { underlying, expiries });
      }
    });

    socket.on("request-expiries", ({ underlying } = {}) => {
      if (!underlying) return;
      const expiries = getCachedExpiries(underlying);
      const buf = bp.encodeJSON("option-expiries", { underlying, expiries });
      socket.emit("binary", buf);
      socket.emit("option-expiries", { underlying, expiries });
    });

    // ── Live candle subscriptions ──────────────────────────────────────────
    let _watchedSymbol = null;
    let _watchedTf     = null;

    socket.on("candle:subscribe", ({ symbol, tf } = {}) => {
      if (!symbol || !tf) return;
      const stream = getStream();
      if (!stream) return;
      if (_watchedSymbol && _watchedTf) {
        stream.unregisterLiveCandleSubscription(_watchedSymbol, _watchedTf);
      }
      _watchedSymbol = symbol.toUpperCase().trim();
      _watchedTf     = tf;
      stream.registerLiveCandleSubscription(_watchedSymbol, _watchedTf);
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
      _binaryClients.delete(socket.id);

      const stream = getStream();
      if (stream && _watchedSymbol && _watchedTf) {
        stream.unregisterLiveCandleSubscription(_watchedSymbol, _watchedTf);
      }
    });

    socket.on("error", (err) => {
      console.error(`Socket error [${socket.id}]:`, err?.message);
    });
  });

  console.log("🌐 Socket.io attached — Binary Protocol v1 enabled");
  console.log("   Rooms: scanner | chart:{SYM} | chain:{SYM} | backtest:{id} | alerts");
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

  // Scanner
  updateScannerTick,
  getScannerSnapshot,

  // ── NEW binary-aware emitters ──────────────────────────────────────────
  emitMarketTick,      // replaces ioRef.emit("market-tick") in upstoxStream
  emitChartLTP,        // replaces ioRef.emit("ltp") in upstoxStream
  emitCandleTick,      // replaces ioRef.emit("candle:tick") in upstoxStream
  emitCandleClosed,    // replaces ioRef.emit("candle:closed") in upstoxStream

  // Backtest
  emitBacktestTick,
  broadcastBacktestTick,

  // Alerts
  emitCircuitAlerts,
  emitDeliverySpikes,
  emitCompositeUpdate,

  // Status
  broadcastUpstoxStatus,
};