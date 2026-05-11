"use strict";

/**
 * server/api/websocket.js — Binary Protocol Edition
 *
 * FIX-BW-1: perMessageDeflate enabled (threshold: 1024)
 *   Was: false — every frame sent uncompressed.
 *   Now: frames > 1KB are gzip-compressed automatically by socket.io.
 *   Impact: options-intelligence JSON (2-5KB) → ~800B. bse/nse events → ~30% of original.
 *
 * FIX-BW-2: emitOptionsIntelTick — JSON fallback removed.
 *   Was: binary (24B) + JSON (~200B) on every Upstox tick (~1s per symbol).
 *   Now: binary only. App.jsx binary handler decodes 0x0D and re-emits
 *        "options-intel-tick" locally — OptionsIntelligencePage listener fires normally.
 *
 * FIX-BW-3: request-straddle-snapshot socket handler added.
 *   StraddlePanel now requests via socket instead of REST polling every 5s.
 *   Server handles the request once and pushes back via "straddle-snapshot".
 */

const { Server } = require("socket.io");
const { subscribe } = require("../queue");
const bp = require("./binaryProtocol");

let _io = null;

const _binaryClients = new Set();

function isBinary(socketId) { return _binaryClients.has(socketId); }

let _gannIntegration = null;

function setGannIntegration(gi) {
  _gannIntegration = gi;
  console.log("📐 websocket.js: gannIntegration wired");
}

let _upstoxStream = null;
function getStream() {
  if (!_upstoxStream) {
    try { _upstoxStream = require("../services/upstoxStream"); } catch (_) {}
  }
  return _upstoxStream;
}

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
  const buf = bp.encodeJSON("option-chain-update", { underlying, data });
  _io.to(`chain:${underlying}`).emit("binary", buf);
  _io.to(`chain:${underlying}`).emit("option-chain-update", { underlying, data });
}

function broadcastUpstoxStatus(connected) {
  if (!_io) return;
  const buf = bp.encodeJSON("upstox-status", { connected });
  _io.emit("binary", buf);
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
  if (_io) {
    const buf = bp.encodeJSON("option-expiries", { underlying, expiries });
    _io.to(`chain:${underlying}`).emit("binary", buf);
    _io.to(`chain:${underlying}`).emit("option-expiries", { underlying, expiries });
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
      try {
        const binaryDiff = bp.encodeScannerDiff(diff);
        io.to("scanner").emit("binary", binaryDiff);
      } catch (e) {
        console.warn("⚠️ binary scanner diff encode error:", e.message);
      }

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

  try {
    const buf = bp.encodeLTPTick(sym, price);
    _io.to(room).emit("binary", buf);
  } catch (e) {
    console.warn("⚠️ binary LTP encode error:", e.message);
  }

  _io.to(room).emit("ltp", { s: sym, p: price, t: now });
}

// ── Market tick broadcast ────────────────────────────────────────────────────
function emitMarketTick(updates) {
  if (!_io || !updates?.length) return;

  try {
    const buf = bp.encodeMarketTick(updates);
    _io.emit("binary", buf);
  } catch (e) {
    console.warn("⚠️ binary market-tick encode error:", e.message);
  }


}

// ── Options Intel live tick ───────────────────────────────────────────────────
// FIX-BW-2: JSON fallback REMOVED. Binary only (24 bytes vs 200 bytes).
// App.jsx binary handler decodes 0x0D and re-emits "options-intel-tick" locally.
const _intelTickThrottle = new Map();

function emitOptionsIntelTick(symbol, spotPrice) {
  if (!_io || !symbol || !spotPrice) return;

  const sym = symbol.toUpperCase();

  const now  = Date.now();
  const last = _intelTickThrottle.get(sym) || 0;
  if (now - last < 500) return;
  _intelTickThrottle.set(sym, now);

  const cached = _intelCache.get(sym);
  if (!cached) return;

  const straddlePrice = cached.data?.structure?.straddlePrice || 0;
  const atmIV         = cached.data?.volatility?.atmIV        || 0;
  const score         = cached.data?.score                    || 50;
  const bias          = cached.data?.bias                     || "NEUTRAL";

  try {
    if (bp.encodeOptionsIntelTick) {
      const buf = bp.encodeOptionsIntelTick(sym, spotPrice, straddlePrice, atmIV, score, bias);
      _io.to("intel").emit("binary", buf);
    } else {
      _io.to("intel").emit("options-intel-tick", { symbol: sym, spotPrice, straddlePrice, atmIV, score, bias });
    }
  } catch (e) {
    // silent
  }
}

// ── Candle emission → chart:{SYMBOL} room only ───────────────────────────────
function emitCandleTick(symbol, tf, candle) {
  if (!_io) return;
  const sym  = symbol.toUpperCase().trim();
  const room = `chart:${sym}`;

  try {
    const buf = bp.encodeCandle(bp.MSG.CANDLE_TICK, sym, tf, candle);
    _io.to(room).emit("binary", buf);
  } catch (e) {
    console.warn("⚠️ binary candle:tick encode error:", e.message);
  }

  _io.to(room).emit("candle:tick", { symbol: sym, tf, candle });
}

function emitCandleClosed(symbol, tf, candle) {
  if (!_io) return;
  const sym  = symbol.toUpperCase().trim();
  const room = `chart:${sym}`;

  try {
    const buf = bp.encodeCandle(bp.MSG.CANDLE_CLOSED, sym, tf, candle);
    _io.to(room).emit("binary", buf);
  } catch (e) {
    console.warn("⚠️ binary candle:closed encode error:", e.message);
  }

  _io.to(room).emit("candle:closed", { symbol: sym, tf, candle });
}

// ── price:tick ───────────────────────────────────────────────────────────────
const _priceTickThrottle = new Map();

function emitPriceTick(symbol, price, change, changePct, prevClose) {
  if (!_io) return;
  const sym  = symbol.toUpperCase().trim();
  const room = `chart:${sym}`;

  const members = _io.sockets.adapter.rooms.get(room);
  if (!members || members.size === 0) return;

  const now  = Date.now();
  const last = _priceTickThrottle.get(sym) || 0;
  if (now - last < 500) return;
  _priceTickThrottle.set(sym, now);

  const payload = {
    symbol: sym, ltp: price,
    change: change ?? 0, changePct: changePct ?? 0,
    prevClose: prevClose ?? 0, t: now,
  };

  try {
    const buf = bp.encodeLTPTick(sym, price);
    _io.to(room).emit("binary", buf);
  } catch (e) {
    console.warn("⚠️ binary price:tick encode error:", e.message);
  }

  _io.to(room).emit("price:tick", payload);
  
}

// ── Scanner tech batch broadcast ─────────────────────────────────────────────
function emitTechBatch(batch) {
  if (!_io || !batch?.length) return;
  _io.to("scanner").emit("scanner-tech-batch", batch);
}

// ── Backtest tick delivery ───────────────────────────────────────────────────
function emitBacktestTick(socketId, payload) {
  if (!_io) return;
  const buf = bp.encodeJSON("backtest-live-tick", payload);
  _io.to(`backtest:${socketId}`).emit("binary", buf);
  _io.to(`backtest:${socketId}`).emit("backtest-live-tick", payload);
}

function broadcastBacktestTick(payload) {
  if (!_io) return;
  const buf = bp.encodeJSON("backtest-live-tick", payload);
  for (const [roomName] of _io.sockets.adapter.rooms) {
    if (roomName.startsWith("backtest:")) {
      _io.to(roomName).emit("binary", buf);
      _io.to(roomName).emit("backtest-live-tick", payload);
    }
  }
}

// ── Alert broadcasting ───────────────────────────────────────────────────────
function emitCircuitAlerts(alerts) {
  if (!_io || !alerts?.length) return;
  const buf = bp.encodeJSON("circuit-alerts", alerts);
  _io.to("alerts").emit("binary", buf);
  _io.to("alerts").emit("circuit-alerts", alerts);
}

function emitDeliverySpikes(spikes) {
  if (!_io || !spikes?.length) return;
  const buf = bp.encodeJSON("delivery-spikes", spikes);
  _io.to("alerts").emit("binary", buf);
  _io.to("alerts").emit("delivery-spikes", spikes);
}

function emitOptionsIntel(data) {
  if (!_io || !data?.symbol) return;
  try {
    const buf = bp.encodeOptionsIntel(data);
    _io.to("intel").emit("binary", buf);
  } catch (e) {
    console.warn("⚠️ binary options-intel encode error:", e.message);
  }
  _io.to("intel").emit("options-intelligence", data);
  setCachedIntel(data.symbol, data);
}
function emitCompositeUpdate(data) {
  if (!_io || !data) return;
  const buf = bp.encodeJSON("composite-update", data);
  _io.emit("binary", buf);
  _io.emit("composite-update", data);
}

// ── Main attach function ─────────────────────────────────────────────────────
function attachSocketIO(server) {
  const io = new Server(server, {
    cors:             { origin: "*" },
    pingInterval:     20_000,
    pingTimeout:      60_000,
    upgradeTimeout:   30_000,
    transports:       ["websocket", "polling"],
    allowUpgrades:    true,
    // FIX-BW-1: was false — now compresses frames > 1KB automatically.
    // options-intelligence JSON (2-5KB) → ~800B. bse/nse events compressed too.
    perMessageDeflate: { threshold: 1024 },
  });

  _io = io;

  subscribe("SECTOR_UPDATED", (data) => {
    io.emit("update", data);
  });

  _startScannerFlush(io);

  io.on("connection", (socket) => {
    console.log(`👤 Client connected: ${socket.id}`);

    // ── Binary protocol handshake ──────────────────────────────────────
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

    socket.on("ping", () => socket.emit("pong"));

    // ── FIX-BW-3: Straddle snapshot via socket (replaces REST polling) ─
    // StraddlePanel emits "request-straddle-snapshot" instead of
    // setInterval REST calls. This fires once per user action, not every 5s.
    socket.on("request-straddle-snapshot", async ({ symbol, type, side } = {}) => {
      if (!symbol) return;
      try {
        const port    = process.env.PORT || 3000;
        const base    = `http://localhost:${port}`;
        const fetchLocal = (url) => new Promise((resolve) => {
          const http = require("http");
          http.get(url, (res) => {
            let d = "";
            res.on("data", c => d += c);
            res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
          }).on("error", () => resolve(null));
        });
        const snap   = await fetchLocal(`http://localhost:${process.env.PORT || 3000}/api/straddle/snapshot?symbol=${symbol}`);
        const payoff = await fetchLocal(`http://localhost:${process.env.PORT || 3000}/api/straddle/payoff?symbol=${symbol}&type=${type || "straddle"}&side=${side || "sell"}`);
        if (snap   && !snap.error)   socket.emit("straddle-snapshot", { symbol, data: snap });
        if (payoff && !payoff.error) socket.emit("straddle-payoff",   { symbol, ...payoff });
      } catch (e) {
        console.warn("⚠️ request-straddle-snapshot error:", e.message);
      }
    });

    // ── Scanner room ───────────────────────────────────────────────────
    socket.on("join:scanner", () => {
      socket.join("scanner");
      const snapshot = getScannerSnapshot();
      if (snapshot.length > 0) {
        try {
          const buf = bp.encodeScannerSnapshot(snapshot);
          socket.emit("binary", buf);
        } catch (e) {
          console.warn("⚠️ binary snapshot encode error:", e.message);
        }
        socket.emit("scanner:snapshot", snapshot);
      }
      console.log(`📊 ${socket.id} joined scanner room (${snapshot.length} stocks, binary=${isBinary(socket.id)})`);
    });

    socket.on("leave:scanner", () => {
      socket.leave("scanner");
    });

    // ── Chart room ────────────────────────────────────────────────────
    socket.on("watch:chart", (symbol) => {
      [...socket.rooms]
        .filter(r => r.startsWith("chart:"))
        .forEach(r => socket.leave(r));

      if (symbol && symbol.trim()) {
        const sym = symbol.toUpperCase().trim();
        socket.join(`chart:${sym}`);
        console.log(`📈 ${socket.id} watching chart: ${sym}`);
        try {
          const stream = require("../services/upstoxStream");
          if (stream.subscribeSymbolForPriceTick) {
            stream.subscribeSymbolForPriceTick(sym);
          }
        } catch (e) {
          console.warn(`⚠️ watch:chart subscribe failed for ${sym}:`, e.message);
        }
      }
    });

    // ── Backtest private room ──────────────────────────────────────────
    socket.on("backtest:start", () => socket.join(`backtest:${socket.id}`));
    socket.on("backtest:stop",  () => socket.leave(`backtest:${socket.id}`));

    // ── Intel room — only OI Intel page clients ────────────────────────
    socket.on("join:intel", () => {
      socket.join("intel");
      for (const [, payload] of _intelCache) {
        try {
          const buf = bp.encodeOptionsIntel(payload);
          socket.emit("binary", buf);
        } catch (_) {}
        socket.emit("options-intelligence", payload);
      }
      console.log(`📐 ${socket.id} joined intel room`);
    });

    socket.on("leave:intel", () => {
      socket.leave("intel");
      console.log(`📐 ${socket.id} left intel room`);
    });

    // ── Alerts room ────────────────────────────────────────────────────
    socket.on("join:alerts", () => {
      socket.join("alerts");
      try {
        const { sendAlertsToClient } = require("../coordinator");
        sendAlertsToClient(socket);
      } catch (_) {}
    });
    socket.on("leave:alerts", () => socket.leave("alerts"));

    // ── Gann analysis ──────────────────────────────────────────────────
    socket.on("get-gann-analysis", ({ symbol, ltp } = {}) => {
      if (!symbol) return;
      const sym = normaliseSymbol(symbol);
      if (_gannIntegration?.getGannAnalysis) {
        const analysis = _gannIntegration.getGannAnalysis(sym, ltp);
        if (analysis) {
          const buf = bp.encodeJSON("gann-analysis", analysis);
          socket.emit("binary", buf);
          socket.emit("gann-analysis", analysis);
          return;
        }
      }
      console.warn(`⚠️ get-gann-analysis: no result for ${sym}`);
    });

    // ── Option chain ───────────────────────────────────────────────────
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

    // ── Live candle subscriptions ──────────────────────────────────────
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
      socket.join(`chart:${_watchedSymbol}`);
    });

    socket.on("candle:unsubscribe", ({ symbol, tf } = {}) => {
      const stream = getStream();
      if (!stream) return;
      const sym = (symbol || _watchedSymbol || "").toUpperCase().trim();
      const t   = tf || _watchedTf;
      if (sym && t) stream.unregisterLiveCandleSubscription(sym, t);
    });

    // ── Disconnect ─────────────────────────────────────────────────────
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

  console.log("🌐 Socket.io attached — Binary Protocol v1 + perMessageDeflate enabled");
  return io;
}

module.exports = {
  attachSocketIO,
  setGannIntegration,
  emitTechBatch,
  emitChainUpdate,
  setCachedChain,
  getCachedChain,
  setCachedExpiries,
  getCachedExpiries,
  setCachedIntel,
  getCachedIntel,
  updateScannerTick,
  getScannerSnapshot,
  emitMarketTick,
  emitChartLTP,
  emitCandleTick,
  emitCandleClosed,
  emitPriceTick,
  emitOptionsIntelTick,
  emitBacktestTick,
  broadcastBacktestTick,
  emitCircuitAlerts,
  emitDeliverySpikes,
  emitCompositeUpdate,
  broadcastUpstoxStatus,
  emitOptionsIntel,
};