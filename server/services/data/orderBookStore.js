"use strict";

/**
 * orderBookStore.js
 * Persists order book to disk — survives server restarts on Render.
 *
 * MEMORY FIXES vs original:
 *  1. saveToDisk() is now debounced — batched into a 30s window instead of
 *     firing synchronously on every addOrder() call. Prevents event-loop
 *     blocking and keeps extra write-buffers from lingering in RAM.
 *  2. orders older than 365 days are pruned on every addOrder() (unchanged).
 *  3. MAX_COMPANIES cap (500) prevents the Map growing unbounded if many
 *     new codes are added over time. Oldest entries evicted first.
 */

const fs   = require("fs");
const path = require("path");

const STORE_FILE   = path.join(__dirname, "../../data/orderBookStore.json");
const MAX_COMPANIES = 500; // cap total entries in the Map

let orderBooks   = new Map();
let orderIdsSeen = new Set();

// ── Load on startup ───────────────────────────────────────────────────────────
function loadFromDisk() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw  = fs.readFileSync(STORE_FILE, "utf8");
      const data = JSON.parse(raw);
      orderBooks   = new Map(Object.entries(data.books  || {}));
      orderIdsSeen = new Set(data.seenIds || []);
      console.log(`📦 OrderBook loaded: ${orderBooks.size} companies`);
    }
  } catch (e) {
    console.log("⚠️ OrderBook load failed:", e.message);
    orderBooks   = new Map();
    orderIdsSeen = new Set();
  }
}

loadFromDisk();

// ── FIX: debounced save ───────────────────────────────────────────────────────
// Writes happen at most once per 30 seconds regardless of how many
// addOrder() calls fire. This eliminates synchronous disk I/O on every
// BSE filing hit during busy market hours.
let _saveTimer = null;

function saveToDisk() {
  try {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify({
      books:   Object.fromEntries(orderBooks),
      seenIds: [...orderIdsSeen].slice(-2000),
    }), "utf8");
  } catch (e) {
    console.log("⚠️ OrderBook save failed:", e.message);
  }
}

function scheduleSave() {
  if (_saveTimer) return; // already queued
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    saveToDisk();
  }, 30_000); // batch all writes into a 30s window
}

// Safety net: flush on process exit so no data is lost
process.on("exit",    saveToDisk);
process.on("SIGTERM", () => { saveToDisk(); process.exit(0); });

// Periodic save every 5 min as extra safety (unchanged from original)
setInterval(saveToDisk, 5 * 60 * 1000);

// ── FIX: evict oldest companies when Map exceeds cap ─────────────────────────
function evictIfNeeded() {
  if (orderBooks.size <= MAX_COMPANIES) return;
  // Maps preserve insertion order — delete the oldest entries
  const deleteCount = orderBooks.size - MAX_COMPANIES;
  let i = 0;
  for (const key of orderBooks.keys()) {
    if (i++ >= deleteCount) break;
    orderBooks.delete(key);
  }
}

// ── addOrder ──────────────────────────────────────────────────────────────────
function addOrder(companyCode, orderValueCrore, orderId) {
  const code = String(companyCode);

  if (orderId && orderIdsSeen.has(orderId)) {
    return orderBooks.get(code) || { totalOrderValue: 0, orders: [] };
  }
  if (orderId) {
    orderIdsSeen.add(orderId);
    // Keep seenIds bounded
    if (orderIdsSeen.size > 3000) {
      const arr = [...orderIdsSeen];
      orderIdsSeen = new Set(arr.slice(-2000));
    }
  }

  if (!orderBooks.has(code)) {
    orderBooks.set(code, { totalOrderValue: 0, orders: [] });
    evictIfNeeded(); // keep Map bounded
  }

  const data = orderBooks.get(code);

  // Remove orders older than 365 days
  const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
  data.orders  = data.orders.filter(o => new Date(o.time).getTime() > cutoff);

  data.orders.push({
    value:   orderValueCrore,
    time:    new Date().toISOString(),
    orderId: orderId || null,
  });

  data.totalOrderValue = data.orders.reduce((s, o) => s + (o.value || 0), 0);

  scheduleSave(); // FIX: debounced — no longer blocks event loop on every call
  return data;
}

// ── getOrderBook ──────────────────────────────────────────────────────────────
function getOrderBook(companyCode) {
  return orderBooks.get(String(companyCode));
}

module.exports = { addOrder, getOrderBook };