const { addOrder: storeAddOrder } = require("../data/orderBookStore");
const {
  getMarketCap,
  getEstimatedOrderBook,
  addNewOrder
} = require("../data/marketCap");

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

  const orderInfo = signal._orderInfo;

  if (!orderInfo || !orderInfo.crores) {
    console.log(`⚠️ No order size for ${company} — skipping`);
    return null;
  }

  const crores = Number(orderInfo.crores);
  if (!crores || crores <= 0) return null;

  const years = orderInfo.years || null;
  const periodLabel = orderInfo.periodLabel || null;
  const annualCrores =
    orderInfo.annualCrores || (years ? crores / years : crores);

  // ✅ Unique ID for dedupe
  const orderId = `${code}-${crores}-${signal.time}`;

  // ✅ Store updates (pass orderId for dedupe support)
  const storeData = storeAddOrder(code, crores, orderId);
  addNewOrder(code, crores, orderId);

  // ─────────────────────────────
  // 📊 QUARTERLY TRACKING
  // ─────────────────────────────

  const quarter = getCurrentQuarter();

  if (!quarterlyStore[code]) {
    quarterlyStore[code] = {
      quarterBook: 0,
      currentQuarter: quarter,
      quarterOrders: 0,
      recentOrders: [],
      quarterHistory: []
    };
  }

  const qs = quarterlyStore[code];

  // Reset on new quarter
  if (qs.currentQuarter !== quarter) {
    // Save previous quarter to history
    qs.quarterHistory.push({
      quarter: qs.currentQuarter,
      value: qs.quarterBook
    });

    qs.quarterHistory = qs.quarterHistory.slice(-4);

    qs.quarterBook = 0;
    qs.quarterOrders = 0;
    qs.currentQuarter = quarter;
  }

  // Update current quarter
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

  // ─────────────────────────────
  // 📈 CALCULATIONS
  // ─────────────────────────────

  const mcap = getMarketCap(code) || 0;

  const mcapRatio = mcap
    ? parseFloat(((crores / mcap) * 100).toFixed(2))
    : 0;

  const qMcapRatio = mcap
    ? parseFloat(((qs.quarterBook / mcap) * 100).toFixed(2))
    : 0;

  const totalBook = storeData.totalOrderValue;

  const totalMcapRatio = mcap
    ? parseFloat(((totalBook / mcap) * 100).toFixed(2))
    : 0;

  // Estimated order book
  const estBook = getEstimatedOrderBook(code);

  const obToRev = estBook?.obToRevRatio || null;
  const bookToBill = estBook?.bookToBill || null;

  // ─────────────────────────────
  // 💪 STRENGTH LOGIC
  // ─────────────────────────────

  let strength = "EARLY";

  if (mcap) {
    if (totalMcapRatio >= 50) strength = "DOMINANT";
    else if (totalMcapRatio >= 20) strength = "STRONG";
    else if (totalMcapRatio >= 10) strength = "GROWING";
    else if (totalMcapRatio >= 5) strength = "BUILDING";
  } else {
    if (totalBook >= 2000) strength = "DOMINANT";
    else if (totalBook >= 500) strength = "STRONG";
    else if (totalBook >= 100) strength = "GROWING";
    else if (totalBook >= 20) strength = "BUILDING";
  }

  // ─────────────────────────────
  // 🚨 ALERT FLAGS
  // ─────────────────────────────

  const isMegaOrder = crores >= 1000;
  const isMcapAlert = mcapRatio >= 5 && mcap > 0;
  const isFrequencyAlert =
    qs.quarterBook >= 500 && qs.quarterOrders >= 3;
  const isHighObRev = obToRev && parseFloat(obToRev) >= 3;

  const alertLevel = {
    mega: isMegaOrder,
    mcap: isMcapAlert,
    freq: isFrequencyAlert
  };

  console.log(
    `📊 ${company} ₹${crores}Cr | Q: ₹${qs.quarterBook}Cr | MCap%: ${mcapRatio}% | Alert: ${JSON.stringify(
      alertLevel
    )}`
  );

  // ─────────────────────────────
  // 📦 FINAL OUTPUT
  // ─────────────────────────────

  return {
    company,
    code,

    orderValue: crores,
    mcapRatio,

    years,
    periodLabel,
    annualCrores,

    quarterBook: qs.quarterBook,
    quarterOrders: qs.quarterOrders,
    currentQuarter: quarter,
    quarterHistory: qs.quarterHistory,

    totalOrderBook: totalBook,
    orders: storeData.orders.length,
    totalMcapRatio,

    estimatedOrderBook: estBook?.estimated || null,
    confirmedOrderBook: estBook?.confirmed || null,
    confirmedQuarter: estBook?.confirmedQuarter || null,
    newOrdersSinceConfirm: estBook?.newOrders || null,

    obToRevRatio: obToRev,
    bookToBill,

    strength,
    isMegaOrder,
    isMcapAlert,
    isFrequencyAlert,
    isHighObRev,
    alertLevel,

    percentage: mcapRatio,
    time: signal.time,
    recentOrders: qs.recentOrders.slice(0, 3)
  };
}

module.exports = orderBookEngine;