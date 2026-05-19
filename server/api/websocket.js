"use strict";

/**
 * server/api/websocket.js — Binary Protocol Edition
 *
 * FIXES IN THIS VERSION:
 * ══════════════════════════════════════════════════════════════════
 * FIX-1: emitOptionsIntelTick — removed duplicate `const stranglePrice` that
 *   caused either a syntax error or the wrong (old) value being used.
 *
 * FIX-2: emitOptionsIntelTick — straddlePrice now reads from the STRADDLE CACHE
 *   (_straddleCache) first, falling back to structure.straddlePrice.
 *   The intel cache stores raw options-intelligence payload where
 *   structure.straddlePrice = raw CE+PE LTP sum across chain (~599).
 *   The REST snapshot computes the correct normalised value (347) from
 *   optionChainCache.json. We now keep a _straddleCache that mirrors
 *   the REST snapshot values so the binary tick uses the same source.
 *
 * FIX-3: PCR null-coercion — all `|| 0` on pcr changed to `?? 0` so a
 *   real PCR of 1.23 is never coerced to 0 or lost. PCR is now
 *   unconditionally updated in the oi block (not gated on OI > 0).
 *
 * FIX-4: join:straddle hydration — same PCR fix applied to initial emit.
 *
 * FIX-5: strangle chart fix — strangle fallback in handleOptionsIntel
 *   changed from `?? straddlePrice` to `?? null` (done in StraddlePage.jsx).
 * ══════════════════════════════════════════════════════════════════
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

const _intelCache    = new Map();
const _chainCache    = new Map();
const _expiriesCache = new Map();

// FIX-2: Separate cache for REST-snapshot-derived straddle/strangle values.
// The intel cache has raw options-intelligence payload (structure.straddlePrice
// = raw chain sum). The REST /api/straddle/snapshot computes the correct
// normalised value. We store those here so binary ticks use the right numbers.
const _straddleCache = new Map(); // sym → { straddlePrice, stranglePrice, pcr, atmIV, ... }

/**
 * Call this from straddleRoutes (or anywhere that computes the correct
 * straddle/strangle premium from optionChainCache.json) so binary ticks
 * emit the same value as the REST snapshot.
 */
function setCachedStraddleSnap(symbol, snap) {
  // Cold-start disk seed only. Exits if live price already set.
  if (!symbol || !snap) return;
  const sym = symbol.toUpperCase();
  const existing = _straddleCache.get(sym) || {};
  if (existing.straddlePrice > 0) return;
  _straddleCache.set(sym, {
    straddlePrice: snap.straddle?.combined ?? 0,
    stranglePrice: snap.strangle?.combined ?? 0,
    pcr:         snap.oi?.pcr != null ? +(+snap.oi.pcr).toFixed(2) : null,
    atmIV:       snap.iv?.atm  ?? 0,
    totalCallOI: snap.oi?.ce   ?? 0,
    totalPutOI:  snap.oi?.pe   ?? 0,
    timestamp:   snap.timestamp ?? Date.now(),
  });
}

// SOLE writer of straddlePrice — called by upstoxStream on every ATM CE+PE tick
function updateLiveStraddlePrice(symbol, straddlePrice) {
  if (!symbol || !straddlePrice) return;
  const sym = symbol.toUpperCase();
  const existing = _straddleCache.get(sym) || {};
  _straddleCache.set(sym, {
    ...existing,
    straddlePrice,
    timestamp: Date.now(),
  });
  // Persist every live ATM tick to disk history (1 entry per minute)
  _persistStraddleTick(
    sym,
    straddlePrice,
    existing.stranglePrice || 0,
    existing.spotPrice     || 0,
    existing.pcr           ?? null,
    Date.now()
  );
}

function getCachedStraddleSnap(symbol) {
  if (!symbol) return null;
  return _straddleCache.get(symbol.toUpperCase()) || null;
}

function setCachedIntel(symbol, payload) {
  if (!symbol || !payload) return;
  const stamped = {
    ...payload,
    cacheTimestamp: payload.cacheTimestamp
      || payload.timestamp
      || payload.fetchedAt
      || Date.now(),
  };
  _intelCache.set(symbol.toUpperCase(), stamped);
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

function emitMarketTick(updates) {
  if (!_io || !updates?.length) return;

  try {
    const buf = bp.encodeMarketTick(updates);
    _io.emit("binary", buf);
  } catch (e) {
    console.warn("⚠️ binary market-tick encode error:", e.message);
  }

  _io.emit("market-tick", updates);
}

const _intelTickThrottle = new Map();
// ── Straddle history persistence ──────────────────────────────────────────────
const _straddleHistory    = new Map(); // sym → [{ ts, straddle, strangle, spot, pcr }]
const _straddleLastMinute = new Map(); // sym → "HH:MM" last written minute

function _persistStraddleTick(sym, straddlePrice, stranglePrice, spotPrice, pcr, ts) {
  if (!sym || !straddlePrice) return;

  // Only write once per minute per symbol
  const now     = new Date();
  const istTime = now.toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata",
  });
  const lastMin = _straddleLastMinute.get(sym);
  if (lastMin === istTime) return; // already wrote this minute
  _straddleLastMinute.set(sym, istTime);

  // Only during market hours IST 09:15–15:30
  const [h, m] = istTime.split(":").map(Number);
  const mins = h * 60 + m;
  if (mins < 555 || mins > 930) return; // 09:15=555, 15:30=930

  const entry = {
    ts:       ts || Date.now(),
    time:     istTime,
    straddle: Math.round(straddlePrice * 100) / 100,
    strangle: Math.round((stranglePrice || 0) * 100) / 100,
    spot:     Math.round((spotPrice || 0) * 100) / 100,
    pcr:      pcr != null ? +(+pcr).toFixed(2) : null,
  };

  // Keep in memory
  if (!_straddleHistory.has(sym)) _straddleHistory.set(sym, []);
  const history = _straddleHistory.get(sym);
  history.push(entry);
  // Keep max 375 entries (one per minute for full market day)
  if (history.length > 375) history.shift();

  // Write to disk every 5 minutes or on first entry
  if (history.length === 1 || history.length % 5 === 0) {
    _flushStraddleHistory();
  }
}

function _flushStraddleHistory() {
  try {
    const fs   = require("fs");
    const path = require("path");
    const filePath = path.join(__dirname, "../data/liveOrderBook.json");

    let existing = {};
    try {
      if (fs.existsSync(filePath)) {
        existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
      }
    } catch (_) {}

    for (const [sym, history] of _straddleHistory) {
      if (!existing[sym]) existing[sym] = {};
      existing[sym].straddleHistory = history;
      existing[sym].updatedAt = Date.now();
    }

    fs.writeFileSync(filePath, JSON.stringify(existing), "utf8");
  } catch (e) {
    console.warn("⚠️ straddleHistory flush failed:", e.message);
  }
}

// Reset history at start of each trading day
function _resetStraddleHistoryIfNewDay() {
  const now = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
  if (_straddleHistory._lastDay && _straddleHistory._lastDay !== now) {
    _straddleHistory.clear();
    _straddleLastMinute.clear();
    console.log("📅 New trading day — straddle history reset");
  }
  _straddleHistory._lastDay = now;
}

setInterval(_resetStraddleHistoryIfNewDay, 60_000);
setInterval(_flushStraddleHistory, 5 * 60_000); // flush every 5 min as backup

function emitOptionsIntelTick(symbol, spotPrice) {
  if (!_io || !symbol || !spotPrice) return;

  const sym = symbol.toUpperCase();

  // Don't emit if straddlePrice not yet seeded — prevents 0 flash on chart
  const snap = _straddleCache.get(sym);
  if (!snap?.straddlePrice) return;

  const now  = Date.now();
  const last = _intelTickThrottle.get(sym) || 0;
  if (now - last < 500) return;
  _intelTickThrottle.set(sym, now);

  const cached = _intelCache.get(sym);
  if (!cached) return;

  const d         = cached.data || cached;
  const structure = d?.structure || {};


  const straddlePrice = snap?.straddlePrice
  ?? structure.straddlePrice
  ?? 0;

  // FIX-1: Single declaration of stranglePrice (removed duplicate).
  const stranglePrice = snap?.stranglePrice
    ?? structure.stranglePrice
    ?? d?.stranglePrice
    ?? 0;

  const atmIV = snap?.atmIV
    ?? d?.volatility?.atmIV
    ?? d?.atmIV
    ?? 0;

  const score = d?.score ?? 50;
  const bias  = d?.bias  ?? "NEUTRAL";

  const totalCallOI = snap?.totalCallOI ?? d?.oi?.totalCallOI ?? 0;
  const totalPutOI  = snap?.totalPutOI  ?? d?.oi?.totalPutOI  ?? 0;

  // FIX-3: Use ?? not || so PCR 0.00 is preserved; null means "no data"
  const pcrRaw = cached.pcr ?? snap?.pcr ?? d?.oi?.pcr ?? null;
  const pcr = pcrRaw != null ? +(+pcrRaw).toFixed(2) : null;

  // Guaranteed non-null timestamp so tsSec is never 0 in the binary frame.
  const cacheTs = Date.now(); // ← live tick time, always now

// Keep existing cacheTs separately for persist only:
const dataTs = cached.cacheTimestamp
  || cached.timestamp
  || d?.cacheTimestamp
  || Date.now();

  try {
    if (bp.encodeOptionsIntelTick) {
      const buf = bp.encodeOptionsIntelTick(
        sym, spotPrice, straddlePrice, atmIV, score, bias,
        stranglePrice, cacheTs, totalCallOI, totalPutOI, pcr
      );
      _io.to("intel").emit("binary", buf);
      _io.to("straddle").emit("binary", buf);
    }
  } catch (e) {
    console.warn("⚠️ binary OPTIONS_INTEL_TICK encode error:", e.message);
  }

  const payload = {
    symbol: sym,
    spotPrice,
    straddlePrice,
    stranglePrice,
    atmIV,
    score,
    bias,
    ts:          cacheTs,
    totalCallOI,
    totalPutOI,
    pcr,
  };
  _io.to("straddle").emit("options-intel-tick", payload);
  _io.to("intel").emit("options-intel-tick", payload);

  // ── Persist straddle tick to disk (1 entry per minute per symbol) ──────────
  // Use dataTs (NSE data capture time) not cacheTs (Date.now()) for disk history
  _persistStraddleTick(sym, straddlePrice, stranglePrice, spotPrice, pcr, dataTs);
}

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

function emitTechBatch(batch) {
  if (!_io || !batch?.length) return;
  try {
    const buf = bp.encodeJSON("scanner-tech-batch", batch);
    _io.to("scanner").emit("binary", buf);
  } catch (e) {
    console.warn("⚠️ emitTechBatch binary encode error:", e.message);
  }
  _io.to("scanner").emit("scanner-tech-batch", batch);
}

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
  let binaryOk = false;
  try {
    const buf = bp.encodeOptionsIntel(data);
    _io.to("intel").emit("binary", buf);
    _io.to("straddle").emit("binary", buf);
    binaryOk = true;
  } catch (e) {
    console.warn("⚠️ binary options-intel encode error:", e.message);
  }
  if (!binaryOk) {
    _io.to("intel").emit("options-intelligence", data);
    _io.to("straddle").emit("options-intelligence", data);
  }
  setCachedIntel(data.symbol, data);

 // 60s poll owns strangle, OI, PCR, IV only.
  // straddlePrice NEVER written here — updateLiveStraddlePrice owns it exclusively.
  const d = data.data || data;
  const s = d?.structure || {};
  const existing = _straddleCache.get(data.symbol.toUpperCase()) || {};
  _straddleCache.set(data.symbol.toUpperCase(), {
    straddlePrice: existing.straddlePrice || 0,
    stranglePrice: s.stranglePrice > 0 ? s.stranglePrice : (existing.stranglePrice || 0),
    pcr:         d?.oi?.pcr != null ? +(+d.oi.pcr).toFixed(2) : existing.pcr ?? null,
    atmIV:       d?.volatility?.atmIV ?? existing.atmIV ?? 0,
    totalCallOI: d?.oi?.totalCallOI   ?? existing.totalCallOI ?? 0,
    totalPutOI:  d?.oi?.totalPutOI    ?? existing.totalPutOI  ?? 0,
    timestamp:   existing.timestamp   ?? Date.now(),
  });
 // Seed straddlePrice from ATM CE+PE LTP if live tick hasn't arrived yet.
  // s.straddlePrice is raw chain sum (wrong). Use ATM row LTP directly.
  // Seed straddlePrice directly from the intel payload's chain data.
  // getSnapshot reads from disk cache which may not exist yet (debounced 5min write).
  // Instead, read ATM LTP directly from the ingestChainData processed result.
  if (!existing.straddlePrice) {
    const sym2 = data.symbol.toUpperCase();
    // Try direct module call first (no disk dependency)
    try {
      const straddleRoutes = require("../routes/straddleRoutes");
      straddleRoutes.getSnapshot(sym2).then(snap => {
        if (snap?.straddle?.combined > 0) {
          const cur3 = _straddleCache.get(sym2) || {};
          if (!cur3.straddlePrice) {
            _straddleCache.set(sym2, {
              ...cur3,
              straddlePrice: snap.straddle.combined,
              stranglePrice: snap.strangle?.combined || cur3.stranglePrice || 0,
              atmIV:   snap.iv?.atm   || cur3.atmIV   || 0,
              pcr:     snap.oi?.pcr   ?? cur3.pcr ?? null,
              totalCallOI: snap.oi?.ce ?? cur3.totalCallOI ?? 0,
              totalPutOI:  snap.oi?.pe ?? cur3.totalPutOI  ?? 0,
              timestamp: Date.now(),
            });
          }
        }
      }).catch(() => {});
    } catch (_) {}

    // Also seed from nseOIListener cache directly — no disk, always available after first poll
    try {
      const oi = require("../services/intelligence/nseOIListener");
      const allCached = oi.getAllCached?.();
      const chainData = allCached?.[sym2];
      if (chainData) {
        const expiries = chainData.expiries || [];
        const nearExp  = expiries[0];
        const chain    = chainData.chains?.[nearExp];
        const strikesArr = chain?.strikes || [];
        if (strikesArr.length) {
          const atmStrike = chain.atmStrike;
          const atmRow = strikesArr.find(s => s.strike === atmStrike);
          if (atmRow) {
            const straddle = (atmRow.ce?.ltp || 0) + (atmRow.pe?.ltp || 0);
            if (straddle > 0) {
              const cur3 = _straddleCache.get(sym2) || {};
              if (!cur3.straddlePrice) {
                _straddleCache.set(sym2, {
                  ...cur3,
                  straddlePrice: straddle,
                  timestamp: Date.now(),
                });
              }
            }
          }
        }
      }
    } catch (_) {}
  }
}
function emitCompositeUpdate(data) {
  if (!_io || !data) return;
  const buf = bp.encodeJSON("composite-update", data);
  _io.emit("binary", buf);
  _io.emit("composite-update", data);
}

function attachSocketIO(server) {
  const io = new Server(server, {
    cors:              { origin: "*" },
    pingInterval:      20_000,
    pingTimeout:       60_000,
    upgradeTimeout:    30_000,
    transports:        ["websocket", "polling"],
    allowUpgrades:     true,
    perMessageDeflate: { threshold: 1024 },
  });

  _io = io;

  // Seed _straddleCache from disk so first binary tick uses correct value
  try {
    const fs   = require("fs");
    const path = require("path");
    const cachePath = path.join(__dirname, "../data/optionChainCache.json");
    if (fs.existsSync(cachePath)) {
      const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      for (const [sym, chainData] of Object.entries(cache)) {
        const rawExpiries = chainData.expiries || Object.keys(chainData.chains || {});
        if (!rawExpiries.length) continue;
        const expiry     = rawExpiries[0];
        const chainExp   = chainData.chains?.[expiry];
        const strikesArr = chainExp?.strikes || [];
        if (!strikesArr.length) continue;
        const spotPrice  = chainExp.spotPrice || chainData.spotPrice || 0;
        const strikes    = strikesArr.map(s => s.strike).sort((a, b) => a - b);
        const atmStrike  = chainExp.atmStrike ||
          strikes.reduce((p, c) => Math.abs(c - spotPrice) < Math.abs(p - spotPrice) ? c : p);
        const atmRow = strikesArr.find(s => s.strike === atmStrike);
        if (!atmRow) continue;
        const straddlePremium = (atmRow?.ce?.ltp ?? 0) + (atmRow?.pe?.ltp ?? 0);
        const atmIdx    = strikes.indexOf(atmStrike);
        const scRow     = strikesArr.find(s => s.strike === (strikes[atmIdx + 1] ?? atmStrike)) || {};
        const spRow     = strikesArr.find(s => s.strike === (strikes[atmIdx - 1] ?? atmStrike)) || {};
        const stranglePremium = (scRow?.ce?.ltp ?? 0) + (spRow?.pe?.ltp ?? 0);
        const totalCeOI = strikesArr.reduce((s, r) => s + (r?.ce?.oi ?? 0), 0);
        const totalPeOI = strikesArr.reduce((s, r) => s + (r?.pe?.oi ?? 0), 0);
        const pcr   = totalCeOI > 0 ? (totalPeOI / totalCeOI).toFixed(2) : null;
        const ceIV  = atmRow?.ce?.iv ?? 0;
        const peIV  = atmRow?.pe?.iv ?? 0;
        const atmIV = +((ceIV + peIV) / 2).toFixed(2);
        const ts    = chainData.timestamp || chainExp?.timestamp || Date.now();
        setCachedStraddleSnap(sym.toUpperCase(), {
          straddle:  { combined: straddlePremium },
          strangle:  { combined: stranglePremium },
          oi:        { pcr, ce: totalCeOI, pe: totalPeOI },
          iv:        { atm: atmIV },
          timestamp: ts,
        });
        console.log(`✅ [straddleCache seed] ${sym}: straddle=${straddlePremium} strangle=${stranglePremium}`);
      }
    }
  } catch (e) {
    console.warn("⚠️ straddleCache disk seed failed:", e.message);
  }

  subscribe("SECTOR_UPDATED", (data) => {
    io.emit("update", data);
  });

  _startScannerFlush(io);

  io.on("connection", (socket) => {
    console.log(`👤 Client connected: ${socket.id}`);

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

    socket.on("request-straddle-snapshot", async ({ symbol, type, side } = {}) => {
      if (!symbol) return;
      try {
        // Use direct module calls instead of self-HTTP
        const straddleRoutes = require("../routes/straddleRoutes");
        if (straddleRoutes.getSnapshot) {
          const snap = await straddleRoutes.getSnapshot(symbol);
          if (snap && !snap.error) socket.emit("straddle-snapshot", { symbol, data: snap });
        }
        if (straddleRoutes.getPayoff) {
          const payoff = await straddleRoutes.getPayoff(symbol, type || "straddle", side || "sell");
          if (payoff && !payoff.error) socket.emit("straddle-payoff", { symbol, ...payoff });
        }
      } catch (e) {
        console.warn("⚠️ request-straddle-snapshot error:", e.message);
      }
    });

    socket.on("join:scanner", () => {
      socket.join("scanner");

      // Send all cached tech data immediately to newly joined client
      try {
        const scanner = require("../services/intelligence/marketScanner");
        if (scanner.getTechBatch) {
          const techBatch = scanner.getTechBatch();
          if (techBatch.length > 0) {
            socket.emit("scanner-tech-batch", techBatch);
            console.log(`📊 join:scanner — sent ${techBatch.length} tech entries`);
          }
        }
      } catch (_) {}

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
      console.log(`📊 ${socket.id} joined scanner room (${snapshot.length} stocks)`);
    });

    socket.on("leave:scanner", () => socket.leave("scanner"));

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

    socket.on("backtest:start", () => socket.join(`backtest:${socket.id}`));
    socket.on("backtest:stop",  () => socket.leave(`backtest:${socket.id}`));

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

    socket.on("join:straddle", () => {
      socket.join("straddle");

      // Only hydrate from _straddleCache (REST snapshot derived, correct values)
      // Skip _intelCache emit — it has stale 60s cycle data that overwrites correct prices
      for (const [sym, snap] of _straddleCache) {
        if (!snap?.straddlePrice) continue;
        const intel = _intelCache.get(sym);
        const d     = intel?.data || intel || {};

        // Send if price exists — either live tick OR REST seed from today's session.
        // Without this, chart is blank until first live tick arrives after restart.

        socket.emit("options-intel-tick", {
          symbol:       sym,
          spotPrice:    d?.spot ?? d?.spotPrice ?? 0,
          straddlePrice: snap.straddlePrice,
          stranglePrice: snap.stranglePrice ?? 0,
          atmIV:        snap.atmIV ?? 0,
          score:        d?.score ?? 50,
          bias:         d?.bias  ?? "NEUTRAL",
          ts:           Date.now(),
          totalCallOI:  snap.totalCallOI ?? 0,
          totalPutOI:   snap.totalPutOI  ?? 0,
          pcr:          snap.pcr ?? null,
        });
        if (intel) socket.emit("options-intelligence", intel);
      }

      console.log(`📊 ${socket.id} joined straddle room`);
    });

    socket.on("leave:straddle", () => {
      socket.leave("straddle");
      console.log(`📊 ${socket.id} left straddle room`);
    });

    socket.on("join:alerts", () => {
      socket.join("alerts");
      try {
        const { sendAlertsToClient } = require("../coordinator");
        sendAlertsToClient(socket);
      } catch (_) {}
      try {
        const sct = require("../services/intelligence/smartCircuitTracker");
        const watchlist = sct.getCircuitWatchlist();
        const alerts    = sct.getRecentAlerts();
        if (watchlist?.length) socket.emit("circuit-watchlist", watchlist);
        if (alerts?.length)    socket.emit("circuit-alerts",    alerts);
        console.log(`🔔 join:alerts hydration: ${watchlist.length} stocks, ${alerts.length} alerts`);
      } catch (e) {
        console.warn("⚠️ join:alerts hydration failed:", e.message);
      }
      try {
        const cw = require("../services/intelligence/circuitWatcher");
        const watchlist = cw.getLastWatchlist();
        const alerts    = cw.getLastAlerts();
        if (watchlist?.length) socket.emit("circuit-watchlist", watchlist);
        if (alerts?.length)    socket.emit("circuit-alerts",    alerts);
      } catch (_) {}
    });

    socket.on("leave:alerts", () => socket.leave("alerts"));

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
// Auto-seed _straddleCache from REST snapshot for all major symbols
  // This ensures correct straddle prices are available before any client connects

  
  console.log("🌐 Socket.io attached — Binary Protocol v1 + perMessageDeflate");
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
  setCachedStraddleSnap,   // ← NEW export — call from straddleRoutes
  getCachedStraddleSnap,   // ← NEW export
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
  updateLiveStraddlePrice,
  _straddleCache,
};