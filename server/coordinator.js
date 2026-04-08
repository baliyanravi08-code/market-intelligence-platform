/**
 * coordinator.js
 * Location: server/coordinator.js
 *
 * UPDATED: 08 Apr 2026 (Session 5 patch)
 * - Gann integration fixed: removed undefined onNewLTP/setGannSignal references
 * - gannDataFetcher wired: auto-pulls 52w high/low + swing pivots for 200 NSE stocks
 * - All prior patches preserved (composite engine, circuit watcher, delivery analyzer, etc.)
 */

const fs   = require("fs");
const path = require("path");

const { startGannIntegration }                     = require("./services/intelligence/gannIntegration");
const { startGannDataFetcher }                     = require("./services/intelligence/gannDataFetcher");
const { startDeliveryAnalyzer, onDeliverySpike }   = require("./services/intelligence/deliveryAnalyzer");
const { startCircuitWatcher, onCircuitAlert, onCircuitWatchlist } = require("./services/intelligence/circuitWatcher");

const {
  startCompositeEngine,
  ingestSmartMoney,
  ingestOpportunity,
  getLeaderboard,
  getCompositeForScrip,
} = require("./services/intelligence/compositeScoreEngine");

const { getCredibilityForScrip } = require("./services/intelligence/credibilityEngine");

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

// ── Persist functions ─────────────────────────────────────────────────────────

function persistRadar(radar) {
  stored.radar = radar || [];
}

function persistOrderBook(orderData) {
  if (!orderData) return;
  const existing   = stored.orderBook.filter((o) => o.company !== orderData.company);
  stored.orderBook = [orderData, ...existing].slice(0, 100);
  saveToDisk();
}

function persistSector(sectorData) {
  if (!sectorData) return;
  const existing = stored.sectors.filter((s) => s.sector !== sectorData.sector);
  stored.sectors = [sectorData, ...existing].slice(0, 20);
  saveToDisk();
}

function persistOpportunity(opp) {
  if (!opp) return;
  ingestOpportunity(opp);
  const existing       = stored.opportunities.filter((o) => o.company !== opp.company);
  stored.opportunities = [opp, ...existing].slice(0, 20);
  saveToDisk();
}

function persistMegaOrder(order) {
  if (!order) return;
  const existing    = stored.megaOrders.filter((o) => o.company !== order.company);
  stored.megaOrders = [order, ...existing].slice(0, 20);
  saveToDisk();
}

function persistGuidance(doc) {
  if (!doc) return;
  const existing  = stored.guidance.filter((g) => g.scrip !== doc.scrip);
  stored.guidance = [doc, ...existing].slice(0, 200);
  saveToDisk();
}

function persistCredibility(doc) {
  if (!doc) return;
  const existing     = stored.credibility.filter((c) => c.scrip !== doc.scrip);
  stored.credibility = [doc, ...existing].slice(0, 200);
  saveToDisk();
}

function persistDeliverySpike(spikes) {
  if (!spikes || spikes.length === 0) return;
  const merged = [...spikes, ...stored.deliverySpikes];
  const seen   = new Set();
  stored.deliverySpikes = merged
    .filter((s) => {
      const key = s.symbol + s.timestamp;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 50);
  saveToDisk();
}

function persistCircuitAlerts(alerts) {
  if (!alerts || alerts.length === 0) return;
  const merged = [...alerts, ...stored.circuitAlerts];
  const seen   = new Set();
  stored.circuitAlerts = merged
    .filter((a) => {
      const key = a.symbol + a.timestamp;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 50);
  saveToDisk();
}

function persistCircuitWatchlist(watchlist) {
  if (!watchlist || watchlist.length === 0) return;
  stored.circuitWatchlist = watchlist;
}

// ── Smart money passthrough ───────────────────────────────────────────────────

function handleSmartMoneyEvent(event) {
  if (!event) return;
  ingestSmartMoney(event);
}

// ── Send stored data to newly connected client ────────────────────────────────

function sendStoredToClient(socket) {
  if (stored.orderBook.length > 0) {
    stored.orderBook.forEach((o) => socket.emit("order_book_update", o));
    console.log(`📤 Sent ${stored.orderBook.length} stored orders to client`);
  }
  if (stored.sectors.length > 0) {
    socket.emit("sector_alerts", stored.sectors);
  }
  if (stored.opportunities.length > 0) {
    stored.opportunities.forEach((o) => socket.emit("opportunity_alert", o));
  }
  if (stored.megaOrders.length > 0) {
    stored.megaOrders.forEach((o) => socket.emit("mega_order_alert", o));
  }
  if (stored.guidance.length > 0) {
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

function getStored() {
  return stored;
}

// ── Start coordinator + all intelligence services ─────────────────────────────

function startCoordinator(io, tokenGetter, instrumentMapGetter) {
  console.log("🚀 Coordinator Running");

  // Composite score engine
  startCompositeEngine(io, { getCredibilityForScrip });
  console.log("⚡ Composite Score Engine started");

  // Gann: wire socket handlers (no live tick feed needed)
  startGannIntegration(io, {
    onNewLTP:      (cb) => {},   // no-op: Gann levels update daily, not tick-by-tick
    setGannSignal: (symbol, signal) => {},   // no-op: extend later to feed composite engine
  });

  // Gann: pull 52w high/low + swing pivots for all NSE stocks from Upstox
  // Runs 5s after startup, then refreshes daily at 09:00 AM IST automatically
  startGannDataFetcher();
  console.log("📐 Gann Data Fetcher scheduled");

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

  setInterval(() => {
    io.emit("system_event", { type: "heartbeat", time: new Date().toISOString() });
  }, 30000);

  startDeliveryAnalyzer(io);
  onDeliverySpike((spikes) => {
    persistDeliverySpike(spikes);
    console.log(`💾 Persisted ${spikes.length} delivery spike(s) to disk`);
  });

  startCircuitWatcher(io, tokenGetter, instrumentMapGetter);

  onCircuitAlert((alerts) => {
    persistCircuitAlerts(alerts);
    console.log(`💾 Persisted ${alerts.length} circuit alert(s) to disk`);
  });

  onCircuitWatchlist((watchlist) => {
    persistCircuitWatchlist(watchlist);
  });
}

module.exports = {
  startCoordinator,
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