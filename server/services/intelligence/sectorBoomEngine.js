/*
  sectorBoomEngine.js

  Detects when a sector crosses a "boom" threshold:
    - 3+ companies with orders in same sector, OR
    - Total sector order value crosses a threshold

  Called after sectorQueue updates.
  Returns a boom event or null.

  MEMORY FIX:
  - boomFired Set was never pruned — grew forever as sectors triggered booms.
    Now capped at MAX_BOOM_KEYS (200). When exceeded, the oldest half are
    removed so the Set stays bounded.
  - Daily reset: boomFired is cleared at the start of each new IST calendar day
    so yesterday's booms don't block today's signals.
*/

const BOOM_ORDER_COUNT = 3;      // min companies with orders
const BOOM_VALUE_CRORE = 500;    // min total sector order value in crore

const MAX_BOOM_KEYS = 200;       // cap on boomFired Set size

const boomFired    = new Set();
const boomFiredLog = [];         // insertion-order log for eviction

let _lastResetDay = null;

function todayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function maybeResetDaily() {
  const today = todayIST();
  if (_lastResetDay !== today) {
    _lastResetDay = today;
    boomFired.clear();
    boomFiredLog.length = 0;
    console.log(`🔄 SectorBoom: daily reset — boomFired cleared for ${today}`);
  }
}

function addBoomKey(key) {
  boomFired.add(key);
  boomFiredLog.push(key);

  // Evict oldest half when cap exceeded
  if (boomFired.size > MAX_BOOM_KEYS) {
    const evictCount = Math.floor(MAX_BOOM_KEYS / 2);
    for (let i = 0; i < evictCount && boomFiredLog.length > 0; i++) {
      const old = boomFiredLog.shift();
      boomFired.delete(old);
    }
  }
}

function sectorBoomEngine(queue) {
  if (!queue || !queue.sector) return null;

  maybeResetDaily();

  const { sector, orders, totalValue, companies } = queue;

  const countBoom = orders >= BOOM_ORDER_COUNT;
  const valueBoom = totalValue >= BOOM_VALUE_CRORE;

  if (!countBoom && !valueBoom) return null;

  const boomKey = `${sector}:${orders}:${Math.floor(totalValue / 100)}`;

  if (boomFired.has(boomKey)) return null;
  addBoomKey(boomKey);

  let boomType = "SECTOR_MOMENTUM";
  if (countBoom && valueBoom) boomType = "SECTOR_BOOM";
  else if (valueBoom)         boomType = "HIGH_VALUE_SECTOR";
  else if (countBoom)         boomType = "MULTI_COMPANY_SECTOR";

  console.log(`🔥 Sector Boom Detected: ${sector} | Orders: ${orders} | Value: Rs.${totalValue} Cr`);

  return {
    sector,
    orders,
    companies,
    totalValue,
    boomType,
    isBoom: true,
    lastUpdate: new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })
  };
}

module.exports = sectorBoomEngine;