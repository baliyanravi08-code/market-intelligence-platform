"use strict";

/**
 * coordinator.js
 * Location: server/coordinator.js
 *
 * CHANGES vs previous version:
 *   - REMOVED: compositeScoreEngine (deleted)
 *   - REMOVED: credibilityEngine (deleted)
 *   - ADDED: smartCircuitTracker (replaces circuitWatcher)
 *   - ADDED: sectorEngine (replaces sectorQueue + sectorBoomEngine + sectorRadar)
 *   - KEPT: Gann, options, delivery analyzer, order book, LTP registry
 */

const fs   = require("fs");
const path = require("path");

const { startGannIntegration }   = require("./services/intelligence/gannIntegration");
const gannIntegration            = require("./services/intelligence/gannIntegration");
const ws                         = require("./api/websocket");

const { startDeliveryAnalyzer, onDeliverySpike } = require("./services/intelligence/deliveryAnalyzer");

// New: SmartCircuitTracker replaces circuitWatcher
const {
  startSmartCircuitTracker,
  onCircuitAlert,
  onCircuitWatchlist,
  getCircuitWatchlist,
} = require("./services/intelligence/smartCircuitTracker");

// New: sectorEngine replaces sectorQueue + sectorBoomEngine + sectorRadar
const {
  startSectorEngine,
  ingestFilingSignal,
  getSectorSnapshot,
} = require("./services/intelligence/sectorEngine");

const { startOptionsIntegration } = require("./services/intelligence/optionsIntegration");

// ── LTP registry ──────────────────────────────────────────────────────────────
const ltpRegistry  = new Map();
const ltpListeners = [];

function registerLTPTick(symbol, ltp) {
  if (!symbol || !ltp || ltp <= 0) return;
  const sym = symbol.toUpperCase();
  ltpRegistry.set(sym, { ltp, ts: Date.now() });
  for (const cb of ltpListeners) {
    try { cb(sym, ltp); } catch { /* never crash tick pipeline */ }
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
        orderBook:        (parsed.orderBook        || []).slice(0, 30),
        sectors:          parsed.sectors          || [],
        opportunities:    parsed.opportunities    || [],
        megaOrders:       parsed.megaOrders       || [],
        deliverySpikes:   (parsed.deliverySpikes   || []).slice(0, 50),
        circuitAlerts:    (parsed.circuitAlerts    || []).slice(0, 50),
        circuitWatchlist: parsed.circuitWatchlist || [],
      };
      console.log(
        `📦 Coordinator loaded: ${stored.orderBook.length} orders, ` +
        `${stored.sectors.length} sectors, ${stored.deliverySpikes.length} delivery spikes, ` +
        `${stored.circuitAlerts.length} circuit alerts, ${stored.circuitWatchlist.length} watchlist stocks`
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

// Save every 15 min
setInterval(saveToDisk, 15 * 60 * 1000);
process.on("exit",    saveToDisk);
process.on("SIGTERM", () => { saveToDisk(); process.exit(0); });

// ── Persist helpers ───────────────────────────────────────────────────────────

function persistRadar(radar) { stored.radar = radar || []; }

function persistOrderBook(orderData) {
  if (!orderData) return;
  stored.orderBook = [orderData, ...stored.orderBook.filter(o => o.company !== orderData.company)].slice(0, 30);
  saveToDisk();
}

function persistSector(sectorData) {
  if (!sectorData) return;
  // Also ingest into live sectorEngine
  try { ingestFilingSignal(sectorData); } catch {}
  stored.sectors = [sectorData, ...stored.sectors.filter(s => s.sector !== sectorData.sector)].slice(0, 20);
  saveToDisk();
}

function persistOpportunity(opp) {
  if (!opp) return;
  stored.opportunities = [opp, ...stored.opportunities.filter(o => o.company !== opp.company)].slice(0, 20);
  saveToDisk();
}

function persistMegaOrder(order) {
  if (!order) return;
  stored.megaOrders = [order, ...stored.megaOrders.filter(o => o.company !== order.company)].slice(0, 20);
  saveToDisk();
}

// Removed: persistGuidance, persistCredibility — those engines are deleted

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
    .filter(a => { const k = a.symbol + (a.timestamp || ""); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 50);
  saveToDisk();
}

function persistCircuitWatchlist(watchlist) {
  if (!watchlist || watchlist.length === 0) return;
  stored.circuitWatchlist = watchlist;
}

function handleSmartMoneyEvent(event) {
  if (!event?.company) return;
  // Pass to sectorEngine as a filing signal
  try {
    ingestFilingSignal({ company: event.company, title: event.title || "", _orderInfo: null, type: "SMART_MONEY" });
  } catch {}
}

// ── Send stored state to newly connected client ───────────────────────────────
function sendStoredToClient(socket) {
  if (stored.orderBook.length > 0) {
    stored.orderBook.forEach(o => socket.emit("order_book_update", o));
  }
  if (stored.sectors.length > 0)       socket.emit("sector_alerts",     stored.sectors);
  if (stored.opportunities.length > 0) stored.opportunities.forEach(o => socket.emit("opportunity_alert", o));
  if (stored.megaOrders.length > 0)    stored.megaOrders.forEach(o => socket.emit("mega_order_alert", o));

  if (stored.deliverySpikes.length > 0) {
    socket.emit("delivery-spikes", stored.deliverySpikes);
  }
  if (stored.circuitAlerts.length > 0) {
    socket.emit("circuit-alerts", stored.circuitAlerts);
  }
  if (stored.circuitWatchlist.length > 0) {
    socket.emit("circuit-watchlist", stored.circuitWatchlist);
  }

  // Send live sector snapshot
  try {
    const snapshot = getSectorSnapshot();
    if (snapshot.length > 0) socket.emit("sector-snapshot", snapshot);
  } catch {}
}

function getStored() { return stored; }

// ── Main coordinator ──────────────────────────────────────────────────────────
function startCoordinator(io, tokenGetter, instrumentMapGetter) {
  console.log("🚀 Coordinator Running");

  // ── 1. Options Intelligence ───────────────────────────────────────────────
  startOptionsIntegration(io, { ingestOptionsSignal: persistOpportunity });
  console.log("📊 Options Intelligence Engine started");

  // ── 2. Sector Engine ─────────────────────────────────────────────────────
  startSectorEngine(io);
  console.log("🏭 Sector Engine started");

  // ── 3. Smart Circuit Tracker ─────────────────────────────────────────────
  startSmartCircuitTracker(io, tokenGetter, instrumentMapGetter);
  onCircuitAlert((alerts) => {
    persistCircuitAlerts(alerts);
  });
  onCircuitWatchlist((watchlist) => {
    persistCircuitWatchlist(watchlist);
  });
  console.log("🔔 Smart Circuit Tracker started");

  // ── 4. Gann Integration ──────────────────────────────────────────────────
  startGannIntegration(io, {
    onNewLTP: (cb) => { ltpListeners.push(cb); },
    setGannSignal: (symbol, signal) => {
      if (!symbol || !signal) return;
    },
  })
    .then(() => {
      ws.setGannIntegration(gannIntegration);
      console.log("📐 Gann Integration started");
    })
    .catch(e => {
      console.error("📐 Gann Integration start error:", e.message);
      ws.setGannIntegration(gannIntegration);
    });

  // ── 5. Socket handlers ────────────────────────────────────────────────────
  io.on("connection", (socket) => {
    sendStoredToClient(socket);
    // Legacy: clients that still ask for composite scores get empty array
    socket.on("get-composite-scores", () => {
      socket.emit("composite-scores", []);
    });
  });

  // ── 6. Heartbeat ─────────────────────────────────────────────────────────
  setInterval(() => {
    io.emit("system_event", { type: "heartbeat", time: new Date().toISOString() });
  }, 30_000);

  // ── 7. Delivery analyzer ─────────────────────────────────────────────────
  startDeliveryAnalyzer(io);
  onDeliverySpike((spikes) => {
    persistDeliverySpike(spikes);
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
  persistDeliverySpike,
  persistCircuitAlerts,
  persistCircuitWatchlist,
  sendStoredToClient,
  handleSmartMoneyEvent,
  getStored,
};