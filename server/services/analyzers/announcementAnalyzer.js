const orderDetector  = require("../intelligence/orderDetector");
const { getLiveMcap } = require("../data/liveMcap");
const { getMarketCap } = require("../data/marketCap");

function scoreFromMcapRatio(crores, mcap) {

  const pct = (crores / mcap) * 100;

  if (pct >= 50) return 98;
  if (pct >= 25) return 95;
  if (pct >= 15) return 92;
  if (pct >= 10) return 88;
  if (pct >= 5)  return 82;
  if (pct >= 2)  return 72;
  if (pct >= 1)  return 62;
  if (pct >= 0.5) return 52;

  return 35;
}

async function analyzeAnnouncement(data) {

  if (!data || !data.title) return null;

  const orderInfo = orderDetector(data.title);

  if (!orderInfo) {
    return {
      ...data,
      type: "NEWS",
      value: 5
    };
  }

  const crores = orderInfo.crores;

  const mcap =
    (await getLiveMcap(data.code)) ||
    getMarketCap(data.code) ||
    null;

  let score = 30;
  let pct = null;

  if (mcap && crores) {
    pct = (crores / mcap * 100);
    score = scoreFromMcapRatio(crores, mcap);
  }

  return {

    ...data,

    type: "ORDER_ALERT",

    value: score,

    _orderInfo: {

      crores,
      mcap,
      mcapPct: pct ? pct.toFixed(2) : null,

      years: orderInfo.years,
      periodLabel: orderInfo.periodLabel,
      annualCrores: orderInfo.annualCrores
    }
  };
}

module.exports = analyzeAnnouncement;