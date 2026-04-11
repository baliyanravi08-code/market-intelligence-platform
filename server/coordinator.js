"use strict";

/**
 * coordinator.js
 * Location: server/coordinator.js
 *
 * FIXES (this session):
 *  1. startGannDataFetcher() removed from here — called by server.js AFTER
 *     loadInstrumentMaster() resolves, eliminating the race condition.
 *  2. startGannIntegration wired to REAL onNewLTP + setGannSignal callbacks.
 *  3. startOptionsIntegration confirmed wired.
 *  4. LTP registry: upstoxStream ticks captured in an in-process Map.
 *  5. FIX: ws.setGannIntegration() called after startGannIntegration so
 *     websocket.js can forward "get-gann-analysis" socket events to the
 *     Gann engine even when the client connects before gannIntegration
 *     registers its own socket listeners.
 */

const fs   = require("fs");
const path = require("path");

const { startGannIntegration }   = require("./services/intelligence/gannIntegration");
const ws                         = require("./api/websocket");           // FIX 5
const { startDeliveryAnalyzer, onDeliverySpike }   = require("./services/intelligence/deliveryAnalyzer");
const { startCircuitWatcher, onCircuitAlert, onCircuitWatchlist } = require("./services/intelligence/circuitWatcher");

const {
  startCompositeEngine,
  ingestSmartMoney,
  ingestOpportunity,
  getLeaderboard,
  getCompositeForScrip,
  setExternalSignal,
} = require("./services/intelligence/compositeScoreEngine");

const { getCredibilityForScrip } = require("./services/intelligence/credibilityEngine");
const { startOptionsIntegration } = require("./services/intelligence/optionsIntegration");

// ── LTP registry ──────────────────────────────────────────────────────────────
const ltpRegistry = new Map();
const ltpListeners = [];

function registerLTPTick(symbol, ltp) {
  if (!symbol || !ltp || ltp <= 0) return;
  const sym = symbol.toUpperCase();
  ltpRegistry.set(sym, { ltp, ts: Date.now() });
  for (const cb of ltpListeners) {
    try { cb(sym, ltp); } catch (e) { /* never crash the tick pipeline */ }
  }
}

function getLatestLTP(symbol) {
  return ltpRegistry.get(symbol?.toUpperCase())?.ltp || null;
}

// ── Data file ─────────────────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, "data/coordinator.json");

let stored = {
  radar:            [],
  orderBook:        [],
  sectors:          [],
  opportunities:    [],
  megaOrders:       [],
  guidance:         [],
  credibility:      [],
  deliverySpikes:   [],
  circuitAlerts:    [],
  circuitWatchlist: [],
};

function loadFromDisk() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw    = fs.readFileSync(DATA_FILE, "utf8");
      const parsed = JSON.parse(raw);
      stored = {
        radar:            parsed.radar            || [],
        orderBook:        parsed.orderBook        || [],
        sectors:          parsed.sectors          || [],
        opportunities:    parsed.opportunities    || [],
        megaOrders:       parsed.megaOrders       || [],
        guidance:         parsed.guidance         || [],
        credibility:      parsed.credibility      || [],
        deliverySpikes:   parsed.deliverySpikes   || [],
        circuitAlerts:    parsed.circuitAlerts    || [],
        circuitWatchlist: parsed.circuitWatchlist || [],
      };
      console.log(
        `📦 Coordinator loaded: ${stored.orderBook.length} orders, ` +
        `${stored.sectors.length} sectors, ` +
        `${stored.guidance.length} guidance, ` +
        `${stored.credibility.length} credibility, ` +
        `${stored.deliverySpikes.length} delivery spikes, ` +
        `${stored.circuitAlerts.length} circuit alerts, ` +
        `${stored.circuitWatchlist.length} watchlist stocks`
      );
    }
  } catch (e) {
    console.log("⚠️ Coordinator load failed:", e.message);
  }
}

function saveToDisk() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(stored), "utf8");
  } catch (e) {
    console.log("⚠️ Coordinator save failed:", e.message);
  }
}

loadFromDisk();
setInterval(saveToDisk, 2 * 60 * 1000);

// ── Persist helpers ───────────────────────────────────────────────────────────

function persistRadar(radar) { stored.radar = radar || []; }

function persistOrderBook(orderData) {
  if (!orderData) return;
  stored.orderBook = [orderData, ...stored.orderBook.filter(o => o.company !== orderData.company)].slice(0, 100);
  saveToDisk();
}

function persistSector(sectorData) {
  if (!sectorData) return;
  stored.sectors = [sectorData, ...stored.sectors.filter(s => s.sector !== sectorData.sector)].slice(0, 20);
  saveToDisk();
}

function persistOpportunity(opp) {
  if (!opp) return;
  ingestOpportunity(opp);
  stored.opportunities = [opp, ...stored.opportunities.filter(o => o.company !== opp.company)].slice(0, 20);
  saveToDisk();
}

function persistMegaOrder(order) {
  if (!order) return;
  stored.megaOrders = [order, ...stored.megaOrders.filter(o => o.company !== order.company)].slice(0, 20);
  saveToDisk();
}

function persistGuidance(doc) {
  if (!doc) return;
  stored.guidance = [doc, ...stored.guidance.filter(g => g.scrip !== doc.scrip)].slice(0, 200);
  saveToDisk();
}

function persistCredibility(doc) {
  if (!doc) return;
  stored.credibility = [doc, ...stored.credibility.filter(c => c.scrip !== doc.scrip)].slice(0, 200);
  saveToDisk();
}

function persistDeliverySpike(spikes) {
  if (!spikes || spikes.length === 0) return;
  const merged = [...spikes, ...stored.deliverySpikes];
  const seen   = new Set();
  stored.deliverySpikes = merged
    .filter(s => { const k = s.symbol + s.timestamp; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 50);
  saveToDisk();
}

function persistCircuitAlerts(alerts) {
  if (!alerts || alerts.length === 0) return;
  const merged = [...alerts, ...stored.circuitAlerts];
  const seen   = new Set();
  stored.circuitAlerts = merged
    .filter(a => { const k = a.symbol + a.timestamp; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 50);
  saveToDisk();
}

function persistCircuitWatchlist(watchlist) {
  if (!watchlist || watchlist.length === 0) return;
  stored.circuitWatchlist = watchlist;
}

function handleSmartMoneyEvent(event) {
  if (event) ingestSmartMoney(event);
}

// ── Send stored state to a newly connected client ─────────────────────────────
function sendStoredToClient(socket) {
  if (stored.orderBook.length > 0) {
    stored.orderBook.forEach(o => socket.emit("order_book_update", o));
    console.log(`📤 Sent ${stored.orderBook.length} stored orders to client`);
  }
  if (stored.sectors.length       > 0) socket.emit("sector_alerts",       stored.sectors);
  if (stored.opportunities.length > 0) stored.opportunities.forEach(o => socket.emit("opportunity_alert", o));
  if (stored.megaOrders.length    > 0) stored.megaOrders.forEach(o => socket.emit("mega_order_alert", o));
  if (stored.guidance.length      > 0) {
    socket.emit("guidance_stored", stored.guidance);
    console.log(`📤 Sent ${stored.guidance.length} stored guidance docs to client`);
  }
  if (stored.credibility.length > 0) {
    socket.emit("credibility_stored", stored.credibility);
    console.log(`📤 Sent ${stored.credibility.length} credibility scores to client`);
  }
  if (stored.deliverySpikes.length > 0) {
    socket.emit("delivery-spikes", stored.deliverySpikes);
    console.log(`📤 Sent ${stored.deliverySpikes.length} delivery spikes to client`);
  }
  if (stored.circuitAlerts.length > 0) {
    socket.emit("circuit-alerts", stored.circuitAlerts);
    console.log(`📤 Sent ${stored.circuitAlerts.length} circuit alerts to client`);
  }
  if (stored.circuitWatchlist.length > 0) {
    socket.emit("circuit-watchlist", stored.circuitWatchlist);
    console.log(`📤 Sent ${stored.circuitWatchlist.length} watchlist stocks to client`);
  }

  const leaderboard = getLeaderboard(100);
  if (leaderboard.length > 0) {
    socket.emit("composite-scores", leaderboard);
    console.log(`📤 Sent ${leaderboard.length} composite scores to client`);
  }
}

function getStored() { return stored; }

// ── Main coordinator ──────────────────────────────────────────────────────────
function startCoordinator(io, tokenGetter, instrumentMapGetter) {
  console.log("🚀 Coordinator Running");

  // ── 1. Composite score engine ─────────────────────────────────────────────
  startCompositeEngine(io, { getCredibilityForScrip });
  console.log("⚡ Composite Score Engine started");

  // ── 2. Options Intelligence ───────────────────────────────────────────────
  startOptionsIntegration(io, { ingestOptionsSignal: ingestOpportunity });
  console.log("📊 Options Intelligence Engine started");

  // ── 3. Gann Integration ───────────────────────────────────────────────────
  const gannIntegration = require("./services/intelligence/gannIntegration");

  startGannIntegration(io, {
    onNewLTP: (cb) => {
      ltpListeners.push(cb);
    },
    setGannSignal: (symbol, signal) => {
      if (!symbol || !signal) return;
      if (typeof setExternalSignal === "function") {
        setExternalSignal(symbol, "gann", signal);
      }
      const updated = getCompositeForScrip(symbol);
      if (updated) io.emit("composite-update", updated);
    },
  });

  // FIX 5: Wire gannIntegration into websocket.js so the "get-gann-analysis"
  // socket handler in websocket.js can forward requests to the Gann engine.
  // This covers the case where a client connects before gannIntegration's own
  // registerSocketHandlers() fires on the "connection" event.
  ws.setGannIntegration(gannIntegration);

  console.log("📐 Gann Integration started");

  // NOTE: startGannDataFetcher() is intentionally NOT called here.
  // server.js calls it inside loadInstrumentMaster().finally() so the
  // instrument map is fully loaded before Gann tries to fetch candles.

  // ── 4. Socket handlers ────────────────────────────────────────────────────
  io.on("connection", (socket) => {
    sendStoredToClient(socket);

    socket.on("get-composite-scores", () => {
      socket.emit("composite-scores", getLeaderboard(100));
    });

    socket.on("get-composite-score", (symbol) => {
      if (!symbol) return;
      const score = getCompositeForScrip(symbol);
      if (score) socket.emit("composite-update", score);
    });
  });

  // ── 5. Heartbeat ──────────────────────────────────────────────────────────
  setInterval(() => {
    io.emit("system_event", { type: "heartbeat", time: new Date().toISOString() });
  }, 30_000);

  // ── 6. Delivery analyzer ──────────────────────────────────────────────────
  startDeliveryAnalyzer(io);
  onDeliverySpike((spikes) => {
    persistDeliverySpike(spikes);
    console.log(`💾 Persisted ${spikes.length} delivery spike(s)`);
  });

  // ── 7. Circuit watcher ────────────────────────────────────────────────────
  startCircuitWatcher(io, tokenGetter, instrumentMapGetter);
  onCircuitAlert((alerts) => {
    persistCircuitAlerts(alerts);
    console.log(`💾 Persisted ${alerts.length} circuit alert(s)`);
  });
  onCircuitWatchlist((watchlist) => {
    persistCircuitWatchlist(watchlist);
  });
}

module.exports = {
  startCoordinator,
  registerLTPTick,
  getLatestLTP,
  persistRadar,
  persistOrderBook,
  persistSector,
  persistOpportunity,
  persistMegaOrder,
  persistGuidance,
  persistCredibility,
  persistDeliverySpike,
  persistCircuitAlerts,
  persistCircuitWatchlist,
  sendStoredToClient,
  handleSmartMoneyEvent,
  getStored,
};