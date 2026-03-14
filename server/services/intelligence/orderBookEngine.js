const { addOrder: storeAddOrder }              = require("../data/orderBookStore");
const { getMarketCap, getCompanyData,
        getEstimatedOrderBook, addNewOrder }   = require("../data/marketCap");

const quarterlyStore = {};

function getCurrentQuarter() {
  const now = new Date();
  const q   = Math.floor(now.getMonth() / 3) + 1;
  return `${now.getFullYear()}Q${q}`;
}

function orderBookEngine(signal) {
  if (signal.type !== "ORDER_ALERT") return null;

  const code    = String(signal.code || signal.company);
  const company = signal.company;

  // ── ONLY use _orderInfo — never fall back to signal.value ──
  const orderInfo = signal._orderInfo;

  if (!orderInfo || !orderInfo.crores || orderInfo.crores <= 0) {
    // Order keyword detected but no size extracted — skip order book
    console.log(`⚠️ No order size for ${company} — skipping order book`);
    return null;
  }

  const crores       = orderInfo.crores;
  const years        = orderInfo.years        || null;
  const periodLabel  = orderInfo.periodLabel  || null;
  const annualCrores = orderInfo.annualCrores || crores;

  // Legacy running total store
  const storeData = storeAddOrder(code, crores);

  // Add to company data runtime tracker
  addNewOrder(code, crores);

  // Quarterly tracker
  const quarter = getCurrentQuarter();
  if (!quarterlyStore[code]) {
    quarterlyStore[code] = {
      quarterBook:    0,
      currentQuarter: quarter,
      quarterOrders:  0,
      recentOrders:   []
    };
  }

  const qs = quarterlyStore[code];
  if (qs.currentQuarter !== quarter) {
    qs.quarterBook    = 0;
    qs.quarterOrders  = 0;
    qs.currentQuarter = quarter;
  }

  qs.quarterBook   += crores;
  qs.quarterOrders += 1;
  qs.recentOrders.unshift({
    crores, years, periodLabel, annualCrores,
    title: (signal.title || "").substring(0, 80),
    time:  signal.time
  });
  qs.recentOrders = qs.recentOrders.slice(0, 10);

  // MCap calculations
  const mcap       = getMarketCap(code) || 0;
  const mcapRatio  = mcap ? parseFloat(((crores / mcap) * 100).toFixed(2)) : 0;
  const qMcapRatio = mcap ? parseFloat(((qs.quarterBook / mcap) * 100).toFixed(2)) : 0;
  const totalBook  = storeData.totalOrderValue;
  const totalMcapR = mcap ? parseFloat(((totalBook / mcap) * 100).toFixed(2)) : 0;

  // Estimated full order book
  const estBook   = getEstimatedOrderBook(code);
  const obToRev   = estBook?.obToRevRatio || null;
  const bookToBill= estBook?.bookToBill   || null;

  // Strength rating
  let strength = "EARLY";
  if (mcap) {
    if      (totalMcapR >= 50) strength = "DOMINANT";
    else if (totalMcapR >= 20) strength = "STRONG";
    else if (totalMcapR >= 10) strength = "GROWING";
    else if (totalMcapR >= 5)  strength = "BUILDING";
  } else {
    if      (totalBook >= 2000) strength = "DOMINANT";
    else if (totalBook >= 500)  strength = "STRONG";
    else if (totalBook >= 100)  strength = "GROWING";
    else if (totalBook >= 20)   strength = "BUILDING";
  }

  // Alert flags
  const isMegaOrder      = crores >= 1000;
  const isMcapAlert      = mcapRatio >= 5 && mcap > 0;
  const isFrequencyAlert = qs.quarterOrders >= 5;
  const isHighObRev      = obToRev && parseFloat(obToRev) >= 3;

  let alertLevel = null;
  if      (isMegaOrder)      alertLevel = "MEGA";
  else if (isMcapAlert)      alertLevel = "MCAP";
  else if (isFrequencyAlert) alertLevel = "FREQUENCY";

  console.log(`📊 OrderBook: ${company} ₹${crores}Cr | Q-Book: ₹${qs.quarterBook}Cr | MCap%: ${mcapRatio}% | Alert: ${alertLevel || "none"}`);

  return {
    company,
    code,

    // This order
    orderValue:    crores,
    years,
    periodLabel,
    annualCrores,

    // Quarter tracking
    quarterBook:    qs.quarterBook,
    quarterOrders:  qs.quarterOrders,
    currentQuarter: quarter,
    qMcapRatio,

    // Running total
    totalOrderBook: totalBook,
    orders:         storeData.orders.length,
    totalMcapRatio: totalMcapR,

    // Estimated full picture
    estimatedOrderBook:    estBook?.estimated        || null,
    confirmedOrderBook:    estBook?.confirmed        || null,
    confirmedQuarter:      estBook?.confirmedQuarter || null,
    newOrdersSinceConfirm: estBook?.newOrders        || null,

    // Ratios
    mcapRatio,
    obToRevRatio: obToRev,
    bookToBill,

    // Flags
    strength,
    isMegaOrder,
    isMcapAlert,
    isFrequencyAlert,
    isHighObRev,
    alertLevel,

    percentage:   mcapRatio,
    time:         signal.time,
    recentOrders: qs.recentOrders.slice(0, 3)
  };
}

module.exports = orderBookEngine;