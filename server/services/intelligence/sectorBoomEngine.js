/*
  sectorBoomEngine.js

  Detects when a sector crosses a "boom" threshold:
    - 3+ companies with orders in same sector, OR
    - Total sector order value crosses a threshold

  Called after sectorQueue updates.
  Returns a boom event or null.
*/

const BOOM_ORDER_COUNT = 3;      // min companies with orders
const BOOM_VALUE_CRORE = 500;    // min total sector order value in crore

const boomFired = new Set(); // track which sectors already fired boom alert

function sectorBoomEngine(queue) {
  if (!queue || !queue.sector) return null;

  const { sector, orders, totalValue, companies } = queue;

  const countBoom = orders >= BOOM_ORDER_COUNT;
  const valueBoom = totalValue >= BOOM_VALUE_CRORE;

  if (!countBoom && !valueBoom) return null;

  // Build a unique key so we don't spam the same boom event
  const boomKey = `${sector}:${orders}:${Math.floor(totalValue / 100)}`;

  if (boomFired.has(boomKey)) return null;
  boomFired.add(boomKey);

  // Determine boom type label
  let boomType = "SECTOR_MOMENTUM";
  if (countBoom && valueBoom) boomType = "SECTOR_BOOM";
  else if (valueBoom) boomType = "HIGH_VALUE_SECTOR";
  else if (countBoom) boomType = "MULTI_COMPANY_SECTOR";

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