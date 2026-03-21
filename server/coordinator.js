/**
 * coordinator.js
 * Persists radar, orderBook, sectors, opportunities to disk.
 * Sends stored data to new clients on connect.
 */

const fs   = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "data/coordinator.json");

let stored = {
  radar:         [],
  orderBook:     [],
  sectors:       [],
  opportunities: [],
  megaOrders:    []
};

function loadFromDisk() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw  = fs.readFileSync(DATA_FILE, "utf8");
      stored = { ...stored, ...JSON.parse(raw) };
      console.log(`📦 Coordinator loaded: ${stored.orderBook.length} orders, ${stored.sectors.length} sectors`);
    }
  } catch(e) {
    console.log("⚠️ Coordinator load failed:", e.message);
  }
}

function saveToDisk() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(stored), "utf8");
  } catch(e) {
    console.log("⚠️ Coordinator save failed:", e.message);
  }
}

loadFromDisk();
setInterval(saveToDisk, 2 * 60 * 1000);

// ── Persist functions called by listeners ──
function persistRadar(radar) {
  stored.radar = radar || [];
}

function persistOrderBook(orderData) {
  if (!orderData) return;
  const existing = stored.orderBook.filter(o => o.company !== orderData.company);
  stored.orderBook = [orderData, ...existing].slice(0, 100);
  saveToDisk();
}

function persistSector(sectorData) {
  if (!sectorData) return;
  const existing = stored.sectors.filter(s => s.sector !== sectorData.sector);
  stored.sectors = [sectorData, ...existing].slice(0, 20);
  saveToDisk();
}

function persistOpportunity(opp) {
  if (!opp) return;
  const existing = stored.opportunities.filter(o => o.company !== opp.company);
  stored.opportunities = [opp, ...existing].slice(0, 20);
  saveToDisk();
}

function persistMegaOrder(order) {
  if (!order) return;
  const existing = stored.megaOrders.filter(o => o.company !== order.company);
  stored.megaOrders = [order, ...existing].slice(0, 20);
  saveToDisk();
}

// ── Called from bseListener on each new socket connection ──
function sendStoredToClient(socket) {
  if (stored.orderBook.length > 0) {
    stored.orderBook.forEach(o => socket.emit("order_book_update", o));
    console.log(`📤 Sent ${stored.orderBook.length} stored orders to client`);
  }
  if (stored.sectors.length > 0) {
    socket.emit("sector_alerts", stored.sectors);
  }
  if (stored.opportunities.length > 0) {
    stored.opportunities.forEach(o => socket.emit("opportunity_alert", o));
  }
  if (stored.megaOrders.length > 0) {
    stored.megaOrders.forEach(o => socket.emit("mega_order_alert", o));
  }
}

function getStored() {
  return stored;
}

function startCoordinator(io) {
  console.log("🚀 Coordinator Running");
  // Heartbeat only — connection handling is done in bseListener.js
  setInterval(() => {
    io.emit("system_event", { type: "heartbeat", time: new Date().toISOString() });
  }, 30000);
}

module.exports = {
  startCoordinator,
  persistRadar,
  persistOrderBook,
  persistSector,
  persistOpportunity,
  persistMegaOrder,
  sendStoredToClient,
  getStored
};