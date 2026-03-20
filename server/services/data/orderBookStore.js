/**
 * orderBookStore.js
 * Persists order book to disk — survives server restarts on Render.
 */

const fs   = require("fs");
const path = require("path");

const STORE_FILE = path.join(__dirname, "../../data/orderBookStore.json");

let orderBooks   = new Map();
let orderIdsSeen = new Set();

function loadFromDisk() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw  = fs.readFileSync(STORE_FILE, "utf8");
      const data = JSON.parse(raw);
      orderBooks   = new Map(Object.entries(data.books || {}));
      orderIdsSeen = new Set(data.seenIds || []);
      console.log(`📦 OrderBook loaded: ${orderBooks.size} companies`);
    }
  } catch(e) {
    console.log("⚠️ OrderBook load failed:", e.message);
    orderBooks   = new Map();
    orderIdsSeen = new Set();
  }
}

function saveToDisk() {
  try {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify({
      books:   Object.fromEntries(orderBooks),
      seenIds: [...orderIdsSeen].slice(-2000)
    }), "utf8");
  } catch(e) {
    console.log("⚠️ OrderBook save failed:", e.message);
  }
}

// Load on startup
loadFromDisk();

// Auto-save every 5 minutes
setInterval(saveToDisk, 5 * 60 * 1000);

function addOrder(companyCode, orderValueCrore, orderId) {
  const code = String(companyCode);

  if (orderId && orderIdsSeen.has(orderId)) {
    return orderBooks.get(code) || { totalOrderValue: 0, orders: [] };
  }
  if (orderId) orderIdsSeen.add(orderId);

  if (!orderBooks.has(code)) {
    orderBooks.set(code, { totalOrderValue: 0, orders: [] });
  }

  const data = orderBooks.get(code);

  // Remove orders older than 365 days
  const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
  data.orders = data.orders.filter(o => new Date(o.time).getTime() > cutoff);

  data.orders.push({
    value:   orderValueCrore,
    time:    new Date().toISOString(),
    orderId: orderId || null
  });

  // Recalculate total from actual orders
  data.totalOrderValue = data.orders.reduce((s, o) => s + (o.value || 0), 0);

  saveToDisk();
  return data;
}

function getOrderBook(companyCode) {
  return orderBooks.get(String(companyCode));
}

module.exports = { addOrder, getOrderBook };