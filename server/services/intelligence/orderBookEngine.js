/**
 * orderBookEngine.js
 * Tracks cumulative quarterly order book per company.
 * Shows total book, current quarter book, order frequency.
 */

const { addOrder: storeAddOrder } = require("../data/orderBookStore");
const { getMarketCap } = require("../data/marketCap");

// In-memory quarterly tracker: company code → data
const quarterlyStore = {};

function getCurrentQuarter() {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3) + 1;
  return `${now.getFullYear()}Q${q}`;
}

function orderBookEngine(signal) {
  if (signal.type !== "ORDER_ALERT") return null;

  const code = String(signal.code || signal.company);
  const company = signal.company;

  // Get order info from signal (set by announcementAnalyzer)
  const orderInfo = signal._orderInfo || {};
  const crores = orderInfo.crores || signal.value || 0;
  const years = orderInfo.years || null;
  const periodLabel = orderInfo.periodLabel || null;
  const annualCrores = orderInfo.annualCrores || crores;

  // Legacy store (keeps existing total)
  const storeData = storeAddOrder(code, crores);

  // Quarterly tracker
  const quarter = getCurrentQuarter();
  if (!quarterlyStore[code]) {
    quarterlyStore[code] = {
      quarterBook: 0,
      currentQuarter: quarter,
      quarterOrders: 0,
      recentOrders: []
    };
  }

  const qs = quarterlyStore[code];

  // Reset if new quarter
  if (qs.currentQuarter !== quarter) {
    qs.quarterBook = 0;
    qs.quarterOrders = 0;
    qs.currentQuarter = quarter;
  }

  qs.quarterBook += crores;
  qs.quarterOrders += 1;
  qs.recentOrders.unshift({
    crores,
    years,
    periodLabel,
    annualCrores,
    title: (signal.title || "").substring(0, 80),
    time: signal.time
  });
  qs.recentOrders = qs.recentOrders.slice(0, 10);

  const totalOrderBook = storeData.totalOrderValue;
  const marketCap = getMarketCap(code) || 0;

  // MCap ratios
  const mcapRatio = marketCap ? parseFloat(((crores / marketCap) * 100).toFixed(2)) : 0;
  const quarterMcapRatio = marketCap ? parseFloat(((qs.quarterBook / marketCap) * 100).toFixed(2)) : 0;
  const totalMcapRatio = marketCap ? parseFloat(((totalOrderBook / marketCap) * 100).toFixed(2)) : 0;

  // Strength based on total book vs mcap
  let strength = "EARLY";
  if (marketCap) {
    if (totalMcapRatio >= 50)     strength = "DOMINANT";
    else if (totalMcapRatio >= 20) strength = "STRONG";
    else if (totalMcapRatio >= 10) strength = "GROWING";
    else if (totalMcapRatio >= 5)  strength = "BUILDING";
  } else {
    if (totalOrderBook >= 2000)    strength = "DOMINANT";
    else if (totalOrderBook >= 500) strength = "STRONG";
    else if (totalOrderBook >= 100) strength = "GROWING";
    else if (totalOrderBook >= 20)  strength = "BUILDING";
  }

  // Mega order flags
  const isMegaOrder = crores >= 1000;
  const isMcapAlert = mcapRatio >= 5 && marketCap > 0;
  const isFrequencyAlert = qs.quarterOrders >= 5; // 5+ orders this quarter

  return {
    company,
    code,
    orderValue: crores,
    years,
    periodLabel,
    annualCrores,
    totalOrderBook,
    quarterBook: qs.quarterBook,
    quarterOrders: qs.quarterOrders,
    currentQuarter: quarter,
    mcapRatio,
    quarterMcapRatio,
    totalMcapRatio,
    orders: storeData.orders.length,
    recentOrders: qs.recentOrders.slice(0, 3),
    strength,
    isMegaOrder,
    isMcapAlert,
    isFrequencyAlert,
    alertLevel: isMegaOrder ? "MEGA" : isMcapAlert ? "MCAP" : isFrequencyAlert ? "FREQUENCY" : null,
    percentage: mcapRatio,
    time: signal.time
  };
}

module.exports = orderBookEngine;