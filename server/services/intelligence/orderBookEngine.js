const { addOrder: storeAddOrder } = require("../data/orderBookStore");
const {
  getMarketCap,
  getEstimatedOrderBook,
  addNewOrder
} = require("../data/marketCap");

const quarterlyStore = {};
const liveOrderBookStore = {}; // ✅ NEW

function getCurrentQuarter() {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3) + 1;
  return `${now.getFullYear()}Q${q}`;
}

// ✅ SET BASE FROM RESULT
function setConfirmedOrderBook(code, company, quarter, value) {
  if (!liveOrderBookStore[code]) {
    liveOrderBookStore[code] = {
      company,
      code,
      confirmedQuarter: null,
      confirmedOrderBook: 0,
      addedSinceResult: 0,
      currentOrderBook: 0,
      dayWiseOrders: [],
      quarterSeries: []
    };
  }

  const item = liveOrderBookStore[code];

  item.company = company;
  item.code = code;
  item.confirmedQuarter = quarter;
  item.confirmedOrderBook = Number(value) || 0;
  item.addedSinceResult = 0;
  item.currentOrderBook = item.confirmedOrderBook;
}

//function addOrderToLiveBook(signal) {
  if (!signal._orderInfo?.crores) return;

  const code = String(signal.code || signal.company);
  const company = signal.company;
  const crores = Number(signal._orderInfo.crores);

  if (!crores || crores <= 0) return;

  if (!liveOrderBookStore[code]) {
    liveOrderBookStore[code] = {
      company,
      code,
      confirmedQuarter: null,
      confirmedOrderBook: 0,
      addedSinceResult: 0,
      currentOrderBook: 0,
      dayWiseOrders: [],
      quarterSeries: []
    };
  }

  const item = liveOrderBookStore[code];

  item.company = company;
  item.addedSinceResult += crores;
  item.currentOrderBook =
    (item.confirmedOrderBook || 0) + item.addedSinceResult;

  // ✅ Prevent duplicate same order
  const orderTime = signal.time || Date.now();

  const exists = item.dayWiseOrders.find(
    o => o.time === orderTime && o.crores === crores
  );

  if (exists) return;

  // ✅ Add new order
  item.dayWiseOrders.unshift({
    date: new Date(orderTime)
      .toISOString()
      .slice(0, 10),
    crores,
    title: (signal.title ?? "").slice(0, 80),
    time: orderTime
  });

  // keep only latest 50
  item.dayWiseOrders = item.dayWiseOrders.slice(0, 50);
}
function addOrderToLiveBook(signal) {
  if (!signal._orderInfo?.crores) return;

  const code = String(signal.code || signal.company);
  const company = signal.company;
  const crores = Number(signal._orderInfo.crores);

  if (!crores || crores <= 0) return;

  if (!liveOrderBookStore[code]) {
    liveOrderBookStore[code] = {
      company,
      code,
      confirmedQuarter: null,
      confirmedOrderBook: 0,
      addedSinceResult: 0,
      currentOrderBook: 0,
      dayWiseOrders: [],
      quarterSeries: []
    };
  }

  const item = liveOrderBookStore[code];

  item.company = company;
  item.addedSinceResult += crores;
  item.currentOrderBook =
    (item.confirmedOrderBook || 0) + item.addedSinceResult;

  const orderTime = signal.time || Date.now();

  const exists = item.dayWiseOrders.find(
    o => o.time === orderTime && o.crores === crores
  );

  if (exists) return;

  item.dayWiseOrders.unshift({
    date: new Date(orderTime).toISOString().slice(0, 10),
    crores,
    title: (signal.title ?? "").slice(0, 80),
    time: orderTime
  });

  item.dayWiseOrders = item.dayWiseOrders.slice(0, 50);
}
function updateQuarterSeries(code, company, quarter, value) {
  if (!liveOrderBookStore[code]) {
    liveOrderBookStore[code] = {
      company,
      code,
      confirmedQuarter: null,
      confirmedOrderBook: 0,
      addedSinceResult: 0,
      currentOrderBook: 0,
      dayWiseOrders: [],
      quarterSeries: []
    };
  }

  const item = liveOrderBookStore[code];

  const numericValue = Number(value) || 0;

  const existing = item.quarterSeries.find(q => q.quarter === quarter);

  if (existing) {
    existing.orderBook = numericValue;
  } else {
    item.quarterSeries.push({
      quarter,
      orderBook: numericValue
    });
  }

  item.quarterSeries.sort((a, b) => {
    const [y1, q1] = a.quarter.split("Q").map(Number);
    const [y2, q2] = b.quarter.split("Q").map(Number);
    return y1 === y2 ? q1 - q2 : y1 - y2;
  });

  item.quarterSeries = item.quarterSeries.slice(-4);

  item.quarterSeries = item.quarterSeries.map((q, i, arr) => {
    if (i === 0) return { ...q, qoqGrowth: null };

    const prev = arr[i - 1].orderBook;
    const growth =
      prev > 0 ? ((q.orderBook - prev) / prev) * 100 : null;

    return {
      ...q,
      qoqGrowth: growth !== null ? Number(growth.toFixed(2)) : null
    };
  });
}
function orderBookEngine(signal) {
  if (signal.type !== "ORDER_ALERT") return null;

  const code = String(signal.code || signal.company);
  const company = signal.company;

  const orderInfo = signal._orderInfo;

  if (!orderInfo || !orderInfo.crores) return null;

  const crores = Number(orderInfo.crores);
  if (!crores || crores <= 0) return null;

  const years = orderInfo.years || null;
  const periodLabel = orderInfo.periodLabel || null;
  const annualCrores =
    orderInfo.annualCrores || (years ? crores / years : crores);

  const orderId = `${code}-${crores}-${signal.time}`;

  const storeData = storeAddOrder(code, crores, orderId);
  addNewOrder(code, crores, orderId);

  // ✅ LIVE ORDER BOOK UPDATE
  addOrderToLiveBook(signal);

  // ───────── QUARTERLY TRACKING ─────────

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

  if (qs.currentQuarter !== quarter) {
    qs.quarterHistory.push({
      quarter: qs.currentQuarter,
      value: qs.quarterBook
    });

    qs.quarterHistory = qs.quarterHistory.slice(-4);

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
  title: (signal.title ?? "").slice(0, 80),
  time: signal.time
});

  qs.recentOrders = qs.recentOrders.slice(0, 10);

  // ───────── CALCULATIONS ─────────

  const mcap = getMarketCap(code) || 0;

  const mcapRatio = mcap
    ? parseFloat(((crores / mcap) * 100).toFixed(2))
    : 0;

  const totalBook = storeData.totalOrderValue;

  const totalMcapRatio = mcap
    ? parseFloat(((totalBook / mcap) * 100).toFixed(2))
    : 0;

  const estBook = getEstimatedOrderBook(code);

  const obToRev = estBook?.obToRevRatio || null;
  const bookToBill = estBook?.bookToBill || null;

  // ───────── STRENGTH ─────────

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

  // ───────── ALERTS ─────────

  const isMegaOrder = crores >= 1000;
  const isMcapAlert = mcapRatio >= 5 && mcap > 0;
  const isFrequencyAlert =
    qs.quarterBook >= 500 && qs.quarterOrders >= 3;

  const alertLevel = {
    mega: isMegaOrder,
    mcap: isMcapAlert,
    freq: isFrequencyAlert
  };

  // ───────── LIVE BOOK DATA ─────────

  const live = liveOrderBookStore[code] || {};

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
    totalMcapRatio,

    estimatedOrderBook: estBook?.estimated || null,
    confirmedOrderBook: estBook?.confirmed || null,
    confirmedQuarter: estBook?.confirmedQuarter || null,

    // ✅ NEW POWER DATA
    currentLiveOrderBook: live.currentOrderBook || 0,
    addedSinceResult: live.addedSinceResult || 0,
    dayWiseOrders: live.dayWiseOrders || [],
    quarterSeries: live.quarterSeries || [],

    strength,
    alertLevel,

    time: signal.time,
    recentOrders: qs.recentOrders.slice(0, 3)
  };
}

module.exports = {
  orderBookEngine,
  setConfirmedOrderBook,
  updateQuarterSeries
};